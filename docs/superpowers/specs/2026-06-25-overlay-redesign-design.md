# Overlay Redesign — Design Spec

**Slice 2 of the UX overhaul arc** (see `docs/superpowers/backlog.md`). Date: 2026-06-25.

## Goal

Raise the in-page subtitle overlay to the Direction-B product bar established in Slice 1: a contained panel that recedes over video, stays legible on any footage, reads as EchoFlow (not a debug tool), and shows clear status — including which mode is live.

## Background

The overlay today (`apps/extension/src/overlay/SubtitleOverlay.tsx`, ~281 lines) is functional but off-brand:

- A boxy dark panel with **hardcoded color literals** — not wired to the `DARK_THEME` tokens (`apps/extension/src/ui/theme.ts`) that the redesigned options page uses, so it is visually inconsistent with the rest of the product.
- An **always-on** row of text-label buttons (`Move · Stop · Hide · A− · 24 · A+`) that sits permanently over the video.
- Status shown as **two separate strips** below the subtitle lines (`重连中…` reconnecting, and a red error strip).
- No indication of which **mode** (pipeline / interpret) is running.

The content script (`apps/extension/entrypoints/content.tsx`) mounts the overlay into a shadow root and owns local UI state (font size, hidden, drag position, connection status). It receives `SERVER_EVENT`, `CONNECTION_STATUS`, and `SESSION_ERROR` runtime messages (typed in `apps/extension/src/messaging/messages.ts`). Subtitle rendering state is reduced by the pure reducer in `apps/extension/src/subtitles/reducer.ts`.

## Decisions (validated via visual brainstorming)

1. **Visual model: contained panel** — keep a contained card (not floating captions, not a feathered scrim), restyled on-brand.
2. **Controls: hover-reveal** — at rest the panel shows only subtitles + the status pill; an **icon-only** control strip fades in on hover.
3. **Status pill** — a single pill carries connection lifecycle *and* the mode label; reconnecting and error states fold into the pill instead of separate strips.

## Design

### 1. Visual model — contained panel, on-brand

The panel persists but is restyled from the `DARK_THEME` tokens rather than hardcoded literals, so the overlay and the options page share one color source of truth.

- Inject the dark theme custom properties into the shadow root via `themeStyleSheet(DARK_THEME, ":host")` (from `theme.ts`). The overlay's CSS references `var(--ef-*)` instead of literal hex values.
- Panel styling: hairline border (`var(--ef-border)`), low-opacity dark backdrop, soft drop shadow, rounded corners (`RADIUS.md`).
- Layout unchanged in spirit: fixed, default bottom-center, draggable; `width: min(760px, calc(100vw - 32px))`.
- Two lines: source (`var(--ef-text)`, weight 700) above translation (`var(--ef-accent)`, weight 650). `line-height: 1.3`, `text-wrap: balance`, `overflow-wrap: anywhere` for mixed CJK + Latin.
- Font size remains user-controlled 12–48, default `DEFAULT_SUBTITLE_FONT_SIZE` (24). The drag and font-size behavior in `content.tsx` is preserved.

### 2. Controls — hover-reveal, icon-only

At rest, the panel renders only the subtitle lines and the status pill. Hovering the panel reveals a compact, icon-only control strip (CSS `:hover` + focus-within, with a fade transition):

| Icon | Action | aria-label |
|---|---|---|
| `⠿` grip | drag to reposition | "Drag subtitles" |
| `A−` | decrease font size | "Decrease subtitle font size" |
| `24` | current size (read-only `output`) | "Subtitle font size" |
| `A+` | increase font size | "Increase subtitle font size" |
| `👁` | hide | "Hide subtitles" |
| `✕` | stop session | "Stop subtitles" |

- Controls are **icon-only**; every interactive control keeps an `aria-label` so the overlay stays screen-reader accessible.
- Hover-reveal uses `:hover` and `:focus-within` on the panel so keyboard focus also reveals controls (the strip must not be reachable-but-invisible).
- The control actions and their handlers (`onStop`, `onHide`, `onDecreaseFontSize`, `onIncreaseFontSize`, `onDragStart`) are the existing props — no new handler wiring in `content.tsx` beyond the status/mode additions in §4.
- **Hidden state:** Hide collapses the panel to a small restore pill (as today). The restore affordance becomes a compact icon pill consistent with the new look.

### 3. Status pill

A single pill, anchored to the panel, carries all connection status and the mode label. Reconnecting and error fold into the pill (color + label), replacing today's two separate strips.

| Lifecycle state | Pill dot + label | Panel body |
|---|---|---|
| connecting | amber · `连接中…` | dimmed placeholder ("waiting for audio") |
| live | teal · `<mode> · LIVE` | subtitles |
| reconnecting | amber · `重连中…` | last subtitles retained |
| error | red · `连接错误` | error message shown inline (small, red, below the lines) |

- **Mode label:** `pipeline → 一致`, `interpret → 实时`. Short labels derived from the settings mode labels (the parenthetical `(免费)/(付费)` is dropped for the pill). The mode label appears in the live state (and may render in all states; mode is known from session start).
- **Error body:** When in the error state, the error message is shown inline within the panel (small red line below the translation), not as a separate strip. If there are no prior subtitles (e.g. auth failure at start), the message is the panel's primary content.

### 4. Data flow

The overlay already receives `SERVER_EVENT`, `CONNECTION_STATUS`, and `SESSION_ERROR`. Two gaps:

**Lifecycle (derived, no new data):** A new pure helper `apps/extension/src/overlay/overlayStatus.ts` maps the signals the content script already has into a single pill state. The overlay **defaults to `"connecting"` the moment it mounts** — the content script is injected at session start, so it is connecting until something arrives. No "connecting" message is sent (that would race the React mount).

