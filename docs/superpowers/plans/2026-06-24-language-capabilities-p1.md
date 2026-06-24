# Language Capabilities (P1 — plumbing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-driven language-capabilities contract and thread an explicit `sourceLanguage` end-to-end, replacing interpret's derived-counterpart source — all behind the existing UI (no picker yet; that's P2).

**Architecture:** A new `CapabilitiesDescriptor` contract + `validTarget` pivot rule live in `@echoflow/protocol` (shared by backend and extension). The backend exposes `GET /v1/capabilities` and validates the `{source,target}` pair when opening an interpret session. The extension stores an explicit `sourceLanguage` (migrated as the EN↔ZH counterpart of the target) and sends it in the `start` message. The options UI does **not** consume capabilities yet.

**Tech Stack:** pnpm monorepo, TypeScript ESM, Fastify + `@fastify/websocket` (backend), WXT + React 19 (extension), Vitest. Protocol source is consumed directly (no build).

## Global Constraints

- **Protocol changes are contract changes:** every edit to `packages/protocol` updates the runtime type guard *and* its `.test.ts` in the same task. Verbatim from spec §4.2 / project CLAUDE.md.
- **AST source codes are explicit; auto-detect is unsupported** (model:default has no empty-source pair). Verbatim from spec §6 / the AST wire reference.
- **Pivot rule:** a `{source,target}` pair is valid iff `source ≠ target`, `target` is not source-only, and `source` or `target` is a pivot language (`zh`/`en`). Verbatim from spec §4.2.
- **No secrets in the extension; provider language knowledge lives on the backend.** Spec §1.
- **Run from repo root:** `pnpm --filter @echoflow/<pkg> test <pattern>`, `pnpm typecheck`. Tests are colocated `*.test.ts`.
- **P1 scope:** ship the 20 ISO-coded AST languages. The two source-only **dialects** (粤语/上海话) are deferred to P2 pending wire-code verification; the contract already supports them via `sourceOnly`.

---

## File Structure

**`packages/protocol/src/`**
- Create `capabilities.ts` — `LanguageOption`, `ModeCapabilities`, `CapabilitiesDescriptor`, `validTarget()`, `isCapabilitiesDescriptor()`.
- Create `capabilities.test.ts`.
- Modify `session.ts` — add `sourceLanguage?: string` to `SessionHandshakeRequest`; extend `isStartSessionMessage`.
- Modify `session.test.ts`.
- Modify `index.ts` — re-export `./capabilities.js`.

**`apps/backend/src/`**
- Modify `providers/astLanguages.ts` — `AST_LANGUAGES` table, generalize `toAstLanguageCode`, add `isSupportedAstPair`; (orphaned `isSupportedInterpretTarget`/`counterpartAstLanguage`/`INTERPRET_SUPPORTED_TARGETS` removed in Tasks 6–7).
- Modify `providers/astLanguages.test.ts`.
- Create `realtime/capabilities.ts` — `buildCapabilities(config)`, `PIPELINE_TARGET_LANGUAGES`.
- Create `realtime/capabilities.test.ts`.
- Modify `server.ts` — register `GET /v1/capabilities` (x-api-key auth).
- Modify `server.test.ts`.
- Modify `realtime/interpretationSubtitleSource.ts` — constructor takes `sourceLanguage`; stop deriving counterpart; emit real source.
- Modify `realtime/interpretationSubtitleSource.test.ts`.
- Modify `realtime/subtitleSource.ts` — `SubtitleSourceFactory` gains `sourceLanguage`; `ModeLanguageUnsupportedError(source,target)`.
- Modify `realtime/subtitleSourceFactory.ts` — validate the pair via `isSupportedAstPair`.
- Modify `realtime/subtitleSourceFactory.test.ts`.
- Modify `realtime/session.ts` — store + thread `sourceLanguage`.
- Modify `realtime/session.test.ts`.

**`apps/extension/src/`**
- Modify `settings/settings.ts` — `ExtensionSettings.sourceLanguage`; migrate default = counterpart of target.
- Modify `settings/settings.test.ts`.
- Modify `realtime/realtimeClient.ts` — `RealtimeClientOptions.sourceLanguage`; include in `createStartMessage`.
- Modify `realtime/realtimeClient.test.ts`.
- Modify `entrypoints/offscreen/main.ts` — pass `settings.sourceLanguage` to `RealtimeClient`.

---

## Task 1: Protocol — capabilities contract

