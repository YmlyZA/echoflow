# Session Teardown Consistency Design (Audit Slice A)

> Captured 2026-07-02. First slice of the repo-audit remediation. Fixes the cluster of
> extension session-lifecycle defects that share a single root cause: the start/stop paths
> interleave and stale participants can act on a session they no longer own.

## Goal

The extension's session start/stop is race-free and ownership-checked end to end:
- `RealtimeClient` never opens a new socket or sends `start` after `stop()`.
- A superseded `startSession` invocation cannot tear down the session that replaced it.
- Background and offscreen process lifecycle messages **serially**, so a `STOP` cannot
  interleave into a half-finished `START`.
- Every lifecycle handler ignores messages that belong to a replaced session
  (`localSessionId` mismatch) — including `handleSessionError`, currently the only one that
  does not.
- Rapid double-Start cannot collide on the offscreen document or on the local session id.

No happy-path behavior changes; the observable effect is that "start then immediately stop",
"double-click Start", and "connect-while-being-replaced" stop producing zombie capture
sessions, orphaned backend WebSockets, and mislabeled error UI.

## Findings addressed

From the audit (confirmed + verified):

| # | Severity | Defect | File |
|---|----------|--------|------|
| 2 | high | `connect()` retry loop + `openSocket().onopen` ignore `this.stopped`; stop during connect spawns a fresh socket that sends `start` and is never closed | `src/realtime/realtimeClient.ts:79` |
| 5 | medium | `handleSessionError` is the only handler with no `localSessionId` match; a replaced session's late error corrupts the current session's state/badge/UI | `entrypoints/background.ts:199` |
| 6 | medium | offscreen `startSession` catch block calls `stopActiveSession` unconditionally, killing the session that already replaced it | `entrypoints/offscreen/main.ts:107` |
| 7 | medium | background/offscreen message handling is not serialized; `await` gaps in `startSession` let a `STOP_SESSION` interleave → "background idle, offscreen still capturing" zombie | `entrypoints/background.ts:106` |
| 14 | medium | double-click Start races `ensureOffscreenDocument` (check-then-create throws "Only a single offscreen document") and collides on `local-${Date.now()}` session ids | `entrypoints/background.ts:287` |

These are one failure chain: #7 (no serialization) is the enabler; #2/#6 are the two ways a
stale participant survives an `await` and acts on the wrong session; #5 is the missing
ownership check that lets the resulting stale error surface; #14 is the double-Start entry
point that triggers the whole chain.

## Design

### 1. `RealtimeClient` honors `stopped` during initial connect (#2)

`connect()` retry loop:
- Check `this.stopped` at the top of each iteration and return early (a stop is not a failure —
  do **not** invoke `onError`).
- In the `catch`, if `this.stopped` is now true, return early (swallow the socket-close
  rejection triggered by our own `stop()`), before the `attempt >= maxAttempts` / `onError` path.

`openSocket().onopen`:
- If `this.stopped`, `socket.close()` and `reject(...)` **before** `send(start)` / `resolve()`.
  This is the critical guard: it prevents a socket that opens *after* `stop()` from ever sending
  `start`, which is what created the un-reclaimable backend session.

The existing reconnect path already checks `stopped` (`handleUnexpectedClose`,
`scheduleReconnect`, the timer callback); this brings the initial-connect path to parity.

### 2. Offscreen `startSession` catch is ownership-scoped (#6)

Capture the `pipeline` created by *this* invocation in a local `const`. In the `catch`:
- If `activeSession?.localSessionId === message.localSessionId`, this invocation still owns the
  session → `await stopActiveSession("start_failed")` (unchanged behavior).
- Otherwise this invocation was superseded → do a **local** best-effort cleanup of the pipeline
  it created (`await pipeline?.stop("start_failed_superseded")`) and leave `activeSession`
  (the newer session) untouched.

The `SESSION_ERROR` emitted from the catch keeps this invocation's `localSessionId`, so with
fix #5 the background will not apply it to the newer session.

### 3. Serial message queue in background and offscreen (#7)

Add a tiny reusable helper `src/messaging/serialQueue.ts`:

```ts
export function createSerialQueue(): (task: () => Promise<void>) => void;
```

It chains tasks on a single promise (`tail = tail.then(task).catch(onError)`) so they run one at
a time in arrival order; a rejecting task is caught (logged) and does not break the chain.

