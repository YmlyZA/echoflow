# Backend Distribution and Honest Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the EchoFlow backend as a runnable multi-arch container image on ghcr.io, and make the backend report its own configuration truthfully so a misconfigured install fails at boot instead of at capture time.

**Architecture:** Three independent threads that meet in the onboarding wizard. (a) `@echoflow/protocol` gains a dual export entry — a custom `echoflow-source` condition keeps bundlers and tests on TypeScript source, while plain Node resolves compiled `dist/`, which is what makes the compiled backend runnable at all. (b) The backend gains a production entry point, a configurable bind host, a pure boot self-check, and fail-fast on genuine misconfiguration. (c) The capabilities descriptor gains additive `demo`/`blockers` fields that the extension's existing Connect step renders as actionable hints.

**Tech Stack:** TypeScript, pnpm 10 workspace, Fastify 5, Vitest 3, WXT + React 19, Docker Buildx, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-15-backend-distribution-design.md`

## Global Constraints

- Zero new npm **runtime** dependencies. Task 1 adds `vitest.config.ts` files only; no new packages.
- Backend source imports use explicit `.js` extensions; extension source imports use **no** extension. Follow the file you are editing.
- `exactOptionalPropertyTypes` is on. Never assign `undefined` to an optional property; spread it conditionally (`...(x !== undefined ? { x } : {})`), matching `createConfig`.
- **NO apostrophes in any user-facing string.** `renderToStaticMarkup` escapes `'` to `&#x27;` and component tests asserting a literal apostrophe fail. Write "does not" not "doesn't".
- Protocol changes are contract changes: the runtime type guard and its `.test.ts` change in the **same commit** as the type.
- All commits DCO-signed: `git commit -s`. End the body with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Base image and CI runtime are **Node 22** — the version CI already tests. Do not upgrade the runtime in this slice.
- Baseline entering this slice: protocol 49 tests / backend 168 / extension 252; `pnpm typecheck`, `pnpm test`, `pnpm build` all clean on `feat/backend-distribution`.

## Verified facts (probed 2026-08-15 — do not re-litigate)

These were confirmed empirically before this plan was written:

1. `node apps/backend/dist/dev.js` on the **current** `exports` fails with `ERR_MODULE_NOT_FOUND` for `packages/protocol/src/events.js`. The compiled backend has never been runnable.
2. With `exports` resolving to `./dist/index.js`, the compiled backend starts and `/healthz` returns `{"ok":true}`.
3. All 168 backend + 252 extension tests pass when protocol resolves through `dist/`.
4. Node's resolver honors a custom `echoflow-source` condition (verified with `node --conditions=echoflow-source`).
5. `tsc --noEmit` passes with `packages/protocol/dist/` deleted.

---

### Task 1: Protocol dual entry point

Makes the compiled backend runnable. Everything else in this plan is dead code in a container until this lands, so it goes first.

**Files:**
- Modify: `packages/protocol/package.json`
- Modify: `tsconfig.base.json`
- Modify: `apps/extension/wxt.config.ts`
- Create: `packages/protocol/vitest.config.ts`
- Create: `apps/backend/vitest.config.ts`
- Create: `apps/extension/vitest.config.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the `echoflow-source` export condition. Every later task depends on `pnpm build` emitting a runnable artifact, but no later task imports anything new from this one.

- [ ] **Step 1: Prove the current artifact is broken**

```bash
pnpm build
node apps/backend/dist/dev.js
```

Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../packages/protocol/src/events.js'`. This is the bug you are fixing; see it fail first.

- [ ] **Step 2: Add the dual export entry**

In `packages/protocol/package.json`, replace the `exports` block. Leave `source`, `main`, `types`, and `files` exactly as they are — legacy resolvers still read them.

```json
  "exports": {
    ".": {
      "echoflow-source": "./src/index.ts",
      "types": "./src/index.ts",
      "default": "./dist/index.js"
    }
  },
```

Order matters: Node picks the first matching condition, so `echoflow-source` must precede `default`. `types` stays on source so `tsc` never needs a built `dist/`.

- [ ] **Step 3: Point TypeScript at the source condition**

In `tsconfig.base.json`, add `customConditions` inside `compilerOptions` (the repo already uses `"moduleResolution": "Bundler"`, which supports it):

```json
    "customConditions": ["echoflow-source"],
```

- [ ] **Step 4: Point Vitest at the source condition**

Create three identical config files so tests read TypeScript source and never depend on build ordering. `ssr.resolve.conditions` is included because Vitest resolves Node-environment imports through the SSR pipeline; setting only the top-level `resolve.conditions` is not reliably enough.

`packages/protocol/vitest.config.ts`, `apps/backend/vitest.config.ts`, and `apps/extension/vitest.config.ts` each get:

```ts
import { defineConfig } from "vitest/config";

// Keep tests on @echoflow/protocol TypeScript source: the package's default
// export condition resolves to compiled dist/ so plain Node can run the built
// backend, and tests must not depend on that build having happened.
export default defineConfig({
  resolve: { conditions: ["echoflow-source"] },
  ssr: { resolve: { conditions: ["echoflow-source"] } },
});
```

- [ ] **Step 5: Point WXT at the source condition**

In `apps/extension/wxt.config.ts`, add a `vite` entry to the `defineConfig` object, as a sibling of `manifestVersion`:

```ts
  vite: () => ({
    resolve: { conditions: ["echoflow-source"] },
  }),
```

- [ ] **Step 6: Verify no consumer depends on a built protocol**

```bash
rm -rf packages/protocol/dist
pnpm typecheck
pnpm test
```

Expected: both pass with `dist/` absent. This is the clean-checkout case CI hits, where `test` runs before `build`.

**If `pnpm test` fails here** with an unresolved `@echoflow/protocol`, the custom condition is not reaching Vitest. Apply the spec's documented fallback instead of improvising: revert Steps 4–5, and in `.github/workflows/ci.yml` move `pnpm build` ahead of `pnpm test` so `dist/` always exists. Note the swap in the commit body.

- [ ] **Step 7: Verify the built artifact now runs**

```bash
pnpm build
node apps/backend/dist/dev.js &
sleep 3
curl -s http://127.0.0.1:8787/healthz
kill %1
```

Expected: `{"ok":true}`.

- [ ] **Step 8: Commit**

