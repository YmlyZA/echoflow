# Session Robustness Design (Direction D)

> Captured 2026-07-01. Direction D / "Backend↔Volcengine auto-reconnect" + "Drain trailing
> final on stop" from `docs/superpowers/backlog.md`. One coherent session-lifecycle slice.

## Goal

A mid-session Volcengine drop no longer kills the session: the backend transparently
reconnects the provider stream (with backoff), showing the overlay's existing "reconnecting"
pill, and resumes subtitles. And stopping mid-utterance no longer drops the last line — the
trailing final is drained before close.

## Problem (current behavior)

- **No reconnect.** In `session.ts`, a provider `onError` immediately does
  `sendError("provider_error")` + `close()` (`session.ts:144-147`), tearing down the whole
  session on any Volcengine WS blip. The extension↔backend WS already reconnects
  (`RealtimeClient` has `reconnecting`/`connected` + backoff); the **backend↔Volcengine** leg
  does not.
- **Dropped trailing final.** On `stop`, `session.ts` calls `stream.end()` then `close()`.
  Each adapter's `end()` sends the final audio frame (ASR `isLast` / AST `FinishSession`) but
  resolves before Volcengine returns the last utterance, so the in-progress final is lost.

## Non-goals (YAGNI, deferred)

- **Audio replay/buffering across the gap** — the in-flight utterance at drop time is lost;
  we accept the gap (streaming ASR cannot meaningfully replay stale audio).
- **Popup-start e2e un-skip** — separate test-infra item (headless gesture/connectivity).
- **Parked interpret minors** — in-flight-after-`end()`, double-`close()`.
- **Extension↔backend reconnect** — already exists; unchanged.

## Architecture & data flow

```
WS transport (onMessage/onError/onClose(code,reason))         [astTransport / volcengineAsrTransport]
  └─ wrapped by withReconnect(connect, {initialize, onStatus, classify, backoff})
       ├─ retryable drop → onStatus("reconnecting") → backoff → reconnect → initialize() → onStatus("live")
       └─ fatal / attempts exhausted → onError (propagate)
     used by PipelineSubtitleSource + InterpretationSubtitleSource
       └─ onStatus → source.onEvent({type:"status", state})   [protocol]
            └─ session forwards to client → reducer providerConnection → deriveOverlayStatus → 重连中… pill
```

### 1. Contract (`packages/protocol/src/events.ts`)

Add a transient connection-state event (no subtitle payload):

```ts
export type StatusEvent = {
  type: "status";
  state: "reconnecting" | "live";
};
```

Add it to the `ServerEvent` union and validate in `isServerEvent`:

```ts
case "status":
  return value.state === "reconnecting" || value.state === "live";
```

Update `events.test.ts` in the same change (accept both states; reject an unknown/absent
state). Per the repo convention, the guard and its test move together.

### 2. Backend — `withReconnect` transport wrapper (the reusable core)

**Location:** `apps/backend/src/providers/reconnectingTransport.ts` (+ test).

Both Volcengine transports share the factory shape
`(options, { onMessage, onError, onClose }) => { send, close }`. `withReconnect` wraps such a
factory and returns the same transport interface, transparently re-establishing the socket:

```ts
export type TransportStatus = "reconnecting" | "live";

export interface ReconnectOptions {
  /** Re-send the session-init frame(s) on a fresh socket (StartSession / ASR config). */
  initialize: (transport: { send: (data: Buffer) => void }) => void;
  /** Emitted on drop (reconnecting) and on recovery (live). */
  onStatus: (status: TransportStatus) => void;
  /** true → retry with backoff; false → propagate onError. Default: `defaultClassify`. */
  classify?: (info: { code?: number; error?: Error }) => boolean;
  /** Backoff schedule in ms; default exponential 500→8000, ~6 attempts. */
  backoff?: readonly number[];
  /** Injectable timer for tests. Default setTimeout. */
  setTimer?: (fn: () => void, ms: number) => void;
}
```

Behavior:
- Opens via the underlying factory, wiring a **stable** `onMessage` (so the source's message
  handling survives reconnects — it sees one continuous stream with a gap).
- On `onClose(code)` / `onError(error)`:
  - `classify` → **retryable** (abnormal socket close `1006/1011/1012/1013`, or a raw network
    error with no protocol code) vs **fatal** (a Volcengine protocol/auth error — the
    adapters raise these as `Error("AST error <code>…")` / `Error("Volcengine ASR error
    <code>…")`, matched by `defaultClassify`).
  - retryable + attempts remain → `onStatus("reconnecting")`, wait `backoff[attempt]`,
    reopen, `initialize(newTransport)`. The wrapper stays in the "reconnecting" state until
    data flows again: `onStatus("live")` and the attempt-counter reset fire on the **first
    `onMessage` after a reconnect** (the transport interface hides the socket "open" event, so
    a returning message is the reliable "recovered" signal). No status is emitted on the very
    first connect (normal startup, not a reconnect).
  - fatal, or backoff exhausted → call the wrapper consumer's `onError` (session tears down,
    as today).
