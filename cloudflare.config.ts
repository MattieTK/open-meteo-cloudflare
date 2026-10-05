/**
 * Worker and Container configuration for the cf CLI (`cf dev`, `cf build`, `cf deploy`, `cf workers types`).
 *
 * Cost notes are in README.md. In short: one lite instance kept awake by the cron trigger.
 */
import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

/**
 * Per-client limits. The Worker reads them through the LIMITS binding (modules imported here cannot also be
 * imported by the Worker) for the homepage and the Durable Object.
 */
const LIMITS = {
  /**
   * All API requests, cached or not: a coarse flood guard using the rate limiting binding, which counts per
   * Cloudflare location and lets short bursts through, so it is not exact.
   */
  allPer10Seconds: 100,
  /** Requests that miss the edge cache and are computed by the container, counted exactly in the Durable Object. */
  originPerMinute: 60,
};

const openMeteo = defineContainer({
  name: "halfhour-weather-open-meteo",
  // The official image, unmodified; see the Dockerfile for why it is rebuilt rather than referenced.
  image: { dockerfile: "./Dockerfile" },
  // 1/16 vCPU, 256 MiB memory, 2 GB disk. The server is network-bound and peaked at about 60 MiB in testing.
  instanceType: "lite",
  // Only one Durable Object name is ever used, so one instance; this also caps the cost.
  maxInstances: 1,
  // Next to Open-Meteo's bucket (AWS us-west-2). A cold read makes hundreds of range requests to it, so
  // placing the container there and crossing the Atlantic once per API request is much faster than the reverse.
  constraints: { regions: ["WNAM"] },
  observability: { logs: { enabled: true } },
});

export default defineConfig({
  worker: {
    name: "halfhour-weather",
    compatibilityDate: "2026-08-22",
    entrypoint,
    domains: ["weather.tk.gg"],
    observability: { enabled: true, headSamplingRate: 1 },
    // Wakes the container every 10 minutes so it does not sleep and lose its block cache (see OpenMeteoServer.sleepAfter).
    triggers: [triggers.scheduled({ schedule: "*/10 * * * *" })],
    env: {
      // Namespace ids are account-wide integers; this one is not used by any other Worker.
      LIMIT_ALL: bindings.rateLimit({ namespace: "7301", simple: { limit: LIMITS.allPer10Seconds, period: 10 } }),
      LIMITS: bindings.json(LIMITS),
    },
    exports: {
      OpenMeteoServer: exports.durableObject({ storage: "sqlite", container: openMeteo }),
    },
  },
  containers: [openMeteo],
});
