# Tab Lifecycle & Overlay Teardown Design (Audit Slice B)

> Captured 2026-07-02. Second slice of the repo-audit remediation. Closes the extension's
> content-script lifecycle gaps: sessions that outlive their tab, an overlay that freezes on stop,
> and a page-writable `window` event bridge into the extension's internal bus.

## Goal

The content-script side of a session has a complete lifecycle:
- Closing or navigating away from the captured tab **ends the session** (no zombie capture, badge,
  or backend WebSocket left running).
- Stopping a session **tears down the overlay** on the page instead of freezing it on the last line.
- The overlay's Stop button and its subtitle stream no longer travel through a page-observable,
  page-writable `window` `CustomEvent` — the page can neither inject fake subtitles nor stop the
  user's session.
- Re-injecting the content script does not leak a second React tree / listener set.

No new manifest permissions. The capture stream is tied to the tab and the extension holds only
localhost `host_permissions` + `activeTab`, so a navigated-away page cannot be re-injected — the
correct, honest behavior on navigation is to end the session, not silently keep capturing with no
visible overlay.

## Findings addressed

| # | Severity | Defect | File |
|---|----------|--------|------|
| 4 | medium | no tab lifecycle handling: closing the captured tab leaves a permanent "running" zombie (badge ON, WS open); navigating destroys the runtime-injected content script so the overlay vanishes while capture continues | `entrypoints/background.ts`, `src/audio/audioPipeline.ts` |
| 13 | medium | content script bridges the internal bus through a `window` `CustomEvent`; the host page can dispatch a guard-passing `echoflow:server-event` to inject fake subtitles, or `echoflow:stop-subtitles` to stop the user's session | `entrypoints/content.tsx` |
| — | low | session stop sends nothing to the content script → overlay freezes on the last subtitle with a live status | `entrypoints/background.ts`, `entrypoints/content.tsx` |
| — | low | overlay Stop sends `STOP_SESSION` with no `localSessionId`, so a stale overlay can stop a different tab's session | `entrypoints/content.tsx` |
| — | low | content-script re-injection removes the host node but never unmounts the prior React root, leaking its `chrome.runtime`/`window` listeners | `entrypoints/content.tsx` |

## Design

### 1. Remove the `window` CustomEvent bridge (#13)

`content.tsx` currently: receives a `SERVER_EVENT` runtime message → re-dispatches it as a `window`
`CustomEvent("echoflow:server-event")` → a separate `window` listener validates and dispatches into
the reducer. And Stop: button → `window` `CustomEvent("echoflow:stop-subtitles")` → `window`
listener → `chrome.runtime.sendMessage(STOP_SESSION)`.

Both round-trips are removed. The runtime-message handler dispatches straight into the reducer
(`dispatchSubtitleEvent(message.event)`), and Stop calls `chrome.runtime.sendMessage(STOP_SESSION)`
directly. The `SERVER_EVENT` payload is already an `isServerEvent`-validated `ServerEvent` produced
by the offscreen `RealtimeClient` (which parses it through `parseServerEventMessage`), so no
window-side re-validation is lost. The `window` `addEventListener`/`dispatchEvent` pair and the
`echoflow:server-event` / `echoflow:stop-subtitles` custom events are deleted entirely — the page
can no longer observe or drive the overlay.

### 2. Overlay Stop carries `localSessionId`

`content.tsx` tracks the latest `localSessionId` it has seen (every `SERVER_EVENT` /
`CONNECTION_STATUS` / `SESSION_ERROR` runtime message carries one). `handleStop` includes that id in
the `STOP_SESSION` message. Background/offscreen already honor `localSessionId` on `STOP_SESSION`
(offscreen ignores a mismatched id; background stops the current session), so a frozen stale overlay
clicking Stop no longer risks stopping a different tab's active session.

### 3. `SESSION_STOPPED` teardown message

Add a `SESSION_STOPPED` runtime message (`{ type; localSessionId }`) to `messages.ts` and
`isRuntimeMessage`. When `background.stopSession` finishes tearing a session down, it sends
`SESSION_STOPPED` to that session's tab via `chrome.tabs.sendMessage` (best-effort; a closed or
navigated tab simply rejects, which is caught). The content script, on `SESSION_STOPPED` for its
current `localSessionId`, **unmounts the overlay**: `EchoFlowMount` invokes an `onSessionEnded`
callback that `main()` wires to `root.unmount()` + host-node removal, so the overlay disappears
instead of freezing on the last line. A subsequent session start re-injects a fresh content script
(background always injects on start), so no reducer-reset action is needed.

