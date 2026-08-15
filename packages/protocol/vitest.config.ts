import { defaultClientConditions, defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

// Keep tests on @echoflow/protocol TypeScript source: the package's default
// export condition resolves to compiled dist/ so plain Node can run the built
// backend, and tests must not depend on that build having happened.
//
// Spread Vite's defaults rather than listing "echoflow-source" alone: since
// Vite 6, a user-set `resolve.conditions` REPLACES `defaultClientConditions`
// (module/browser/development|production) instead of extending it, and
// `ssr.resolve.conditions` likewise replaces `defaultServerConditions`
// (module/node/...). Dropping them silently resolves dependencies through the
// wrong entry point, with no error anywhere.
export default defineConfig({
  resolve: { conditions: [...defaultClientConditions, "echoflow-source"] },
  ssr: { resolve: { conditions: [...defaultServerConditions, "echoflow-source"] } },
});
