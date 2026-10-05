import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

// `cf dev` and `cf build` run through Vite; the Worker and the Container are configured in cloudflare.config.ts.
export default defineConfig({
  plugins: [cloudflare()],
  // packages/worker's dev server uses 8787.
  server: { port: 8788, strictPort: true },
});
