/**
 * Worker and Container configuration for the cf CLI (`cf dev`, `cf build`, `cf deploy`, `cf workers types`).
 *
 * Cost notes are in README.md. In short: one lite instance kept awake by the cron trigger.
 */
import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

/**
 * Per-client limits for the rate limiting bindings below, also shown on the homepage (through the LIMITS
 * binding, because modules imported here cannot also be imported by the Worker). The bindings count per
 * Cloudflare location, so the limits are approximate.
 */
const LIMITS = {
  /** All API requests, cached or not. */
  allPerMinute: 600,
  /** Requests that miss the edge cache and are computed by the container. */
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
      // Namespace ids are account-wide integers; these two are not used by any other Worker.
      LIMIT_ALL: bindings.rateLimit({ namespace: "7301", simple: { limit: LIMITS.allPerMinute, period: 60 } }),
      LIMIT_ORIGIN: bindings.rateLimit({ namespace: "7302", simple: { limit: LIMITS.originPerMinute, period: 60 } }),
      LIMITS: bindings.json(LIMITS),
    },
    exports: {
      OpenMeteoServer: exports.durableObject({ storage: "sqlite", container: openMeteo }),
    },
  },
  containers: [openMeteo],
});
