# Pre-Release Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three accepted-minor fixes before the first release tag: the Options sync row stops counting the actively-capturing session as waiting (+ honest per-session failed wording), `dev.ts` shuts down gracefully, and Volcengine `UsageResponse(154)` events are logged instead of dropped.

**Architecture:** (a) `deriveSyncStatusView` gains `activeSessionId` and per-id exclusion mirroring the engine's outbox rule; Options reads the background's persisted session state from `chrome.storage.session`. (b) `SIGINT`/`SIGTERM` → `server.close()` in `dev.ts`. (c) `parseAstMessage`'s usage case renders the payload's top-level protobuf fields generically into a `details` string; the interpret source logs it. Spec: `docs/superpowers/specs/2026-07-07-pre-release-polish-design.md`.

**Tech Stack:** TypeScript; extension (strict TS, no `.js` extensions) + backend (`.js` extensions, exactOptionalPropertyTypes) conventions as established.

## Global Constraints

- Zero new npm dependencies; no new permissions; no protocol (`packages/protocol`) changes.
- NO apostrophes in any new user-facing label (renderToStaticMarkup escaping gotcha).
- The active-session exclusion is **by id** (`id !== activeSessionId`), NOT by status — it must mirror `syncEngine.ts`'s `isSessionActive` outbox rule exactly.
- (c) performs NO semantic interpretation of usage fields: field numbers + varint values / byte lengths only, ascending field order, the event field itself skipped.
- All commits DCO-signed: `git commit -s`, body ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Baseline entering this slice: protocol 49 / backend 166 / extension 249; typecheck + build clean.

---

### Task 1: Sync UX — active-session exclusion + failed wording + Options wiring

**Files:**
- Modify: `apps/extension/src/sync/syncStatusView.ts`
- Modify: `apps/extension/src/sync/syncStatusView.test.ts` (rewrite — input shape changes)
- Modify: `apps/extension/entrypoints/options/main.tsx`

**Interfaces:**
- Consumes: `loadPersistedState`, `SESSION_STATE_STORAGE_KEY`, `PersistedSessionState` from `src/session/sessionStore` (existing); the existing `SyncSection`/`HistoryPanel` wiring from SP4c.
- Produces: `SyncStatusViewInput` becomes `{ syncAvailable: boolean | null; lastSyncAtMs: number | null; sessions: ReadonlyArray<{ id: string; syncStatus: SyncStatus }>; activeSessionId: string | null }` — the ONLY call site is `HistoryPanel` in options `main.tsx`, updated in this same task (the shapes must land together or typecheck breaks).

- [ ] **Step 1: Rewrite the test file (failing)**

