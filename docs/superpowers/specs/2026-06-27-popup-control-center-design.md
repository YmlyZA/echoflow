# Popup Control Center — Design Spec

**Slice 3 of the UX overhaul arc** (see `docs/superpowers/backlog.md`). Date: 2026-06-27.

## Goal

Add a toolbar popup that becomes EchoFlow's product home — start/stop, live status, and quick controls (mode, target language) — on the Direction-B light theme, reusing the building blocks established in Slices 1–2.

## Background

Today there is **no popup**. Clicking the toolbar icon fires `chrome.action.onClicked` (`apps/extension/entrypoints/background.ts`), which directly **toggles** the session: `handleActionClick` starts a session when idle (validating settings, opening Options if invalid, fetching the `tabCapture` stream id from the click gesture) and stops it when running. A `pendingStart` queue handles a click that lands during teardown. The badge shows `...`/`ON`.

Session lifecycle lives in the background: `sessionState` (`apps/extension/src/session/sessionState.ts`) reduces `idle / connecting / running / stopping / error`. The background owns `startSession` (creates a Dexie local history session via `historyStore`, reduces `START_CONNECTING`, ensures the offscreen document, calls `chrome.tabCapture.getMediaStreamId`, reduces `STREAM_READY`, sends `START_SESSION` to the offscreen) and `stopSession`.

Reusable pieces already exist from Slices 1–2:
- `apps/extension/src/ui/theme.ts` — `LIGHT_THEME`, `themeStyleSheet`, `RADIUS`, `FONT_STACK`.
- `apps/extension/src/ui/SegmentedControl.tsx` — generic segmented control (used for mode).
- `apps/extension/src/ui/LanguagePicker.tsx` — searchable capability-driven picker.
- `apps/extension/src/settings/capabilitiesClient.ts` — `fetchCapabilities(serverUrl, apiKey)`.
- `apps/extension/src/settings/languageSelection.ts` — `sourceOptions`/`targetOptions`/`coercePair`/`filterLanguages`.
- `apps/extension/src/settings/settings.ts` — `loadSettings`/`saveSettings`/`validateSettings`, `SUBTITLE_MODE_OPTIONS`, `counterpartSource`.
- `apps/extension/src/history/` — Dexie history store (recent sessions).

## Decisions (validated via visual brainstorming)

1. **Popup role: control center** — the icon opens the popup; start/stop moves into it. The popup is the primary surface; full Options is the escape hatch.
2. **Layout A (action hero)** — header (wordmark + status pill) → big Start/Stop → quick controls (mode, language) → recent history → footer "Open full settings".
3. **Mode labels go bare** — drop the `(免费)/(付费)` parentheticals from `SUBTITLE_MODE_OPTIONS` (`一致` / `实时`) across Options and the popup; paywall framing returns when billing is built.
4. **Quick controls editable while running** — mode and language stay editable during a session with an "applies next session" hint (changes are read at the next session start, consistent with current behavior).
5. **No live subtitle preview in the popup** — subtitles already render on the page via the overlay; the live-card shows tab · mode · elapsed only (no new live-segment data path into the popup).
6. **Capture gesture moves to the popup** — the Start button click is the user gesture; the popup obtains the `streamId` and hands it to the background, which keeps its session orchestration.

## Design

### 1. Role & interaction model

Setting `default_popup` makes the icon open the popup instead of firing `action.onClicked`; the two are mutually exclusive in MV3. Start/stop therefore lives in the popup. `action.onClicked` and the `pendingStart` toggle-queue are removed.

Layout A, top to bottom:
- **Header** — `EchoFlow` wordmark + status pill.
- **Primary action** — large Start/Stop button; under it, the current tab title ("on *<tab>*").
- **Quick controls** — mode segmented control; target-language picker.
- **Recent** — the last few history sessions (compact), linking to full history in Options.
- **Footer** — "Open full settings" → `chrome.runtime.openOptionsPage()`.

### 2. States

The pill reuses the overlay's status language for cross-surface consistency, driven by the background session lifecycle. A pure mapping `popupStatus(status)` (`sessionState.status` → pill descriptor) lives in a new `apps/extension/src/popup/popupStatus.ts`:

| `sessionState.status` | Pill | Body |
|---|---|---|
| `idle` | neutral · `Idle` | `Start subtitles` hero + "on *<tab>*" |
| `connecting` | amber · `连接中…` | Start button shows a connecting/disabled state |
| `running` | teal · `<mode> · LIVE` | `Stop subtitles` + live-card |
| `stopping` | amber · `停止中…` | Stop button shows a stopping/disabled state |
| `error` | red · `连接错误` | error message shown inline; Start available to retry |

The live-card (running only): `Capturing <tab>` · `<mode> · <src> → <target>` · elapsed (mm:ss, derived from the session start time). Mode label uses the bare `一致 / 实时` (reusing `modeLabel` from `apps/extension/src/overlay/overlayStatus.ts`).

The popup is ephemeral: on open it queries the background for the current `sessionState` and subscribes to lifecycle updates (via `chrome.runtime` messages) while open, unsubscribing on unmount.

### 3. Quick controls

