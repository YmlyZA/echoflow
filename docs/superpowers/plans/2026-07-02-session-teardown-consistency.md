# Session Teardown Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the extension's session start/stop race-free and ownership-checked so "start then immediately stop", "double-click Start", and "connect-while-being-replaced" stop producing zombie capture sessions, orphaned backend WebSockets, and mislabeled error UI.

**Architecture:** Three small, unit-tested `src/` helpers (a serial queue, an active-session ownership predicate, a unique-id source) carry the testable contract; the untested entrypoints (`background.ts`, `offscreen/main.ts`) and the WebSocket client are then wired to use them. All changes are in `apps/extension`; no protocol, reducer-transition, or reconnect-semantics changes.

**Tech Stack:** TypeScript (ESM), WXT + React 19 MV3, Vitest, existing fake-`WebSocket` harness in `realtimeClient.test.ts`.

## Global Constraints

- All work is in `apps/extension`. No changes to `packages/protocol` or `apps/backend`.
- The extension tsconfig is `strict` but does **not** enable `exactOptionalPropertyTypes`/`noUncheckedIndexedAccess` — assigning a possibly-undefined value to an optional property is allowed here.
- Provider secrets never appear in the extension. No new dependencies.
- Vitest runs colocated `*.test.ts`; the extension `test` script targets `src` only — entrypoint files (`background.ts`, `offscreen/main.ts`) are NOT unit-tested (covered by local smoke/e2e). Put testable logic in `src/`.
- Per-package check after each task: `pnpm --filter @echoflow/extension typecheck` and `pnpm --filter @echoflow/extension test` must stay green.
- Commit trailer on every commit:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

---

### Task 1: `createSerialQueue` helper

**Files:**
- Create: `apps/extension/src/messaging/serialQueue.ts`
- Test: `apps/extension/src/messaging/serialQueue.test.ts`

**Interfaces:**
- Produces: `createSerialQueue(onError?: (error: unknown) => void): (task: () => Promise<void>) => void` — returns an `enqueue` function that runs tasks one at a time in arrival order; a rejecting task is passed to `onError` (default: swallow) and does not stall the chain.

- [ ] **Step 1: Write the failing test**

```ts
// apps/extension/src/messaging/serialQueue.test.ts
import { describe, expect, it, vi } from "vitest";
import { createSerialQueue } from "./serialQueue";

describe("createSerialQueue", () => {
  it("runs tasks one at a time in arrival order", async () => {
    const order: string[] = [];
    const enqueue = createSerialQueue();
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      enqueue(async () => {
        order.push("a-start");
        resolve();
        await new Promise<void>((r) => {
          releaseFirst = r;
        });
        order.push("a-end");
      });
    });

    enqueue(async () => {
      order.push("b");
    });

    await firstStarted;
    expect(order).toEqual(["a-start"]); // b has NOT started while a is in flight
    releaseFirst();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });

  it("isolates a rejecting task and keeps draining", async () => {
    const onError = vi.fn();
    const enqueue = createSerialQueue(onError);
    const ran: string[] = [];

    enqueue(async () => {
      throw new Error("boom");
    });
    enqueue(async () => {
      ran.push("after");
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(ran).toEqual(["after"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- serialQueue`
Expected: FAIL — cannot find module `./serialQueue`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/extension/src/messaging/serialQueue.ts

/**
 * Runs async tasks strictly one at a time in the order they were enqueued.
 * A rejecting task is reported to `onError` and does not break the chain, so
 * later tasks still run. Used to serialize lifecycle message handling so a
 * STOP cannot interleave into a half-finished START.
 */
