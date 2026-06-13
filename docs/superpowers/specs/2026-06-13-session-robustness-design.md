# Spec 2 — Session Robustness (SW-restart recovery + in-session reconnect)

**Date:** 2026-06-13
**Status:** Approved (design)
**Scope track:** Technical-debt paydown, sub-project 2 of 2 (Spec 1 = realtime pipeline & segment-semantics refactor, already merged).

## Problem

Two independent robustness gaps surfaced in the Spec 1 review, plus one P2 cleanup. All three are about keeping a *running* session alive and consistent.

**A. MV3 service-worker restart orphans the session.** `background.ts` holds `sessionState` and `detectedSourceLanguage` as module-global variables. MV3 reclaims an idle service worker (~30 s), but the offscreen document keeps the WebSocket and audio capture running independently. On SW restart the globals reset to `idle`/`"unknown"`, so:
- `forwardServerEvent` sees `status === "idle"` and **drops** every `SERVER_EVENT` the offscreen document still forwards → subtitles freeze, history stops recording.
- the toolbar badge is wrong, and a toolbar click takes the "start a new session" path while the old offscreen session is still streaming → conflict.

**B. No in-session reconnect.** `RealtimeClient.connect()` retries only the *initial* open (3×). After a connection is established, an unexpected close is unhandled: subsequent `sendAudioFrame` throws `"Realtime connection is not open"` and the session dies silently.

**P2. `finalizedSegmentIds` grows unbounded.** `subtitles/reducer.ts` accumulates every finalized segment id forever and scans it with `.includes()` (O(n)) on every partial.

A correctness coupling ties A and B together: **reconnect causes a segment-id collision.** After reconnect the backend is a *fresh* session — the fake provider restarts at `seg-1` and re-emits `language`. The overlay reducer's `reducePartialEvent` early-returns when `finalizedSegmentIds.includes(segmentId)`, so a post-reconnect `seg-1` is silently ignored (subtitles never resume), and history's `[sessionId+segmentId]` primary key overwrites the old row. Reconnect is not "done" until segment ids are made unique across connections.

## Goals / Success Criteria

- After an SW restart mid-session, the background recovers its view of the running session: `SERVER_EVENT`s are accepted again, history keeps recording, the badge is correct, and a toolbar click correctly *stops* the session.
- An unexpected WebSocket close during a running session triggers bounded exponential-backoff reconnection with a re-sent handshake; audio frames during the gap are dropped (not buffered); the user sees a "重连中…" indicator; exhausting the retry budget surfaces a terminal error and stops the session.
- Segment ids are unique across reconnects, so subtitles resume and history does not overwrite.
- `finalizedSegmentIds` is bounded.
- All logic covered by deterministic unit tests (DI + in-memory adapters + `vi.useFakeTimers`), consistent with the existing test style.

## Non-Goals (YAGNI)

- Buffering/replaying audio across the reconnect gap (the chosen behavior is drop-frames).
- Backend session resumption (resuming segment numbering across a fresh WS connection) — out of scope; handled client-side via epoch namespacing.
- Active heartbeat reconciliation between background and offscreen — the `chrome.storage.session` lifetime aligns with the offscreen lifetime (see §1), so a passive fallback suffices.
- `apiKey`-in-query-string hardening — still documented as an accepted localhost-MVP limitation.

## Design

### §1 Part A — SW-restart recovery via `chrome.storage.session`

New module `apps/extension/src/session/sessionStore.ts` persists `{ sessionState, detectedSourceLanguage }` to `chrome.storage.session`, mirroring the settings storage-adapter pattern:

- `SessionStateStorage` — a small `{ get, set }` interface (locally defined; does not couple to settings' `SettingsStorageAdapter`).
- `createChromeSessionStorageAdapter()` — wraps `chrome.storage.session` (analogous to settings' `createChromeStorageAdapter` over `chrome.storage.local`).
- `loadPersistedState(storage?)` / `persistState(value, storage?)` — typed load/save of the persisted blob; an in-memory adapter backs the tests.

**Why `storage.session`, not `storage.local`:** its lifetime aligns with the offscreen document's. SW restart preserves both; extension reload/update and browser close clear both. So the persisted "is a session running" never disagrees with "is the offscreen document still streaming" across the events that matter. `storage.local` would leave a stale running-session across a browser restart (after which the offscreen document is gone).

**`background.ts` changes (rehydrate-before-handle):**

```ts
let sessionState = createInitialSessionState();
let detectedSourceLanguage = "unknown";
let stateLoaded: Promise<void> | undefined;

function ensureStateLoaded(): Promise<void> {
  stateLoaded ??= loadPersistedState().then((persisted) => {
    sessionState = persisted.sessionState;
    detectedSourceLanguage = persisted.detectedSourceLanguage;
  });
  return stateLoaded;
}

async function commitSessionState(next: SessionState): Promise<void> {
  sessionState = next;
  await persistState({ sessionState, detectedSourceLanguage });
}
```

- Every async entry point (`handleActionClick`, `handleRuntimeMessage`) awaits `ensureStateLoaded()` first.
- Every `sessionState` mutation goes through `commitSessionState(...)` (assign + persist; awaited, so no write races).
- A `language` event that updates only `detectedSourceLanguage` (no `sessionState` change) persists explicitly with `persistState({ sessionState, detectedSourceLanguage })` — `forwardServerEvent` already runs in an async context, so this is a plain `await`.
- After rehydrate: `forwardServerEvent` sees the real (non-idle) state and keeps forwarding + recording; the badge is restored from status; a toolbar click takes the correct stop path.

**Stale-state fallback (no heartbeat):** the only residual mismatch is a rare offscreen crash leaving a persisted `running`. That is handled lazily — on the next toolbar click the stop path sends `STOP_SESSION` to a (possibly absent) offscreen document and clears state regardless. No active reconciliation.

### §2 Part B — `RealtimeClient` in-session reconnect

Reconnection lives in `RealtimeClient` (it owns the socket) and is transparent to the offscreen pipeline (which keeps calling `sendAudioFrame` every 250 ms).

New options (all defaulted, DI-friendly): `maxReconnectAttempts` (default 5), `reconnectBaseDelayMs` (default 500), `reconnectMaxDelayMs` (default 8000), `onStatus?: (status: "reconnecting" | "connected") => void`.

State machine:
- New internal state: `stopped` (set by `stop()`), `reconnectAttempts`, `epoch` (see §4).
- **Successful open:** `epoch += 1`; `reconnectAttempts = 0`; re-send `createStartMessage()`; `onStatus("connected")`.
- **Unexpected close** (already settled AND not `stopped`): `scheduleReconnect()` — delay `min(reconnectBaseDelayMs · 2^(reconnectAttempts), reconnectMaxDelayMs)`, `onStatus("reconnecting")`, then re-open.
- **Retry budget exhausted** (`reconnectAttempts >= maxReconnectAttempts`): `onError({ code: "connection_lost", message })`. No further attempts. (Terminal failure flows through the existing `onError` channel — NOT through `onStatus` — so there is one failure signal, not two.)
- `stop()` sets `stopped = true`; its close does not reconnect.

`sendAudioFrame` changes from "throw if socket not open" to **silently drop** (`if not OPEN: return`). This realizes the drop-frames behavior and keeps the pipeline unaware of connection state.

**Terminal teardown:** when `onError(connection_lost)` fires, `offscreen/main.ts`'s `onError` handler additionally calls `stopActiveSession(...)` (a permanently lost connection should stop audio capture). The background still handles the resulting `SESSION_ERROR` as today (record error, clear badge, set `error` state).

### §3 Surfacing "reconnecting" to the overlay

Connection status is a *client-side* concept (the backend does not know about reconnect), so it travels on its own runtime message, not inside a wire `ServerEvent`.

Path:
```
RealtimeClient.onStatus("reconnecting"|"connected")          [offscreen]
  → CONNECTION_STATUS runtime message { localSessionId, status }
  → background: (1) forward to sessionState.tabId  (2) badge: reconnecting→"...", connected→"ON"
  → content.tsx runtime listener → setConnectionStatus(useState)
  → <SubtitleOverlay connectionStatus> renders a "重连中…" banner (shown on reconnecting, cleared on connected)
```

Changes:
- `messaging/messages.ts`: add `ConnectionStatusMessage { type: "CONNECTION_STATUS"; localSessionId: string; status: "reconnecting" | "connected" }` to the `RuntimeMessage` union and the `isRuntimeMessage` type list.
- `offscreen/main.ts`: pass `onStatus` to the `RealtimeClient`, forwarding as `CONNECTION_STATUS`.
- `background.ts`: handle `CONNECTION_STATUS` — forward to `sessionState.tabId` and update the badge via the existing `setBadge`/`clearBadge` (depends on §1 rehydrated `tabId`).
- `content.tsx`: a `useState` updated by the `CONNECTION_STATUS` message (handled directly, not routed through the subtitle reducer), passed to the overlay.
- `overlay/SubtitleOverlay.tsx`: a `connectionStatus` prop; render a banner when `"reconnecting"`.

**Why `connectionStatus` lives in overlay state, not the reducer:** the `subtitles/reducer.ts` input contract is the wire `ServerEvent` (subtitle content); connection liveness is orthogonal client meta. Keeping it as overlay state preserves the reducer's focused input type; the banner renders from a prop and is tested in `SubtitleOverlay.test.tsx`. The `content.tsx` wiring is thin glue (covered by component integration, like `background.ts`).

### §4 Segment-id epoch namespacing

`RealtimeClient` tracks `epoch` (first connection = 1, `+1` per successful open). In `handleServerMessage`, after parsing and before `onEvent`, rewrite the `segmentId` of `partial`/`final` events via a pure helper `withEpochSegmentId(event, epoch)`: `seg-1` → `e1:seg-1`, post-reconnect → `e2:seg-1`. `language`/`error` events (no `segmentId`) pass through unchanged.

- The first connection is prefixed too (uniform; no mixed prefixed/unprefixed ids).
- `segmentId` is a purely internal key — history export uses timestamps/source/translated text, never the id — so the prefix is invisible to users.
- Effect: ids are globally unique across reconnects, so the reducer's `finalizedSegmentIds.includes` no longer kills the post-reconnect `seg-1`, and history's primary key never overwrites. This is what makes §2 actually resume on reconnect.

### §5 P2 — bound `finalizedSegmentIds`

In `subtitles/reducer.ts`, `appendFinalizedSegmentId` keeps only the most recent `MAX_FINALIZED_TRACKED = 50` ids (`slice(-50)` after append). The set is used only to ignore a late partial for an already-finalized segment, which in streaming only happens for the current/recent segment, so a 50-id window is safe. Pure reducer change.

### §6 Testing

| Layer | Tests |
|---|---|
| `session/sessionStore.ts` (new) | save → load round-trips `{ sessionState, detectedSourceLanguage }` through an in-memory adapter. |
| `realtime/realtimeClient.ts` | injected `WebSocketCtor` + `vi.useFakeTimers`: unexpected close → reconnect after backoff → handshake re-sent; backoff doubles up to the cap; after `maxReconnectAttempts` → `onError(connection_lost)` and no further attempts; clean `stop()` → no reconnect; `onStatus` emits `reconnecting`/`connected`; `sendAudioFrame` during the gap neither throws nor sends. |
| epoch | `withEpochSegmentId`: first connection `e1:`, post-reconnect `e2:`; `language`/`error` pass through. |
| `messaging/messages.ts` | `isRuntimeMessage` accepts `CONNECTION_STATUS`. |
| `overlay/SubtitleOverlay.tsx` | `connectionStatus="reconnecting"` renders the banner; absent/`"connected"` does not. |
| `subtitles/reducer.ts` | after 60 finals, `finalizedSegmentIds.length <= 50`; a late partial for a still-tracked recent final is still ignored. |

`dev-smoke.sh` / Playwright smoke remain unchanged and valid. Backend is untouched by this spec.

## File structure

- **Create:** `apps/extension/src/session/sessionStore.ts` (+ `.test.ts`) — `SessionStateStorage` interface, `createChromeSessionStorageAdapter()`, `loadPersistedState`/`persistState`, in-memory adapter for tests.
- **Modify:**
  - `apps/extension/src/realtime/realtimeClient.ts` — reconnect state machine, `onStatus`, epoch + `withEpochSegmentId`, non-throwing `sendAudioFrame`.
  - `apps/extension/src/messaging/messages.ts` — `ConnectionStatusMessage` + guard.
  - `apps/extension/entrypoints/background.ts` — rehydrate-before-handle, `commitSessionState`, `CONNECTION_STATUS` handling + badge.
  - `apps/extension/entrypoints/offscreen/main.ts` — `onStatus` wiring + terminal `stopActiveSession`.
  - `apps/extension/entrypoints/content.tsx` — `connectionStatus` state from `CONNECTION_STATUS`.
  - `apps/extension/src/overlay/SubtitleOverlay.tsx` — reconnecting banner prop.
  - `apps/extension/src/subtitles/reducer.ts` — bounded `finalizedSegmentIds`.

## Implementation sequencing (one plan, three groups)

1. **Part A** — `sessionStore` + `background.ts` rehydrate/commit.
2. **Part B core** — `RealtimeClient` reconnect + epoch + `offscreen` terminal stop.
3. **Surfacing + P2** — `CONNECTION_STATUS` path (messages → offscreen → background → content → overlay) + bounded `finalizedSegmentIds`.