- **Mode** — `SegmentedControl` over `SUBTITLE_MODE_OPTIONS` (now bare-labeled). Writing the new mode persists via `saveSettings`.
- **Target language** — `LanguagePicker` driven by `fetchCapabilities` + `languageSelection` (same wiring as Options). Changing the target re-derives the source via `counterpartSource`/`coercePair` and persists via `saveSettings`.
- Both remain **editable while running**. When `status === "running"`, an `applies next session` hint renders near the controls. No mid-session re-config is performed (out of scope).

### 4. Data flow — the capture-gesture move

The user gesture for `chrome.tabCapture.getMediaStreamId` must originate in the calling context. Moving start into the popup means:

1. On **Start** click (the gesture), the popup resolves the active tab (`chrome.tabs.query({ active: true, currentWindow: true })`), validates settings (`validateSettings(loadSettings())`); if invalid, it renders the inline "Finish setup in Options" state and stops.
2. The popup calls `chrome.tabCapture.getMediaStreamId({ targetTabId })` itself (the popup has the `tabCapture` permission) to obtain `streamId` within the gesture.
3. The popup sends a new `START_FROM_POPUP` runtime message to the background carrying `{ tabId, streamId, settings }`.
4. The background's `startSession` is refactored to **accept** `tabId` + `streamId` + `settings` instead of fetching the stream id itself: it creates the local history session, reduces `START_CONNECTING` then `STREAM_READY`, ensures the offscreen document, and sends `START_SESSION` to the offscreen. The only thing removed from `startSession` is its own `getMediaStreamId` call (the popup now supplies `streamId`); the content-script injection (`injectRuntimeContentScript`) and badge updates stay exactly as they are.
5. **Stop**: the popup sends the existing `STOP_SESSION` message.

`action.onClicked`, `handleActionClick`, `pendingStartTab`, and `drainPendingStart` are removed from the background. The content-script injection, offscreen lifecycle, `RealtimeSession`, and `sessionState` reducer are unchanged. The badge logic (`setBadge`) remains, now driven by the same lifecycle transitions.

A background message handler answers the popup's state query: a new `GET_SESSION_STATE` request returns the current `sessionState` (status + active details), and the existing lifecycle transitions broadcast updates the popup listens for while open.

### 5. Components

New under `apps/extension/entrypoints/popup/`:
- `index.html` + `main.tsx` — WXT popup entrypoint mounting the React tree (light theme via `themeStyleSheet(LIGHT_THEME, ":root")`).
- `PopupApp.tsx` — composes header/pill, primary action, quick controls, recent list, footer. Owns local UI state and the start/stop handlers.

New under `apps/extension/src/popup/`:
- `popupStatus.ts` (+ test) — pure `sessionState.status` → pill descriptor mapping, and an elapsed-time formatter.
- `recentSessions.ts` (+ test) — pure selector that takes the history store's sessions and returns the last N for the recent list.
- `canStart.ts` (+ test) — pure settings-gate: given settings validation, returns whether Start is enabled and the reason if not (drives the "Finish setup in Options" state).

New messaging (`apps/extension/src/messaging/messages.ts`): `StartFromPopupMessage { type: "START_FROM_POPUP"; tabId; streamId; settings }` and `GetSessionStateMessage` / its response shape. The `isRuntimeMessage` guard's type list is extended accordingly. No `packages/protocol` change.

`wxt.config.ts`: add `action.default_popup` pointing at the popup entrypoint.

### 6. Error handling

- **Invalid/missing settings:** inline "Finish setup in Options" state (button → `openOptionsPage`), replacing today's silent `openOptionsPage` on click.
- **`getMediaStreamId` failure / capture denied:** inline error in the popup with a retry affordance.
- **Backend/session errors:** the pill enters its error state with the message inline, mirroring the overlay; the existing `SESSION_ERROR` flow updates `sessionState` to `error`, which the popup reflects on its next state read/update.
- **No active tab / restricted tab (e.g. `chrome://`):** Start is disabled with a short reason.

### 7. Testing

- Pure units (Vitest): `popupStatus` (every lifecycle → pill + elapsed formatting), `recentSessions` (ordering, N cap, empty), `canStart` (valid vs each invalid reason).
- Component render tests (`renderToStaticMarkup`, matching the overlay/options test pattern): popup idle / connecting / live / error / "finish setup" states render the right pill, primary action, and controls.
- The capture-gesture path (`getMediaStreamId` in the popup → `START_FROM_POPUP` → background) is entrypoint/e2e territory per project convention (the extension `test` script targets `src` only); its contract is enforced by the message types and verified by the dev smoke / Playwright e2e where a gesture is available.
- Gates: `pnpm typecheck` clean; `pnpm --filter @echoflow/extension test` green; `pnpm --filter @echoflow/extension build` succeeds.

### 8. Out of scope (stays in backlog)

- Live subtitle mirroring in the popup (§3 / Decision 5) — the overlay already shows subtitles on the page.
- Live mode/language re-config mid-session — changes apply at the next session start.
- Onboarding / first-run (Slice 4).
- Paywall / billing framing — the bare mode labels are deliberate until billing exists.
- No change to `packages/protocol` (the backend wire contract).