Replace the contents of `apps/extension/src/sync/syncStatusView.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { deriveSyncStatusView } from "./syncStatusView";

const fmt = (ms: number) => `T${ms}`;

function session(
  id: string,
  syncStatus: "local-only" | "pending" | "synced" | "failed"
) {
  return { id, syncStatus };
}

function derive(input: {
  syncAvailable?: boolean | null;
  lastSyncAtMs?: number | null;
  sessions?: Array<{ id: string; syncStatus: "local-only" | "pending" | "synced" | "failed" }>;
  activeSessionId?: string | null;
}) {
  return deriveSyncStatusView(
    {
      syncAvailable: input.syncAvailable ?? true,
      lastSyncAtMs: input.lastSyncAtMs ?? null,
      sessions: input.sessions ?? [],
      activeSessionId: input.activeSessionId ?? null
    },
    fmt
  );
}

describe("deriveSyncStatusView", () => {
  it("is unavailable (button disabled) when the server lacks sync or capabilities are unknown", () => {
    for (const syncAvailable of [false, null] as const) {
      const view = derive({ syncAvailable });
      expect(view.tone).toBe("unavailable");
      expect(view.label).toBe("Sync is not available on this server");
      expect(view.canSyncNow).toBe(false);
    }
  });

  it("excludes the actively-capturing session from the waiting count", () => {
    const view = derive({
      sessions: [session("active", "local-only"), session("done", "synced")],
      activeSessionId: "active"
    });
    expect(view.tone).toBe("empty");
    expect(view.label).toBe("Nothing to sync yet");
  });

  it("reports failed sessions with an honest per-session label", () => {
    const view = derive({
      lastSyncAtMs: 1000,
      sessions: [session("a", "failed"), session("b", "pending"), session("c", "synced")]
    });
    expect(view.tone).toBe("failed");
    expect(view.label).toBe("1 session could not sync");
    expect(view.canSyncNow).toBe(true);
  });

  it("pluralizes the failed label", () => {
    const view = derive({
      sessions: [session("a", "failed"), session("b", "failed")]
    });
    expect(view.label).toBe("2 sessions could not sync");
  });

  it("excludes the active session from the failed check too (rule is by id)", () => {
    const view = derive({
      lastSyncAtMs: 500,
      sessions: [session("active", "failed"), session("done", "synced")],
      activeSessionId: "active"
    });
    expect(view.tone).toBe("ok");
    expect(view.label).toBe("Last synced T500");
  });

  it("counts pending, failed and local-only sessions as waiting", () => {
    const view = derive({
      sessions: [session("a", "pending"), session("b", "local-only"), session("c", "synced")]
    });
    expect(view.tone).toBe("waiting");
    expect(view.label).toBe("2 sessions waiting to sync");
  });

  it("uses the singular form for one waiting session", () => {
    const view = derive({ sessions: [session("a", "pending")] });
    expect(view.label).toBe("1 session waiting to sync");
  });

  it("shows the last-synced time when nothing is waiting", () => {
    const view = derive({ lastSyncAtMs: 1234, sessions: [session("a", "synced")] });
    expect(view.tone).toBe("ok");
    expect(view.label).toBe("Last synced T1234");
    expect(view.canSyncNow).toBe(true);
  });

  it("shows an empty state before any sync", () => {
    const view = derive({});
    expect(view.tone).toBe("empty");
    expect(view.label).toBe("Nothing to sync yet");
    expect(view.canSyncNow).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test syncStatusView`
Expected: FAIL — `activeSessionId` unknown / labels differ.

- [ ] **Step 3: Implement the view rework**

Replace the contents of `apps/extension/src/sync/syncStatusView.ts` with:

```ts
import type { SyncStatus } from "../history/historyStore";

export interface SyncStatusViewInput {
  /** Capabilities sync.available; null while capabilities are unknown. */
  syncAvailable: boolean | null;
  lastSyncAtMs: number | null;
  sessions: ReadonlyArray<{ id: string; syncStatus: SyncStatus }>;
  /**
   * The currently-capturing session, excluded from waiting/failed counts —
   * mirrors the engine outbox rule (isSessionActive), which never pushes it.
   */
  activeSessionId: string | null;
}

export interface SyncStatusView {
  tone: "unavailable" | "failed" | "waiting" | "ok" | "empty";
  label: string;
  canSyncNow: boolean;
}

const WAITING_STATUSES: ReadonlySet<SyncStatus> = new Set([
  "pending",
  "failed",
  "local-only"
]);

/** Pure derivation of the Options sync-status row from already-loaded state. */
export function deriveSyncStatusView(
  input: SyncStatusViewInput,
  formatTime: (ms: number) => string = defaultFormatTime
): SyncStatusView {
  if (input.syncAvailable !== true) {
    return {
      tone: "unavailable",
      label: "Sync is not available on this server",
      canSyncNow: false
    };
  }

  const relevant = input.sessions.filter(
    (session) => session.id !== input.activeSessionId
  );
  const waiting = relevant.filter((session) =>
    WAITING_STATUSES.has(session.syncStatus)
  ).length;
  const failed = relevant.filter(
    (session) => session.syncStatus === "failed"
  ).length;

  if (failed > 0) {
    return {
      tone: "failed",
      label: `${failed} ${failed === 1 ? "session" : "sessions"} could not sync`,
      canSyncNow: true
    };
  }
  if (waiting > 0) {
    return {
      tone: "waiting",
      label: `${waiting} ${waiting === 1 ? "session" : "sessions"} waiting to sync`,
      canSyncNow: true
    };
  }
  if (input.lastSyncAtMs !== null) {
    return {
      tone: "ok",
      label: `Last synced ${formatTime(input.lastSyncAtMs)}`,
      canSyncNow: true
    };
  }
  return { tone: "empty", label: "Nothing to sync yet", canSyncNow: true };
}

function defaultFormatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
```