export function createSerialQueue(
  onError: (error: unknown) => void = () => {}
): (task: () => Promise<void>) => void {
  let tail: Promise<void> = Promise.resolve();

  return (task: () => Promise<void>) => {
    tail = tail.then(task).catch(onError);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/extension test -- serialQueue`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

```bash
git add apps/extension/src/messaging/serialQueue.ts apps/extension/src/messaging/serialQueue.test.ts
git commit -m "feat(extension): serial queue helper for lifecycle message ordering

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `RealtimeClient` honors `stopped` during initial connect

**Files:**
- Modify: `apps/extension/src/realtime/realtimeClient.ts` (`connect` ~79-97, `openSocket().onopen` ~157-170)
- Test: `apps/extension/src/realtime/realtimeClient.test.ts` (extend the `RealtimeClient reconnect` describe block; reuse the file's `FakeWebSocket` + `createClient`/`createConnectedClient` helpers)

**Interfaces:**
- Consumes: existing `RealtimeClient` public API (`connect`, `stop`) and the file's `FakeWebSocket` harness (`open()`, `remoteClose()`, `sentText`).
- Produces: no signature change; new guaranteed behavior — after `stop()`, `connect()` opens no further socket, sends no `start`, and does not call `onError`.

- [ ] **Step 1: Write the failing tests**

Add inside `describe("RealtimeClient reconnect", …)` (it has `FakeWebSocket` in scope):

```ts
  it("opens no further socket when stopped during a connect retry", async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const client = createClient({ onError });
      const connecting = client.connect();

      // First attempt fails to open (connection refused before open).
      FakeWebSocket.instances[0].remoteClose();
      client.stop();

      await vi.advanceTimersByTimeAsync(1000);
      await connecting;

      expect(FakeWebSocket.instances).toHaveLength(1); // no retry socket
      expect(onError).not.toHaveBeenCalled(); // stop is not a failure
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send start if stopped before the socket opens", async () => {
    const client = createClient();
    const connecting = client.connect();

    client.stop(); // stop lands while the socket is still CONNECTING
    FakeWebSocket.instances[0].open(); // late open fires afterwards

    await connecting;

    expect(FakeWebSocket.instances[0].sentText).toHaveLength(0); // no "start"
    expect(FakeWebSocket.instances[0].readyState).toBe(3); // closed
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @echoflow/extension test -- realtimeClient`
Expected: FAIL — first test finds a 2nd `FakeWebSocket` instance (retry after stop); second test finds a `start` message in `sentText`.

- [ ] **Step 3: Guard the connect retry loop**

In `connect()` (realtimeClient.ts ~79), replace the loop body so a stop short-circuits it without erroring:

```ts
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (this.stopped) {
        return;
      }

      try {
        await this.openSocket();
        return;
      } catch (error) {
        if (this.stopped) {
          // The stop closed our in-flight socket; that rejection is expected,
          // not a connection failure — exit quietly without onError.
          return;
        }

        if (attempt >= maxAttempts) {
          const clientError = toClientError(
            error,
            "connection_failed",
            "Realtime connection failed"
          );
          this.options.onError?.(clientError);
          throw new Error(clientError.message);
        }

        await delay(this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
      }
    }
```

- [ ] **Step 4: Guard the `onopen` handler**

In `openSocket()` (realtimeClient.ts ~157), add a stopped check at the very top of `onopen`, before `send(start)`/`resolve`:

```ts
      socket.onopen = () => {
        if (this.stopped) {
          // Opened after stop(): close it and reject so connect() exits without
          // ever sending "start" — this is what prevented the un-reclaimable
          // backend session.
          socket.close();
          reject(new Error("Realtime connection stopped before opening"));
          return;
        }

        opened = true;
        this.epoch += 1;
        this.reconnectAttempts = 0;
        socket.send(JSON.stringify(this.createStartMessage()));
        if (this.epoch > 1) {
          this.options.onStatus?.("connected");
        }
        resolve();
      };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/extension test -- realtimeClient`
Expected: PASS — new tests green, and the existing `"does not reconnect after an intentional stop"` and connect/reconnect tests still pass.

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

```bash
git add apps/extension/src/realtime/realtimeClient.ts apps/extension/src/realtime/realtimeClient.test.ts
git commit -m "fix(extension): RealtimeClient honors stop during initial connect

Guards the connect retry loop and onopen against a stop() that lands while a
socket is still connecting, so no new socket is opened and no start frame is
sent after stop (no orphaned backend session).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `isMessageForActiveSession` ownership predicate

**Files:**
- Create: `apps/extension/src/session/activeSession.ts`
- Test: `apps/extension/src/session/activeSession.test.ts`

**Interfaces:**
- Consumes: `SessionState` from `./sessionState`.
- Produces: `isMessageForActiveSession(state: SessionState, messageLocalSessionId: string | undefined): boolean` — `false` when idle; `true` when the message carries no id (legacy/no-id path); otherwise `true` only if the id equals the active session's `localSessionId`. This is the guard `handleSessionStarted`/`forwardServerEvent` already apply inline, extracted so `handleSessionError` (Task 5) can reuse it and it is unit-testable off the entrypoint.

- [ ] **Step 1: Write the failing test**

```ts
// apps/extension/src/session/activeSession.test.ts
import { describe, expect, it } from "vitest";
import { isMessageForActiveSession } from "./activeSession";
import type { SessionState } from "./sessionState";

const running: SessionState = {
  status: "running",
  localSessionId: "local-active",
  tabId: 1,
  streamId: "stream-1",
  targetLanguage: "zh-CN",
  mode: "pipeline"
};

describe("isMessageForActiveSession", () => {
  it("is false when idle", () => {
    expect(isMessageForActiveSession({ status: "idle" }, "local-active")).toBe(false);
  });

  it("is true when the id matches the active session", () => {
    expect(isMessageForActiveSession(running, "local-active")).toBe(true);
  });

  it("is false when the id belongs to a replaced session", () => {
    expect(isMessageForActiveSession(running, "local-stale")).toBe(false);
  });

  it("treats a message with no id as targeting the active session", () => {
    expect(isMessageForActiveSession(running, undefined)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- activeSession`
Expected: FAIL — cannot find module `./activeSession`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/extension/src/session/activeSession.ts
import type { SessionState } from "./sessionState";

/**
 * Whether a runtime message should drive the currently active session's state
 * and UI. A message tagged with a different localSessionId belongs to a session
 * that has since been replaced and must be ignored (its own history may still be
 * recorded by the caller). A message with no id is treated as current for
 * backward compatibility with senders that omit it.
 */
export function isMessageForActiveSession(
  state: SessionState,
  messageLocalSessionId: string | undefined
): boolean {
  if (state.status === "idle") {
    return false;
  }

  if (messageLocalSessionId === undefined) {
    return true;
  }

  return messageLocalSessionId === state.localSessionId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/extension test -- activeSession`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

```bash
git add apps/extension/src/session/activeSession.ts apps/extension/src/session/activeSession.test.ts
git commit -m "feat(extension): active-session ownership predicate for stale-message filtering

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Unique local session ids

**Files:**
- Modify: `apps/extension/src/history/historyStore.ts` (`CreateLocalSessionInput` ~30-37; `createLocalSession` ~81-88)
- Test: `apps/extension/src/history/historyStore.test.ts` (extend; update the export-text assertion at ~111)

**Interfaces:**
- Consumes: nothing new.
- Produces: `CreateLocalSessionInput` gains `randomSuffix?: () => string`; ids become `local-${timestamp}-${suffix}` (suffix defaults to `crypto.randomUUID()`), while `startedAt` stays the numeric timestamp. Two calls in the same millisecond now yield distinct ids.

- [ ] **Step 1: Write the failing test + fix the existing export assertion**

Add a new test (place near the other `createLocalSession` tests):

```ts
  it("generates distinct ids for calls in the same millisecond", async () => {
    const store = createHistoryStore(createInMemoryPersistence());
    const a = await store.createLocalSession({ now: () => 42 });
    const b = await store.createLocalSession({ now: () => 42 });

    expect(a.id).not.toBe(b.id);
    expect(a.startedAt).toBe(42);
    expect(b.startedAt).toBe(42);
    expect(a.id.startsWith("local-42-")).toBe(true);
  });
```

> Note: use whatever persistence factory the sibling tests use (e.g. `createInMemoryPersistence()` / the file's existing in-memory helper). Match the existing imports at the top of `historyStore.test.ts`.

Update the existing export-text test so its generated id is deterministic. At the `createLocalSession` call that uses `now: () => 30` (~line 82), add `randomSuffix: () => "s"`, and change the expected line (~111) from `"Session: local-30"` to `"Session: local-30-s"`.

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `pnpm --filter @echoflow/extension test -- historyStore`
Expected: FAIL — the same-millisecond ids are currently equal (both `local-42`); the export test also fails until the impl honors `randomSuffix`.

- [ ] **Step 3: Implement the suffix**

In `CreateLocalSessionInput` add:

```ts
  now?: () => number;
  randomSuffix?: () => string;
```

In `createLocalSession`:

```ts
    async createLocalSession(input = {}) {
      const timestamp = input.startedAt ?? input.now?.() ?? Date.now();
      const suffix = (input.randomSuffix ?? (() => crypto.randomUUID()))();
      const session: HistorySessionRecord = {
        id: `local-${timestamp}-${suffix}`,
        startedAt: timestamp,
        updatedAt: timestamp,
        syncStatus: input.syncStatus ?? "local-only"
      };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/extension test -- historyStore`
Expected: PASS — new uniqueness test green; export test green with `local-30-s`; the `/^local-/` prefix assertion (~line 24) still matches.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

```bash
git add apps/extension/src/history/historyStore.ts apps/extension/src/history/historyStore.test.ts
git commit -m "fix(extension): unique local session ids to avoid same-millisecond collision

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Wire the entrypoints — serial queues, ownership-scoped teardown, offscreen-doc robustness

**Files:**
- Modify: `apps/extension/entrypoints/background.ts` (onMessage listener ~56-62; `handleSessionError` ~199-228; `ensureOffscreenDocument` ~285-301)
- Modify: `apps/extension/entrypoints/offscreen/main.ts` (onMessage listener ~21-43; `startSession` catch ~106-115)

**Interfaces:**
- Consumes: `createSerialQueue` (Task 1), `isMessageForActiveSession` (Task 3).
- Produces: no exported API change — entrypoint wiring only. Covered by local smoke/e2e, not vitest.

- [ ] **Step 1: Serialize background message handling (#7)**

In `background.ts`, import the queue and enqueue instead of `void`-ing:

```ts
import { createSerialQueue } from "../src/messaging/serialQueue";
```

Replace the listener body:

```ts
  const enqueueMessage = createSerialQueue((error) => {
    console.error("EchoFlow background message handler failed", error);
  });

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!isRuntimeMessage(message)) {
      return;
    }

    enqueueMessage(() => handleRuntimeMessage(message));
  });
```

- [ ] **Step 2: Filter stale errors in `handleSessionError` (#5)**

In `background.ts`, import the predicate:

```ts
import { isMessageForActiveSession } from "../src/session/activeSession";
```

Rewrite `handleSessionError` so a stale-session error only writes history:

```ts
async function handleSessionError(message: SessionErrorMessage): Promise<void> {
  // A late error from a session that has since been replaced must not corrupt
  // the current session's state/badge/UI — record its own history and return.
  if (
    message.localSessionId &&
    sessionState.status !== "idle" &&
    !isMessageForActiveSession(sessionState, message.localSessionId)
  ) {
    await historyStore.recordSessionError(message.localSessionId, {
      code: message.code,
      message: message.message
    });
    return;
  }

  if (sessionState.status !== "idle") {
    await commitSessionState(
      reduceSessionState(sessionState, {
        type: "SESSION_ERROR",
        error: { code: message.code, message: message.message }
      })
    );
  }

  const localSessionId =
    message.localSessionId ??
    (sessionState.status === "idle" ? undefined : sessionState.localSessionId);

  if (localSessionId) {
    await historyStore.recordSessionError(localSessionId, {
      code: message.code,
      message: message.message
    });
  }

  if (sessionState.status !== "idle") {
    await sendMessageToTab(sessionState.tabId, message);
  }

  await clearBadge();
}
```

- [ ] **Step 3: Make `ensureOffscreenDocument` tolerate the single-document race (#14)**

In `background.ts`, wrap the create call:

```ts
async function ensureOffscreenDocument(): Promise<void> {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl]
  });

  if (contexts.length > 0) {
    return;
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["USER_MEDIA"],
      justification: "Capture tab audio for realtime subtitles."
    });
  } catch (error) {
    // Serialization (the background message queue) makes concurrent creation
    // unreachable, but if the document already exists the goal is met — Chrome
    // rejects a second createDocument with this specific message.
    const alreadyExists =
      error instanceof Error &&
      error.message.includes("Only a single offscreen document");
    if (!alreadyExists) {
      throw error;
    }
  }
}
```

- [ ] **Step 4: Serialize offscreen handling and scope its start-failure teardown (#6, #7)**

In `offscreen/main.ts`, import the queue and serialize START/STOP:

```ts
import { createSerialQueue } from "../../src/messaging/serialQueue";
```

```ts
const enqueueMessage = createSerialQueue((error) => {
  console.error("EchoFlow offscreen message handler failed", error);
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isRuntimeMessage(message)) {
    return;
  }

  if (message.type === "START_SESSION") {
    enqueueMessage(() => startSession(message));
    return;
  }

  if (message.type === "STOP_SESSION") {
    if (
      message.localSessionId &&
      activeSession &&
      message.localSessionId !== activeSession.localSessionId
    ) {
      return;
    }

    enqueueMessage(() => stopActiveSession(message.reason ?? "stop_session"));
    return;
  }
});
```

Scope the `startSession` catch so it never tears down a session that replaced this one. Hoist the `pipeline` into a local visible to the catch:

```ts
async function startSession(message: StartSessionMessage): Promise<void> {
  await stopActiveSession("replaced_by_new_session");

  let pipeline: OffscreenAudioPipeline | undefined;
  try {
    const tab = await getTabMetadata(message.tabId);
    const client = new RealtimeClient({
      // …unchanged options…
    });
    pipeline = new OffscreenAudioPipeline({
      streamId: message.streamId,
      client,
      workletModuleUrl: chrome.runtime.getURL("pcm-encoder.worklet.js")
    });

    activeSession = {
      localSessionId: message.localSessionId,
      pipeline
    };

    await client.connect();
    await pipeline.start();

    await chrome.runtime.sendMessage({
      type: "SESSION_STARTED",
      localSessionId: message.localSessionId
    } satisfies SessionStartedMessage);
  } catch (error) {
    if (activeSession?.localSessionId === message.localSessionId) {
      // This invocation still owns the active session — full teardown.
      await stopActiveSession("start_failed");
    } else if (pipeline) {
      // A newer session replaced us mid-await; only clean up what we created,
      // leaving the current activeSession intact.
      await pipeline.stop("start_failed_superseded");
    }

    await chrome.runtime.sendMessage({
      type: "SESSION_ERROR",
      localSessionId: message.localSessionId,
      code: "offscreen_start_failed",
      message:
        error instanceof Error ? error.message : "Failed to start offscreen session"
    } satisfies SessionErrorMessage);
  }
}
```

> Keep the `RealtimeClient` options block exactly as it is today (the `onEvent`/`onError`/`onStatus` handlers are unchanged); only the `pipeline` declaration is hoisted and the `catch` body is rewritten.

- [ ] **Step 5: Verify the whole extension package is green (static — no unit test for entrypoints)**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

Run: `pnpm --filter @echoflow/extension test`
Expected: PASS — all pre-existing `src` tests plus Tasks 1-4's new tests green (entrypoint wiring has no unit test by design).

Run these greps to confirm the wiring is in place:

Run: `grep -n "enqueueMessage" apps/extension/entrypoints/background.ts apps/extension/entrypoints/offscreen/main.ts`
Expected: the listener in each file enqueues rather than `void`-ing.

Run: `grep -n "start_failed_superseded\|isMessageForActiveSession\|Only a single offscreen" apps/extension/entrypoints`
Expected: the superseded-cleanup branch, the stale-error guard, and the create-document guard are all present.

- [ ] **Step 6: Commit**

```bash
git add apps/extension/entrypoints/background.ts apps/extension/entrypoints/offscreen/main.ts
git commit -m "fix(extension): serialize lifecycle messages and ownership-scope teardown

Enqueue background/offscreen runtime messages on a serial queue so a STOP can
no longer interleave into a half-finished START; scope the offscreen start
failure teardown to the invocation that still owns activeSession; ignore stale
replaced-session errors in handleSessionError; tolerate the single-offscreen
document race.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- #2 (connect honors stopped) → Task 2. ✅
- #5 (handleSessionError ownership) → Task 3 (predicate) + Task 5 Step 2 (wiring). ✅
- #6 (offscreen catch ownership) → Task 5 Step 4. ✅
- #7 (serialization) → Task 1 (queue) + Task 5 Steps 1 & 4 (wiring). ✅
- #14 (offscreen-doc race + id collision) → Task 4 (id) + Task 5 Step 3 (doc). ✅
- Testing plan (serialQueue, realtimeClient stopped, isMessageForActiveSession, historyStore unique id) → Tasks 1-4. ✅

**Placeholder scan:** No TBD/TODO. All code shown in full; the one soft reference (Task 4's persistence factory) is flagged to match the file's existing sibling tests, not left blank.

**Type consistency:** `createSerialQueue` returns `(task: () => Promise<void>) => void` and is called that way in both entrypoints. `isMessageForActiveSession(state, messageLocalSessionId)` signature matches its Task 5 call. `randomSuffix?: () => string` added to `CreateLocalSessionInput` and read in `createLocalSession`. `pipeline` hoisted to `OffscreenAudioPipeline | undefined` and null-checked in the catch.

**Ordering:** Tasks 1-4 are independent `src/` additions (each self-contained, package stays green); Task 5 depends on 1 & 3 and consumes 2 & 4's behavior. Every task leaves `typecheck` + `test` green.
