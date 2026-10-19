import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      isolatedStorage: true,
      // The suite assumes an open relay that counts nothing; a developer's
      // .dev.vars must not close it or send test traffic to PostHog.
      // closed.test.ts and visits.test.ts set their values per request instead.
      miniflare: { bindings: { RELAY_KEY: "", POSTHOG_KEY: "", POSTHOG_HOST: "" } },
    }),
  ],
});
