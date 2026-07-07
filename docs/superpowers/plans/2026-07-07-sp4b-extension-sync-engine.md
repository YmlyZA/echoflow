# SP4b — Extension Sync Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The extension replicates its local Dexie history to/from the self-hosted backend's `/v1/sync` routes (shipped in SP4a), driven by session-end, a 15-minute alarm, and a manual trigger — making history a cross-device asset.

**Architecture:** A pure `SyncEngine` (injected persistence + transport + cursor store, single-flight) drains the `syncStatus` outbox to `POST /v1/sync/push` and applies `GET /v1/sync/pull` deltas with per-record LWW. A fetch-based `SyncTransport` derives HTTP URLs from `serverUrl` (shared helper extracted from the capabilities client). The background wires triggers and gates on the server's `sync.available` capability. Spec: `docs/superpowers/specs/2026-07-07-self-hosted-history-sync-design.md`.

**Tech Stack:** TypeScript (WXT/MV3 extension), Dexie, `@echoflow/protocol` sync types, Vitest.

## Global Constraints

- **Extension tsconfig is `strict` but does NOT have `exactOptionalPropertyTypes`/`noUncheckedIndexedAccess`** (it extends the WXT-generated tsconfig). Imports have **no `.js` extension** (bundler resolution) — this differs from the backend.
- **Zero new npm dependencies.**
- **`syncStatus` never crosses the wire**: stripped from the pushed payload; forced to `"synced"` on pull-apply. `syncStatus` is device-local state only.
- **`updatedAt` is the content clock** (it feeds LWW). Sync-state changes (`setSessionSyncStatus`, engine marking synced/failed) must NOT bump `updatedAt`.
- **Sync must never block or break capture**: background triggers are fire-and-forget (`void engine.syncNow()` with caught errors); marking a session `pending` in the stop path is wrapped in try/catch.
- **LWW apply rule**: an incoming session is applied iff there is no local row OR `local.updatedAt < record.updatedAtMs` (ties keep local — a device's own echo is a no-op). Segments are put idempotently.
- **Single-flight**: concurrent `syncNow()` calls coalesce onto the in-flight run's promise.
- **Cursor**: persisted in `chrome.storage.local` under `"echoflow.syncCursor"`, advanced only after a page's records are applied (crash → idempotent re-apply).
- Sync availability is re-checked per trigger via `fetchCapabilities` → `sync.available`; unavailable/unconfigured → quiet no-op.
- All commits DCO-signed: `git commit -s`, message body ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Verification: `pnpm --filter @echoflow/extension test`, `pnpm typecheck` (root). Full suite baseline entering this slice: protocol 49 / backend 166 / extension 215.

---

### Task 1: History layer — `syncStatus` semantics fix, `putSession`, `setSessionSyncStatus`

**Files:**
- Modify: `apps/extension/src/history/historyStore.ts`
- Modify: `apps/extension/src/history/db.ts`
- Modify: `apps/extension/src/history/historyStore.test.ts`

**Interfaces:**
- Consumes: existing `HistoryPersistence`, `HistoryStore`, `SyncStatus`, `cloneSession`.
- Produces: `HistoryPersistence.putSession(session: HistorySessionRecord): Promise<void>` (blind upsert — implemented in BOTH the Dexie and in-memory persistences); `HistoryStore.setSessionSyncStatus(sessionId: string, status: SyncStatus): Promise<void>`; `recordSessionError` no longer touches `syncStatus`. Task 4 consumes `putSession`; Task 5 consumes `setSessionSyncStatus`.

- [ ] **Step 1: Write the failing tests**

In `apps/extension/src/history/historyStore.test.ts`, first FIND the existing test that asserts `recordSessionError` sets `syncStatus` to `"failed"` (search for `"failed"`) and change that assertion: the session's `syncStatus` must now REMAIN its prior value (`"local-only"`), while the `error` field is still recorded. Then append a new describe block:

```ts
describe("sync support", () => {
  it("recordSessionError leaves syncStatus untouched", async () => {
    const persistence = createInMemoryHistoryPersistence();
    const store = createHistoryStore(persistence);
    const session = await store.createLocalSession({ startedAt: 1000 });

    await store.recordSessionError(session.id, {
      code: "capture_failed",
      message: "boom",
      occurredAt: 2000
    });

    const updated = await store.getSession(session.id);
    expect(updated?.syncStatus).toBe("local-only");
    expect(updated?.error?.code).toBe("capture_failed");
  });

  it("putSession inserts a new session and overwrites an existing one", async () => {
    const persistence = createInMemoryHistoryPersistence();
    const record = {
      id: "local-1-abc",
      startedAt: 1000,
      updatedAt: 1000,
      syncStatus: "synced" as const
    };

    await persistence.putSession(record);
    expect((await persistence.getSession("local-1-abc"))?.updatedAt).toBe(1000);

    await persistence.putSession({ ...record, updatedAt: 2000 });
    expect((await persistence.getSession("local-1-abc"))?.updatedAt).toBe(2000);
  });

  it("setSessionSyncStatus updates the status without bumping updatedAt", async () => {
    const persistence = createInMemoryHistoryPersistence();
    const store = createHistoryStore(persistence);
    const session = await store.createLocalSession({ startedAt: 1000 });

    await store.setSessionSyncStatus(session.id, "pending");

    const updated = await store.getSession(session.id);
    expect(updated?.syncStatus).toBe("pending");
    expect(updated?.updatedAt).toBe(1000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @echoflow/extension test historyStore`
Expected: FAIL — `recordSessionError` still sets `"failed"`; `putSession` / `setSessionSyncStatus` do not exist.

- [ ] **Step 3: Implement**

In `apps/extension/src/history/historyStore.ts`:

(a) Change `recordSessionError`'s implementation to (removing the `syncStatus: "failed"` line — a capture error is not a sync state):

```ts
    async recordSessionError(sessionId, error) {
      const occurredAt = error.occurredAt ?? Date.now();

      await persistence.updateSession(sessionId, {
        error: {
          code: error.code,
          message: error.message,
          occurredAt
        },
        updatedAt: occurredAt
      });
    },
```

(b) Add to the `HistoryPersistence` interface, after `updateSession`:

```ts
  /** Blind upsert (sync pull-apply). addSession stays create-only. */
  putSession(session: HistorySessionRecord): Promise<void>;
```

(c) Add to the `HistoryStore` interface, after `recordSessionError`:

```ts
  /**
   * Device-local sync-state change. Deliberately does NOT bump updatedAt —
   * updatedAt is the content clock that feeds sync LWW.
   */
  setSessionSyncStatus(sessionId: string, status: SyncStatus): Promise<void>;
```

(d) Implement it in `createHistoryStore`, after `recordSessionError`:

```ts
    async setSessionSyncStatus(sessionId, status) {
      await persistence.updateSession(sessionId, { syncStatus: status });
    },
```

(e) In `createInMemoryHistoryPersistence`, add after `updateSession`:

```ts
    async putSession(session) {
      sessions.set(session.id, cloneSession(session));
    },
```

In `apps/extension/src/history/db.ts`, add to the returned persistence object after `updateSession`:

```ts
    async putSession(session) {
      await database.sessions.put(session);
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/extension test historyStore`
Expected: PASS (including the updated error-semantics assertion).

- [ ] **Step 5: Run the full extension suite** (the Options panel renders `session.syncStatus` as text — nothing derives an error badge from it, but confirm nothing else regressed)

Run: `pnpm --filter @echoflow/extension test && pnpm --filter @echoflow/extension typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/extension/src/history/
git commit -s -m "feat(extension): sync-ready history layer (putSession, setSessionSyncStatus, error/sync split)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `buildServerHttpUrl` helper (extracted from the capabilities client)

**Files:**
- Create: `apps/extension/src/settings/serverHttpUrl.ts`
- Create: `apps/extension/src/settings/serverHttpUrl.test.ts`
- Modify: `apps/extension/src/settings/capabilitiesClient.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildServerHttpUrl(serverUrl: string, path: string): string | null` — ws/wss → http/https, trailing-slash-safe path join, query/hash stripped, `null` on unparseable input. Task 3's transport consumes it; `fetchCapabilities` is refactored onto it (behavior unchanged).

- [ ] **Step 1: Write the failing test**

Create `apps/extension/src/settings/serverHttpUrl.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildServerHttpUrl } from "./serverHttpUrl";

