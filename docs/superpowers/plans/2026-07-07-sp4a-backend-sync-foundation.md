# SP4a — Backend Sync Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the self-hosted backend an optional, protocol-typed history sync store — `POST /v1/sync/push` / `GET /v1/sync/pull` over `node:sqlite` — so extension devices can replicate their subtitle history (SP4b consumes it).

**Architecture:** New `packages/protocol/src/sync.ts` wire types + guards; a `HistoryRepository` interface with in-memory (tests) and `node:sqlite` (production) implementations sharing one contract test suite; a Fastify route plugin gated on `ECHOFLOW_HISTORY_DB`; auth through a new injectable `createApiKeyVerifier` seam that the WS route also adopts. Spec: `docs/superpowers/specs/2026-07-07-self-hosted-history-sync-design.md`.

**Tech Stack:** TypeScript (ESM), Fastify 5, `node:sqlite` (built-in, zero new npm deps), Vitest.

## Global Constraints

- **Zero new npm dependencies.** Storage is `node:sqlite` (`DatabaseSync`), verified working unflagged on the repo's Node 22.22 (prints an ExperimentalWarning — acceptable).
- **Sync is strictly optional:** with `ECHOFLOW_HISTORY_DB` unset (and no `historyDbPath` input), the sync routes are NOT registered (requests 404) and the backend stays exactly as stateless as today.
- **Protocol changes are contract changes:** every new/changed type in `packages/protocol` ships with its runtime guard and guard tests in the same task.
- `packages/protocol` has **no runtime deps** and is consumed as source — no build step needed between tasks.
- Backend tsconfig has `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`: use conditional spread `...(x !== undefined ? { k: x } : {})` for optional fields; never index arrays without handling `undefined` (prefer `.at()` + `??`).
- Backend imports use `.js` specifiers (`import ... from "./historyRepository.js"`).
- `syncStatus` never crosses the wire; the server stores payloads opaquely (replication store, not query engine).
- Pull page limit is exactly `500` rows (sessions + segments combined, seq order); push body limit is exactly `10 * 1024 * 1024` bytes.
- LWW: a session upsert with `updatedAtMs <=` the stored row's is a no-op (ties keep the stored row). Segments are immutable: an upsert on an existing `(sessionId, segmentId)` is a no-op.
- The `owner` column is nullable, written on session upserts, **ignored on reads** (single-user; cloud insurance only). Routes always pass `null`.
- All commits are DCO-signed: `git commit -s`, and end the message body with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Verification commands: `pnpm --filter @echoflow/protocol test`, `pnpm --filter @echoflow/backend test`, `pnpm typecheck` (root).

---

### Task 1: Protocol sync wire contract (`sync.ts`)

**Files:**
- Create: `packages/protocol/src/sync.ts`
- Create: `packages/protocol/src/sync.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**
- Consumes: nothing (leaf module; follows the guard style of `packages/protocol/src/events.ts`).
- Produces: types `SyncSessionRecord`, `SyncSegmentRecord`, `SyncPushRequest`, `SyncPushResponse`, `SyncPullResponse`; guards `isSyncPushRequest(value: unknown): value is SyncPushRequest`, `isSyncPullResponse(value: unknown): value is SyncPullResponse`. Tasks 4–7 import all of these from `@echoflow/protocol`.

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/src/sync.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isSyncPushRequest, isSyncPullResponse } from "./sync.js";

const session = {
  id: "local-1751800000000-abc",
  updatedAtMs: 1751800001000,
  payload: { startedAt: 1751800000000, videoKey: "youtube:dQw4w9WgXcQ" },
};

const segment = {
  sessionId: "local-1751800000000-abc",
  segmentId: "e0:seg-1",
  payload: { sourceText: "hello", translatedText: "你好" },
};

describe("isSyncPushRequest", () => {
  it("accepts a valid push request", () => {
    expect(isSyncPushRequest({ sessions: [session], segments: [segment] })).toBe(true);
  });

  it("accepts empty arrays", () => {
    expect(isSyncPushRequest({ sessions: [], segments: [] })).toBe(true);
  });

  it("rejects non-objects and missing arrays", () => {
    expect(isSyncPushRequest(null)).toBe(false);
    expect(isSyncPushRequest("push")).toBe(false);
    expect(isSyncPushRequest({ sessions: [session] })).toBe(false);
    expect(isSyncPushRequest({ segments: [segment] })).toBe(false);
  });

  it("rejects a session with a non-finite updatedAtMs or missing payload", () => {
    expect(
      isSyncPushRequest({
        sessions: [{ ...session, updatedAtMs: Number.NaN }],
        segments: [],
      }),
    ).toBe(false);
    expect(
      isSyncPushRequest({
        sessions: [{ id: "x", updatedAtMs: 1 }],
        segments: [],
      }),
    ).toBe(false);
    expect(
      isSyncPushRequest({
        sessions: [{ ...session, payload: "not-an-object" }],
        segments: [],
      }),
    ).toBe(false);
  });

  it("rejects a segment missing sessionId or segmentId", () => {
    expect(
      isSyncPushRequest({ sessions: [], segments: [{ segmentId: "a", payload: {} }] }),
    ).toBe(false);
    expect(
      isSyncPushRequest({ sessions: [], segments: [{ sessionId: "a", payload: {} }] }),
    ).toBe(false);
  });
});

describe("isSyncPullResponse", () => {
  it("accepts a valid pull response", () => {
    expect(
      isSyncPullResponse({
        sessions: [session],
        segments: [segment],
        nextCursor: 42,
        hasMore: false,
      }),
    ).toBe(true);
  });

  it("accepts an empty pull response", () => {
    expect(
      isSyncPullResponse({ sessions: [], segments: [], nextCursor: 0, hasMore: false }),
    ).toBe(true);
  });

  it("rejects missing or non-numeric cursor and non-boolean hasMore", () => {
    expect(
      isSyncPullResponse({ sessions: [], segments: [], hasMore: false }),
    ).toBe(false);
    expect(
      isSyncPullResponse({ sessions: [], segments: [], nextCursor: "42", hasMore: false }),
    ).toBe(false);
    expect(
      isSyncPullResponse({ sessions: [], segments: [], nextCursor: 1, hasMore: "no" }),
    ).toBe(false);
  });

  it("rejects invalid records inside the arrays", () => {
    expect(
      isSyncPullResponse({
        sessions: [{ id: 5, updatedAtMs: 1, payload: {} }],
        segments: [],
        nextCursor: 1,
        hasMore: false,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/protocol test sync`