- `background.ts`: the `chrome.runtime.onMessage` listener enqueues `handleRuntimeMessage(message)`
  instead of `void`-ing it. All lifecycle transitions (start, stop, session-started, error) are
  now serialized, closing the `await`-gap interleave.
- `offscreen/main.ts`: the `START_SESSION` / `STOP_SESSION` handling enqueues onto its own serial
  queue, so a `STOP` cannot run between `startSession`'s `await`s.

Serializing all runtime messages (not just lifecycle ones) is intentional: handlers are all
short awaits on chrome/Dexie APIs, and in-order processing is exactly the property the teardown
path needs. The known consequence — `SERVER_EVENT` forwarding now waits behind the queue — is
acceptable here (per-message cost is a few ms); optimizing the forward path (history-write
ordering) is deferred to audit Slice D and is not in scope.

### 4. `handleSessionError` ignores replaced-session errors (#5)

At the top of `handleSessionError`, mirror the guard the other handlers already use:

- If `message.localSessionId` is present, the state is non-idle, and
  `message.localSessionId !== sessionState.localSessionId` → the error belongs to a replaced
  session. **Only** `recordSessionError(message.localSessionId, …)` for history, then return.
  Do not reduce `sessionState`, do not clear the badge, do not notify the current tab.

Extract the ownership check as a pure helper `isMessageForActiveSession(state, localSessionId)`
in `src/session/` (reused conceptually by the other handlers) so it is unit-testable without the
entrypoint.

### 5. Double-Start safety: offscreen doc + session id (#14)

- **Local session id collision:** `historyStore.createLocalSession` derives its id from
  `local-${timestamp}`. Add a random suffix so two calls in the same millisecond cannot collide:
  `id: \`local-${timestamp}-${suffix}\`` (suffix from `crypto.randomUUID()`), keeping
  `startedAt: timestamp` unchanged. The `now`/`startedAt` injection points stay for test
  determinism; add an injectable id/suffix source if a test needs a stable id.
- **Offscreen document race:** serialization (#3) already prevents two `ensureOffscreenDocument`
  calls from running concurrently. As defense in depth, wrap `chrome.offscreen.createDocument` so
  the specific "Only a single offscreen document may be created" error is caught and treated as
  success (the document exists — the goal is met).

## Testing

The core lesson from the audit is that these files have **no** unit coverage. Where the fix has
pure logic, extract and test it; where it lives in the WebSocket client, use the existing fake
harness.

- **`serialQueue.test.ts`** (new): tasks run in order; a later task waits for an earlier one's
  promise; a rejecting task is isolated and the queue keeps draining.
- **`realtimeClient.test.ts`** (extend): (a) calling `stop()` while a connect attempt is
  in-flight does not open a further socket and never sends `start`; (b) if `stop()` lands between
  socket construction and `onopen`, `onopen` closes the socket and does not send `start`; (c) the
  stopped exit does not invoke `onError`. Uses the existing fake `WebSocketCtor` + `vi.useFakeTimers`.
- **`isMessageForActiveSession` test** (new, in `src/session/`): mismatch when ids differ,
  match when equal, and the "no id on message" / "idle state" fallthrough cases.
- **`historyStore.test.ts`** (extend): two `createLocalSession` calls with the same injected
  timestamp yield distinct ids; `startedAt` still equals the timestamp.

Background/offscreen wiring (enqueue instead of `void`, the catch ownership branch, the
`handleSessionError` early return) remains entrypoint code covered by the local smoke/e2e, not
vitest — the extracted helpers carry the unit-level contract.

## Non-goals

- Tab lifecycle (page navigation destroying the content script, tab-close zombies) → audit Slice B.
- The stop tail-final drain race and latest-wins history loss → audit Slice D.
- Backend fault tolerance, security (Origin check) → audit Slices C / E.
- Any change to the wire protocol, reducers' transition table, or reconnect semantics.

## Rollout

1. Land on `fix/session-teardown-consistency` via PR (CI `check` gates the merge).
2. The extracted helpers + RealtimeClient tests run in `pnpm test`.
3. Manual confirmation post-merge: start a session then immediately Stop → no lingering capture
   indicator, no orphaned backend connection; double-click Start → single healthy session.
4. Update `docs/superpowers/backlog.md` to mark Slice A of the audit remediation shipped.