describe("buildServerHttpUrl", () => {
  it("maps ws/wss schemes to http/https", () => {
    expect(buildServerHttpUrl("ws://127.0.0.1:8787", "/v1/sync/pull")).toBe(
      "http://127.0.0.1:8787/v1/sync/pull"
    );
    expect(buildServerHttpUrl("wss://127.0.0.1:8787", "/v1/sync/pull")).toBe(
      "https://127.0.0.1:8787/v1/sync/pull"
    );
  });

  it("keeps http/https and joins the path through a trailing slash", () => {
    expect(buildServerHttpUrl("http://127.0.0.1:8787/", "/v1/capabilities")).toBe(
      "http://127.0.0.1:8787/v1/capabilities"
    );
    expect(buildServerHttpUrl("http://localhost:8787/base/", "/v1/capabilities")).toBe(
      "http://localhost:8787/base/v1/capabilities"
    );
  });

  it("strips query and hash and trims whitespace", () => {
    expect(
      buildServerHttpUrl("  http://127.0.0.1:8787?apiKey=x#frag  ", "/v1/sync/push")
    ).toBe("http://127.0.0.1:8787/v1/sync/push");
  });

  it("returns null for an unparseable url", () => {
    expect(buildServerHttpUrl("not a url", "/v1/capabilities")).toBeNull();
    expect(buildServerHttpUrl("", "/v1/capabilities")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test serverHttpUrl`
Expected: FAIL — cannot resolve `./serverHttpUrl`.

- [ ] **Step 3: Implement + refactor the capabilities client onto it**

Create `apps/extension/src/settings/serverHttpUrl.ts`:

```ts
/**
 * Derive an HTTP(S) endpoint on the configured server from the stored
 * serverUrl (which users may enter as ws://, wss://, http:// or https://).
 * Returns null when serverUrl is unparseable.
 */
export function buildServerHttpUrl(serverUrl: string, path: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl.trim());
  } catch {
    return null;
  }

  if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  } else if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  }

  const normalizedBase = parsed.pathname.endsWith("/")
    ? parsed.pathname.slice(0, -1)
    : parsed.pathname;
  parsed.pathname = `${normalizedBase}${path}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}
```

Refactor `apps/extension/src/settings/capabilitiesClient.ts` — replace the inline URL-building block (the `let url: string; try { ... } catch { return null; }` section) with:

```ts
import {
  isCapabilitiesDescriptor,
  type CapabilitiesDescriptor,
} from "@echoflow/protocol";
import { buildServerHttpUrl } from "./serverHttpUrl";

export async function fetchCapabilities(
  serverUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CapabilitiesDescriptor | null> {
  const url = buildServerHttpUrl(serverUrl, "/v1/capabilities");
  if (url === null) {
    return null;
  }

  try {
    const response = await fetchImpl(url, { headers: { "x-api-key": apiKey } });
    if (!response.ok) {
      return null;
    }
    const data: unknown = await response.json();
    return isCapabilitiesDescriptor(data) ? data : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass** (the existing capabilitiesClient tests gate the refactor)

Run: `pnpm --filter @echoflow/extension test serverHttpUrl capabilitiesClient`
Expected: PASS — new suite green, capabilities suite unchanged-green.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/settings/
git commit -s -m "refactor(extension): extract buildServerHttpUrl from capabilities client

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Fetch `SyncTransport`

**Files:**
- Create: `apps/extension/src/sync/syncTransport.ts`
- Create: `apps/extension/src/sync/syncTransport.test.ts`

**Interfaces:**
- Consumes: `buildServerHttpUrl` (Task 2); `isSyncPullResponse`, `SyncPushRequest`, `SyncPushResponse`, `SyncPullResponse` from `@echoflow/protocol`.
- Produces: `SyncTransport = { push(request: SyncPushRequest): Promise<SyncPushResponse>; pull(since: number): Promise<SyncPullResponse> }`; `createFetchSyncTransport(options: { serverUrl: string; apiKey: string; fetchImpl?: typeof fetch }): SyncTransport | null` (null when serverUrl is unparseable). Task 4's engine consumes the `SyncTransport` type; Task 5 constructs the fetch transport.

- [ ] **Step 1: Write the failing test**

Create `apps/extension/src/sync/syncTransport.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SyncPullResponse } from "@echoflow/protocol";
import { createFetchSyncTransport } from "./syncTransport";

const emptyPull: SyncPullResponse = {
  sessions: [],
  segments: [],
  nextCursor: 7,
  hasMore: false
};

function fakeFetch(
  handler: (url: string, init?: RequestInit) => { status: number; body: unknown }
): { impl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

describe("createFetchSyncTransport", () => {
  it("returns null for an unparseable serverUrl", () => {
    expect(
      createFetchSyncTransport({ serverUrl: "not a url", apiKey: "k" })
    ).toBeNull();
  });

  it("POSTs the push request as JSON with the api key header", async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 200,
      body: { accepted: { sessions: 1, segments: 2 } }
    }));
    const transport = createFetchSyncTransport({
      serverUrl: "ws://127.0.0.1:8787",
      apiKey: "secret",
      fetchImpl: impl
    });

    const request = { sessions: [], segments: [] };
    const response = await transport!.push(request);

    expect(response.accepted).toEqual({ sessions: 1, segments: 2 });
    expect(calls[0].url).toBe("http://127.0.0.1:8787/v1/sync/push");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.headers).toMatchObject({
      "content-type": "application/json",
      "x-api-key": "secret"
    });
    expect(calls[0].init?.body).toBe(JSON.stringify(request));
  });

  it("GETs pull with the since cursor and validates the response", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: emptyPull }));
    const transport = createFetchSyncTransport({
      serverUrl: "http://127.0.0.1:8787",
      apiKey: "secret",
      fetchImpl: impl
    });

    const page = await transport!.pull(5);

    expect(page).toEqual(emptyPull);
    expect(calls[0].url).toBe("http://127.0.0.1:8787/v1/sync/pull?since=5");
    expect(calls[0].init?.headers).toMatchObject({ "x-api-key": "secret" });
  });

  it("throws on non-ok responses with the status in the message", async () => {
    const { impl } = fakeFetch(() => ({ status: 401, body: { error: "Unauthorized" } }));
    const transport = createFetchSyncTransport({
      serverUrl: "http://127.0.0.1:8787",
      apiKey: "wrong",
      fetchImpl: impl
    });

    await expect(transport!.push({ sessions: [], segments: [] })).rejects.toThrow(
      "sync_push_failed_401"
    );
    await expect(transport!.pull(0)).rejects.toThrow("sync_pull_failed_401");
  });

  it("throws when the pull response fails the protocol guard", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: { nope: true } }));
    const transport = createFetchSyncTransport({
      serverUrl: "http://127.0.0.1:8787",
      apiKey: "secret",
      fetchImpl: impl
    });

    await expect(transport!.pull(0)).rejects.toThrow("sync_pull_invalid_response");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test syncTransport`
Expected: FAIL — cannot resolve `./syncTransport`.

- [ ] **Step 3: Implement**

Create `apps/extension/src/sync/syncTransport.ts`:

```ts
import {
  isSyncPullResponse,
  type SyncPullResponse,
  type SyncPushRequest,
  type SyncPushResponse
} from "@echoflow/protocol";
import { buildServerHttpUrl } from "../settings/serverHttpUrl";