Expected: FAIL — cannot resolve `./sync.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/protocol/src/sync.ts`:

```ts
/**
 * History sync wire contract (SP4). The backend is a replication store, not a
 * query engine: records cross the wire as an opaque `payload` document plus
 * the few fields the server needs for ordering and conflict resolution.
 * Device-local state (`syncStatus`) never crosses the wire.
 */

export type SyncSessionRecord = {
  /** Globally unique already: `local-<timestamp>-<uuid>`. */
  id: string;
  /** Last-writer-wins clock, client-authored. */
  updatedAtMs: number;
  /** Full HistorySessionRecord (minus syncStatus). */
  payload: Record<string, unknown>;
};

export type SyncSegmentRecord = {
  sessionId: string;
  segmentId: string;
  /** Full HistorySegmentRecord; immutable once final. */
  payload: Record<string, unknown>;
};

export type SyncPushRequest = {
  sessions: SyncSessionRecord[];
  segments: SyncSegmentRecord[];
};

export type SyncPushResponse = {
  accepted: { sessions: number; segments: number };
};

export type SyncPullResponse = {
  sessions: SyncSessionRecord[];
  segments: SyncSegmentRecord[];
  /** Max sync_seq included in this page; pass as ?since= on the next pull. */
  nextCursor: number;
  /** True when the page limit was hit; pull again with nextCursor. */
  hasMore: boolean;
};

export function isSyncSessionRecord(value: unknown): value is SyncSessionRecord {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.updatedAtMs === "number" &&
    Number.isFinite(value.updatedAtMs) &&
    isRecord(value.payload)
  );
}

export function isSyncSegmentRecord(value: unknown): value is SyncSegmentRecord {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.sessionId === "string" &&
    typeof value.segmentId === "string" &&
    isRecord(value.payload)
  );
}

export function isSyncPushRequest(value: unknown): value is SyncPushRequest {
  if (!isRecord(value)) {
    return false;
  }
  return (
    Array.isArray(value.sessions) &&
    value.sessions.every(isSyncSessionRecord) &&
    Array.isArray(value.segments) &&
    value.segments.every(isSyncSegmentRecord)
  );
}

export function isSyncPullResponse(value: unknown): value is SyncPullResponse {
  if (!isRecord(value)) {
    return false;
  }
  return (
    Array.isArray(value.sessions) &&
    value.sessions.every(isSyncSessionRecord) &&
    Array.isArray(value.segments) &&
    value.segments.every(isSyncSegmentRecord) &&
    typeof value.nextCursor === "number" &&
    Number.isFinite(value.nextCursor) &&
    typeof value.hasMore === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
```

Modify `packages/protocol/src/index.ts` to:

```ts
export * from "./events.js";
export * from "./session.js";
export * from "./capabilities.js";
export * from "./sync.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/protocol test`
Expected: PASS (all protocol tests, including the new sync suite).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/sync.ts packages/protocol/src/sync.test.ts packages/protocol/src/index.ts
git commit -s -m "feat(protocol): sync wire contract (push/pull records + guards)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Capabilities `sync` flag (protocol type + backend builder)

**Files:**
- Modify: `packages/protocol/src/capabilities.ts`
- Modify: `packages/protocol/src/capabilities.test.ts`
- Modify: `apps/backend/src/realtime/capabilities.ts`
- Modify: `apps/backend/src/realtime/capabilities.test.ts`
- Modify: `apps/backend/src/server.ts:25` (the `buildCapabilities` call)

**Interfaces:**
- Consumes: existing `CapabilitiesDescriptor`, `isCapabilitiesDescriptor`, `buildCapabilities(config: ProviderConfig)`.
- Produces: `CapabilitiesDescriptor` gains optional `sync?: { available: boolean }`; `buildCapabilities(config: ProviderConfig, options: { syncAvailable: boolean }): CapabilitiesDescriptor` (new required second parameter). Task 7 passes the real `syncAvailable`; this task wires `{ syncAvailable: false }` at the `server.ts` call site as a placeholder.

- [ ] **Step 1: Write the failing tests**

Append to `packages/protocol/src/capabilities.test.ts` (inside the existing `describe` for `isCapabilitiesDescriptor`, or as a new `describe` block at the end of the file):

```ts
describe("isCapabilitiesDescriptor sync flag", () => {
  const mode = {
    available: true,
    autoDetect: true,
    languages: [],
  };
  const base = { modes: { pipeline: mode, interpret: mode } };

  it("accepts a descriptor without sync (older servers)", () => {
    expect(isCapabilitiesDescriptor(base)).toBe(true);
  });

  it("accepts sync: { available: boolean }", () => {
    expect(isCapabilitiesDescriptor({ ...base, sync: { available: true } })).toBe(true);
    expect(isCapabilitiesDescriptor({ ...base, sync: { available: false } })).toBe(true);
  });

  it("rejects a malformed sync field", () => {
    expect(isCapabilitiesDescriptor({ ...base, sync: {} })).toBe(false);
    expect(isCapabilitiesDescriptor({ ...base, sync: { available: "yes" } })).toBe(false);
    expect(isCapabilitiesDescriptor({ ...base, sync: null })).toBe(false);
  });
});
```

(If the file does not already import `describe`, extend the vitest import accordingly.)

Append to `apps/backend/src/realtime/capabilities.test.ts`:

```ts
describe("buildCapabilities sync flag", () => {
  const config = {
    asr: { provider: "fake" as const },
    translation: { provider: "fake" as const },
  };

  it("reports sync availability", () => {
    expect(buildCapabilities(config, { syncAvailable: true }).sync).toEqual({
      available: true,
    });
    expect(buildCapabilities(config, { syncAvailable: false }).sync).toEqual({
      available: false,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @echoflow/protocol test capabilities && pnpm --filter @echoflow/backend test capabilities`
Expected: protocol — the malformed-sync rejection cases FAIL (the current guard ignores extra fields); backend — the new test FAILS at the assertion (`.sync` is `undefined`; vitest strips types, so the extra argument is ignored at runtime rather than failing to compile).

- [ ] **Step 3: Implement**

In `packages/protocol/src/capabilities.ts`, add the type and extend the guard:

```ts
export type SyncCapability = {
  available: boolean;
};
```

Change `CapabilitiesDescriptor` to:

