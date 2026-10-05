import { defineConfig } from "vitest/config";

// The tests cover the request handler and cache policy with fakes, so they run in Node rather than workerd:
// loading cloudflare.config.ts in the Workers pool would also try to build the container image.
export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