export interface SyncTransport {
  push(request: SyncPushRequest): Promise<SyncPushResponse>;
  pull(since: number): Promise<SyncPullResponse>;
}

export interface FetchSyncTransportOptions {
  serverUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/** HTTP transport for the backend /v1/sync routes. Null when serverUrl is unparseable. */
export function createFetchSyncTransport(
  options: FetchSyncTransportOptions
): SyncTransport | null {
  const pushUrl = buildServerHttpUrl(options.serverUrl, "/v1/sync/push");
  const pullUrl = buildServerHttpUrl(options.serverUrl, "/v1/sync/pull");
  if (pushUrl === null || pullUrl === null) {
    return null;
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async push(request) {
      const response = await fetchImpl(pushUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey
        },
        body: JSON.stringify(request)
      });
      if (!response.ok) {
        throw new Error(`sync_push_failed_${response.status}`);
      }
      return (await response.json()) as SyncPushResponse;
    },
    async pull(since) {
      const response = await fetchImpl(`${pullUrl}?since=${since}`, {
        headers: { "x-api-key": options.apiKey }
      });
      if (!response.ok) {
        throw new Error(`sync_pull_failed_${response.status}`);
      }
      const data: unknown = await response.json();
      if (!isSyncPullResponse(data)) {
        throw new Error("sync_pull_invalid_response");
      }
      return data;
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/extension test syncTransport`
Expected: PASS — all 5 transport tests.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/sync/
git commit -s -m "feat(extension): fetch-based SyncTransport for /v1/sync

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `SyncEngine`

**Files:**
- Create: `apps/extension/src/sync/syncEngine.ts`
- Create: `apps/extension/src/sync/syncEngine.test.ts`

**Interfaces:**
- Consumes: `HistoryPersistence` (+ `putSession` from Task 1), `createInMemoryHistoryPersistence`, `HistorySegmentRecord`, `HistorySessionRecord` from `../history/historyStore`; `SyncTransport` (Task 3); `SyncPushRequest`, `SyncSegmentRecord`, `SyncSessionRecord`, `SyncPullResponse` from `@echoflow/protocol`.
- Produces (Task 5 consumes all of these):

```ts
export interface SyncCursorStore { get(): Promise<number>; set(cursor: number): Promise<void>; }
export interface SyncResult {
  status: "ok" | "failed" | "unavailable";
  pushedSessions: number; pushedSegments: number;
  pulledSessions: number; pulledSegments: number;
  error?: string;
}
export interface SyncEngineOptions {
  persistence: HistoryPersistence;
  cursorStore: SyncCursorStore;
  getTransport: () => Promise<SyncTransport | null>;
  isSessionActive?: (sessionId: string) => boolean;
}
export interface SyncEngine { syncNow(): Promise<SyncResult>; }
export function createSyncEngine(options: SyncEngineOptions): SyncEngine;
```

- [ ] **Step 1: Write the failing tests**

Create `apps/extension/src/sync/syncEngine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type {
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse
} from "@echoflow/protocol";
import {
  createInMemoryHistoryPersistence,
  type HistorySegmentRecord,
  type HistorySessionRecord
} from "../history/historyStore";
import { createSyncEngine, type SyncCursorStore } from "./syncEngine";
import type { SyncTransport } from "./syncTransport";

function makeCursorStore(initial = 0): SyncCursorStore & { value: number } {
  const store = {
    value: initial,
    async get() {
      return store.value;
    },
    async set(cursor: number) {
      store.value = cursor;
    }
  };
  return store;
}

const EMPTY_PAGE: SyncPullResponse = {
  sessions: [],
  segments: [],
  nextCursor: 0,
  hasMore: false
};

function makeTransport(pullPages: SyncPullResponse[] = []): {
  transport: SyncTransport;
  pushes: SyncPushRequest[];
  pullSinces: number[];
  failPush: boolean;
} {
  const pages = [...pullPages];
  // Single mutable object so tests can flip failPush after construction
  // (a spread copy here would silently disconnect the flag from the closure).
  const bundle = {
    pushes: [] as SyncPushRequest[],
    pullSinces: [] as number[],
    failPush: false,
    transport: undefined as unknown as SyncTransport
  };
  bundle.transport = {
    async push(request): Promise<SyncPushResponse> {
      if (bundle.failPush) {
        throw new Error("sync_push_failed_503");
      }
      bundle.pushes.push(request);
      return {
        accepted: {
          sessions: request.sessions.length,
          segments: request.segments.length
        }
      };
    },
    async pull(since) {
      bundle.pullSinces.push(since);
      return pages.shift() ?? { ...EMPTY_PAGE, nextCursor: since };
    }
  };
  return bundle;
}

function session(
  id: string,
  syncStatus: HistorySessionRecord["syncStatus"],
  updatedAt = 1000
): HistorySessionRecord {
  return { id, startedAt: 1000, updatedAt, syncStatus };
}

function segment(sessionId: string, segmentId: string): HistorySegmentRecord {
  return {
    sessionId,
    segmentId,
    startTimeMs: 0,
    endTimeMs: 500,
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    sourceText: "hi",
    translatedText: "你好",
    status: "final"
  };
}

describe("syncEngine push", () => {
  it("pushes pending sessions with their segments and marks them synced", async () => {
    const persistence = createInMemoryHistoryPersistence();
    await persistence.addSession(session("s1", "pending"));
    await persistence.putSegment(segment("s1", "e0:seg-1"));
    const { transport, pushes } = makeTransport();

    const engine = createSyncEngine({
      persistence,
      cursorStore: makeCursorStore(),
      getTransport: async () => transport
    });
    const result = await engine.syncNow();

    expect(result.status).toBe("ok");
    expect(result.pushedSessions).toBe(1);
    expect(result.pushedSegments).toBe(1);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].sessions[0]).toMatchObject({ id: "s1", updatedAtMs: 1000 });
    expect(pushes[0].sessions[0].payload).not.toHaveProperty("syncStatus");
    expect(pushes[0].segments[0]).toMatchObject({
      sessionId: "s1",
      segmentId: "e0:seg-1"
    });
    expect((await persistence.getSession("s1"))?.syncStatus).toBe("synced");
  });

  it("sweeps failed and inactive local-only sessions, skips synced and the active session", async () => {
    const persistence = createInMemoryHistoryPersistence();
    await persistence.addSession(session("s-failed", "failed"));
    await persistence.addSession(session("s-local", "local-only"));
    await persistence.addSession(session("s-active", "local-only"));
    await persistence.addSession(session("s-done", "synced"));
    const { transport, pushes } = makeTransport();

    const engine = createSyncEngine({
      persistence,
      cursorStore: makeCursorStore(),
      getTransport: async () => transport,
      isSessionActive: (id) => id === "s-active"
    });
    const result = await engine.syncNow();

    expect(result.pushedSessions).toBe(2);
    const pushedIds = pushes.flatMap((p) => p.sessions.map((s) => s.id)).sort();
    expect(pushedIds).toEqual(["s-failed", "s-local"]);
    expect((await persistence.getSession("s-active"))?.syncStatus).toBe("local-only");
    expect((await persistence.getSession("s-done"))?.syncStatus).toBe("synced");
  });

  it("marks the session failed and reports failure when push throws", async () => {
    const persistence = createInMemoryHistoryPersistence();
    await persistence.addSession(session("s1", "pending"));
    const bundle = makeTransport();
    bundle.failPush = true;

    const engine = createSyncEngine({
      persistence,
      cursorStore: makeCursorStore(),
      getTransport: async () => bundle.transport
    });
    const result = await engine.syncNow();

    expect(result.status).toBe("failed");
    expect(result.error).toBe("sync_push_failed_503");
    expect((await persistence.getSession("s1"))?.syncStatus).toBe("failed");
    expect(bundle.pullSinces).toHaveLength(0); // pull skipped after push failure
  });
});