```ts
export type CapabilitiesDescriptor = {
  modes: { pipeline: ModeCapabilities; interpret: ModeCapabilities };
  /** Absent on servers older than SP4a; treat as unavailable. */
  sync?: SyncCapability;
};
```

Change `isCapabilitiesDescriptor` to:

```ts
export function isCapabilitiesDescriptor(value: unknown): value is CapabilitiesDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.modes !== "object" || v.modes === null) return false;
  const modes = v.modes as Record<string, unknown>;
  const syncValid =
    v.sync === undefined ||
    (typeof v.sync === "object" &&
      v.sync !== null &&
      typeof (v.sync as Record<string, unknown>).available === "boolean");
  return isModeCapabilities(modes.pipeline) && isModeCapabilities(modes.interpret) && syncValid;
}
```

In `apps/backend/src/realtime/capabilities.ts`, change the builder signature and add the field:

```ts
export function buildCapabilities(
  config: ProviderConfig,
  options: { syncAvailable: boolean },
): CapabilitiesDescriptor {
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
    sync: { available: options.syncAvailable },
  };
}
```

Update every existing `buildCapabilities(...)` call in `apps/backend/src/realtime/capabilities.test.ts` to pass `{ syncAvailable: false }` as the second argument, and in `apps/backend/src/server.ts` change line 25 to:

```ts
    return buildCapabilities(config.providers, { syncAvailable: false });
```

(`false` is a placeholder; Task 7 replaces it with the repository presence.)

- [ ] **Step 4: Run the full suites**

Run: `pnpm --filter @echoflow/protocol test && pnpm --filter @echoflow/backend test && pnpm --filter @echoflow/extension test`
Expected: all PASS (the extension consumes `isCapabilitiesDescriptor`; the new field is optional so nothing breaks — the extension run confirms it).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/capabilities.ts packages/protocol/src/capabilities.test.ts apps/backend/src/realtime/capabilities.ts apps/backend/src/realtime/capabilities.test.ts apps/backend/src/server.ts
git commit -s -m "feat(protocol,backend): capabilities advertise sync availability

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `createApiKeyVerifier` auth seam (WS + capabilities adopt it)

**Files:**
- Modify: `apps/backend/src/wsAuth.ts`
- Modify: `apps/backend/src/wsAuth.test.ts`
- Modify: `apps/backend/src/server.ts` (three `timingSafeKeyMatch(..., config.apiKey)` call sites)

**Interfaces:**
- Consumes: existing `timingSafeKeyMatch(provided, expected)`.
- Produces: `createApiKeyVerifier(expected: string): (provided: string | undefined) => boolean` exported from `wsAuth.ts`. Tasks 6–7 inject the returned verifier into the sync routes.

- [ ] **Step 1: Write the failing test**

Append to `apps/backend/src/wsAuth.test.ts`:

```ts
describe("createApiKeyVerifier", () => {
  it("verifies the matching key and rejects others", () => {
    const verify = createApiKeyVerifier("secret-key");
    expect(verify("secret-key")).toBe(true);
    expect(verify("wrong-key")).toBe(false);
    expect(verify("")).toBe(false);
    expect(verify(undefined)).toBe(false);
  });
});
```