Run: `pnpm --filter @echoflow/extension test syncStatusView` — expected: PASS (9 tests).

- [ ] **Step 4: Wire the Options page** (read `apps/extension/entrypoints/options/main.tsx` first; anchor on the quoted code)

(a) Extend imports:

```tsx
import {
  loadPersistedState,
  SESSION_STATE_STORAGE_KEY,
  type PersistedSessionState
} from "../../src/session/sessionStore";
```

(b) In `HistoryPanel`, alongside the existing sync state hooks, add:

```tsx
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
```

(c) After the existing `lastSyncAtMs` effect, add (background persists its session state to `chrome.storage.session`, readable from extension pages):

```tsx
  useEffect(() => {
    let mounted = true;
    const applySessionState = (state: PersistedSessionState) => {
      setActiveSessionId(
        state.sessionState.status !== "idle" ? state.sessionState.localSessionId : null
      );
    };
    void loadPersistedState()
      .then((state) => {
        if (mounted) applySessionState(state);
      })
      .catch(() => {});

    const onSessionChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (area !== "session" || !(SESSION_STATE_STORAGE_KEY in changes)) {
        return;
      }
      void loadPersistedState()
        .then((state) => applySessionState(state))
        .catch(() => {});
    };
    chrome.storage.onChanged.addListener(onSessionChanged);
    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(onSessionChanged);
    };
  }, []);
```

(d) Update the `SyncSection` render to pass the new field:

```tsx
      <SyncSection
        view={deriveSyncStatusView({ syncAvailable, lastSyncAtMs, sessions, activeSessionId })}
        syncing={syncing}
        onSyncNow={syncNow}
      />
```

- [ ] **Step 5: Verify**

Run: `pnpm --filter @echoflow/extension test && pnpm --filter @echoflow/extension typecheck && pnpm --filter @echoflow/extension build`
Expected: all PASS/clean.

- [ ] **Step 6: Commit**

```bash
git add apps/extension/src/sync/syncStatusView.ts apps/extension/src/sync/syncStatusView.test.ts apps/extension/entrypoints/options/main.tsx
git commit -s -m "fix(extension): sync row excludes the active session; honest failed wording

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Backend polish — usage logging + graceful shutdown + docs

**Files:**
- Modify: `apps/backend/src/providers/astProtocol.ts`
- Modify: `apps/backend/src/providers/astProtocol.test.ts`
- Modify: `apps/backend/src/realtime/interpretationSubtitleSource.ts`
- Modify: `apps/backend/src/dev.ts`
- Modify: `docs/superpowers/backlog.md`

**Interfaces:**
- Consumes: existing `parseAstMessage`, `ProtoField = { wireType: number; value: bigint | Buffer }`, `C.AST_RESP_FIELD_EVENT` / `C.AST_EVENT_USAGE` constants, the test file's `vField`/`sField` proto-building helpers.
- Produces: `AstServerEvent`'s usage variant becomes `{ kind: "usage"; details: string }`. `details` format: for each top-level field number ascending (skipping `AST_RESP_FIELD_EVENT`), each occurrence renders as `` `${field}=${varintValue}` `` for varints or `` `${field}=bytes(${byteLength})` `` for length-delimited, joined by single spaces.

- [ ] **Step 1: Write the failing test**

In `apps/backend/src/providers/astProtocol.test.ts`, first search the file for any existing assertion on `{ kind: "usage" }` and update it to the new shape if present. Then append (inside the existing `parseAstMessage` describe block if there is one, else as a new describe):

```ts
describe("parseAstMessage usage events", () => {
  it("renders the usage payload fields generically, skipping the event field", () => {
    const message = Buffer.concat([
      vField(C.AST_RESP_FIELD_EVENT, C.AST_EVENT_USAGE),
      vField(7, 1234),
      sField(9, "abc"),
    ]);

    expect(parseAstMessage(message)).toEqual({
      kind: "usage",
      details: "7=1234 9=bytes(3)",
    });
  });

  it("renders an empty details string when the usage event carries no extra fields", () => {
    const message = vField(C.AST_RESP_FIELD_EVENT, C.AST_EVENT_USAGE);

    expect(parseAstMessage(message)).toEqual({ kind: "usage", details: "" });
  });
});
```

Run: `pnpm --filter @echoflow/backend test astProtocol`
Expected: FAIL — parsed value is `{ kind: "usage" }` without `details`.

- [ ] **Step 2: Implement the generic decode**

In `apps/backend/src/providers/astProtocol.ts`:

(a) Change the union member in `AstServerEvent` from `| { kind: "usage" }` to:

```ts
  | { kind: "usage"; details: string }
