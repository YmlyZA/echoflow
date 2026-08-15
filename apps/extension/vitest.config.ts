import { defineConfig } from "vitest/config";

// Keep tests on @echoflow/protocol TypeScript source: the package's default
// export condition resolves to compiled dist/ so plain Node can run the built
// backend, and tests must not depend on that build having happened.
export default defineConfig({
  resolve: { conditions: ["echoflow-source"] },
  ssr: { resolve: { conditions: ["echoflow-source"] } },
});