```bash
git add packages/protocol/package.json tsconfig.base.json apps/extension/wxt.config.ts \
        packages/protocol/vitest.config.ts apps/backend/vitest.config.ts apps/extension/vitest.config.ts
git commit -s -m "fix(protocol): dual export entry so the compiled backend runs

The exports map pointed at src/index.ts, whose .js specifiers only exist
under dist/, so plain Node could never load the built backend. A custom
echoflow-source condition keeps bundlers and tests on source while default
resolves to compiled output.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Configurable bind host and a shared server bootstrap

**Files:**
- Modify: `apps/backend/src/config.ts`
- Modify: `apps/backend/src/config.test.ts`
- Create: `apps/backend/src/startServer.ts`
- Create: `apps/backend/src/main.ts`
- Modify: `apps/backend/src/dev.ts`

**Interfaces:**
- Consumes: `createConfig`, `createServer` (existing).
- Produces:
  - `BackendConfig.host: string` — defaults to `"127.0.0.1"`, read from `ECHOFLOW_HOST`.
  - `startServer(input?: BackendConfigInput): Promise<FastifyInstance>` in `src/startServer.ts` — creates config, creates the server, listens on `config.host`, logs the listen line, registers SIGINT/SIGTERM shutdown, returns the instance.
  - `src/main.ts` — the production entry point the container runs (`dist/main.js`). Task 9's CI smoke step starts it too.

- [ ] **Step 1: Write the failing tests**

Append to `apps/backend/src/config.test.ts`, matching the env-var save/restore style already used in that file:

```ts
describe("host", () => {
  it("defaults to loopback", () => {
    delete process.env.ECHOFLOW_HOST;
    expect(createConfig().host).toBe("127.0.0.1");
  });

  it("reads ECHOFLOW_HOST", () => {
    process.env.ECHOFLOW_HOST = "0.0.0.0";
    expect(createConfig().host).toBe("0.0.0.0");
  });

  it("ignores a blank ECHOFLOW_HOST", () => {
    process.env.ECHOFLOW_HOST = "   ";
    expect(createConfig().host).toBe("127.0.0.1");
  });

  it("prefers an explicit input over the environment", () => {
    process.env.ECHOFLOW_HOST = "0.0.0.0";
    expect(createConfig({ host: "127.0.0.1" }).host).toBe("127.0.0.1");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @echoflow/backend test config`
Expected: FAIL — `host` is `undefined`.

- [ ] **Step 3: Add the host field**

In `apps/backend/src/config.ts`, add to `BackendConfig` directly under `port`:

```ts
  /** Listen address. Loopback by default; containers set ECHOFLOW_HOST=0.0.0.0. */
  host: string;
```

Add the constant beside `DEFAULT_PORT`:

```ts
const DEFAULT_HOST = "127.0.0.1";
```

And inside the object returned by `createConfig`, directly after the `port` entry:

```ts
    host: input.host ?? readNonEmpty(process.env.ECHOFLOW_HOST) ?? DEFAULT_HOST,
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `pnpm --filter @echoflow/backend test config`
Expected: PASS.

- [ ] **Step 5: Extract the shared bootstrap**

Create `apps/backend/src/startServer.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { createConfig, type BackendConfigInput } from "./config.js";
import { createServer } from "./server.js";

/**
 * Shared bootstrap for both entry points (dev.ts loads a repo-root .env first;
 * main.ts does not). Keeping listen + shutdown here means the graceful-shutdown
 * block exists once rather than being copy-pasted into a second entry point.
 */
export async function startServer(
  input: BackendConfigInput = {},
): Promise<FastifyInstance> {
  const config = createConfig(input);
  const server = createServer(config);

  await server.listen({ port: config.port, host: config.host });
  console.log(`EchoFlow backend listening on http://${config.host}:${config.port}`);

  // process.once so a second signal falls through to Node's default handler
  // and kills a hung shutdown.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      console.log(`Received ${signal}, shutting down...`);
      void server.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }

  return server;
}
```

- [ ] **Step 6: Reduce dev.ts to its one distinct job**

Replace the body of `apps/backend/src/dev.ts` below the imports so it keeps only the repo-root `.env` convenience and delegates the rest. The file becomes:

```ts
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./startServer.js";

// Dev convenience: the backend has no dotenv, and provider credentials live in
// the repo-root .env (gitignored). Load it before reading config so a plain
// `pnpm --filter @echoflow/backend dev` picks up Volcengine keys. No-op when the
// file is absent (CI / production), and shell-provided env vars still win.
const repoRootEnv = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
if (existsSync(repoRootEnv)) {
  process.loadEnvFile(repoRootEnv);
  console.log(`Loaded environment from ${repoRootEnv}`);
}

await startServer();
```

- [ ] **Step 7: Add the production entry point**

Create `apps/backend/src/main.ts` — the second caller of `startServer`, and the one the container runs:

```ts
import { startServer } from "./startServer.js";

// Production entry point. Unlike dev.ts it does not load a repo-root .env —
// containers receive their environment from --env-file or -e.
await startServer();
```

- [ ] **Step 8: Verify dev still works**

```bash
pnpm --filter @echoflow/backend dev &
sleep 3
curl -s http://127.0.0.1:8787/healthz
kill %1
```

Expected: `{"ok":true}` and a `listening on http://127.0.0.1:8787` line.

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/config.ts apps/backend/src/config.test.ts \
        apps/backend/src/startServer.ts apps/backend/src/main.ts apps/backend/src/dev.ts
git commit -s -m "feat(backend): configurable bind host and shared bootstrap

ECHOFLOW_HOST defaults to loopback so the no-external-interfaces property
is given up only by an explicit act; containers set 0.0.0.0. startServer
holds listen + graceful shutdown for both entry points.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Boot self-check and fail-fast

**Files:**
- Create: `apps/backend/src/configHealth.ts`
- Create: `apps/backend/src/configHealth.test.ts`
- Modify: `apps/backend/src/startServer.ts`

**Interfaces:**
- Consumes: `BackendConfig` from `./config.js`; `isInterpretAvailable` from `./providers/providerConfig.js`.
- Produces, from `./configHealth.js`:
  - `type CapabilityHealth = { name: "asr" | "translation" | "interpret"; provider: string; ready: boolean; demo: boolean; missing: readonly string[] }`
  - `describeConfigHealth(config: BackendConfig): readonly CapabilityHealth[]`
  - `formatConfigHealth(health: readonly CapabilityHealth[]): string`
  - `assertConfigUsable(health: readonly CapabilityHealth[]): void` — throws on a selected-but-uncredentialed provider.

Task 5 reuses `describeConfigHealth` so the terminal and `/v1/capabilities` can never disagree.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/configHealth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createConfig } from "./config.js";
import {
  assertConfigUsable,
  describeConfigHealth,
  formatConfigHealth,
} from "./configHealth.js";

const fakeConfig = () =>
  createConfig({
    providers: { asr: { provider: "fake" }, translation: { provider: "fake" } },
  });

const volcAsrNoCreds = () =>
  createConfig({
    providers: { asr: { provider: "volcengine" }, translation: { provider: "fake" } },
  });

const volcAsrWithCreds = () =>
  createConfig({
    providers: {
      asr: {
        provider: "volcengine",
        volcengine: {
          appKey: "app",
          accessKey: "secret",
          resourceId: "res",
          endpoint: "wss://example.test",
        },
      },
      translation: { provider: "fake" },
    },
  });

describe("describeConfigHealth", () => {
  it("marks fake providers ready and demo", () => {
    const asr = describeConfigHealth(fakeConfig()).find((c) => c.name === "asr");
    expect(asr).toMatchObject({ provider: "fake", ready: true, demo: true, missing: [] });
  });

  it("marks a selected provider without credentials not ready", () => {
    const asr = describeConfigHealth(volcAsrNoCreds()).find((c) => c.name === "asr");
    expect(asr?.ready).toBe(false);
    expect(asr?.demo).toBe(false);
    expect(asr?.missing).toEqual([
      "VOLCENGINE_ASR_APP_KEY",
      "VOLCENGINE_ASR_ACCESS_KEY",
    ]);
  });

  it("marks a credentialed provider ready and not demo", () => {
    const asr = describeConfigHealth(volcAsrWithCreds()).find((c) => c.name === "asr");
    expect(asr).toMatchObject({ ready: true, demo: false, missing: [] });
  });

  it("reports interpret as not ready without an AST key", () => {
    const interpret = describeConfigHealth(fakeConfig()).find(
      (c) => c.name === "interpret",
    );
    expect(interpret?.ready).toBe(false);
    expect(interpret?.missing).toEqual(["VOLCENGINE_AST_API_KEY"]);
  });
});

describe("assertConfigUsable", () => {
  it("accepts the all-fake demo configuration", () => {
    expect(() => assertConfigUsable(describeConfigHealth(fakeConfig()))).not.toThrow();
  });

  it("accepts a backend with no interpret credentials", () => {
    expect(() =>
      assertConfigUsable(describeConfigHealth(volcAsrWithCreds())),
    ).not.toThrow();
  });

  it("throws naming the missing variables", () => {
    expect(() => assertConfigUsable(describeConfigHealth(volcAsrNoCreds()))).toThrow(
      /VOLCENGINE_ASR_APP_KEY/,
    );
  });
});

describe("formatConfigHealth", () => {
  it("names the demo mode in plain text", () => {
    expect(formatConfigHealth(describeConfigHealth(fakeConfig()))).toContain("demo");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @echoflow/backend test configHealth`
Expected: FAIL — cannot resolve `./configHealth.js`.

- [ ] **Step 3: Implement**

Create `apps/backend/src/configHealth.ts`:

```ts
import type { BackendConfig } from "./config.js";
import { isInterpretAvailable } from "./providers/providerConfig.js";

export type CapabilityHealth = {
  name: "asr" | "translation" | "interpret";
  provider: string;
  /** Usable as configured. A fake provider is ready — it is a valid demo, not an error. */
  ready: boolean;
  /** Served by a deterministic fake rather than a real provider. */
  demo: boolean;
  /**
   * Environment variables that would make this capability real. The config layer
   * drops the whole credential object when any part is missing, so this names
   * every variable of the set rather than the one that is actually absent.
   */
  missing: readonly string[];
};

const ASR_CREDENTIAL_VARS = [
  "VOLCENGINE_ASR_APP_KEY",
  "VOLCENGINE_ASR_ACCESS_KEY",
] as const;
const TRANSLATION_CREDENTIAL_VARS = ["VOLCENGINE_API_KEY"] as const;
const INTERPRET_CREDENTIAL_VARS = ["VOLCENGINE_AST_API_KEY"] as const;

export function describeConfigHealth(
  config: BackendConfig,
): readonly CapabilityHealth[] {
  const { asr, translation } = config.providers;

  return [
    {
      name: "asr",
      provider: asr.provider,
      ready: asr.provider === "fake" || asr.volcengine !== undefined,
      demo: asr.provider === "fake",
      missing:
        asr.provider === "volcengine" && asr.volcengine === undefined
          ? [...ASR_CREDENTIAL_VARS]
          : [],
    },
    {
      name: "translation",
      provider: translation.provider,
      ready: translation.provider === "fake" || translation.volcengine !== undefined,
      demo: translation.provider === "fake",
      missing:
        translation.provider === "volcengine" && translation.volcengine === undefined
          ? [...TRANSLATION_CREDENTIAL_VARS]
          : [],
    },
    {
      name: "interpret",
      provider: "volcengine",
      ready: isInterpretAvailable(config.providers),
      demo: false,
      missing: isInterpretAvailable(config.providers)
        ? []
        : [...INTERPRET_CREDENTIAL_VARS],
    },
  ];
}

export function formatConfigHealth(health: readonly CapabilityHealth[]): string {
  const lines = health.map((capability) => {
    if (capability.demo) {
      return `  ${capability.name}: ${capability.provider} (demo — deterministic placeholder output)`;
    }
    if (capability.ready) {
      return `  ${capability.name}: ${capability.provider} (configured)`;
    }
    return `  ${capability.name}: unavailable — set ${capability.missing.join(", ")}`;
  });
  return ["EchoFlow configuration:", ...lines].join("\n");
}

/**
 * Throws when a provider was explicitly selected but its credentials are absent.
 * providerFactory already throws for this case, but only when a session opens —
 * this moves the same failure to boot, where the cause is.
 *
 * `interpret` is never fatal: it is opt-in, and a backend without AST credentials
 * is a valid pipeline-only deployment.
 */
export function assertConfigUsable(health: readonly CapabilityHealth[]): void {
  const broken = health.filter(
    (capability) => capability.name !== "interpret" && !capability.ready,
  );
  if (broken.length === 0) {
    return;
  }
  const detail = broken
    .map((capability) => `${capability.name} requires ${capability.missing.join(" and ")}`)
    .join("; ");
  throw new Error(`Backend configuration is incomplete: ${detail}`);
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `pnpm --filter @echoflow/backend test configHealth`
Expected: PASS.

- [ ] **Step 5: Wire it into the bootstrap**

In `apps/backend/src/startServer.ts`, add the import:

```ts
import { assertConfigUsable, describeConfigHealth, formatConfigHealth } from "./configHealth.js";
```

And inside `startServer`, between `const config = createConfig(input);` and `const server = createServer(config);`:

```ts
  const health = describeConfigHealth(config);
  console.log(formatConfigHealth(health));
  assertConfigUsable(health);
```

Ordering is deliberate: print the report first so a failing boot still tells the operator the full picture, not just the first broken capability.

- [ ] **Step 6: Verify fail-fast end to end**

```bash
ECHOFLOW_ASR_PROVIDER=volcengine pnpm --filter @echoflow/backend dev; echo "exit=$?"
```

Expected: the configuration report prints, then `Backend configuration is incomplete: asr requires VOLCENGINE_ASR_APP_KEY and VOLCENGINE_ASR_ACCESS_KEY`, and a non-zero exit.

Note: if the repo-root `.env` has real ASR credentials, this command will start normally instead. Temporarily rename `.env` to see the failure, and rename it back.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/configHealth.ts apps/backend/src/configHealth.test.ts apps/backend/src/startServer.ts
git commit -s -m "feat(backend): boot self-check and fail-fast on misconfiguration

A selected provider with absent credentials used to boot happily, pass
/healthz, and fail only when a session opened. Boot now prints a per-
capability report and exits non-zero on a real misconfiguration.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Protocol — demo and blocker fields

**Files:**
- Modify: `packages/protocol/src/capabilities.ts`
- Modify: `packages/protocol/src/capabilities.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, from `@echoflow/protocol`:
  - `CAPABILITY_BLOCKER_CODES` — a readonly tuple of the five codes below.
  - `type CapabilityBlockerCode` — the union of those codes.
  - `ModeCapabilities.demo?: boolean` and `ModeCapabilities.blockers?: readonly string[]`.

Note the asymmetry, and keep it: the **type** is a union for authoring discipline, the **wire validation** accepts any `string[]`. An unrecognized code from a newer backend must cost one missing hint, never a failed descriptor.

- [ ] **Step 1: Write the failing tests**

Append to `packages/protocol/src/capabilities.test.ts` (reuse the file's existing `valid` fixture):

```ts
describe("isCapabilitiesDescriptor demo and blockers", () => {
  const withPipeline = (extra: Record<string, unknown>) => ({
    ...valid,
    modes: { ...valid.modes, pipeline: { ...valid.modes.pipeline, ...extra } },
  });

  it("accepts a descriptor without the new fields", () => {
    expect(isCapabilitiesDescriptor(valid)).toBe(true);
  });

  it("accepts a boolean demo flag", () => {
    expect(isCapabilitiesDescriptor(withPipeline({ demo: true }))).toBe(true);
  });

  it("rejects a non-boolean demo flag", () => {
    expect(isCapabilitiesDescriptor(withPipeline({ demo: "yes" }))).toBe(false);
  });

  it("accepts known blocker codes", () => {
    expect(
      isCapabilitiesDescriptor(withPipeline({ blockers: ["asr_credentials_missing"] })),
    ).toBe(true);
  });

  it("accepts an unknown blocker code from a newer backend", () => {
    expect(isCapabilitiesDescriptor(withPipeline({ blockers: ["quantum_flux"] }))).toBe(
      true,
    );
  });

  it("rejects blockers that are not an array of strings", () => {
    expect(isCapabilitiesDescriptor(withPipeline({ blockers: "nope" }))).toBe(false);
    expect(isCapabilitiesDescriptor(withPipeline({ blockers: [1] }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @echoflow/protocol test capabilities`
Expected: FAIL — the non-boolean `demo` and non-array `blockers` cases pass validation today because the guard ignores unknown keys.

- [ ] **Step 3: Implement**

In `packages/protocol/src/capabilities.ts`, add above `ModeCapabilities`:

```ts
/**
 * Why a mode is not fully usable. The backend emits codes; all wording lives in
 * the extension, so the backend never acquires opinions about UI copy.
 */
export const CAPABILITY_BLOCKER_CODES = [
  "asr_credentials_missing",
  "translation_credentials_missing",
  "interpret_credentials_missing",
  "asr_provider_unimplemented",
  "translation_provider_unimplemented",
] as const;

export type CapabilityBlockerCode = (typeof CAPABILITY_BLOCKER_CODES)[number];
```

Extend `ModeCapabilities`:

```ts
export type ModeCapabilities = {
  available: boolean;
  autoDetect: boolean;
  languages: LanguageOption[];
  defaultPair?: { source: string; target: string };
  /** Served by deterministic fakes. `available` stays true — the demo is a feature. */
  demo?: boolean;
  /**
   * Reason codes. Typed as string[] on the wire on purpose: an unknown code from
   * a newer backend must not fail validation of the whole descriptor.
   */
  blockers?: readonly string[];
};
```

And in `isModeCapabilities`, add before the `return`:

```ts
  const demoValid = v.demo === undefined || typeof v.demo === "boolean";
  const blockersValid =
    v.blockers === undefined ||
    (Array.isArray(v.blockers) && v.blockers.every((code) => typeof code === "string"));
```

then add `demoValid && blockersValid &&` into the returned conjunction.

- [ ] **Step 4: Run to verify the tests pass**

Run: `pnpm --filter @echoflow/protocol test capabilities`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/capabilities.ts packages/protocol/src/capabilities.test.ts
git commit -s -m "feat(protocol): demo and blocker fields on ModeCapabilities

Additive and optional, following the sync.available precedent. Blockers
validate as string[] rather than a whitelist so an unknown code from a
newer backend costs one hint line, not a failed descriptor.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Backend emits demo and blockers

**Files:**
- Modify: `apps/backend/src/realtime/capabilities.ts`
- Modify: `apps/backend/src/realtime/capabilities.test.ts` (create if absent)
- Modify: `apps/backend/src/server.ts`

**Interfaces:**
- Consumes: `describeConfigHealth` (Task 3), `CapabilityBlockerCode` (Task 4).
- Produces: `buildCapabilities(config, options)` gains a third input — it now takes the full `BackendConfig` rather than just `ProviderConfig`, because it needs the same health predicates the boot report uses.

**Design note for the implementer:** `pipeline.demo` is true when **either** leg is fake. A real transcript with fake translation is still not real output, and claiming otherwise is the exact dishonesty this slice removes. `pipeline.available` stays `true` regardless.

- [ ] **Step 1: Write the failing test**

Create or extend `apps/backend/src/realtime/capabilities.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createConfig } from "../config.js";
import { buildCapabilities } from "./capabilities.js";

const build = (input: Parameters<typeof createConfig>[0]) =>
  buildCapabilities(createConfig(input), { syncAvailable: false });

describe("buildCapabilities demo and blockers", () => {
  it("keeps pipeline available but flags demo when both legs are fake", () => {
    const caps = build({
      providers: { asr: { provider: "fake" }, translation: { provider: "fake" } },
    });
    expect(caps.modes.pipeline.available).toBe(true);
    expect(caps.modes.pipeline.demo).toBe(true);
  });

  it("flags demo when only the translation leg is fake", () => {
    const caps = build({
      providers: {
        asr: {
          provider: "volcengine",
          volcengine: {
            appKey: "a",
            accessKey: "b",
            resourceId: "r",
            endpoint: "wss://example.test",
          },
        },
        translation: { provider: "fake" },
      },
    });
    expect(caps.modes.pipeline.demo).toBe(true);
  });

  it("reports missing ASR credentials as a blocker", () => {
    const caps = build({
      providers: { asr: { provider: "volcengine" }, translation: { provider: "fake" } },
    });
    expect(caps.modes.pipeline.blockers).toContain("asr_credentials_missing");
  });

  it("reports a reserved provider name as unimplemented", () => {
    const caps = build({
      providers: { asr: { provider: "aliyun" }, translation: { provider: "fake" } },
    });
    expect(caps.modes.pipeline.blockers).toContain("asr_provider_unimplemented");
  });

  it("blocks interpret without AST credentials", () => {
    const caps = build({
      providers: { asr: { provider: "fake" }, translation: { provider: "fake" } },
    });
    expect(caps.modes.interpret.available).toBe(false);
    expect(caps.modes.interpret.demo).toBe(false);
    expect(caps.modes.interpret.blockers).toContain("interpret_credentials_missing");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @echoflow/backend test realtime/capabilities`
Expected: FAIL — `buildCapabilities` does not accept a `BackendConfig` and emits no `demo`/`blockers`.

- [ ] **Step 3: Implement**

In `apps/backend/src/realtime/capabilities.ts`, replace the imports and `buildCapabilities` signature/body. Keep `PIPELINE_TARGET_LANGUAGES` exactly as it is.

```ts
import type { CapabilitiesDescriptor, CapabilityBlockerCode, LanguageOption } from "@echoflow/protocol";
import type { BackendConfig } from "../config.js";
import { describeConfigHealth } from "../configHealth.js";
import { isInterpretAvailable } from "../providers/providerConfig.js";
import { AST_LANGUAGES } from "../providers/astLanguages.js";

const UNIMPLEMENTED_PROVIDERS = new Set(["aliyun", "tencent"]);

export function buildCapabilities(
  config: BackendConfig,
  options: { syncAvailable: boolean },
): CapabilitiesDescriptor {
  const health = describeConfigHealth(config);
  const asr = health.find((c) => c.name === "asr");
  const translation = health.find((c) => c.name === "translation");

  const pipelineBlockers: CapabilityBlockerCode[] = [];
  if (asr !== undefined && !asr.ready) {
    pipelineBlockers.push(
      UNIMPLEMENTED_PROVIDERS.has(asr.provider)
        ? "asr_provider_unimplemented"
        : "asr_credentials_missing",
    );
  }
  if (translation !== undefined && !translation.ready) {
    pipelineBlockers.push(
      UNIMPLEMENTED_PROVIDERS.has(translation.provider)
        ? "translation_provider_unimplemented"
        : "translation_credentials_missing",
    );
  }

  const interpretAvailable = isInterpretAvailable(config.providers);

  return {
    modes: {
      pipeline: {
        available: true,
        autoDetect: true,
        languages: PIPELINE_TARGET_LANGUAGES,
        defaultPair: { source: "auto", target: "en" },
        // Either fake leg means the output is not real, so say so.
        demo: (asr?.demo ?? false) || (translation?.demo ?? false),
        blockers: pipelineBlockers,
      },
      interpret: {
        available: interpretAvailable,
        autoDetect: false,
        languages: interpretAvailable ? AST_LANGUAGES : [],
        defaultPair: { source: "en", target: "zh" },
        demo: false,
        blockers: interpretAvailable ? [] : ["interpret_credentials_missing"],
      },
    },
    sync: { available: options.syncAvailable },
  };
}
```

A reserved provider name (`aliyun`/`tencent`) never reaches `ready: true` in Task 3's health, because neither `provider === "fake"` nor a populated `volcengine` object holds — so it lands in the blocker branch, and the `UNIMPLEMENTED_PROVIDERS` check picks the accurate code.

- [ ] **Step 4: Update the one call site**

In `apps/backend/src/server.ts`, the `/v1/capabilities` handler currently passes `config.providers`. Change it to pass the whole config:

```ts
    return buildCapabilities(config, {
      syncAvailable: historyRepository !== undefined,
    });
```

- [ ] **Step 5: Run the full backend suite**

Run: `pnpm --filter @echoflow/backend test`
Expected: PASS, including the existing `server.test.ts` capabilities assertions.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/realtime/capabilities.ts apps/backend/src/realtime/capabilities.test.ts apps/backend/src/server.ts
git commit -s -m "feat(backend): capabilities report demo mode and blockers

buildCapabilities now derives from the same health predicates as the boot
report, so the terminal and /v1/capabilities cannot disagree. A fake leg
is reported as demo rather than silently as a working pipeline.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Extension — blocker copy and demo-aware summary

**Files:**
- Create: `apps/extension/src/onboarding/describeBlocker.ts`
- Create: `apps/extension/src/onboarding/describeBlocker.test.ts`
- Modify: `apps/extension/src/onboarding/connectionSummary.ts`
- Modify: `apps/extension/src/onboarding/connectionSummary.test.ts`

**Interfaces:**
- Consumes: `CapabilitiesDescriptor` (Task 4).
- Produces:
  - `describeBlocker(code: string): string` from `src/onboarding/describeBlocker`.
  - `ConnectionSummary` gains `demo: boolean` and `blockers: readonly string[]` (already-described sentences, ready to render).

**Copy constraint:** no apostrophes anywhere in these strings.

- [ ] **Step 1: Write the failing tests**

Create `apps/extension/src/onboarding/describeBlocker.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { describeBlocker } from "./describeBlocker";

describe("describeBlocker", () => {
  it("describes missing ASR credentials", () => {
    expect(describeBlocker("asr_credentials_missing")).toContain("VOLCENGINE_ASR_APP_KEY");
  });

  it("describes an unimplemented provider", () => {
    expect(describeBlocker("asr_provider_unimplemented")).toContain("not implemented");
  });

  it("falls back for an unknown code", () => {
    expect(describeBlocker("quantum_flux")).toContain("quantum_flux");
  });

  it("never uses an apostrophe", () => {
    for (const code of [
      "asr_credentials_missing",
      "translation_credentials_missing",
      "interpret_credentials_missing",
      "asr_provider_unimplemented",
      "translation_provider_unimplemented",
      "unknown_code",
    ]) {
      expect(describeBlocker(code)).not.toContain("'");
    }
  });
});
```

Append to `apps/extension/src/onboarding/connectionSummary.test.ts`:

```ts
describe("summarizeCapabilities demo", () => {
  const caps = (pipeline: Record<string, unknown>, interpretAvailable = false) =>
    ({
      modes: {
        pipeline: {
          available: true,
          autoDetect: true,
          languages: [{ code: "en", label: "English", pivot: true }],
          ...pipeline,
        },
        interpret: {
          available: interpretAvailable,
          autoDetect: false,
          languages: [],
        },
      },
    }) as never;

  it("reports demo mode without claiming the pipeline is unavailable", () => {
    const summary = summarizeCapabilities(caps({ demo: true }));
    expect(summary.demo).toBe(true);
    expect(summary.tone).toBe("partial");
  });

  it("is not demo when the backend is fully configured", () => {
    expect(summarizeCapabilities(caps({ demo: false }, true)).demo).toBe(false);
  });

  it("surfaces described blockers", () => {
    const summary = summarizeCapabilities(
      caps({ demo: true, blockers: ["asr_credentials_missing"] }),
    );
    expect(summary.blockers[0]).toContain("VOLCENGINE_ASR_APP_KEY");
  });

  it("has no blockers when none are reported", () => {
    expect(summarizeCapabilities(caps({ demo: false }, true)).blockers).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @echoflow/extension test onboarding`
Expected: FAIL — `describeBlocker` does not exist and `ConnectionSummary` has no `demo`.

- [ ] **Step 3: Implement describeBlocker**

Create `apps/extension/src/onboarding/describeBlocker.ts`:

```ts
// All blocker wording lives here: the backend emits codes only. Copy must avoid
// apostrophes — renderToStaticMarkup escapes them and component tests break.
const BLOCKER_COPY: Record<string, string> = {
  asr_credentials_missing:
    "Speech recognition is not configured. Set VOLCENGINE_ASR_APP_KEY and VOLCENGINE_ASR_ACCESS_KEY in the backend environment.",
  translation_credentials_missing:
    "Translation is not configured. Set VOLCENGINE_API_KEY in the backend environment.",
  interpret_credentials_missing:
    "Interpret mode is not configured. Set VOLCENGINE_AST_API_KEY in the backend environment.",
  asr_provider_unimplemented:
    "The selected speech recognition provider is not implemented yet. Use fake or volcengine.",
  translation_provider_unimplemented:
    "The selected translation provider is not implemented yet. Use fake or volcengine.",
};

export function describeBlocker(code: string): string {
  return (
    BLOCKER_COPY[code] ??
    `The backend reported a limitation this version does not recognize: ${code}`
  );
}
```

- [ ] **Step 4: Extend the summary**

In `apps/extension/src/onboarding/connectionSummary.ts`, add the import:

```ts
import { describeBlocker } from "./describeBlocker";
```

Extend the interface:

```ts
export interface ConnectionSummary {
  tone: ConnectionTone;
  detail: string;
  languageCount: number;
  /** Backend is serving deterministic placeholder output. */
  demo: boolean;
  /** Already-described sentences, ready to render. */
  blockers: readonly string[];
}
```

Inside `summarizeCapabilities`, compute the two new values above the existing branches:

```ts
  const demo = caps.modes.pipeline.demo === true;
  const blockers = [
    ...(caps.modes.pipeline.blockers ?? []),
    ...(caps.modes.interpret.blockers ?? []),
  ].map(describeBlocker);
```

Then add `demo,` and `blockers,` to **each** of the four returned objects. In the `pipeline && interpret` branch, when `demo` is true the detail must not claim full capability — replace that branch's `detail` with:

```ts
      detail: demo
        ? `Demo mode — deterministic sample subtitles · ${languageCount} languages`
        : `Free + Interpret available · ${languageCount} languages`,
```

and in the `pipeline`-only branch:

```ts
      detail: demo
        ? "Demo mode — deterministic sample subtitles. Add backend credentials for real subtitles."
        : "Free mode available · Interpret needs backend AST credentials",
```

Leave `tone` untouched in every branch: demo stays `partial`, so the Connect gate (`tone !== "none"`) still lets demo users advance.

- [ ] **Step 5: Run to verify the tests pass**

Run: `pnpm --filter @echoflow/extension test onboarding`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/extension/src/onboarding/describeBlocker.ts \
        apps/extension/src/onboarding/describeBlocker.test.ts \
        apps/extension/src/onboarding/connectionSummary.ts \
        apps/extension/src/onboarding/connectionSummary.test.ts
git commit -s -m "feat(extension): demo-aware connection summary and blocker copy

Backend blocker codes become actionable sentences here; the backend never
carries UI copy. Demo stays tone partial so the Connect gate still admits
a zero-credential first run.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Onboarding renders the diagnosis

**Files:**
- Modify: `apps/extension/src/onboarding/OnboardingApp.tsx`
- Modify: `apps/extension/src/onboarding/OnboardingApp.test.tsx`

**Interfaces:**
- Consumes: `ConnectionSummary` with `demo` and `blockers` (Task 6).
- Produces: no new exports. The `ConnectStep` component renders a demo badge and the blocker list.

**Breaking change to expect:** `OnboardingApp.test.tsx` constructs a `connectSummary` object literal in its existing "connect (ok)" test (`{ tone: "full", detail: ..., languageCount: 20 }`). Task 6 made `demo` and `blockers` required, so that literal no longer typechecks. Step 3 fixes it — this is expected, not a regression.

- [ ] **Step 1: Write the failing tests**

`OnboardingApp.test.tsx` already provides `render(view: Partial<OnboardingView>)` and a `base` view. Use them; do not add a new helper. Append:

```tsx
it("connect (demo): shows the demo badge and the blocker hint", () => {
  const html = render({
    step: "connect",
    connectState: "ok",
    canContinue: true,
    connectSummary: {
      tone: "partial",
      detail: "Demo mode — deterministic sample subtitles",
      languageCount: 8,
      demo: true,
      blockers: ["Speech recognition is not configured. Set VOLCENGINE_ASR_APP_KEY"]
    }
  });
  expect(html).toContain("Demo mode");
  expect(html).toContain("VOLCENGINE_ASR_APP_KEY");
});

it("connect (configured): shows no demo badge and no blocker list", () => {
  const html = render({
    step: "connect",
    connectState: "ok",
    canContinue: true,
    connectSummary: {
      tone: "full",
      detail: "Free + Interpret available · 20 languages",
      languageCount: 20,
      demo: false,
      blockers: []
    }
  });
  expect(html).not.toContain("Demo mode");
  expect(html).not.toContain("ef-onboarding-blockers");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @echoflow/extension test OnboardingApp`
Expected: FAIL — the badge and list are not rendered, and the pre-existing "connect (ok)" test fails to typecheck on the now-required fields.

- [ ] **Step 3: Repair the pre-existing fixture**

In the existing `connect (ok)` test, extend the literal with the two new fields so it compiles again:

```tsx
      connectSummary: { tone: "full", detail: "Free + Interpret available · 20 languages", languageCount: 20, demo: false, blockers: [] }
```

- [ ] **Step 4: Render the diagnosis**

In `apps/extension/src/onboarding/OnboardingApp.tsx`, the connect-state block lives in `ConnectStep` around line 154. Insert the badge and list **inside** the existing `connectState === "ok"` branch, after the `<div><b>Connected.</b> ...</div>` line and still inside that `<div className="ef-test ef-test-ok">`:

```tsx
      {view.connectState === "ok" && view.connectSummary ? (
        <div className="ef-test ef-test-ok" role="status">
          <span className="ef-test-ic">✓</span>
          <div>
            <b>Connected.</b> {view.connectSummary.detail}
            {view.connectSummary.demo ? (
              <p className="ef-onboarding-demo-badge">
                Demo mode — the backend is serving deterministic sample subtitles.
              </p>
            ) : null}
            {view.connectSummary.blockers.length > 0 ? (
              <ul className="ef-onboarding-blockers">
                {view.connectSummary.blockers.map((hint) => (
                  <li key={hint}>{hint}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : view.connectState === "error" ? (
```

- [ ] **Step 5: Update the now-stale error copy**

The `connectState === "error"` branch tells the user to start the backend with `pnpm --filter @echoflow/backend dev`. After Task 8 that is no longer the recommended path. Replace that sentence with the Docker command, keeping the existing `Setup guide →` button untouched:

```tsx
            <b>Can not reach the backend.</b> Is it running? Start it with <code>docker run --rm -p 127.0.0.1:8787:8787 --env-file .env ghcr.io/ymlyza/echoflow-backend</code>, then retry.{" "}
```

Note the existing test asserts only `toContain("reach the backend")`, so it keeps passing.

- [ ] **Step 6: Add the styles**

Next to the existing onboarding styles, add rules for `.ef-onboarding-demo-badge` and `.ef-onboarding-blockers`, using the same design tokens the neighbouring `.ef-test` rules use. The badge should read as advisory rather than as an error, and the list should be compact.

- [ ] **Step 7: Run the full extension suite**

Run: `pnpm --filter @echoflow/extension test`
Expected: PASS — the 252 baseline tests plus the new ones.

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`
Expected: clean. This catches any `ConnectionSummary` literal elsewhere that Task 6 broke.

- [ ] **Step 9: Commit**

```bash
git add apps/extension/src/onboarding/OnboardingApp.tsx \
        apps/extension/src/onboarding/OnboardingApp.test.tsx
git commit -s -m "feat(extension): connect step renders demo badge and blocker hints

The diagnosis now lands on the screen the user is looking at during first
run, instead of only in the backend terminal. The unreachable-backend copy
points at docker run rather than a workspace build.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Container image

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `apps/backend/tsconfig.build.json`
- Modify: `apps/backend/package.json`
- Modify: `README.md`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `apps/backend/src/main.ts` (Task 2).
- Produces: an image whose default command is `node dist/main.js`, listening on `0.0.0.0:8787`.

- [ ] **Step 1: Keep tests out of the shipped build**

Create `apps/backend/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["src/**/*.test.ts"]
}
```

In `apps/backend/package.json`, change the build script:

```json
    "build": "tsc -p tsconfig.build.json",
```

Verify: `rm -rf apps/backend/dist && pnpm --filter @echoflow/backend build && ls apps/backend/dist` shows no `*.test.js`, and `apps/backend/dist/main.js` exists.

- [ ] **Step 2: Add .dockerignore**

Create `.dockerignore`:

```
node_modules
**/node_modules
**/dist
**/.output
.git
.env
*.log
docs
```

- [ ] **Step 3: Write the Dockerfile**

Create `Dockerfile` at the repo root:

```dockerfile
# syntax=docker/dockerfile:1

# Node 22 matches what CI tests. node:sqlite loads unflagged on 22 (it prints an
# ExperimentalWarning), so the optional history-sync store needs no extra flags.
FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /app

# Manifests first so dependency installation caches independently of source.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/backend/package.json apps/backend/
RUN pnpm install --frozen-lockfile --filter @echoflow/backend...

COPY packages/protocol packages/protocol
COPY apps/backend apps/backend
RUN pnpm --filter @echoflow/protocol build \
 && pnpm --filter @echoflow/backend build \
 && pnpm --filter @echoflow/backend --prod deploy /out

FROM node:22-alpine AS runtime
WORKDIR /app
COPY --from=builder /out /app

ENV NODE_ENV=production \
    ECHOFLOW_HOST=0.0.0.0 \
    ECHOFLOW_PORT=8787

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
```

`pnpm deploy` resolves the workspace `@echoflow/protocol` dependency into a real directory under `/out/node_modules`, carrying its `dist/` (the package `files` field already lists `dist` and `src`). That is what lets the runtime stage be a plain copy.

**If `pnpm deploy` fails** (it is the one step here that varies across pnpm configurations), the documented fallback is to skip it and copy the built workspace wholesale into the runtime stage — `COPY --from=builder /app /app` with `CMD ["node", "apps/backend/dist/main.js"]`. Larger image, same behavior. Note the substitution in the commit body.

- [ ] **Step 4: Build and run the image**

```bash
docker build -t echoflow-backend:dev .
docker run --rm -d --name echoflow-probe -p 127.0.0.1:8787:8787 echoflow-backend:dev
sleep 4
curl -s http://127.0.0.1:8787/healthz
docker logs echoflow-probe
docker rm -f echoflow-probe
```

Expected: `{"ok":true}`, and the logs show the configuration report plus `listening on http://0.0.0.0:8787`.

- [ ] **Step 5: Verify fail-fast inside the container**

```bash
docker run --rm -e ECHOFLOW_ASR_PROVIDER=volcengine echoflow-backend:dev; echo "exit=$?"
```

Expected: the report prints, the incomplete-configuration error follows, and the exit code is non-zero — the container dies loudly instead of serving a backend that cannot work.

- [ ] **Step 6: Rewrite the README install path**

Restructure `README.md` so Docker leads. Replace the current `## Setup` section with a Docker quickstart, and move the pnpm instructions under `## Development` (which already exists). The quickstart:

````markdown
## Quick start (Docker)

```bash
curl -O https://raw.githubusercontent.com/YmlyZA/echoflow/main/.env.example
mv .env.example .env    # edit it to add provider credentials, or leave the fake defaults
docker run --rm -p 127.0.0.1:8787:8787 --env-file .env ghcr.io/ymlyza/echoflow-backend:latest
```

Then install the extension (see below) and open its onboarding wizard.

Publish the port to `127.0.0.1` explicitly, as above. A bare `-p 8787:8787` binds
every interface and exposes your backend and its API key to the local network.

With the `fake` defaults the backend needs no credentials and produces
deterministic sample subtitles — enough to confirm the whole path works. The
onboarding wizard shows a demo badge until real credentials are configured.
````

Keep the existing `### Provider Configuration` section intact and cross-reference it from the quickstart.

- [ ] **Step 7: Align .env.example**

Ensure `.env.example` contains every variable the container reads, each commented, including `ECHOFLOW_HOST` (documented as container-only) and `ECHOFLOW_HISTORY_DB` (documented as opt-in for sync).

- [ ] **Step 8: Commit**

```bash
git add Dockerfile .dockerignore apps/backend/src/main.ts apps/backend/tsconfig.build.json \
        apps/backend/package.json README.md .env.example
git commit -s -m "feat(backend): container image and Docker-first install path

Multi-stage build on node:22-alpine, non-root, healthchecked, listening on
0.0.0.0 inside the container while the host binding stays loopback by
default. README now leads with docker run instead of a workspace build.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: CI gate and image publishing

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `docs/RELEASING.md`

**Interfaces:**
- Consumes: the `Dockerfile` (Task 8) and the runnable artifact (Task 1).
- Produces: `ghcr.io/ymlyza/echoflow-backend` tagged with the release version and, for non-prereleases, `latest`.

- [ ] **Step 1: Gate on the artifact actually running**

In `.github/workflows/ci.yml`, add after the existing `pnpm build` step:

```yaml
      # A passing tsc is not evidence that the output runs: the compiled backend
      # was unrunnable for the project's whole life because nothing ever started it.
      - name: Smoke the built backend
        run: |
          node apps/backend/dist/main.js &
          SERVER_PID=$!
          for _ in $(seq 1 20); do
            if curl -sf http://127.0.0.1:8787/healthz; then
              kill $SERVER_PID
              exit 0
            fi
            sleep 0.5
          done
          echo "backend did not become healthy"
          kill $SERVER_PID || true
          exit 1
```

- [ ] **Step 2: Verify the gate catches the original bug**

```bash
git stash push packages/protocol/package.json
pnpm build && node apps/backend/dist/main.js
git stash pop
```

Expected: with Task 1 reverted, the start fails with `ERR_MODULE_NOT_FOUND` — confirming the new CI step would have caught it. Restore before continuing.

- [ ] **Step 3: Publish the image from the release tag**

In `.github/workflows/release.yml`, add outputs to the existing `release` job so the image job reuses the same derived version — one tag, one version truth:

```yaml
    outputs:
      versionName: ${{ steps.ver.outputs.versionName }}
      prerelease: ${{ steps.ver.outputs.prerelease }}
```

Then add a second job:

```yaml
  image:
    needs: release
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: |
            ghcr.io/${{ github.repository_owner }}/echoflow-backend:${{ needs.release.outputs.versionName }}
            ${{ needs.release.outputs.prerelease == 'false' && format('ghcr.io/{0}/echoflow-backend:latest', github.repository_owner) || '' }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

A prerelease tag publishes only the version tag, never `latest`.

- [ ] **Step 4: Validate the workflow files parse**

Run: `python3 -c "import yaml,sys; [yaml.safe_load(open(f)) for f in ['.github/workflows/ci.yml','.github/workflows/release.yml']]; print('yaml ok')"`
Expected: `yaml ok`.

- [ ] **Step 5: Document the second artifact**

In `docs/RELEASING.md`, update the release description: a `vX.Y.Z` tag now produces **two** artifacts — the extension zip on the GitHub Release and the multi-arch backend image on ghcr.io — and note that the ghcr package must be made public once, manually, after the first publish, or `docker run` will prompt for credentials.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml docs/RELEASING.md
git commit -s -m "ci: smoke the built backend and publish a multi-arch image

CI now starts the compiled artifact and curls /healthz — the gap that let
an unrunnable dist/ stay green. Release tags additionally push
ghcr.io/<owner>/echoflow-backend for linux/amd64 and linux/arm64.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Whole-branch verification

**Files:** none (verification only, plus a backlog entry).

- [ ] **Step 1: Full clean verification**

```bash
rm -rf packages/protocol/dist apps/backend/dist
pnpm typecheck && pnpm test && pnpm build
```

Expected: all green, in that order, from a state with no build output — the clean-checkout case CI runs.

- [ ] **Step 2: End-to-end through the container**

Run the image with real credentials in an env file, load the built extension in Chrome, and walk the onboarding wizard. Confirm: with `fake` providers the Connect step shows the demo badge and still advances; with real credentials the badge disappears; with a deliberately misspelled `VOLCENGINE_ASR_APP_KEY` the container exits non-zero and names the variable.

- [ ] **Step 3: Record the slice in the backlog**

Add an entry to `docs/superpowers/backlog.md` under a new "Distribution" heading marking this slice shipped, and note the two follow-ups this slice deliberately left: Chrome Web Store submission, and the second real provider.

- [ ] **Step 4: Commit and open the PR**

```bash
git add docs/superpowers/backlog.md
git commit -s -m "docs: record the backend distribution slice in the backlog

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/backend-distribution
gh pr create --fill
```

Note: `gh` may default to the wrong account — verify it is operating as `YmlyZA` before pushing.