(Extend the import from `./wsAuth.js` with `createApiKeyVerifier`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/backend test wsAuth`
Expected: FAIL — `createApiKeyVerifier` is not exported.

- [ ] **Step 3: Implement**

Append to `apps/backend/src/wsAuth.ts`:

```ts
/**
 * Auth seam: routes depend on `(provided) => boolean`, not on how keys are
 * checked. Self-hosted deployments bind one static key (constant-time compare);
 * a future control plane swaps in a key→tenant lookup without touching routes.
 */
export function createApiKeyVerifier(
  expected: string,
): (provided: string | undefined) => boolean {
  return (provided) => timingSafeKeyMatch(provided, expected);
}
```

In `apps/backend/src/server.ts`, construct the verifier once after `createConfig`:

```ts
  const config = createConfig(input);
  const verifyApiKey = createApiKeyVerifier(config.apiKey);
```

and replace the three call sites:
- capabilities route: `if (!timingSafeKeyMatch(headerKey, config.apiKey))` → `if (!verifyApiKey(headerKey))`
- WS preValidation: `!timingSafeKeyMatch(headerKey, config.apiKey) && !timingSafeKeyMatch(queryApiKey, config.apiKey)` → `!verifyApiKey(headerKey) && !verifyApiKey(queryApiKey)`

Update the import in `server.ts` from `{ isAllowedOrigin, timingSafeKeyMatch }` to `{ createApiKeyVerifier, isAllowedOrigin }`.

- [ ] **Step 4: Run the backend suite**

Run: `pnpm --filter @echoflow/backend test`
Expected: PASS — existing server auth tests (401 paths) prove the refactor preserved behavior.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/wsAuth.ts apps/backend/src/wsAuth.test.ts apps/backend/src/server.ts
git commit -s -m "refactor(backend): injectable createApiKeyVerifier auth seam

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `HistoryRepository` interface + in-memory implementation + contract suite

**Files:**
- Create: `apps/backend/src/history/historyRepository.ts`
- Create: `apps/backend/src/history/inMemoryHistoryRepository.ts`
- Create: `apps/backend/src/history/historyRepositoryContract.ts` (shared vitest suite)
- Create: `apps/backend/src/history/inMemoryHistoryRepository.test.ts`

**Interfaces:**
- Consumes: `SyncSessionRecord`, `SyncSegmentRecord`, `SyncPullResponse` from `@echoflow/protocol` (Task 1).
- Produces: `HistoryRepository` interface; `createInMemoryHistoryRepository(): HistoryRepository`; `describeHistoryRepositoryContract(makeRepository: () => Promise<HistoryRepository> | HistoryRepository): void`. Task 5 runs the same contract against sqlite; Task 6 injects a repository into the routes.

- [ ] **Step 1: Define the interface**

Create `apps/backend/src/history/historyRepository.ts`:

```ts
import type {
  SyncPullResponse,
  SyncSegmentRecord,
  SyncSessionRecord,
} from "@echoflow/protocol";

/**
 * Server-side replication store for extension history. Mirrors the provider
 * pattern: an interface with an in-memory implementation (tests) and a
 * node:sqlite implementation (production).
 *
 * `owner` is nullable cloud insurance: stored on session upserts, ignored on
 * reads (single-user deployments pass null everywhere).
 */
export interface HistoryRepository {
  /** LWW per record: incoming updatedAtMs <= stored is a no-op (ties keep stored). */
  upsertSessions(sessions: SyncSessionRecord[], owner: string | null): Promise<void>;
  /** Segments are immutable: an existing (sessionId, segmentId) is a no-op. */
  upsertSegments(segments: SyncSegmentRecord[], owner: string | null): Promise<void>;
  /**
   * Rows with sync_seq > cursor in seq order, at most `limit` rows total
   * (sessions + segments combined). nextCursor = max seq returned, or the
   * cursor itself when nothing changed.
   */
  changesSince(
    cursor: number,
    limit: number,
    owner: string | null,
  ): Promise<SyncPullResponse>;
  close(): Promise<void>;
}
```

- [ ] **Step 2: Write the shared contract suite (the failing tests)**

Create `apps/backend/src/history/historyRepositoryContract.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import type { SyncSegmentRecord, SyncSessionRecord } from "@echoflow/protocol";
import type { HistoryRepository } from "./historyRepository.js";

function session(id: string, updatedAtMs: number, extra = {}): SyncSessionRecord {
  return { id, updatedAtMs, payload: { id, updatedAt: updatedAtMs, ...extra } };
}

function segment(sessionId: string, segmentId: string): SyncSegmentRecord {
  return { sessionId, segmentId, payload: { sessionId, segmentId, sourceText: "hi" } };
}

/** Behavioral contract every HistoryRepository implementation must satisfy. */
export function describeHistoryRepositoryContract(
  makeRepository: () => Promise<HistoryRepository> | HistoryRepository,
): void {
  describe("HistoryRepository contract", () => {
    let repository: HistoryRepository;

    afterEach(async () => {
      await repository.close();
    });

    async function make(): Promise<HistoryRepository> {
      repository = await makeRepository();
      return repository;
    }

    it("returns pushed sessions and segments from changesSince(0)", async () => {
      const repo = await make();
      await repo.upsertSessions([session("s1", 100)], null);
      await repo.upsertSegments([segment("s1", "e0:seg-1")], null);

      const page = await repo.changesSince(0, 500, null);
      expect(page.sessions.map((s) => s.id)).toEqual(["s1"]);
      expect(page.segments.map((s) => s.segmentId)).toEqual(["e0:seg-1"]);
      expect(page.nextCursor).toBeGreaterThan(0);
      expect(page.hasMore).toBe(false);
    });

    it("round-trips the payload verbatim", async () => {
      const repo = await make();
      const original = session("s1", 100, { videoKey: "youtube:x", nested: { a: [1, 2] } });
      await repo.upsertSessions([original], null);

      const page = await repo.changesSince(0, 500, null);
      expect(page.sessions[0]?.payload).toEqual(original.payload);
      expect(page.sessions[0]?.updatedAtMs).toBe(100);
    });

    it("applies LWW: newer wins, older and equal are no-ops", async () => {
      const repo = await make();
      await repo.upsertSessions([session("s1", 100, { v: "first" })], null);
      const afterFirst = (await repo.changesSince(0, 500, null)).nextCursor;

      await repo.upsertSessions([session("s1", 50, { v: "stale" })], null);
      await repo.upsertSessions([session("s1", 100, { v: "tie" })], null);
      const unchanged = await repo.changesSince(0, 500, null);
      expect(unchanged.sessions[0]?.payload.v).toBe("first");
      expect(unchanged.nextCursor).toBe(afterFirst);

      await repo.upsertSessions([session("s1", 200, { v: "second" })], null);
      const changed = await repo.changesSince(afterFirst, 500, null);
      expect(changed.sessions.map((s) => s.id)).toEqual(["s1"]);
      expect(changed.sessions[0]?.payload.v).toBe("second");
    });

    it("treats segments as immutable (duplicate upsert is a no-op)", async () => {
      const repo = await make();
      await repo.upsertSegments([segment("s1", "e0:seg-1")], null);
      const afterFirst = (await repo.changesSince(0, 500, null)).nextCursor;

      const dupe = { ...segment("s1", "e0:seg-1"), payload: { mutated: true } };
      await repo.upsertSegments([dupe], null);

      const page = await repo.changesSince(0, 500, null);
      expect(page.segments).toHaveLength(1);
      expect(page.segments[0]?.payload).toEqual({
        sessionId: "s1",
        segmentId: "e0:seg-1",
        sourceText: "hi",
      });
      expect(page.nextCursor).toBe(afterFirst);
    });

    it("paginates in seq order with hasMore and a resumable cursor", async () => {
      const repo = await make();
      await repo.upsertSessions([session("s1", 100)], null);
      await repo.upsertSegments(
        [segment("s1", "e0:seg-1"), segment("s1", "e0:seg-2")],
        null,
      );

      const first = await repo.changesSince(0, 2, null);
      expect(first.sessions).toHaveLength(1);
      expect(first.segments).toHaveLength(1);
      expect(first.hasMore).toBe(true);

      const second = await repo.changesSince(first.nextCursor, 2, null);
      expect(second.sessions).toHaveLength(0);
      expect(second.segments.map((s) => s.segmentId)).toEqual(["e0:seg-2"]);
      expect(second.hasMore).toBe(false);

      const third = await repo.changesSince(second.nextCursor, 2, null);
      expect(third.sessions).toHaveLength(0);
      expect(third.segments).toHaveLength(0);
      expect(third.nextCursor).toBe(second.nextCursor);
      expect(third.hasMore).toBe(false);
    });

    it("excludes rows at or below the cursor", async () => {
      const repo = await make();
      await repo.upsertSessions([session("s1", 100)], null);
      const cursor = (await repo.changesSince(0, 500, null)).nextCursor;
      await repo.upsertSessions([session("s2", 100)], null);

      const page = await repo.changesSince(cursor, 500, null);
      expect(page.sessions.map((s) => s.id)).toEqual(["s2"]);
    });
  });
}
```

Create `apps/backend/src/history/inMemoryHistoryRepository.test.ts`:

```ts
import { describeHistoryRepositoryContract } from "./historyRepositoryContract.js";
import { createInMemoryHistoryRepository } from "./inMemoryHistoryRepository.js";

describeHistoryRepositoryContract(() => createInMemoryHistoryRepository());
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @echoflow/backend test inMemoryHistoryRepository`
Expected: FAIL — cannot resolve `./inMemoryHistoryRepository.js`.

- [ ] **Step 4: Implement the in-memory repository**

Create `apps/backend/src/history/inMemoryHistoryRepository.ts`:

```ts
import type { SyncSegmentRecord, SyncSessionRecord } from "@echoflow/protocol";
import type { HistoryRepository } from "./historyRepository.js";

type StoredSession = { record: SyncSessionRecord; owner: string | null; seq: number };
type StoredSegment = { record: SyncSegmentRecord; seq: number };

/** Reference implementation of the repository contract; the test double. */
export function createInMemoryHistoryRepository(): HistoryRepository {
  const sessions = new Map<string, StoredSession>();
  const segments = new Map<string, StoredSegment>();
  let seq = 0;

  return {
    async upsertSessions(records, owner) {
      for (const record of records) {
        const existing = sessions.get(record.id);
        if (existing && existing.record.updatedAtMs >= record.updatedAtMs) {
          continue;
        }
        seq += 1;
        sessions.set(record.id, { record, owner, seq });
      }
    },
    async upsertSegments(records) {
      for (const record of records) {
        const key = `${record.sessionId} ${record.segmentId}`;
        if (segments.has(key)) {
          continue;
        }
        seq += 1;
        segments.set(key, { record, seq });
      }
    },
    async changesSince(cursor, limit) {
      const rows = [
        ...[...sessions.values()].map((s) => ({
          seq: s.seq,
          session: s.record,
          segment: undefined,
        })),
        ...[...segments.values()].map((s) => ({
          seq: s.seq,
          session: undefined,
          segment: s.record,
        })),
      ]
        .filter((row) => row.seq > cursor)
        .sort((a, b) => a.seq - b.seq);

      const page = rows.slice(0, limit);
      return {
        sessions: page.flatMap((row) => (row.session ? [row.session] : [])),
        segments: page.flatMap((row) => (row.segment ? [row.segment] : [])),
        nextCursor: page.at(-1)?.seq ?? cursor,
        hasMore: rows.length > limit,
      };
    },
    async close() {
      sessions.clear();
      segments.clear();
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/backend test inMemoryHistoryRepository`
Expected: PASS — all 6 contract cases.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/history/
git commit -s -m "feat(backend): HistoryRepository contract + in-memory implementation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `node:sqlite` repository implementation

**Files:**
- Create: `apps/backend/src/history/sqliteHistoryRepository.ts`
- Create: `apps/backend/src/history/sqliteHistoryRepository.test.ts`

**Interfaces:**
- Consumes: `HistoryRepository` (Task 4), `describeHistoryRepositoryContract` (Task 4), `node:sqlite` `DatabaseSync`.
- Produces: `createSqliteHistoryRepository(path: string): HistoryRepository` — `path` is a filesystem path or `":memory:"`. Task 7 constructs it from config.

- [ ] **Step 1: Write the failing tests**

Create `apps/backend/src/history/sqliteHistoryRepository.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeHistoryRepositoryContract } from "./historyRepositoryContract.js";
import { createSqliteHistoryRepository } from "./sqliteHistoryRepository.js";

describeHistoryRepositoryContract(() => createSqliteHistoryRepository(":memory:"));

describe("sqlite persistence", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("survives close and reopen on the same file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "echoflow-sync-"));
    dirs.push(dir);
    const path = join(dir, "history.db");

    const first = createSqliteHistoryRepository(path);
    await first.upsertSessions(
      [{ id: "s1", updatedAtMs: 100, payload: { videoKey: "youtube:x" } }],
      null,
    );
    const cursor = (await first.changesSince(0, 500, null)).nextCursor;
    await first.close();

    const second = createSqliteHistoryRepository(path);
    const page = await second.changesSince(0, 500, null);
    expect(page.sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(page.sessions[0]?.payload).toEqual({ videoKey: "youtube:x" });

    // The seq counter must also persist: new writes continue past the old cursor.
    await second.upsertSessions([{ id: "s2", updatedAtMs: 100, payload: {} }], null);
    const delta = await second.changesSince(cursor, 500, null);
    expect(delta.sessions.map((s) => s.id)).toEqual(["s2"]);
    await second.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/backend test sqliteHistoryRepository`
Expected: FAIL — cannot resolve `./sqliteHistoryRepository.js`.

- [ ] **Step 3: Implement**

Create `apps/backend/src/history/sqliteHistoryRepository.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import type { SyncSegmentRecord, SyncSessionRecord } from "@echoflow/protocol";
import type { HistoryRepository } from "./historyRepository.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sync_sessions (
  id         TEXT PRIMARY KEY,
  owner      TEXT,
  updated_at INTEGER NOT NULL,
  sync_seq   INTEGER NOT NULL,
  payload    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_segments (
  session_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  sync_seq   INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  PRIMARY KEY (session_id, segment_id)
);
CREATE TABLE IF NOT EXISTS sync_state (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_sessions_seq ON sync_sessions(sync_seq);
CREATE INDEX IF NOT EXISTS idx_sync_segments_seq ON sync_segments(sync_seq);
`;

/**
 * Production HistoryRepository on node:sqlite (built-in; zero npm deps).
 * DatabaseSync is synchronous — methods are async only to satisfy the
 * interface. Single-process access is assumed (one backend per deployment).
 */
export function createSqliteHistoryRepository(path: string): HistoryRepository {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  db.exec(`INSERT OR IGNORE INTO sync_state (k, v) VALUES ('seq', 0);`);

  const bumpSeq = db.prepare(`UPDATE sync_state SET v = v + 1 WHERE k = 'seq'`);
  const readSeq = db.prepare(`SELECT v FROM sync_state WHERE k = 'seq'`);
  const readSessionUpdatedAt = db.prepare(
    `SELECT updated_at FROM sync_sessions WHERE id = ?`,
  );
  const writeSession = db.prepare(
    `INSERT INTO sync_sessions (id, owner, updated_at, sync_seq, payload)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       owner = excluded.owner,
       updated_at = excluded.updated_at,
       sync_seq = excluded.sync_seq,
       payload = excluded.payload`,
  );
  const segmentExists = db.prepare(
    `SELECT 1 FROM sync_segments WHERE session_id = ? AND segment_id = ?`,
  );
  const writeSegment = db.prepare(
    `INSERT INTO sync_segments (session_id, segment_id, sync_seq, payload)
     VALUES (?, ?, ?, ?)`,
  );
  const readChanges = db.prepare(
    `SELECT kind, sync_seq, id, updated_at, session_id, segment_id, payload FROM (
       SELECT 'session' AS kind, sync_seq, id, updated_at,
              NULL AS session_id, NULL AS segment_id, payload
       FROM sync_sessions WHERE sync_seq > ?
       UNION ALL
       SELECT 'segment' AS kind, sync_seq, NULL, NULL,
              session_id, segment_id, payload
       FROM sync_segments WHERE sync_seq > ?
     )
     ORDER BY sync_seq ASC
     LIMIT ?`,
  );

  function nextSeq(): number {
    bumpSeq.run();
    const row = readSeq.get() as { v: number | bigint } | undefined;
    return Number(row?.v ?? 0);
  }

  function inTransaction(fn: () => void): void {
    db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    async upsertSessions(records, owner) {
      inTransaction(() => {
        for (const record of records) {
          const existing = readSessionUpdatedAt.get(record.id) as
            | { updated_at: number | bigint }
            | undefined;
          if (existing && Number(existing.updated_at) >= record.updatedAtMs) {
            continue;
          }
          writeSession.run(
            record.id,
            owner,
            record.updatedAtMs,
            nextSeq(),
            JSON.stringify(record.payload),
          );
        }
      });
    },
    async upsertSegments(records) {
      inTransaction(() => {
        for (const record of records) {
          if (segmentExists.get(record.sessionId, record.segmentId) !== undefined) {
            continue;
          }
          writeSegment.run(
            record.sessionId,
            record.segmentId,
            nextSeq(),
            JSON.stringify(record.payload),
          );
        }
      });
    },
    async changesSince(cursor, limit) {
      // Fetch limit + 1 to learn whether another page exists.
      const rows = readChanges.all(cursor, cursor, limit + 1) as Array<{
        kind: string;
        sync_seq: number | bigint;
        id: string | null;
        updated_at: number | bigint | null;
        session_id: string | null;
        segment_id: string | null;
        payload: string;
      }>;
      const page = rows.slice(0, limit);
      const sessions: SyncSessionRecord[] = [];
      const segments: SyncSegmentRecord[] = [];
      for (const row of page) {
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
        if (row.kind === "session" && row.id !== null && row.updated_at !== null) {
          sessions.push({ id: row.id, updatedAtMs: Number(row.updated_at), payload });
        } else if (row.session_id !== null && row.segment_id !== null) {
          segments.push({
            sessionId: row.session_id,
            segmentId: row.segment_id,
            payload,
          });
        }
      }
      return {
        sessions,
        segments,
        nextCursor: page.length > 0 ? Number(page[page.length - 1]!.sync_seq) : cursor,
        hasMore: rows.length > limit,
      };
    },
    async close() {
      db.close();
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/backend test sqliteHistoryRepository`
Expected: PASS — the full contract suite against `:memory:` plus the file-persistence test. (An `ExperimentalWarning: SQLite` line in stderr is expected and fine.)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/history/sqliteHistoryRepository.ts apps/backend/src/history/sqliteHistoryRepository.test.ts
git commit -s -m "feat(backend): node:sqlite HistoryRepository (zero new deps)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Sync route plugin (`/v1/sync/push`, `/v1/sync/pull`)

**Files:**
- Create: `apps/backend/src/history/syncRoutes.ts`
- Create: `apps/backend/src/history/syncRoutes.test.ts`

**Interfaces:**
- Consumes: `HistoryRepository` + `createInMemoryHistoryRepository` (Task 4), `isSyncPushRequest` / `SyncPushResponse` / `SyncPullResponse` (Task 1), verifier shape `(provided: string | undefined) => boolean` (Task 3).
- Produces: `registerSyncRoutes(server: FastifyInstance, options: SyncRouteOptions): void` with `SyncRouteOptions = { repository: HistoryRepository; verifyApiKey: (provided: string | undefined) => boolean }`; constants `SYNC_PUSH_BODY_LIMIT_BYTES`, `SYNC_PULL_PAGE_LIMIT`. Task 7 registers this on the real server.

- [ ] **Step 1: Write the failing tests**

Create `apps/backend/src/history/syncRoutes.test.ts`:

```ts
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApiKeyVerifier } from "../wsAuth.js";
import { createInMemoryHistoryRepository } from "./inMemoryHistoryRepository.js";
import { registerSyncRoutes } from "./syncRoutes.js";

const KEY = "test-key";

let server: FastifyInstance;

function makeServer(): FastifyInstance {
  server = Fastify({ logger: false });
  registerSyncRoutes(server, {
    repository: createInMemoryHistoryRepository(),
    verifyApiKey: createApiKeyVerifier(KEY),
  });
  return server;
}

afterEach(async () => {
  await server.close();
});

const pushBody = {
  sessions: [
    { id: "s1", updatedAtMs: 100, payload: { videoKey: "youtube:x" } },
  ],
  segments: [
    { sessionId: "s1", segmentId: "e0:seg-1", payload: { sourceText: "hi" } },
  ],
};

describe("POST /v1/sync/push", () => {
  it("rejects a missing or wrong api key with 401", async () => {
    const app = makeServer();
    const noKey = await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      payload: pushBody,
    });
    expect(noKey.statusCode).toBe(401);

    const wrongKey = await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      headers: { "x-api-key": "nope" },
      payload: pushBody,
    });
    expect(wrongKey.statusCode).toBe(401);
  });

  it("rejects a malformed body with 400", async () => {
    const app = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      headers: { "x-api-key": KEY },
      payload: { sessions: "nope" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_sync_push" });
  });

  it("accepts a valid push and reports counts", async () => {
    const app = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      headers: { "x-api-key": KEY },
      payload: pushBody,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: { sessions: 1, segments: 1 } });
  });
});

describe("GET /v1/sync/pull", () => {
  it("rejects a missing api key with 401", async () => {
    const app = makeServer();
    const res = await app.inject({ method: "GET", url: "/v1/sync/pull" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a non-integer or negative since with 400", async () => {
    const app = makeServer();
    for (const since of ["abc", "-1", "1.5"]) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/sync/pull?since=${since}`,
        headers: { "x-api-key": KEY },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "invalid_since" });
    }
  });

  it("round-trips pushed records, then returns an empty delta", async () => {
    const app = makeServer();
    await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      headers: { "x-api-key": KEY },
      payload: pushBody,
    });

    const full = await app.inject({
      method: "GET",
      url: "/v1/sync/pull",
      headers: { "x-api-key": KEY },
    });
    expect(full.statusCode).toBe(200);
    const body = full.json();
    expect(body.sessions).toEqual(pushBody.sessions);
    expect(body.segments).toEqual(pushBody.segments);
    expect(body.hasMore).toBe(false);

    const delta = await app.inject({
      method: "GET",
      url: `/v1/sync/pull?since=${body.nextCursor}`,
      headers: { "x-api-key": KEY },
    });
    expect(delta.json()).toEqual({
      sessions: [],
      segments: [],
      nextCursor: body.nextCursor,
      hasMore: false,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/backend test syncRoutes`
Expected: FAIL — cannot resolve `./syncRoutes.js`.

- [ ] **Step 3: Implement**

Create `apps/backend/src/history/syncRoutes.ts`:

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  isSyncPushRequest,
  type SyncPullResponse,
  type SyncPushResponse,
} from "@echoflow/protocol";
import type { HistoryRepository } from "./historyRepository.js";

export const SYNC_PUSH_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
export const SYNC_PULL_PAGE_LIMIT = 500;

export interface SyncRouteOptions {
  repository: HistoryRepository;
  verifyApiKey: (provided: string | undefined) => boolean;
}

/**
 * History sync routes. Auth is header-only (`x-api-key`): a cross-origin web
 * page cannot attach the header without a CORS preflight, which this server
 * never approves — so no separate Origin check is needed here.
 */
export function registerSyncRoutes(
  server: FastifyInstance,
  options: SyncRouteOptions,
): void {
  function authorized(request: FastifyRequest, reply: FastifyReply): boolean {
    const headerKey =
      typeof request.headers["x-api-key"] === "string"
        ? request.headers["x-api-key"]
        : undefined;
    if (!options.verifyApiKey(headerKey)) {
      void reply.code(401).send({ error: "Unauthorized" });
      return false;
    }
    return true;
  }

  server.post(
    "/v1/sync/push",
    { bodyLimit: SYNC_PUSH_BODY_LIMIT_BYTES },
    async (request, reply) => {
      if (!authorized(request, reply)) {
        return reply;
      }
      if (!isSyncPushRequest(request.body)) {
        return reply.code(400).send({ error: "invalid_sync_push" });
      }
      await options.repository.upsertSessions(request.body.sessions, null);
      await options.repository.upsertSegments(request.body.segments, null);
      const response: SyncPushResponse = {
        accepted: {
          sessions: request.body.sessions.length,
          segments: request.body.segments.length,
        },
      };
      return response;
    },
  );

  server.get("/v1/sync/pull", async (request, reply) => {
    if (!authorized(request, reply)) {
      return reply;
    }
    const query = request.query as Record<string, unknown>;
    const sinceRaw = typeof query.since === "string" ? query.since : undefined;
    const since = sinceRaw === undefined ? 0 : Number(sinceRaw);
    if (!Number.isInteger(since) || since < 0) {
      return reply.code(400).send({ error: "invalid_since" });
    }
    const response: SyncPullResponse = await options.repository.changesSince(
      since,
      SYNC_PULL_PAGE_LIMIT,
      null,
    );
    return response;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/backend test syncRoutes`
Expected: PASS — all 6 route tests.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/history/syncRoutes.ts apps/backend/src/history/syncRoutes.test.ts
git commit -s -m "feat(backend): /v1/sync push/pull routes behind api-key verifier

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Config + server wiring + docs

**Files:**
- Modify: `apps/backend/src/config.ts`
- Modify: `apps/backend/src/config.test.ts`
- Modify: `apps/backend/src/server.ts`
- Modify: `apps/backend/src/server.test.ts`
- Modify: `.env.example` (repo root)
- Modify: `CLAUDE.md` (backend request flow section)
- Modify: `docs/superpowers/backlog.md` (SP4 entry)

**Interfaces:**
- Consumes: `createSqliteHistoryRepository(path)` (Task 5), `registerSyncRoutes` (Task 6), `createApiKeyVerifier` / `verifyApiKey` (Task 3), `buildCapabilities(config, { syncAvailable })` (Task 2).
- Produces: `BackendConfig` gains `historyDbPath?: string` (`ECHOFLOW_HISTORY_DB` env; unset → sync off); `createServer` registers sync routes and reports `sync.available` iff configured.

- [ ] **Step 1: Write the failing config tests**

Append to `apps/backend/src/config.test.ts` (match the file's existing env-stashing pattern if one exists; otherwise use this self-contained form):

```ts
describe("historyDbPath", () => {
  const ENV_KEY = "ECHOFLOW_HISTORY_DB";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = saved;
    }
  });

  it("is absent by default (sync off)", () => {
    expect(createConfig({}).historyDbPath).toBeUndefined();
  });

  it("reads ECHOFLOW_HISTORY_DB", () => {
    process.env[ENV_KEY] = "./history.db";
    expect(createConfig({}).historyDbPath).toBe("./history.db");
  });

  it("treats a blank env value as unset", () => {
    process.env[ENV_KEY] = "  ";
    expect(createConfig({}).historyDbPath).toBeUndefined();
  });

  it("prefers explicit input over env", () => {
    process.env[ENV_KEY] = "./env.db";
    expect(createConfig({ historyDbPath: ":memory:" }).historyDbPath).toBe(":memory:");
  });
});
```

(Extend the vitest import with `beforeEach`/`afterEach` if not already imported.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/backend test config`
Expected: FAIL — `historyDbPath` does not exist on `BackendConfig` (type error) or is always `undefined` for the env case.

- [ ] **Step 3: Implement the config field**

In `apps/backend/src/config.ts`, change `BackendConfig` to:

```ts
export type BackendConfig = {
  apiKey: string;
  port: number;
  providers: ProviderConfig;
  /** Path (or ":memory:") for the history sync store; unset → sync disabled. */
  historyDbPath?: string;
};
```

and change `createConfig` to (conditional spread — `exactOptionalPropertyTypes`):

```ts
export function createConfig(input: BackendConfigInput = {}): BackendConfig {
  const historyDbPath =
    input.historyDbPath ?? readNonEmpty(process.env.ECHOFLOW_HISTORY_DB);
  return {
    apiKey: input.apiKey ?? process.env.ECHOFLOW_API_KEY ?? DEFAULT_API_KEY,
    port:
      input.port ??
      readPort(process.env.ECHOFLOW_PORT, "ECHOFLOW_PORT") ??
      readPort(process.env.PORT, "PORT") ??
      DEFAULT_PORT,
    providers: input.providers ?? readProviderConfig(),
    ...(historyDbPath !== undefined ? { historyDbPath } : {}),
  };
}

function readNonEmpty(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return value;
}
```

Run: `pnpm --filter @echoflow/backend test config` — expected: PASS.

- [ ] **Step 4: Write the failing server integration tests**

Append to `apps/backend/src/server.test.ts`:

```ts
describe("history sync wiring", () => {
  const pushBody = {
    sessions: [{ id: "s1", updatedAtMs: 100, payload: { videoKey: "youtube:x" } }],
    segments: [
      { sessionId: "s1", segmentId: "e0:seg-1", payload: { sourceText: "hi" } },
    ],
  };

  it("does not register sync routes by default and reports sync unavailable", async () => {
    const server = createServer();
    await server.ready();

    const push = await server.inject({
      method: "POST",
      url: "/v1/sync/push",
      headers: { "x-api-key": "dev-key" },
      payload: pushBody,
    });
    expect(push.statusCode).toBe(404);

    const caps = await server.inject({
      method: "GET",
      url: "/v1/capabilities",
      headers: { "x-api-key": "dev-key" },
    });
    expect(caps.json().sync).toEqual({ available: false });

    await server.close();
  });

  it("registers sync routes when historyDbPath is set and round-trips a push", async () => {
    const server = createServer({ historyDbPath: ":memory:" });
    await server.ready();

    const caps = await server.inject({
      method: "GET",
      url: "/v1/capabilities",
      headers: { "x-api-key": "dev-key" },
    });
    expect(caps.json().sync).toEqual({ available: true });

    const push = await server.inject({
      method: "POST",
      url: "/v1/sync/push",
      headers: { "x-api-key": "dev-key" },
      payload: pushBody,
    });
    expect(push.statusCode).toBe(200);
    expect(push.json()).toEqual({ accepted: { sessions: 1, segments: 1 } });

    const pull = await server.inject({
      method: "GET",
      url: "/v1/sync/pull?since=0",
      headers: { "x-api-key": "dev-key" },
    });
    expect(pull.statusCode).toBe(200);
    expect(pull.json().sessions).toEqual(pushBody.sessions);
    expect(pull.json().segments).toEqual(pushBody.segments);

    await server.close();
  });

  it("rejects sync requests without the api key", async () => {
    const server = createServer({ historyDbPath: ":memory:" });
    await server.ready();

    const res = await server.inject({
      method: "GET",
      url: "/v1/sync/pull",
    });
    expect(res.statusCode).toBe(401);

    await server.close();
  });
});
```

Run: `pnpm --filter @echoflow/backend test server` — expected: the new describe FAILS (404s everywhere, `sync.available` false in the enabled case).

- [ ] **Step 5: Wire the server**

In `apps/backend/src/server.ts`:

Add imports:

```ts
import { createSqliteHistoryRepository } from "./history/sqliteHistoryRepository.js";
import { registerSyncRoutes } from "./history/syncRoutes.js";
```

After `const verifyApiKey = createApiKeyVerifier(config.apiKey);` add:

```ts
  const historyRepository =
    config.historyDbPath !== undefined
      ? createSqliteHistoryRepository(config.historyDbPath)
      : undefined;
```

Change the capabilities route's return to:

```ts
    return buildCapabilities(config.providers, {
      syncAvailable: historyRepository !== undefined,
    });
```

After the capabilities route (before the websocket register block), add:

```ts
  if (historyRepository !== undefined) {
    const repository = historyRepository;
    registerSyncRoutes(server, { repository, verifyApiKey });
    server.addHook("onClose", async () => {
      await repository.close();
    });
  }
```

- [ ] **Step 6: Run the full backend suite**

Run: `pnpm --filter @echoflow/backend test && pnpm typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 7: Documentation**

Append to `.env.example` (repo root):

```bash

# --- History sync (SP4, optional) ---
# Cross-device subtitle history sync. Unset (default): sync routes are not
# registered and the backend stays stateless. Set to a file path to enable.
# The DB file contains your transcript text — keep it on your own machine.
# ECHOFLOW_HISTORY_DB=./echoflow-history.db
```

In `CLAUDE.md`, "Backend request flow" section, append this sentence to the paragraph describing `server.ts` routes (after the sentence introducing the health check and WS route):

```
When `ECHOFLOW_HISTORY_DB` is set, `server.ts` also registers optional history-sync routes (`POST /v1/sync/push`, `GET /v1/sync/pull` — `apps/backend/src/history/`): a `HistoryRepository` (in-memory for tests, `node:sqlite` in production, zero new deps) stores extension history as opaque payloads with a monotonic `sync_seq` cursor for delta pulls; LWW on `updatedAtMs` for sessions, segments immutable. Auth reuses the same api key via the injectable `createApiKeyVerifier` seam (`wsAuth.ts`), and `/v1/capabilities` advertises `sync.available`. Unset → routes absent, backend stateless as before.
```

In `docs/superpowers/backlog.md`, change the SP4 line:

```markdown
- ⬜ **SP4 — accounts / cloud sync** (uses the existing `syncStatus`) — separate product decision, deferred (the only remaining arc item).
```

to:

```markdown
- 🟡 **SP4 — self-hosted history sync** → `specs/2026-07-07-self-hosted-history-sync-design.md` (single-user, decided 2026-07-07; accounts/cloud stay out of the OSS repo). **SP4a — backend sync foundation** shipped: protocol `sync.ts` wire contract, `HistoryRepository` (in-memory + `node:sqlite`, zero new deps), `/v1/sync/push`+`/v1/sync/pull` behind the `createApiKeyVerifier` seam, `sync.available` in capabilities, all gated on `ECHOFLOW_HISTORY_DB` (unset → stateless as before). Next: SP4b (extension SyncEngine), SP4c (options/status UI).
```

- [ ] **Step 8: Final verification + commit**

Run: `pnpm test && pnpm typecheck`
Expected: all packages PASS, typecheck clean.

```bash
git add apps/backend/src/config.ts apps/backend/src/config.test.ts apps/backend/src/server.ts apps/backend/src/server.test.ts .env.example CLAUDE.md docs/superpowers/backlog.md
git commit -s -m "feat(backend): optional history sync store gated on ECHOFLOW_HISTORY_DB

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