describe("syncEngine pull", () => {
  it("applies foreign sessions and segments as synced and persists the cursor", async () => {
    const persistence = createInMemoryHistoryPersistence();
    const cursorStore = makeCursorStore();
    const foreign = session("remote-1", "synced", 5000);
    const { syncStatus: _s, ...payload } = foreign;
    const page: SyncPullResponse = {
      sessions: [{ id: "remote-1", updatedAtMs: 5000, payload }],
      segments: [
        {
          sessionId: "remote-1",
          segmentId: "e0:seg-1",
          payload: { ...segment("remote-1", "e0:seg-1") }
        }
      ],
      nextCursor: 12,
      hasMore: false
    };
    const { transport } = makeTransport([page]);

    const engine = createSyncEngine({
      persistence,
      cursorStore,
      getTransport: async () => transport
    });
    const result = await engine.syncNow();

    expect(result.status).toBe("ok");
    expect(result.pulledSessions).toBe(1);
    expect(result.pulledSegments).toBe(1);
    expect((await persistence.getSession("remote-1"))?.syncStatus).toBe("synced");
    expect(await persistence.getSegments("remote-1")).toHaveLength(1);
    expect(cursorStore.value).toBe(12);
  });

  it("LWW: keeps a local session that is same-or-newer than the incoming record", async () => {
    const persistence = createInMemoryHistoryPersistence();
    await persistence.addSession(session("s1", "synced", 9000));
    const incoming = session("s1", "synced", 5000);
    const { syncStatus: _s, ...payload } = incoming;
    const page: SyncPullResponse = {
      sessions: [{ id: "s1", updatedAtMs: 5000, payload }],
      segments: [],
      nextCursor: 3,
      hasMore: false
    };
    const { transport } = makeTransport([page]);

    const engine = createSyncEngine({
      persistence,
      cursorStore: makeCursorStore(),
      getTransport: async () => transport
    });
    const result = await engine.syncNow();

    expect(result.pulledSessions).toBe(0);
    expect((await persistence.getSession("s1"))?.updatedAt).toBe(9000);
  });

  it("follows hasMore across pages, persisting the cursor per page", async () => {
    const persistence = createInMemoryHistoryPersistence();
    const cursorStore = makeCursorStore();
    const s1 = session("r1", "synced", 100);
    const s2 = session("r2", "synced", 200);
    const { syncStatus: _a, ...p1 } = s1;
    const { syncStatus: _b, ...p2 } = s2;
    const pages: SyncPullResponse[] = [
      {
        sessions: [{ id: "r1", updatedAtMs: 100, payload: p1 }],
        segments: [],
        nextCursor: 1,
        hasMore: true
      },
      {
        sessions: [{ id: "r2", updatedAtMs: 200, payload: p2 }],
        segments: [],
        nextCursor: 2,
        hasMore: false
      }
    ];
    const { transport, pullSinces } = makeTransport(pages);

    const engine = createSyncEngine({
      persistence,
      cursorStore,
      getTransport: async () => transport
    });
    const result = await engine.syncNow();

    expect(result.pulledSessions).toBe(2);
    expect(pullSinces).toEqual([0, 1]);
    expect(cursorStore.value).toBe(2);
  });

  it("skips malformed payloads without failing the run", async () => {
    const persistence = createInMemoryHistoryPersistence();
    const page: SyncPullResponse = {
      sessions: [{ id: "bad", updatedAtMs: 100, payload: { nope: true } }],
      segments: [
        { sessionId: "bad", segmentId: "x", payload: { alsoNope: true } }
      ],
      nextCursor: 4,
      hasMore: false
    };
    const { transport } = makeTransport([page]);

    const engine = createSyncEngine({
      persistence,
      cursorStore: makeCursorStore(),
      getTransport: async () => transport
    });
    const result = await engine.syncNow();

    expect(result.status).toBe("ok");
    expect(result.pulledSessions).toBe(0);
    expect(result.pulledSegments).toBe(0);
    expect(await persistence.getSession("bad")).toBeUndefined();
  });
});