### 4. Tab lifecycle in background (#4)

Two listeners, registered once in the background entrypoint, both routed through the existing serial
queue (Slice A) so they interleave safely with start/stop:

- `chrome.tabs.onRemoved(tabId)` — if a session is active (`connecting`/`running`/`stopping`) and
  `tabId` matches its `tabId`, enqueue `stopSession("tab_closed")`. `onRemoved` fires without the
  `tabs` permission.
- `chrome.tabs.onUpdated(tabId, changeInfo)` — if `changeInfo.status === "loading"` and `tabId`
  matches the active session's tab, enqueue `stopSession("tab_navigated")`. `status` is delivered
  without the `tabs` permission; `"loading"` marks a real document navigation/reload (SPA
  `pushState`/hash changes do not fire it, and the content script survives those anyway). Gate on an
  active session so an unrelated tab's load is ignored.

`stopSession` already broadcasts `STOP_SESSION` to offscreen and now also emits `SESSION_STOPPED`
(§3); for `tab_closed` the tab message no-ops, for `tab_navigated` it clears any overlay the new page
might still show.

### 5. Offscreen-side capture-ended safety net + content re-injection guard

- **Capture ended (#4, offscreen side):** `OffscreenAudioPipeline` gains an optional
  `onCaptureEnded?: (reason: string) => void`. In `start()`, attach an `ended` listener to each
  captured `MediaStreamTrack`; when it fires (tab closed / stream revoked out from under us), invoke
  `onCaptureEnded("capture_ended")` once. Offscreen wires it to send a `SESSION_ERROR`
  (`code: "capture_ended"`) and stop the active session — a backstop for the case where the track
  dies before/without a `tabs` event. Unit-testable with the existing fake-track harness.
- **Re-injection guard (#, low):** the content script stashes its React root on a well-known
  `window` property in the page's isolated world. `main()` unmounts a prior root (running its effect
  cleanups, which remove the `chrome.runtime` listener) before removing the host node and mounting a
  fresh tree, so a second injection into the same document cannot leave a duplicate listener. The
  same root reference is what §3's `onSessionEnded` unmounts on `SESSION_STOPPED`.

## Testing

- **`messages.test.ts`** (extend): `isRuntimeMessage` accepts `SESSION_STOPPED`.
- **`audioPipeline.test.ts`** (extend): a captured track firing `ended` invokes `onCaptureEnded`
  exactly once with `"capture_ended"`; `stop()` detaches the listener so a later `ended` does not
  fire the callback. Reuse the file's fake `getUserMedia`/track harness.
- **content-script bus** (new `src/`-level test where feasible): the bulk of `content.tsx` is
  entrypoint code (not in the vitest `src` scope), but the pure pieces — the "latest localSessionId"
  selection and the SESSION_STOPPED reset decision — are extracted into a small
  `src/subtitles/overlaySession.ts` helper and unit-tested (which message types update the tracked
  id; whether a given `SESSION_STOPPED` targets the current session). The `window`-bridge removal and
  listener wiring are covered by the local smoke/e2e.
- Background tab-lifecycle listeners are entrypoint code (no unit test by design); their trigger
  logic (does this tabId+status warrant a stop) is trivial and covered by manual + the extracted
  predicate where it isn't inline.

## Non-goals

- Restoring the overlay after navigation (needs host_permissions we intentionally lack) — we stop
  instead.
- Backend fault tolerance / stop tail-final / security Origin check → Slices C / D / E.
- Any change to the wire protocol, reducers' transition tables, or reconnect semantics.

## Rollout

1. Land on `fix/tab-lifecycle-and-overlay-teardown` via PR (CI `check` gates the merge).
2. Manual confirmation post-merge: start a session, then (a) close the tab → badge clears, no
   lingering capture; (b) navigate the tab → session ends cleanly; (c) Stop from popup → overlay
   disappears rather than freezing.
3. Update `docs/superpowers/backlog.md` to mark Slice B of the audit remediation shipped.