**Files:**
- Create: `packages/protocol/src/capabilities.ts`
- Test: `packages/protocol/src/capabilities.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**
- Produces: `type LanguageOption = { code: string; label: string; pivot: boolean; sourceOnly?: boolean }`; `type ModeCapabilities = { available: boolean; autoDetect: boolean; languages: LanguageOption[]; defaultPair?: { source: string; target: string } }`; `type CapabilitiesDescriptor = { modes: { pipeline: ModeCapabilities; interpret: ModeCapabilities } }`; `validTarget(source: LanguageOption, target: LanguageOption): boolean`; `isCapabilitiesDescriptor(value: unknown): value is CapabilitiesDescriptor`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/protocol/src/capabilities.test.ts
import { describe, expect, it } from "vitest";
import {
  isCapabilitiesDescriptor,
  validTarget,
  type CapabilitiesDescriptor,
  type LanguageOption,
} from "./capabilities.js";

const zh: LanguageOption = { code: "zh", label: "中文", pivot: true };
const en: LanguageOption = { code: "en", label: "English", pivot: true };
const ja: LanguageOption = { code: "ja", label: "日本語", pivot: false };
const ko: LanguageOption = { code: "ko", label: "한국어", pivot: false };
const yue: LanguageOption = { code: "yue", label: "粤语", pivot: false, sourceOnly: true };

describe("validTarget", () => {
  it("allows a foreign source only against a pivot target", () => {
    expect(validTarget(ja, zh)).toBe(true);
    expect(validTarget(ja, en)).toBe(true);
    expect(validTarget(ja, ko)).toBe(false); // neither side pivot
  });
  it("allows a pivot source against any other language", () => {
    expect(validTarget(zh, ja)).toBe(true);
    expect(validTarget(en, ja)).toBe(true);
  });
  it("rejects same-language and source-only targets", () => {
    expect(validTarget(zh, zh)).toBe(false);
    expect(validTarget(en, yue)).toBe(false); // yue is source-only
  });
});

describe("isCapabilitiesDescriptor", () => {
  const valid: CapabilitiesDescriptor = {
    modes: {
      pipeline: { available: true, autoDetect: true, languages: [en] },
      interpret: {
        available: true,
        autoDetect: false,
        languages: [zh, en, ja],
        defaultPair: { source: "en", target: "zh" },
      },
    },
  };
  it("accepts a well-formed descriptor", () => {
    expect(isCapabilitiesDescriptor(valid)).toBe(true);
  });
  it("rejects malformed input", () => {
    expect(isCapabilitiesDescriptor(null)).toBe(false);
    expect(isCapabilitiesDescriptor({ modes: {} })).toBe(false);
    expect(isCapabilitiesDescriptor({ modes: { pipeline: {}, interpret: {} } })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/protocol test capabilities`
Expected: FAIL — cannot find module `./capabilities.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/protocol/src/capabilities.ts
export type LanguageOption = {
  code: string;
  label: string;
  pivot: boolean;
  sourceOnly?: boolean;
};

export type ModeCapabilities = {
  available: boolean;
  autoDetect: boolean;
  languages: LanguageOption[];
  defaultPair?: { source: string; target: string };
};

export type CapabilitiesDescriptor = {
  modes: { pipeline: ModeCapabilities; interpret: ModeCapabilities };
};

/** A {source,target} pair is valid iff distinct, target is selectable, and one side is a pivot (zh/en). */
export function validTarget(source: LanguageOption, target: LanguageOption): boolean {
  return (
    source.code !== target.code &&
    target.sourceOnly !== true &&
    (source.pivot || target.pivot)
  );
}

function isLanguageOption(value: unknown): value is LanguageOption {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.code === "string" &&
    typeof v.label === "string" &&
    typeof v.pivot === "boolean" &&
    (v.sourceOnly === undefined || typeof v.sourceOnly === "boolean")
  );
}

function isModeCapabilities(value: unknown): value is ModeCapabilities {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.available === "boolean" &&
    typeof v.autoDetect === "boolean" &&
    Array.isArray(v.languages) &&
    v.languages.every(isLanguageOption)
  );
}

export function isCapabilitiesDescriptor(value: unknown): value is CapabilitiesDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.modes !== "object" || v.modes === null) return false;
  const modes = v.modes as Record<string, unknown>;
  return isModeCapabilities(modes.pipeline) && isModeCapabilities(modes.interpret);
}
```

- [ ] **Step 4: Re-export from the package index**

In `packages/protocol/src/index.ts`, add alongside the existing exports:

```ts
export * from "./capabilities.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/protocol test capabilities`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/capabilities.ts packages/protocol/src/capabilities.test.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): add language CapabilitiesDescriptor + validTarget rule"
```

---

## Task 2: Protocol — `sourceLanguage` on the start handshake

**Files:**
- Modify: `packages/protocol/src/session.ts`
- Test: `packages/protocol/src/session.test.ts`

**Interfaces:**
- Consumes: existing `SessionHandshakeRequest`, `isStartSessionMessage`.
- Produces: `SessionHandshakeRequest.sourceLanguage?: string`; `isStartSessionMessage` accepts an optional string `sourceLanguage`.

- [ ] **Step 1: Write the failing test**

Add to `packages/protocol/src/session.test.ts`:

```ts
it("accepts a start message carrying sourceLanguage", () => {
  expect(
    isStartSessionMessage({ type: "start", sourceLanguage: "en", targetLanguage: "zh" }),
  ).toBe(true);
});

it("rejects a non-string sourceLanguage", () => {
  expect(isStartSessionMessage({ type: "start", sourceLanguage: 7 })).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/protocol test session`
Expected: FAIL — `sourceLanguage: 7` currently passes (field ignored), so the second test fails.

- [ ] **Step 3: Add the field to the type**

In `packages/protocol/src/session.ts`, in `SessionHandshakeRequest` (after `targetLanguage: string;`):

```ts
  sourceLanguage?: string;
```

- [ ] **Step 4: Extend the guard**

In `isStartSessionMessage`, add a clause to the returned `&&` chain (next to `isOptionalString(value, "targetLanguage")`):

```ts
    isOptionalString(value, "sourceLanguage") &&
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/protocol test session`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/session.ts packages/protocol/src/session.test.ts
git commit -m "feat(protocol): add optional sourceLanguage to start handshake"
```

---

## Task 3: Backend — AST language table + pair validation

**Files:**
- Modify: `apps/backend/src/providers/astLanguages.ts`
- Test: `apps/backend/src/providers/astLanguages.test.ts`

**Interfaces:**
- Consumes: `validTarget`, `LanguageOption` from `@echoflow/protocol`.
- Produces: `AST_LANGUAGES: LanguageOption[]` (20 ISO languages, `zh`/`en` pivot); `toAstLanguageCode(code: string): string` (maps `zh-CN`/`zh-TW`→`zh`, else identity); `isSupportedAstPair(sourceAst: string, targetAst: string): boolean`. (Existing `INTERPRET_SUPPORTED_TARGETS`, `isSupportedInterpretTarget`, `counterpartAstLanguage` are retained for now and removed in Tasks 6–7.)

- [ ] **Step 1: Write the failing test**

Replace the body of `apps/backend/src/providers/astLanguages.test.ts` with (keep any unrelated existing tests if present):

```ts
import { describe, expect, it } from "vitest";
import { AST_LANGUAGES, isSupportedAstPair, toAstLanguageCode } from "./astLanguages.js";

describe("AST_LANGUAGES", () => {
  it("lists 20 languages with zh/en as the only pivots", () => {
    expect(AST_LANGUAGES).toHaveLength(20);
    const pivots = AST_LANGUAGES.filter((l) => l.pivot).map((l) => l.code).sort();
    expect(pivots).toEqual(["en", "zh"]);
  });
});

describe("toAstLanguageCode", () => {
  it("maps Chinese UI codes to zh and passes others through", () => {
    expect(toAstLanguageCode("zh-CN")).toBe("zh");
    expect(toAstLanguageCode("zh-TW")).toBe("zh");
    expect(toAstLanguageCode("en")).toBe("en");
    expect(toAstLanguageCode("ja")).toBe("ja");
  });
});

describe("isSupportedAstPair", () => {
  it("enforces the pivot rule over AST codes", () => {
    expect(isSupportedAstPair("en", "zh")).toBe(true);
    expect(isSupportedAstPair("ja", "zh")).toBe(true);
    expect(isSupportedAstPair("ja", "ko")).toBe(false);
    expect(isSupportedAstPair("zh", "zh")).toBe(false);
    expect(isSupportedAstPair("xx", "zh")).toBe(false); // unknown code
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/backend test astLanguages`
Expected: FAIL — `AST_LANGUAGES`/`isSupportedAstPair` not exported.

- [ ] **Step 3: Add the table and helpers**

In `apps/backend/src/providers/astLanguages.ts`, add at the top (keep the existing `INTERPRET_SUPPORTED_TARGETS`, `isSupportedInterpretTarget`, `counterpartAstLanguage`, and the existing `toAstLanguageCode` — you will REPLACE `toAstLanguageCode` below):

```ts
import { validTarget, type LanguageOption } from "@echoflow/protocol";

// AST S2T supported languages (20). zh/en are the pivot anchors.
// Dialects (粤语/上海话, source-only) are deferred to P2 pending wire-code verification.
export const AST_LANGUAGES: LanguageOption[] = [
  { code: "zh", label: "中文", pivot: true },
  { code: "en", label: "English", pivot: true },
  { code: "ja", label: "日本語", pivot: false },
  { code: "ko", label: "한국어", pivot: false },
  { code: "es", label: "Español", pivot: false },
  { code: "pt", label: "Português", pivot: false },
  { code: "de", label: "Deutsch", pivot: false },
  { code: "fr", label: "Français", pivot: false },
  { code: "ru", label: "Русский", pivot: false },
  { code: "it", label: "Italiano", pivot: false },
  { code: "ar", label: "العربية", pivot: false },
  { code: "tr", label: "Türkçe", pivot: false },
  { code: "id", label: "Bahasa Indonesia", pivot: false },
  { code: "ms", label: "Bahasa Melayu", pivot: false },
  { code: "vi", label: "Tiếng Việt", pivot: false },
  { code: "th", label: "ไทย", pivot: false },
  { code: "nl", label: "Nederlands", pivot: false },
  { code: "ro", label: "Română", pivot: false },
  { code: "pl", label: "Polski", pivot: false },
  { code: "cs", label: "Čeština", pivot: false },
];

const AST_BY_CODE = new Map(AST_LANGUAGES.map((l) => [l.code, l]));

export function isSupportedAstPair(sourceAst: string, targetAst: string): boolean {
  const s = AST_BY_CODE.get(sourceAst);
  const t = AST_BY_CODE.get(targetAst);
  return s !== undefined && t !== undefined && validTarget(s, t);
}
```

- [ ] **Step 4: Generalize `toAstLanguageCode`**

Replace the existing `toAstLanguageCode` body so non-Chinese codes pass through unchanged (previously it returned `"en"` for anything non-zh):

```ts
export function toAstLanguageCode(code: string): string {
  if (code === "zh-CN" || code === "zh-TW") {
    return "zh";
  }
  return code;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/backend test astLanguages`
Expected: PASS. Then `pnpm --filter @echoflow/backend typecheck` — Expected: clean (old helpers still present and used).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/providers/astLanguages.ts apps/backend/src/providers/astLanguages.test.ts
git commit -m "feat(backend): add AST language table + pivot pair validation"
```

---

## Task 4: Backend — capabilities builder

**Files:**
- Create: `apps/backend/src/realtime/capabilities.ts`
- Test: `apps/backend/src/realtime/capabilities.test.ts`

**Interfaces:**
- Consumes: `AST_LANGUAGES` (Task 3); `isInterpretAvailable`, `ProviderConfig`, `DEFAULT_PROVIDER_CONFIG` from `providerConfig.js`; `CapabilitiesDescriptor`, `LanguageOption` from `@echoflow/protocol`.
- Produces: `PIPELINE_TARGET_LANGUAGES: LanguageOption[]`; `buildCapabilities(config: ProviderConfig): CapabilitiesDescriptor`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backend/src/realtime/capabilities.test.ts
import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_CONFIG } from "../providers/providerConfig.js";
import { buildCapabilities } from "./capabilities.js";

const WITH_AST = {
  ...DEFAULT_PROVIDER_CONFIG,
  interpret: { apiKey: "k", resourceId: "r", endpoint: "wss://x" },
};

describe("buildCapabilities", () => {
  it("marks interpret available and lists the AST languages when configured", () => {
    const caps = buildCapabilities(WITH_AST);
    expect(caps.modes.interpret.available).toBe(true);
    expect(caps.modes.interpret.autoDetect).toBe(false);
    expect(caps.modes.interpret.languages.length).toBe(20);
    expect(caps.modes.interpret.defaultPair).toEqual({ source: "en", target: "zh" });
  });

  it("marks interpret unavailable with no languages when AST is not configured", () => {
    const caps = buildCapabilities(DEFAULT_PROVIDER_CONFIG);
    expect(caps.modes.interpret.available).toBe(false);
    expect(caps.modes.interpret.languages).toEqual([]);
  });

  it("always offers pipeline with auto-detect source and target options", () => {
    const caps = buildCapabilities(DEFAULT_PROVIDER_CONFIG);
    expect(caps.modes.pipeline.available).toBe(true);
    expect(caps.modes.pipeline.autoDetect).toBe(true);
    expect(caps.modes.pipeline.languages.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/backend test capabilities`
Expected: FAIL — cannot find module `./capabilities.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/backend/src/realtime/capabilities.ts
import type { CapabilitiesDescriptor, LanguageOption } from "@echoflow/protocol";
import { isInterpretAvailable, type ProviderConfig } from "../providers/providerConfig.js";
import { AST_LANGUAGES } from "../providers/astLanguages.js";

// Pipeline targets are the translation provider's supported output languages.
// (Source is auto-detected by ASR, so no source list is needed.)
export const PIPELINE_TARGET_LANGUAGES: LanguageOption[] = [
  { code: "en", label: "English", pivot: false },
  { code: "zh-CN", label: "Chinese (Simplified)", pivot: false },
  { code: "zh-TW", label: "Chinese (Traditional)", pivot: false },
  { code: "ja", label: "日本語", pivot: false },
  { code: "ko", label: "한국어", pivot: false },
  { code: "es", label: "Español", pivot: false },
  { code: "fr", label: "Français", pivot: false },
  { code: "de", label: "Deutsch", pivot: false },
];

export function buildCapabilities(config: ProviderConfig): CapabilitiesDescriptor {
  const interpretAvailable = isInterpretAvailable(config);
  return {
    modes: {
      pipeline: {
        available: true,
        autoDetect: true,
        languages: PIPELINE_TARGET_LANGUAGES,
        defaultPair: { source: "auto", target: "en" },
      },
      interpret: {
        available: interpretAvailable,
        autoDetect: false,
        languages: interpretAvailable ? AST_LANGUAGES : [],
        defaultPair: { source: "en", target: "zh" },
      },
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/backend test capabilities`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/realtime/capabilities.ts apps/backend/src/realtime/capabilities.test.ts
git commit -m "feat(backend): build language CapabilitiesDescriptor from provider config"
```

---

## Task 5: Backend — `GET /v1/capabilities` route

**Files:**
- Modify: `apps/backend/src/server.ts`
- Test: `apps/backend/src/server.test.ts`

**Interfaces:**
- Consumes: `buildCapabilities` (Task 4); the existing `config` (with `config.apiKey` and `config.providers`) available in `createServer`.
- Produces: `GET /v1/capabilities` → `200` `CapabilitiesDescriptor` when `x-api-key` matches; `401 { error: "Unauthorized" }` otherwise.

> Config shape (confirmed): `createConfig()` returns `{ apiKey, port, providers }` — the WS-route auth already reads `config.apiKey`, and `config.test.ts` asserts `config.providers.interpret`. So pass `config.providers` (a `ProviderConfig`) to `buildCapabilities`.

- [ ] **Step 1: Write the failing test**

Add to `apps/backend/src/server.test.ts` (follow the file's existing pattern for building a server + injecting requests):

```ts
it("serves capabilities to an authorized GET /v1/capabilities", async () => {
  const server = createServer(testConfig); // testConfig: same factory the other tests use
  const res = await server.inject({
    method: "GET",
    url: "/v1/capabilities",
    headers: { "x-api-key": testConfig.apiKey },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.modes.pipeline.available).toBe(true);
  expect(typeof body.modes.interpret.available).toBe("boolean");
  await server.close();
});

it("rejects /v1/capabilities without a valid key", async () => {
  const server = createServer(testConfig);
  const res = await server.inject({ method: "GET", url: "/v1/capabilities" });
  expect(res.statusCode).toBe(401);
  await server.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/backend test server`
Expected: FAIL — route returns 404.

- [ ] **Step 3: Register the route**

In `apps/backend/src/server.ts`, import the builder near the top:

```ts
import { buildCapabilities } from "./realtime/capabilities.js";
```

Then register the route where the other routes (`/healthz`, the WS route) are registered:

```ts
server.get("/v1/capabilities", async (request, reply) => {
  if (request.headers["x-api-key"] !== config.apiKey) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
  return buildCapabilities(config.providers);
});
```

(Match the exact config property names used by the existing WS-route auth and provider construction — e.g. `config.apiKey`, `config.providers`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/backend test server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/server.ts apps/backend/src/server.test.ts
git commit -m "feat(backend): expose GET /v1/capabilities (x-api-key auth)"
```

---

## Task 6: Backend — InterpretationSubtitleSource takes an explicit source

**Files:**
- Modify: `apps/backend/src/realtime/interpretationSubtitleSource.ts`
- Modify: `apps/backend/src/providers/astLanguages.ts` (delete orphaned `counterpartAstLanguage`)
- Test: `apps/backend/src/realtime/interpretationSubtitleSource.test.ts`

**Interfaces:**
- Consumes: `toAstLanguageCode` (Task 3).
- Produces: `new InterpretationSubtitleSource(config, sourceLanguage, targetLanguage, connect?)` — sends `toAstLanguageCode(sourceLanguage)` as the AST source and emits it in the `language` event.

- [ ] **Step 1: Update the test**

In `apps/backend/src/realtime/interpretationSubtitleSource.test.ts`, update every `new InterpretationSubtitleSource(CONFIG, "zh-CN", t.factory)` to pass an explicit source: `new InterpretationSubtitleSource(CONFIG, "en", "zh-CN", t.factory)`. Update the language-event assertion to:

```ts
expect(events).toContainEqual({
  type: "language",
  sourceLanguage: "en",
  targetLanguage: "zh-CN",
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/backend test interpretationSubtitleSource`
Expected: FAIL — constructor arity / wrong source emitted.

- [ ] **Step 3: Update the constructor + remove derivation**

In `apps/backend/src/realtime/interpretationSubtitleSource.ts`:
- Change the import to drop `counterpartAstLanguage`: `import { toAstLanguageCode } from "../providers/astLanguages.js";`
- Add `sourceLanguage` to the constructor before `targetLanguage`:

```ts
  constructor(
    private readonly config: AstSourceConfig,
    private readonly sourceLanguage: string,
    private readonly targetLanguage: string,
    private readonly connect: AstTransportFactory = connectAstTransport,
  ) {}
```

- Replace the `sourceAst`/`targetAst` derivation lines with:

```ts
    const targetAst = toAstLanguageCode(targetLanguage);
    const sourceAst = toAstLanguageCode(this.sourceLanguage);
```

(Keep the rest: `encodeStartSession({ ..., sourceLanguage: sourceAst, targetLanguage: targetAst, ... })` and the `language` event emitting `sourceLanguage: sourceAst` already wired in this file. Verify the `language` event uses `sourceAst`.)

- [ ] **Step 4: Delete the orphaned helper**

`counterpartAstLanguage` now has no callers. In `apps/backend/src/providers/astLanguages.ts`, delete the `counterpartAstLanguage` export and any test referencing it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/backend test interpretationSubtitleSource astLanguages`
Expected: PASS. Then `pnpm --filter @echoflow/backend typecheck` — note it will FAIL on `subtitleSourceFactory.ts` (still calls the 2-arg constructor); that is fixed in Task 7. Proceed.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/realtime/interpretationSubtitleSource.ts apps/backend/src/realtime/interpretationSubtitleSource.test.ts apps/backend/src/providers/astLanguages.ts
git commit -m "feat(backend): interpret source is explicit, not derived"
```

---

## Task 7: Backend — factory pair-validation + session threading

**Files:**
- Modify: `apps/backend/src/realtime/subtitleSource.ts`
- Modify: `apps/backend/src/realtime/subtitleSourceFactory.ts`
- Modify: `apps/backend/src/providers/astLanguages.ts` (delete orphaned `isSupportedInterpretTarget` + `INTERPRET_SUPPORTED_TARGETS`)
- Modify: `apps/backend/src/realtime/session.ts`
- Test: `apps/backend/src/realtime/subtitleSourceFactory.test.ts`, `apps/backend/src/realtime/session.test.ts`

**Interfaces:**
- Produces: `SubtitleSourceFactory = (mode, sourceLanguage, targetLanguage) => SubtitleSource`; `ModeLanguageUnsupportedError(sourceLanguage, targetLanguage)`; `RealtimeSession` threads `message.sourceLanguage` into the factory.

- [ ] **Step 1: Update the factory + session tests**

In `apps/backend/src/realtime/subtitleSourceFactory.test.ts`:
- Update pipeline call: `factory("pipeline", "auto", "zh-CN")`.
- Update interpret-success call: `factory("interpret", "en", "zh-CN")` (still `toBeInstanceOf(InterpretationSubtitleSource)`).
- Update the unsupported-target test to an unsupported PAIR: `expect(() => factory("interpret", "ja", "ko")).toThrow(ModeLanguageUnsupportedError)` (ja→ko violates the pivot rule).
- Keep the `ModeUnavailableError` test, updating its call to `factory("interpret", "en", "zh-CN")`.

In `apps/backend/src/realtime/session.test.ts`: update any `createSubtitleSource` stub/spy signature to `(mode, sourceLanguage, targetLanguage)` and assert the session passes `message.sourceLanguage` through (add a `start` message with `sourceLanguage: "en"` and assert the factory received `"en"`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @echoflow/backend test subtitleSourceFactory session`
Expected: FAIL — arity mismatch / pair not validated.

- [ ] **Step 3: Widen the factory type + error**

In `apps/backend/src/realtime/subtitleSource.ts`:

```ts
export type SubtitleSourceFactory = (
  mode: SubtitleMode,
  sourceLanguage: string,
  targetLanguage: string,
) => SubtitleSource;
```

```ts
export class ModeLanguageUnsupportedError extends Error {
  constructor(
    public readonly sourceLanguage: string,
    public readonly targetLanguage: string,
  ) {
    super(`Language pair "${sourceLanguage}" → "${targetLanguage}" is not supported in this mode`);
    this.name = "ModeLanguageUnsupportedError";
  }
}
```

- [ ] **Step 4: Validate the pair in the factory**

Rewrite `apps/backend/src/realtime/subtitleSourceFactory.ts`:

```ts
import {
  createSpeechProvider,
  createTranslationProvider,
} from "../providers/providerFactory.js";
import {
  isInterpretAvailable,
  type ProviderConfig,
} from "../providers/providerConfig.js";
import { isSupportedAstPair, toAstLanguageCode } from "../providers/astLanguages.js";
import { PipelineSubtitleSource } from "./pipelineSubtitleSource.js";
import { InterpretationSubtitleSource } from "./interpretationSubtitleSource.js";
import {
  ModeLanguageUnsupportedError,
  ModeUnavailableError,
  type SubtitleSourceFactory,
} from "./subtitleSource.js";

export function createSubtitleSourceFactory(
  config: ProviderConfig,
): SubtitleSourceFactory {
  return (mode, sourceLanguage, targetLanguage) => {
    if (mode === "pipeline") {
      return new PipelineSubtitleSource(
        createSpeechProvider(config.asr),
        createTranslationProvider(config.translation),
        targetLanguage,
      );
    }
    // interpret
    if (!isInterpretAvailable(config) || config.interpret === undefined) {
      throw new ModeUnavailableError(mode);
    }
    if (!isSupportedAstPair(toAstLanguageCode(sourceLanguage), toAstLanguageCode(targetLanguage))) {
      throw new ModeLanguageUnsupportedError(sourceLanguage, targetLanguage);
    }
    return new InterpretationSubtitleSource(config.interpret, sourceLanguage, targetLanguage);
  };
}
```

- [ ] **Step 5: Delete the orphaned helpers**

In `apps/backend/src/providers/astLanguages.ts`, delete `INTERPRET_SUPPORTED_TARGETS` and `isSupportedInterpretTarget` (no remaining callers) and any test lines referencing them.

- [ ] **Step 6: Thread sourceLanguage through the session**

In `apps/backend/src/realtime/session.ts`:
- Add a field `private sourceLanguage = "";` next to `targetLanguage`.
- In `handleClientMessage` `case "start"`, before `openSource(...)`:

```ts
        this.targetLanguage = message.targetLanguage ?? this.targetLanguage;
        this.sourceLanguage = message.sourceLanguage ?? this.sourceLanguage;
        this.openSource(message.mode ?? "pipeline");
```

- Change `openSource` to pass the source:

```ts
      source = this.options.createSubtitleSource(mode, this.sourceLanguage, this.targetLanguage);
```

- [ ] **Step 7: Run tests + typecheck to verify green**

Run: `pnpm --filter @echoflow/backend test` then `pnpm --filter @echoflow/backend typecheck`
Expected: PASS, clean.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/realtime/subtitleSource.ts apps/backend/src/realtime/subtitleSourceFactory.ts apps/backend/src/realtime/subtitleSourceFactory.test.ts apps/backend/src/realtime/session.ts apps/backend/src/realtime/session.test.ts apps/backend/src/providers/astLanguages.ts
git commit -m "feat(backend): validate interpret language pair + thread explicit source"
```

---

## Task 8: Extension — settings `sourceLanguage` + migration

**Files:**
- Modify: `apps/extension/src/settings/settings.ts`
- Test: `apps/extension/src/settings/settings.test.ts`

**Interfaces:**
- Produces: `ExtensionSettings.sourceLanguage: string`; `loadSettings` defaults it to the EN↔ZH counterpart of the target when absent (`en` when target is Chinese, `zh` otherwise).

- [ ] **Step 1: Write the failing test**

Add to `apps/extension/src/settings/settings.test.ts` (follow the file's storage-adapter mock pattern):

```ts
it("defaults sourceLanguage to the counterpart of a stored target", async () => {
  const adapter = makeAdapter({ // existing helper that seeds storage
    serverUrl: "http://x", apiKey: "k", targetLanguage: "zh-CN", subtitleFontSize: 24, mode: "interpret",
  });
  const settings = await loadSettings(adapter);
  expect(settings.sourceLanguage).toBe("en");
});

it("uses zh as the counterpart when the target is English", async () => {
  const adapter = makeAdapter({
    serverUrl: "http://x", apiKey: "k", targetLanguage: "en", subtitleFontSize: 24, mode: "interpret",
  });
  const settings = await loadSettings(adapter);
  expect(settings.sourceLanguage).toBe("zh");
});
```

(If the existing tests construct the adapter differently, mirror that; the assertion is what matters.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test settings`
Expected: FAIL — `sourceLanguage` undefined.

- [ ] **Step 3: Add the field + counterpart default**

In `apps/extension/src/settings/settings.ts`:
- Add to `ExtensionSettings`: `sourceLanguage: string;`
- Add a constant + helper near the other defaults:

```ts
const DEFAULT_SOURCE_LANGUAGE = "en";

function counterpartSource(target: string): string {
  return target === "zh-CN" || target === "zh-TW" ? "en" : "zh";
}
```

- In the normalization path inside `loadSettings` (where stored partial settings are merged with defaults), set:

```ts
    sourceLanguage:
      stored.sourceLanguage ?? counterpartSource(stored.targetLanguage ?? DEFAULT_TARGET_LANGUAGE),
```

(Use the exact merge shape already in `loadSettings`; `DEFAULT_SOURCE_LANGUAGE` covers the all-defaults case.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/extension test settings`
Expected: PASS. Then `pnpm --filter @echoflow/extension typecheck`.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/settings/settings.ts apps/extension/src/settings/settings.test.ts
git commit -m "feat(extension): add sourceLanguage to settings with counterpart default"
```

---

## Task 9: Extension — send `sourceLanguage` in the start message

**Files:**
- Modify: `apps/extension/src/realtime/realtimeClient.ts`
- Modify: `apps/extension/entrypoints/offscreen/main.ts`
- Test: `apps/extension/src/realtime/realtimeClient.test.ts`

**Interfaces:**
- Consumes: `ExtensionSettings.sourceLanguage` (Task 8).
- Produces: `RealtimeClientOptions.sourceLanguage: string`; the `start` `ClientMessage` includes `sourceLanguage`.

- [ ] **Step 1: Write the failing test**

In `apps/extension/src/realtime/realtimeClient.test.ts`, find the test that asserts the start message contents (it checks `mode`/`targetLanguage`). Add `sourceLanguage` to that client's options and assert it appears in the sent `start` frame:

```ts
// when constructing the client under test, include: sourceLanguage: "en"
// then, after connect, on the parsed start frame:
expect(sentStart.sourceLanguage).toBe("en");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test realtimeClient`
Expected: FAIL — `sourceLanguage` undefined on the frame.

- [ ] **Step 3: Add to options + start message**

In `apps/extension/src/realtime/realtimeClient.ts`:
- Add to `RealtimeClientOptions` (after `targetLanguage: string;`): `sourceLanguage: string;`
- In `createStartMessage`, add after `targetLanguage: this.options.targetLanguage,`:

```ts
      sourceLanguage: this.options.sourceLanguage,
```

- [ ] **Step 4: Pass it from the offscreen document**

In `apps/extension/entrypoints/offscreen/main.ts`, in the `new RealtimeClient({ ... })` options (next to `targetLanguage: message.settings.targetLanguage,`):

```ts
      sourceLanguage: message.settings.sourceLanguage,
```

- [ ] **Step 5: Run tests + typecheck to verify green**

Run: `pnpm --filter @echoflow/extension test realtimeClient` then `pnpm --filter @echoflow/extension typecheck`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add apps/extension/src/realtime/realtimeClient.ts apps/extension/src/realtime/realtimeClient.test.ts apps/extension/entrypoints/offscreen/main.ts
git commit -m "feat(extension): send explicit sourceLanguage in the start message"
```

---

## Final verification

- [ ] **Full gate:** from repo root run `pnpm test`, `pnpm typecheck`, `pnpm build`. Expected: protocol + backend + extension all green; types clean; extension `.output/chrome-mv3` builds.
- [ ] **Manual wire check:** with `VOLCENGINE_AST_API_KEY` set, run `scripts/volcengine-ast-smoke.ts` — interpret still produces paired finals (the explicit source path is now exercised end-to-end).
- [ ] **Capabilities smoke:** `curl -s -H "x-api-key: $ECHOFLOW_API_KEY" http://127.0.0.1:8787/v1/capabilities | jq '.modes.interpret.available, (.modes.interpret.languages|length)'` → `true`, `20` (with AST creds).

## Out of scope (P2)

Design tokens (`src/ui/theme.ts`), the redesigned options page, the searchable source / constrained target pickers consuming `/v1/capabilities`, dialect wire codes, and removing the extension's hardcoded `TARGET_LANGUAGE_OPTIONS`. P2 gets its own plan once P1 lands.