```

(b) Change the switch case in `parseAstMessage` from `return { kind: "usage" };` to:

```ts
    case C.AST_EVENT_USAGE:
      return { kind: "usage", details: describeFields(fields) };
```

(c) Add near the other private helpers (after `parseSubtitle`):

```ts
/**
 * Compact, deterministic rendering of a message's top-level fields — varints
 * as `n=value`, length-delimited as `n=bytes(len)` — ascending field order,
 * skipping the event field. No semantic interpretation: the usage payload's
 * field meanings are unverified, and each logged line doubles as a sample for
 * a future structured decode.
 */
function describeFields(fields: Map<number, ProtoField[]>): string {
  const parts: string[] = [];
  for (const field of [...fields.keys()].sort((a, b) => a - b)) {
    if (field === C.AST_RESP_FIELD_EVENT) {
      continue;
    }
    for (const entry of fields.get(field) ?? []) {
      parts.push(
        Buffer.isBuffer(entry.value)
          ? `${field}=bytes(${entry.value.length})`
          : `${field}=${entry.value}`,
      );
    }
  }
  return parts.join(" ");
}
```

Run: `pnpm --filter @echoflow/backend test astProtocol` — expected: PASS.

- [ ] **Step 3: Log usage in the interpret source**

In `apps/backend/src/realtime/interpretationSubtitleSource.ts`, the message handler currently has (around line 69):

```ts
      if (event.kind === "other" || event.kind === "usage") return;
```

Replace with:

```ts
      if (event.kind === "usage") {
        // Billing-relevant; field semantics unverified — log the generic decode.
        console.info("EchoFlow: volcengine usage", event.details);
        return;
      }
      if (event.kind === "other") return;
```

Run: `pnpm --filter @echoflow/backend test interpretationSubtitleSource` — expected: PASS (existing tests; if any test feeds a usage event and asserts on console, follow that file's existing spy conventions).

- [ ] **Step 4: Graceful shutdown in dev.ts**

In `apps/backend/src/dev.ts`, after the final `console.log(...)` line, append:

```ts
// Graceful shutdown: server.close() runs the onClose hooks (e.g. the sqlite
// history repository). process.once so a second signal falls through to
// Node's default handler and kills a hung shutdown.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log(`Received ${signal}, shutting down...`);
    void server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
```

Run: `pnpm --filter @echoflow/backend typecheck` — expected: clean.

- [ ] **Step 5: Docs**

In `docs/superpowers/backlog.md`, find the line:

```markdown
- **Usage / billing tracking** — the `UsageResponse(154)` event is currently ignored; record usage for the paid mode.
```

and replace it with:

```markdown
- 🟡 **Usage / billing tracking** — `UsageResponse(154)` is now decoded generically and logged (`EchoFlow: volcengine usage` + field dump; `astProtocol.ts` `describeFields`). Structured decode/persistence deferred until real samples confirm the field semantics — the logged lines are those samples.
```

- [ ] **Step 6: Final verification + commit**

Run: `pnpm test && pnpm typecheck`
Expected: all packages PASS (backend gains 2 tests).

```bash
git add apps/backend/src/providers/astProtocol.ts apps/backend/src/providers/astProtocol.test.ts apps/backend/src/realtime/interpretationSubtitleSource.ts apps/backend/src/dev.ts docs/superpowers/backlog.md
git commit -s -m "feat(backend): log Volcengine usage events; graceful dev shutdown

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