describe("syncEngine lifecycle", () => {
  it("reports unavailable and touches nothing when getTransport resolves null", async () => {
    const persistence = createInMemoryHistoryPersistence();
    await persistence.addSession(session("s1", "pending"));

    const engine = createSyncEngine({
      persistence,
      cursorStore: makeCursorStore(),
      getTransport: async () => null
    });
    const result = await engine.syncNow();

    expect(result.status).toBe("unavailable");
    expect((await persistence.getSession("s1"))?.syncStatus).toBe("pending");
  });

  it("coalesces concurrent syncNow calls onto one run", async () => {
    const persistence = createInMemoryHistoryPersistence();
    let resolveGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    let transportRequests = 0;
    const { transport } = makeTransport();

    const engine = createSyncEngine({
      persistence,
      cursorStore: makeCursorStore(),
      getTransport: async () => {
        transportRequests += 1;
        await gate;
        return transport;
      }
    });

    const first = engine.syncNow();
    const second = engine.syncNow();
    expect(second).toBe(first); // same in-flight promise
    resolveGate();
    await first;
    expect(transportRequests).toBe(1);

    // After completion a new run starts fresh.
    const third = engine.syncNow();
    expect(third).not.toBe(first);
    await third;
    expect(transportRequests).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test syncEngine`
Expected: FAIL — cannot resolve `./syncEngine`.

- [ ] **Step 3: Implement**

Create `apps/extension/src/sync/syncEngine.ts`:

```ts
import type {
  SyncPushRequest,
  SyncSegmentRecord,
  SyncSessionRecord
} from "@echoflow/protocol";
import type {
  HistoryPersistence,
  HistorySegmentRecord,
  HistorySessionRecord
} from "../history/historyStore";
import type { SyncTransport } from "./syncTransport";

export interface SyncCursorStore {
  get(): Promise<number>;
  set(cursor: number): Promise<void>;
}

export interface SyncResult {
  status: "ok" | "failed" | "unavailable";
  pushedSessions: number;
  pushedSegments: number;
  pulledSessions: number;
  pulledSegments: number;
  error?: string;
}

export interface SyncEngineOptions {
  persistence: HistoryPersistence;
  cursorStore: SyncCursorStore;
  /** Resolved per run; null = sync unavailable right now (unconfigured server / capability off). */
  getTransport: () => Promise<SyncTransport | null>;
  /** True for the session currently being captured — excluded from the outbox. */
  isSessionActive?: (sessionId: string) => boolean;
}

export interface SyncEngine {
  syncNow(): Promise<SyncResult>;
}

const OUTBOX_STATUSES: ReadonlySet<HistorySessionRecord["syncStatus"]> = new Set([
  "pending",
  "failed",
  "local-only"
]);

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  let inFlight: Promise<SyncResult> | null = null;

  return {
    syncNow() {
      if (inFlight !== null) {
        return inFlight; // coalesce concurrent triggers onto the running sync
      }
      inFlight = run(options).finally(() => {
        inFlight = null;
      });
      return inFlight;
    }
  };
}

async function run(options: SyncEngineOptions): Promise<SyncResult> {
  const result: SyncResult = {
    status: "ok",
    pushedSessions: 0,
    pushedSegments: 0,
    pulledSessions: 0,
    pulledSegments: 0
  };

  const transport = await options.getTransport();
  if (transport === null) {
    return { ...result, status: "unavailable" };
  }

  try {
    await pushOutbox(options, transport, result);
    await pullChanges(options, transport, result);
  } catch (error) {
    result.status = "failed";
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

async function pushOutbox(
  options: SyncEngineOptions,
  transport: SyncTransport,
  result: SyncResult
): Promise<void> {
  const sessions = await options.persistence.listSessions();
  const outbox = sessions.filter(
    (session) =>
      OUTBOX_STATUSES.has(session.syncStatus) &&
      !(options.isSessionActive?.(session.id) ?? false)
  );

  for (const session of outbox) {
    const segments = await options.persistence.getSegments(session.id);
    try {
      await transport.push(toPushRequest(session, segments));
    } catch (error) {
      // Server likely unreachable: mark, stop pushing, skip pull (it would
      // fail the same way). The next trigger retries.
      await options.persistence.updateSession(session.id, { syncStatus: "failed" });
      throw error;
    }
    await options.persistence.updateSession(session.id, { syncStatus: "synced" });
    result.pushedSessions += 1;
    result.pushedSegments += segments.length;
  }
}

function toPushRequest(
  session: HistorySessionRecord,
  segments: HistorySegmentRecord[]
): SyncPushRequest {
  const { syncStatus: _syncStatus, ...payload } = session;
  return {
    sessions: [
      { id: session.id, updatedAtMs: session.updatedAt, payload: toWirePayload(payload) }
    ],
    segments: segments.map((segment) => ({
      sessionId: segment.sessionId,
      segmentId: segment.segmentId,
      payload: toWirePayload(segment)
    }))
  };
}

/** Interfaces lack index signatures; the spread + assertion bridges to the wire's opaque payload. */
function toWirePayload(value: object): Record<string, unknown> {
  return { ...value } as Record<string, unknown>;
}

async function pullChanges(
  options: SyncEngineOptions,
  transport: SyncTransport,
  result: SyncResult
): Promise<void> {
  let cursor = await options.cursorStore.get();

  for (;;) {
    const page = await transport.pull(cursor);

    for (const record of page.sessions) {
      if (await applySession(options.persistence, record)) {
        result.pulledSessions += 1;
      }
    }
    for (const record of page.segments) {
      if (await applySegment(options.persistence, record)) {
        result.pulledSegments += 1;
      }
    }

    if (page.nextCursor > cursor) {
      cursor = page.nextCursor;
      await options.cursorStore.set(cursor);
    } else if (page.hasMore) {
      // Defensive: refuse to loop without cursor progress.
      return;
    }
    if (!page.hasMore) {
      return;
    }
  }
}

async function applySession(
  persistence: HistoryPersistence,
  record: SyncSessionRecord
): Promise<boolean> {
  const payload = record.payload;
  if (
    payload.id !== record.id ||
    typeof payload.startedAt !== "number" ||
    typeof payload.updatedAt !== "number"
  ) {
    return false; // malformed foreign payload: skip, never corrupt local history
  }

  const local = await persistence.getSession(record.id);
  if (local !== undefined && local.updatedAt >= record.updatedAtMs) {
    return false; // LWW: local same-or-newer wins (a device's own echo lands here)
  }

  await persistence.putSession({
    ...(payload as unknown as Omit<HistorySessionRecord, "syncStatus">),
    syncStatus: "synced"
  });
  return true;
}

async function applySegment(
  persistence: HistoryPersistence,
  record: SyncSegmentRecord
): Promise<boolean> {
  const payload = record.payload;
  if (
    payload.sessionId !== record.sessionId ||
    payload.segmentId !== record.segmentId ||
    typeof payload.sourceText !== "string" ||
    payload.status !== "final"
  ) {
    return false;
  }

  await persistence.putSegment(payload as unknown as HistorySegmentRecord);
  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/extension test syncEngine`
Expected: PASS — all 9 engine tests.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/sync/syncEngine.ts apps/extension/src/sync/syncEngine.test.ts
git commit -s -m "feat(extension): SyncEngine — outbox push + LWW pull with cursor

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Background triggers + `SYNC_NOW` message + alarms permission + docs

**Files:**
- Modify: `apps/extension/src/messaging/messages.ts`
- Modify: `apps/extension/src/messaging/messages.test.ts`
- Modify: `apps/extension/entrypoints/background.ts`
- Modify: `apps/extension/wxt.config.ts`
- Modify: `docs/superpowers/backlog.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `createSyncEngine`, `SyncCursorStore`, `SyncResult` (Task 4); `createFetchSyncTransport` (Task 3); `setSessionSyncStatus` + `createDexieHistoryPersistence` (Task 1 / existing); `fetchCapabilities` (`src/settings/capabilitiesClient`), `loadSettings` (`src/settings/settings`).
- Produces: `SyncNowMessage { type: "SYNC_NOW" }` in the runtime-message union (SP4c's Options button sends it); sync cursor at `chrome.storage.local["echoflow.syncCursor"]`; last-success timestamp at `chrome.storage.local["echoflow.lastSyncAtMs"]` (SP4c reads it).

- [ ] **Step 1: Write the failing message-guard test**

In `apps/extension/src/messaging/messages.test.ts`, find the test that enumerates accepted message types and add a case (following the file's existing pattern for a payload-less message):

```ts
  it("accepts SYNC_NOW", () => {
    expect(isRuntimeMessage({ type: "SYNC_NOW" })).toBe(true);
  });
```

Run: `pnpm --filter @echoflow/extension test messages`
Expected: FAIL — `SYNC_NOW` not in the accepted list.

- [ ] **Step 2: Add the message type**

In `apps/extension/src/messaging/messages.ts`: add to the `RuntimeMessage` union `| SyncNowMessage`; add the interface after `CachedTranscriptMessage`:

```ts
export interface SyncNowMessage {
  type: "SYNC_NOW";
}
```

and add `"SYNC_NOW"` to the accepted-types array in `isRuntimeMessage`.

Run: `pnpm --filter @echoflow/extension test messages`
Expected: PASS.

- [ ] **Step 3: Add the alarms permission**

In `apps/extension/wxt.config.ts`, change the permissions line to:

```ts
    permissions: ["activeTab", "storage", "tabCapture", "offscreen", "scripting", "alarms"],
```

- [ ] **Step 4: Wire the background**

All edits in `apps/extension/entrypoints/background.ts`:

(a) Extend imports (top of file, alongside the existing ones):

```ts
import { createDexieHistoryPersistence } from "../src/history/db";
import { createSyncEngine, type SyncCursorStore } from "../src/sync/syncEngine";
import { createFetchSyncTransport } from "../src/sync/syncTransport";
import { fetchCapabilities } from "../src/settings/capabilitiesClient";
import { loadSettings } from "../src/settings/settings";
```

(b) Share ONE Dexie persistence between the history store and the engine — change the existing line `const historyStore = createHistoryStore();` to:

```ts
const historyPersistence = createDexieHistoryPersistence();
const historyStore = createHistoryStore(historyPersistence);
```

(c) Below the `historyStore` block, add the sync wiring:

```ts
const SYNC_ALARM_NAME = "echoflow-sync";
const SYNC_ALARM_PERIOD_MINUTES = 15;
const SYNC_CURSOR_STORAGE_KEY = "echoflow.syncCursor";
const LAST_SYNC_STORAGE_KEY = "echoflow.lastSyncAtMs";

const syncCursorStore: SyncCursorStore = {
  async get() {
    const stored = await chrome.storage.local.get(SYNC_CURSOR_STORAGE_KEY);
    const value: unknown = stored[SYNC_CURSOR_STORAGE_KEY];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  },
  async set(cursor) {
    await chrome.storage.local.set({ [SYNC_CURSOR_STORAGE_KEY]: cursor });
  }
};

const syncEngine = createSyncEngine({
  persistence: historyPersistence,
  cursorStore: syncCursorStore,
  getTransport: async () => {
    const settings = await loadSettings();
    if (!settings.serverUrl.trim() || !settings.apiKey.trim()) {
      return null;
    }
    const capabilities = await fetchCapabilities(settings.serverUrl, settings.apiKey);
    if (capabilities?.sync?.available !== true) {
      return null;
    }
    return createFetchSyncTransport({
      serverUrl: settings.serverUrl,
      apiKey: settings.apiKey
    });
  },
  isSessionActive: (sessionId) =>
    sessionState.status !== "idle" && sessionState.localSessionId === sessionId
});

/** Fire-and-forget: sync must never block or fail the capture path. */
function triggerSync(reason: string): void {
  syncEngine
    .syncNow()
    .then(async (result) => {
      if (result.status === "ok") {
        await chrome.storage.local.set({ [LAST_SYNC_STORAGE_KEY]: Date.now() });
      } else if (result.status === "failed") {
        console.warn(`EchoFlow sync failed (${reason}):`, result.error);
      }
    })
    .catch((error) => {
      console.warn(`EchoFlow sync error (${reason}):`, error);
    });
}
```

(d) Inside `defineBackground`, after the `chrome.runtime.onInstalled.addListener(...)` block, add the alarm (creation is idempotent — safe on every service-worker start):

```ts
  void chrome.alarms.create(SYNC_ALARM_NAME, {
    periodInMinutes: SYNC_ALARM_PERIOD_MINUTES
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== SYNC_ALARM_NAME) {
      return;
    }
    enqueueMessage(async () => {
      await ensureStateLoaded();
      triggerSync("alarm");
    });
  });
```

(e) In `handleRuntimeMessage`, add a case (matching the function's existing dispatch style). If the function begins with an `ensureStateLoaded()` call, place the new case AFTER it — `triggerSync` reads `sessionState` via `isSessionActive` and must see loaded state:

```ts
  if (message.type === "SYNC_NOW") {
    triggerSync("manual");
    return;
  }
```

(f) At the END of `stopSession` (after `notifyTabSessionStopped(...)`), mark the finished session for sync and trigger:

```ts
  try {
    await historyStore.setSessionSyncStatus(localSessionId, "pending");
  } catch (error) {
    // Marking is best-effort; the local-only sweep catches missed sessions.
    console.warn("EchoFlow: failed to mark session for sync", error);
  }
  triggerSync("session_end");
```

- [ ] **Step 5: Verify the whole suite + typecheck + build**

Run: `pnpm --filter @echoflow/extension test && pnpm typecheck && pnpm --filter @echoflow/extension build`
Expected: tests PASS, typecheck clean, WXT build succeeds (proves the manifest change and background imports are bundle-valid).

- [ ] **Step 6: Documentation**

In `docs/superpowers/backlog.md`, inside the SP4 entry (updated by SP4a), replace `Next: SP4b (extension SyncEngine), SP4c (options/status UI).` with:

```markdown
**SP4b — extension sync engine** shipped: `SyncEngine` (single-flight; outbox push of `pending`/`failed`/inactive-`local-only` sessions with `syncStatus` stripped from the wire payload; LWW pull-apply marking rows `synced`; cursor in `chrome.storage.local`), fetch `SyncTransport` (shared `buildServerHttpUrl`), triggers = session end + 15-min `chrome.alarms` + `SYNC_NOW`, gated per trigger on capabilities `sync.available`. `recordSessionError` no longer conflates capture errors with `syncStatus`. Next: SP4c (options/status UI).
```

In `CLAUDE.md`, in the extension architecture section, append to the `entrypoints/background.ts` bullet (after the sentence about the toolbar badge):

```
It also owns history sync (SP4b): a single-flight `SyncEngine` (`src/sync/`) pushes finished sessions (`syncStatus` outbox — sessions are marked `pending` on stop) to the backend's `/v1/sync` routes and pulls foreign deltas with per-record LWW on `updatedAt` (`syncStatus` is device-local and never crosses the wire; `updatedAt` is the content clock and is not bumped by sync-state changes). Triggers: session end, a 15-minute `chrome.alarms` period, and the `SYNC_NOW` runtime message — each gated on the server's capabilities `sync.available` flag, all fire-and-forget so sync can never break capture.
```

- [ ] **Step 7: Final verification + commit**

Run: `pnpm test && pnpm typecheck`
Expected: all packages PASS.

```bash
git add apps/extension/src/messaging/ apps/extension/entrypoints/background.ts apps/extension/wxt.config.ts docs/superpowers/backlog.md CLAUDE.md
git commit -s -m "feat(extension): background sync triggers (session end + alarm + SYNC_NOW)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