```
type OverlayLifecycle = "connecting" | "live" | "reconnecting" | "error";

deriveOverlayStatus({
  connectionStatus,   // "reconnecting" | "connected" | null  (from CONNECTION_STATUS)
  hasError,           // transientError != null || a SESSION_ERROR was received
  hasSignal,          // at least one SERVER_EVENT (language/partial/final) seen
}): OverlayLifecycle
```

Mapping rules (first match wins):
- `hasError` → `"error"` (highest priority).
- `connectionStatus === "reconnecting"` → `"reconnecting"`.
- `hasSignal || connectionStatus === "connected"` → `"live"`.
- otherwise → `"connecting"`.

This helper is pure and unit-tested, matching the project convention of extending a pure reducer/helper plus its test rather than adding ad-hoc state.

**Mode (one new datum):** Carry the mode on the `SERVER_EVENT` channel, which reliably arrives with the first `language`/`partial`. (`CONNECTION_STATUS` is *not* used for mode: `RealtimeClient.onStatus` only fires on reconnect events, never on the initial connect, so it never arrives in a normal session.) The "live" pill — the only state that shows the mode label — is entered exactly when the first `SERVER_EVENT` arrives, so mode is always known before it is displayed.

- In `apps/extension/src/messaging/messages.ts`: add `mode: SubtitleMode` to `ServerEventMessage` (`import type { ServerEvent, SubtitleMode } from "@echoflow/protocol"` — `SubtitleMode` is exported from the protocol package). `ConnectionStatusMessage` is unchanged.
- In `apps/extension/src/session/sessionState.ts`: add `mode: SubtitleMode` to `ActiveSessionDetails`; the `START_CONNECTING` reducer branch sets it from `event.settings.mode` (alongside the existing `targetLanguage`).
- In `apps/extension/entrypoints/background.ts`: `forwardServerEvent` stamps `mode: sessionState.mode` onto the `SERVER_EVENT` message it sends to the tab (it already reads `sessionState` for `tabId`/`targetLanguage` in that function).
- This is an **internal extension messaging change only** — `packages/protocol` (the backend wire contract) is untouched. `isRuntimeMessage` validates by `type` only, so no per-field guard change is required; the type definitions are updated.

The content script (`content.tsx`) tracks `connectionStatus`, `hasSignal`, `hasError`, and `mode` from the messages it receives, derives the pill state via `deriveOverlayStatus`, and passes `lifecycle` + `mode` + the existing segment/error props to `SubtitleOverlay`. It also injects `themeStyleSheet(DARK_THEME, ":host")` into the shadow root once at mount.

### 5. File structure

- **Modify** `apps/extension/src/overlay/SubtitleOverlay.tsx` — new structure: status pill, hover-reveal icon strip, feathered on-brand panel, inline error fold-in. CSS references `var(--ef-*)` tokens. New props: `lifecycle: OverlayLifecycle`, `mode: SubtitleMode`. (Existing props retained.)
- **New** `apps/extension/src/overlay/overlayStatus.ts` — pure `deriveOverlayStatus` helper + the mode-label mapping.
- **New** `apps/extension/src/overlay/overlayStatus.test.ts` — unit tests for all four lifecycle states and the mode-label mapping.
- **Modify** `apps/extension/entrypoints/content.tsx` — track lifecycle + mode from messages, inject theme vars into the shadow root, derive and pass pill state.
- **Modify** `apps/extension/src/messaging/messages.ts` — add `mode: SubtitleMode` to `ServerEventMessage`.
- **Modify** `apps/extension/src/session/sessionState.ts` — add `mode` to `ActiveSessionDetails`; set it in the `START_CONNECTING` branch.
- **Modify** `apps/extension/entrypoints/background.ts` — `forwardServerEvent` stamps `mode: sessionState.mode` onto the tab message.
- **Modify** `apps/extension/src/overlay/SubtitleOverlay.test.tsx` — cover the four pill states, hover-reveal control presence, mode label, and error fold-in.

### 6. Testing

- `overlayStatus.test.ts` (new): each lifecycle branch (connecting / live / reconnecting / error), error priority over reconnecting, and `pipeline → 一致` / `interpret → 实时` label mapping.
- `SubtitleOverlay.test.tsx` (updated): renders each pill state; control strip present with `aria-label`s; mode label rendered; error message folded into the panel (no separate strip); hidden → restore pill.
- `reducer.test.ts`: unchanged — the subtitle segment state shape is stable.
- Gate: `pnpm typecheck` and `pnpm --filter @echoflow/extension test` clean.

### 7. Edge cases

- **No segment yet:** connecting state shows a dimmed placeholder, not an empty panel.
- **Long lines:** wrap with `overflow-wrap: anywhere` + `text-wrap: balance`; panel has a max height with overflow handling so it never grows unbounded.
- **Reconnect:** amber pill, last subtitles retained (not cleared).
- **Error with vs. without prior subtitles:** message folds in either way; it is the primary content when no subtitles exist.
- **Keyboard focus:** `:focus-within` reveals the control strip so controls are operable without a pointer.

## Out of scope (stays in backlog)

- **Speaker labels** (Direction C) — `spk_chg` / `speaker_id` remain ignored.
- **Auto-reconnect logic** (Direction D) — the pill *renders* the reconnecting state, but the backend↔Volcengine reconnect itself is still deferred.
- **Popup** (Slice 3) — the long-term home for mode display and quick controls; this slice only surfaces mode in the pill.
- No change to `packages/protocol` (the backend wire contract).
