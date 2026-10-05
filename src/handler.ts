/**
 * The request path for weather.tk.gg: homepage, edge cache, rate limits, then the Open-Meteo container.
 *
 * Everything the handler touches is passed in (`Deps`), so tests run it against fakes without the Workers runtime.
 */
import { type Limits, homePage } from "./home";
import { ENDPOINTS, ERROR_TTL_SECONDS, MAX_LOCATIONS, MAX_URL_LENGTH, cacheKey, endpointFor, locationCount, ttlSeconds } from "./policy";

/** The subset of the Workers rate limiting binding that the handler uses. */
export type Limiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

/** The subset of the Cache API that the handler uses. */
export type EdgeCache = {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
};

export type Deps = {
  cache: EdgeCache;
  /** A coarse flood guard on every API request, including cache hits. */
  limitAll: Limiter;
  /**
   * Sends a GET for a path and query (for example `/v1/forecast?latitude=...`) to the Open-Meteo container.
   * The client key travels with it, because the per-client limit on uncached requests is counted there.
   */
  origin: (pathAndQuery: string, clientKey: string, signal: AbortSignal) => Promise<Response>;
  waitUntil: (promise: Promise<unknown>) => void;
  now: () => Date;
  /** The image reference in use, shown on the homepage. */
  image: string;
  /** The rate limits configured in cloudflare.config.ts, shown on the homepage. */
  limits: Limits;
  /** How long to wait for the container before answering 504. */
  originTimeoutMs?: number;
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-max-age": "86400",
};

/** Open-Meteo's own error shape, so existing clients can read our errors too. */
function apiError(status: number, reason: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: true, reason }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS, ...headers },
  });
}

/**
 * Rate limit key: the client IP, plus the calling zone for requests made by Workers.
 *
 * Every Worker on Cloudflare reaches us from the same few egress addresses, so the IP alone would put all
 * Worker callers (Halfhour included) in one bucket. Cloudflare sets `CF-Worker` to the caller's zone and a
 * Worker cannot change it; a non-Worker client that sends the header only moves itself to a different bucket.
 */
export function clientKey(request: Request): string {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const worker = request.headers.get("cf-worker");
  return worker ? `${ip}|${worker}` : ip;
}

function withoutBody(response: Response, method: string): Response {
  return method === "HEAD" ? new Response(null, response) : response;
}

export async function handle(request: Request, deps: Deps): Promise<Response> {
  if (request.url.length > MAX_URL_LENGTH) {
    return apiError(414, `The request URL is longer than ${MAX_URL_LENGTH} characters.`);
  }
  const url = new URL(request.url);
  const method = request.method;

  if (url.pathname === "/" || url.pathname === "/index.html") {
    if (method !== "GET" && method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    return withoutBody(
      new Response(homePage({ origin: url.origin, image: deps.image, limits: deps.limits }), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" },
      }),
      method,
    );
  }
  if (url.pathname === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /v1/\n", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" } });
  }
  if (!url.pathname.startsWith("/v1/")) {
    return new Response("Not found. The API lives under /v1/; see / for details.\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (method !== "GET" && method !== "HEAD") {
    return apiError(405, "Only GET requests are accepted on this server.", { allow: "GET, HEAD, OPTIONS" });
  }

  const endpoint = endpointFor(url.pathname);
  if (!endpoint) {
    return apiError(404, `Unknown endpoint. This server answers /v1/ followed by one of: ${Object.keys(ENDPOINTS).join(", ")}.`);
  }

  if (locationCount(url.searchParams) > MAX_LOCATIONS) {
    return apiError(400, `This server accepts up to ${MAX_LOCATIONS} locations per request.`);
  }

  const key = clientKey(request);
  if (!(await deps.limitAll.limit({ key })).success) {
    return apiError(429, "Too many requests from this address. Please wait a few seconds and try again.", { "retry-after": "10" });
  }

  // Canonical path (no trailing slash) and sorted parameters, so equivalent requests share one cache entry.
  const canonical = new URL(`/v1/${endpoint}`, url.origin);
  canonical.search = url.search;
  const cacheUrl = cacheKey(canonical);

  const hit = await deps.cache.match(cacheUrl);
  if (hit) {
    const response = new Response(hit.body, hit);
    response.headers.set("x-cache", "HIT");
    return withoutBody(response, method);
  }

  const pathAndQuery = cacheUrl.slice(url.origin.length);
  let upstream: Response;
  try {
    upstream = await deps.origin(pathAndQuery, key, AbortSignal.timeout(deps.originTimeoutMs ?? 60_000));
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    console.error(JSON.stringify({ msg: "origin request failed", endpoint, error: String(error) }));
    return timedOut
      ? apiError(504, "The weather server took too long to answer. Large requests may succeed if retried later, or try a shorter date range.")
      : apiError(502, "The weather server is unavailable at the moment. Please try again shortly.");
  }

  const ttl = upstream.status === 200 ? ttlSeconds(ENDPOINTS[endpoint], url.searchParams, deps.now()) : upstream.status === 400 ? ERROR_TTL_SECONDS : 0;
  const headers = new Headers(CORS);
  for (const name of ["content-type", "content-disposition", "retry-after"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("cache-control", ttl > 0 ? `public, max-age=${ttl}` : "no-store");
  const response = new Response(upstream.body, { status: upstream.status, headers });

  if (ttl > 0) {
    const stored = response.clone();
    deps.waitUntil(deps.cache.put(cacheUrl, stored).catch((error) => console.error(JSON.stringify({ msg: "cache put failed", error: String(error) }))));
  }
  response.headers.set("x-cache", "MISS");
  return withoutBody(response, method);
}
