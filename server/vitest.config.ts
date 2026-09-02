import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      isolatedStorage: true,
      // The suite assumes an open relay; a developer's .dev.vars must not
      // close it. closed.test.ts sets the key per request instead.
      miniflare: { bindings: { RELAY_KEY: "" } },
    }),
  ],
});