- `send(data)` proxies to the live socket; **while disconnected, frames are dropped** (no
  unbounded buffer; the gap's audio is lost by design).
- `close()` stops reconnection and closes the current socket.

`defaultClassify` and `defaultBackoff` are exported for reuse/testing. Backoff default:
`[500, 1000, 2000, 4000, 8000, 8000]` (~6 attempts, ~23.5s), then fatal.

### 3. Backend — adapters adopt `withReconnect`

- **`volcengineSpeechProvider.ts`** (pipeline) and **`interpretationSubtitleSource.ts`**
  (interpret): wrap their transport creation in `withReconnect`, supplying an `initialize`
  closure that re-sends their init frame (ASR config request / AST `StartSession`). The
  existing session/request ids are **reused** across reconnects (each reconnect is a fresh WS
  connection, which Volcengine treats as a new streaming session regardless of the echoed id).
  Regenerating ids per reconnect is a documented follow-up if a real drop shows Volcengine
  rejects duplicates — it would be a change localized to the `initialize`/`connect` closures.
  `onStatus` is threaded up to the source's `onEvent` as `{ type: "status", state }`.
- The `SubtitleSource.open` callback surface stays `{ onEvent, onError }`; the status event
  rides `onEvent` (it is a `ServerEvent`). No new source-callback needed.
- Reconciler state (utterance/interpret accumulators) is **not** reset on reconnect; a fresh
  Volcengine session simply starts a new `definite` sentence. Accepted (the gap is lost
  anyway).

### 4. Backend — drain trailing final on stop

Each adapter's `end()` currently sends the final frame and resolves immediately. Change it to
**await the trailing final**: resolve once the last `definite`/final utterance for the
in-progress segment has been delivered via `onMessage`, bounded by a **timeout (~1500ms)** so
`end()` never hangs if Volcengine sends nothing. The source's `end()` awaits this plus the
existing translation `tail`, so `session.ts`'s `stop` path emits the last line before
`close()`. The fake provider's `end()` already flushes synchronously and is unchanged.

### 5. Extension wiring

- **`subtitles/reducer.ts`**: handle the new `"status"` event → track
  `providerConnection: "live" | "reconnecting"` on `SubtitleState` (default `"live"`). No
  subtitle payload changes.
- **`overlay/overlayStatus.ts`**: `deriveOverlayStatus` gains a `providerReconnecting: boolean`
  input; it returns `"reconnecting"` when either the extension↔backend `connectionStatus` is
  `"reconnecting"` OR `providerReconnecting` is true. Error precedence unchanged (error wins).
- **`entrypoints/content.tsx`**: feed `subtitleState.providerConnection === "reconnecting"`
  into `deriveOverlayStatus`. A `status:"live"` clears it.

## Error handling / edge cases

- **Fatal provider error** (auth, bad config): `classify` → fatal immediately, no pointless
  retries; session tears down with `provider_error` as today.
- **Backoff exhausted:** after ~6 failed attempts, propagate `onError` → fatal.
- **Stop during reconnect:** `close()` cancels pending reconnection; no status churn after
  close.
- **status event after close / stale session:** the extension's `localSessionId` tagging
  already discards stale messages; the reducer treats an unknown terminal state safely.
- **Drain timeout:** if no trailing final arrives within the window, `end()` resolves anyway
  (no hang); worst case the last partial simply isn't promoted — same as today.

## Testing

- **`withReconnect`** (mock transport scripting drops, injectable timer):
  - retryable close → reconnect, `initialize` re-run, `onStatus` reconnecting→live;
  - fatal error → propagate `onError`, no retry, no status;
  - backoff exhausted → fatal after N attempts;
  - `send` during the gap is dropped; after recovery it proxies again;
  - `close()` during backoff cancels the pending reconnect.
- **Drain-final:** adapter `end()` resolves after the trailing final is delivered, and
  resolves on timeout when none arrives.
- **Protocol:** `isServerEvent` for `status` (both states accepted; unknown/missing rejected).
- **Reducer:** `status` event updates `providerConnection`; `live` clears it.
- **`deriveOverlayStatus`:** `providerReconnecting` → reconnecting pill; error precedence.
- **Session:** a provider `onStatus` is forwarded to the client as a `status` event; a fatal
  error still closes.
- Backend tests use Vitest with mock transports/timers (no real Volcengine); extension tests
  are the usual pure-reducer / `renderToStaticMarkup` style.

## Rollout

1. Land on `feat/session-robustness` via PR (CI `check` gates the merge).
2. Manual check (fake provider path is unaffected; reconnect needs a real drop): with
   Volcengine creds, start a session and kill/restore connectivity briefly — confirm the
   overlay shows 重连中… then resumes, rather than erroring out. Stop mid-sentence and confirm
   the last line is retained.
3. Mark the two D items progressed in `docs/superpowers/backlog.md`.
