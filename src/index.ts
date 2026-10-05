/**
 * weather.tk.gg: a Worker in front of one Cloudflare Container running the official Open-Meteo server.
 *
 * The Worker answers the homepage, serves repeat API requests from the edge cache and applies rate limits;
 * only cache misses reach the container, through the `OpenMeteoServer` Durable Object below.
 */
import { Container, getContainer } from "@cloudflare/containers";
import { exports } from "cloudflare:workers";
import { handle } from "./handler";
import { OPEN_METEO_IMAGE } from "./image";
import { WindowCounter } from "./policy";

/** All traffic goes to a single named instance, so the container's block cache is shared by every request. */
const INSTANCE = "primary";

/** Requests the container works on at once before new ones get a 503; it has 1/16 of a vCPU. */
const MAX_IN_FLIGHT = 8;

/** Carries the rate limit key from the Worker to the Durable Object. The object is not reachable from outside. */
const CLIENT_KEY_HEADER = "x-weather-client";

function jsonError(status: number, reason: string, retryAfter: number): Response {
  return new Response(JSON.stringify({ error: true, reason }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "retry-after": String(retryAfter) },
  });
}

export class OpenMeteoServer extends Container<Env> {
  defaultPort = 8080;
  // The cron below calls the container every 10 minutes, so it only sleeps if two runs in a row fail.
  // Sleeping wipes the disk, and with it the block cache that makes warm requests fast.
  sleepAfter = "25m";
  // The server answers /robots.txt without touching any data.
  pingEndpoint = "localhost/robots.txt";
  envVars = {
    // Read the processed model data straight from Open-Meteo's open-data bucket on AWS, so no downloaders run here.
    REMOTE_DATA_DIRECTORY: "https://openmeteo.s3.amazonaws.com/data/",
    // The cache file is allocated in full at start. The lite instance has 2 GB of disk, which also holds the image.
    CACHE_SIZE: "1GB",
  };

  private inFlight = 0;
  private uncached = new WindowCounter(this.env.LIMITS.originPerMinute, 60_000);

  override async fetch(request: Request): Promise<Response> {
    // Every cache miss passes through this one object, so the per-client count here is exact and global.
    // The cron's warm-up request carries no key and is not counted.
    const key = request.headers.get(CLIENT_KEY_HEADER);
    const now = Date.now();
    if (key && !this.uncached.take(key, now)) {
      return jsonError(429, `Too many uncached requests from this address (the limit is ${this.env.LIMITS.originPerMinute} a minute). Please try again shortly.`, this.uncached.retryAfter(key, now));
    }
    if (this.inFlight >= MAX_IN_FLIGHT) {
      return jsonError(503, "The weather server is busy. Please try again in a few seconds.", 5);
    }
    this.inFlight++;
    try {
      const forwarded = new Request(request);
      forwarded.headers.delete(CLIENT_KEY_HEADER);
      return await super.fetch(forwarded);
    } finally {
      this.inFlight--;
    }
  }

  override onError(error: unknown): unknown {
    console.error(JSON.stringify({ msg: "container error", error: String(error) }));
    throw error;
  }
}

function container() {
  return getContainer(exports.OpenMeteoServer, INSTANCE);
}

/** Halfhour's 7-day London forecast: keeps the container awake and the current UK model run in its block cache. */
const WARM_PATH =
  "/v1/forecast?forecast_days=7&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_speed_100m&latitude=51.51&longitude=-0.13&models=ecmwf_ifs&timezone=UTC";

export default {
  async fetch(request, env, ctx) {
    return handle(request, {
      cache: caches.default,
      limitAll: env.LIMIT_ALL,
      origin: (pathAndQuery, clientKey, signal) =>
        container().fetch(new Request(`http://container${pathAndQuery}`, { headers: { "accept-encoding": "identity", [CLIENT_KEY_HEADER]: clientKey }, signal })),
      waitUntil: (promise) => ctx.waitUntil(promise),
      now: () => new Date(),
      image: OPEN_METEO_IMAGE,
      limits: env.LIMITS,
    });
  },

  async scheduled(_controller, _env, ctx) {
    ctx.waitUntil(
      (async () => {
        const started = Date.now();
        try {
          const response = await container().fetch(new Request(`http://container${WARM_PATH}`, { headers: { "accept-encoding": "identity" } }));
          await response.arrayBuffer();
          console.log(JSON.stringify({ msg: "warm", status: response.status, ms: Date.now() - started }));
        } catch (error) {
          console.error(JSON.stringify({ msg: "warm failed", error: String(error), ms: Date.now() - started }));
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
