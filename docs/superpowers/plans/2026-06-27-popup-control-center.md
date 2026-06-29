# Popup Control Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toolbar popup that becomes EchoFlow's product home — start/stop, live status, and quick controls (mode, target language) — on the Direction-B light theme, reusing the Slice-1/2 building blocks.

**Architecture:** Setting `default_popup` makes the icon open the popup instead of firing `action.onClicked`, so start/stop moves into the popup. The Start-button click is the user gesture for `chrome.tabCapture.getMediaStreamId`; the popup obtains the `streamId` and hands it to the background via a new `START_FROM_POPUP` message, and `startSession` is refactored to accept it (all other orchestration preserved). The popup reads live session state from the existing `chrome.storage.session` store (`loadPersistedState` + `chrome.storage.onChanged`) — no new state message. A presentational `PopupApp` (in `src/popup/`, props-driven, unit-tested) is wired by a thin entrypoint (`entrypoints/popup/`, e2e-covered).

**Tech Stack:** WXT + React 19 (MV3), TypeScript ESM, Vitest, `renderToStaticMarkup` for component tests. pnpm monorepo.

## Global Constraints

- Internal extension messaging change only — **do not touch `packages/protocol`** (the backend wire contract).
- `SubtitleMode` is `"pipeline" | "interpret"`, exported from `@echoflow/protocol`.
- Mode labels go **bare**: `一致` / `实时` (drop the `(免费)/(付费)` parentheticals; paywall framing returns when billing exists).
- Pill labels (exact): idle `Idle`, connecting `连接中…`, stopping `停止中…`, running `<modeLabel> · LIVE`, error `连接错误`. `modeLabel`: pipeline→`一致`, interpret→`实时` (reuse `modeLabel` from `src/overlay/overlayStatus.ts`).
- Popup is light-themed via `themeStyleSheet(LIGHT_THEME, ":root")` (`src/ui/theme.ts`).
- The only new runtime message is `START_FROM_POPUP`; Stop reuses the existing `STOP_SESSION`. Session state reaches the popup via `sessionStore` + `chrome.storage.onChanged`.
- Run commands from the repo root. Test: `pnpm --filter @echoflow/extension test`. Typecheck: `pnpm typecheck`. Build: `pnpm --filter @echoflow/extension build`.
- All work on branch `feat/popup-control-center-slice3` (already created; the spec is already committed there).

---

### Task 1: Foundation — bare mode labels + `START_FROM_POPUP` message

Deliver the label change and the one new message type so later tasks can compose against them. No behavior change yet.

**Files:**
- Modify: `apps/extension/src/settings/settings.ts` (bare mode labels)
- Modify: `apps/extension/src/messaging/messages.ts` (add `StartFromPopupMessage`)
- Test: `apps/extension/src/messaging/messages.test.ts` (extend)

**Interfaces:**
- Consumes: `ExtensionSettings` (already in `messages.ts`).
- Produces:
  - `SUBTITLE_MODE_OPTIONS` labels are now `"一致"` / `"实时"`.
  - `StartFromPopupMessage { type: "START_FROM_POPUP"; tabId: number; streamId: string; settings: ExtensionSettings }`, added to the `RuntimeMessage` union and the `isRuntimeMessage` type list.

- [ ] **Step 1: Write the failing test** — `isRuntimeMessage` accepts a `START_FROM_POPUP` message.

In `apps/extension/src/messaging/messages.test.ts`, add a test (keep the existing ones):

```ts
it("accepts a START_FROM_POPUP message", () => {
  expect(
    isRuntimeMessage({
      type: "START_FROM_POPUP",
      tabId: 7,
      streamId: "stream-1",
      settings: {
        serverUrl: "http://127.0.0.1:8787",
        apiKey: "k",
        targetLanguage: "zh-CN",
        sourceLanguage: "en",
        subtitleFontSize: 24,
        mode: "interpret"
      }
    })
  ).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test messages`
Expected: FAIL — `isRuntimeMessage` returns `false` for the unknown type `START_FROM_POPUP`.

- [ ] **Step 3: Add the message type and register it in the guard**

In `apps/extension/src/messaging/messages.ts`, add to the `RuntimeMessage` union (after `StartSessionMessage`):

```ts
export type RuntimeMessage =
  | StartSessionMessage
  | StartFromPopupMessage
  | StopSessionMessage
  | SessionStartedMessage
  | SessionErrorMessage
  | ServerEventMessage
  | OffscreenReadyMessage
  | ConnectionStatusMessage;
```

Add the interface (next to `StartSessionMessage`):

```ts
export interface StartFromPopupMessage {
  type: "START_FROM_POPUP";
  tabId: number;
  streamId: string;
  settings: ExtensionSettings;
}
```

Add `"START_FROM_POPUP"` to the array inside `isRuntimeMessage`:

```ts
  return [
    "START_SESSION",
    "START_FROM_POPUP",
    "STOP_SESSION",
    "SESSION_STARTED",
    "SESSION_ERROR",
    "SERVER_EVENT",
    "OFFSCREEN_READY",
    "CONNECTION_STATUS"
  ].includes(message.type);
```

- [ ] **Step 4: Make the mode labels bare**

In `apps/extension/src/settings/settings.ts`, replace the `SUBTITLE_MODE_OPTIONS` block:

```ts
export const SUBTITLE_MODE_OPTIONS = [
  { value: "pipeline" as const, label: "一致" },
  { value: "interpret" as const, label: "实时" }
] as const;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/extension test messages`
Expected: PASS. Then `pnpm typecheck` — Expected: PASS (no consumer asserts the old labels; `options/main.tsx` renders them dynamically).

- [ ] **Step 6: Commit**

```bash
git add apps/extension/src/settings/settings.ts apps/extension/src/messaging/messages.ts apps/extension/src/messaging/messages.test.ts
git commit -m "feat(extension): bare mode labels + START_FROM_POPUP message type"
```

---

### Task 2: Popup pure helpers — `popupStatus`, `recentSessions`, `canStart`

Three small pure modules that carry the popup's logic and its unit tests, so the UI tasks stay thin.

**Files:**
- Create: `apps/extension/src/popup/popupStatus.ts`
- Create: `apps/extension/src/popup/popupStatus.test.ts`
- Create: `apps/extension/src/popup/recentSessions.ts`
- Create: `apps/extension/src/popup/recentSessions.test.ts`
- Create: `apps/extension/src/popup/canStart.ts`
- Create: `apps/extension/src/popup/canStart.test.ts`

**Interfaces:**
- Consumes: `SubtitleMode` from `@echoflow/protocol`; `modeLabel` from `../overlay/overlayStatus`; `SessionState` from `../session/sessionState`; `HistorySessionRecord` from `../history/historyStore`.
- Produces:
  - `type PopupTone = "idle" | "connecting" | "live" | "error"`
  - `interface PopupPill { tone: PopupTone; label: string }`
  - `popupPill(status: SessionState["status"], mode: SubtitleMode): PopupPill`
  - `formatElapsed(ms: number): string` → `"mm:ss"`
  - `recentSessions(sessions: HistorySessionRecord[], limit: number): HistorySessionRecord[]` (newest first, capped)
  - `type StartReason = "ok" | "finish_setup" | "no_tab"`
  - `evaluateStartGate(input: { settingsValid: boolean; hasActiveTab: boolean }): { canStart: boolean; reason: StartReason }`

- [ ] **Step 1: Write the failing tests**

Create `apps/extension/src/popup/popupStatus.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { popupPill, formatElapsed } from "./popupStatus";

describe("popupPill", () => {
  it("maps idle to a neutral Idle pill", () => {
    expect(popupPill("idle", "pipeline")).toEqual({ tone: "idle", label: "Idle" });
  });
  it("maps connecting and stopping to amber labels", () => {
    expect(popupPill("connecting", "pipeline")).toEqual({ tone: "connecting", label: "连接中…" });
    expect(popupPill("stopping", "pipeline")).toEqual({ tone: "connecting", label: "停止中…" });
  });
  it("maps running to a live pill carrying the mode label", () => {
    expect(popupPill("running", "interpret")).toEqual({ tone: "live", label: "实时 · LIVE" });
    expect(popupPill("running", "pipeline")).toEqual({ tone: "live", label: "一致 · LIVE" });
  });
  it("maps error to a red 连接错误 pill", () => {
    expect(popupPill("error", "pipeline")).toEqual({ tone: "error", label: "连接错误" });
  });
});

describe("formatElapsed", () => {
  it("formats milliseconds as mm:ss", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(65_000)).toBe("01:05");
    expect(formatElapsed(600_000)).toBe("10:00");
  });
});
```

Create `apps/extension/src/popup/recentSessions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { recentSessions } from "./recentSessions";
import type { HistorySessionRecord } from "../history/historyStore";

function session(id: string, startedAt: number): HistorySessionRecord {
  return { id, startedAt, updatedAt: startedAt, syncStatus: "local-only" };
}

describe("recentSessions", () => {
  it("returns newest first, capped at the limit", () => {
    const out = recentSessions(
      [session("a", 100), session("b", 300), session("c", 200)],
      2
    );
    expect(out.map((s) => s.id)).toEqual(["b", "c"]);
  });
  it("returns an empty array for no sessions", () => {
    expect(recentSessions([], 3)).toEqual([]);
  });
});
```

Create `apps/extension/src/popup/canStart.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { evaluateStartGate } from "./canStart";

describe("evaluateStartGate", () => {
  it("allows start when settings are valid and a tab is active", () => {
    expect(evaluateStartGate({ settingsValid: true, hasActiveTab: true })).toEqual({
      canStart: true,
      reason: "ok"
    });
  });
  it("blocks with finish_setup when settings are invalid", () => {
    expect(evaluateStartGate({ settingsValid: false, hasActiveTab: true })).toEqual({
      canStart: false,
      reason: "finish_setup"
    });
  });
  it("blocks with no_tab when no capturable tab is active (settings valid)", () => {
    expect(evaluateStartGate({ settingsValid: true, hasActiveTab: false })).toEqual({
      canStart: false,
      reason: "no_tab"
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @echoflow/extension test popup/`
Expected: FAIL — cannot find modules `./popupStatus`, `./recentSessions`, `./canStart`.

- [ ] **Step 3: Implement the three helpers**

Create `apps/extension/src/popup/popupStatus.ts`:

```ts
import type { SubtitleMode } from "@echoflow/protocol";
import type { SessionState } from "../session/sessionState";
import { modeLabel } from "../overlay/overlayStatus";

export type PopupTone = "idle" | "connecting" | "live" | "error";

export interface PopupPill {
  tone: PopupTone;
  label: string;
}

export function popupPill(
  status: SessionState["status"],
  mode: SubtitleMode
): PopupPill {
  switch (status) {
    case "running":
      return { tone: "live", label: `${modeLabel(mode)} · LIVE` };
    case "connecting":
      return { tone: "connecting", label: "连接中…" };
    case "stopping":
      return { tone: "connecting", label: "停止中…" };
    case "error":
      return { tone: "error", label: "连接错误" };
    case "idle":
      return { tone: "idle", label: "Idle" };
  }
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${pad(minutes)}:${pad(seconds)}`;
}
```

Create `apps/extension/src/popup/recentSessions.ts`:

```ts
import type { HistorySessionRecord } from "../history/historyStore";

export function recentSessions(
  sessions: HistorySessionRecord[],
  limit: number
): HistorySessionRecord[] {
  return [...sessions]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);
}
```

Create `apps/extension/src/popup/canStart.ts`:

```ts
export type StartReason = "ok" | "finish_setup" | "no_tab";

export function evaluateStartGate(input: {
  settingsValid: boolean;
  hasActiveTab: boolean;
}): { canStart: boolean; reason: StartReason } {
  if (!input.settingsValid) {
    return { canStart: false, reason: "finish_setup" };
  }
  if (!input.hasActiveTab) {
    return { canStart: false, reason: "no_tab" };
  }
  return { canStart: true, reason: "ok" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/extension test popup/`
Expected: PASS (popupStatus 6, recentSessions 2, canStart 3).

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/popup/popupStatus.ts apps/extension/src/popup/popupStatus.test.ts apps/extension/src/popup/recentSessions.ts apps/extension/src/popup/recentSessions.test.ts apps/extension/src/popup/canStart.ts apps/extension/src/popup/canStart.test.ts
git commit -m "feat(extension): popup pure helpers (status pill, recent, start gate)"
```

---

### Task 3: Background refactor — start flow accepts a popup-supplied stream id

Move the capture gesture out of the background: remove `action.onClicked` and the toggle-queue, refactor `startSession` to take `tabId` + `streamId` + `settings`, and handle `START_FROM_POPUP`.

**Files:**
- Modify: `apps/extension/entrypoints/background.ts`

**Interfaces:**
- Consumes: `StartFromPopupMessage` (Task 1).
- Produces: nothing for later tasks (the popup entrypoint in Task 5 sends `START_FROM_POPUP`).

This is an entrypoint change; per project convention (entrypoints are e2e-covered, the `test` script targets `src` only) its gate is a clean `pnpm typecheck` plus the existing suite staying green.

- [ ] **Step 1: Add `StartFromPopupMessage` to the imports**

In `apps/extension/entrypoints/background.ts`, add `type StartFromPopupMessage` to the existing import from `../src/messaging/messages`:

```ts
import {
  isRuntimeMessage,
  type ConnectionStatusMessage,
  type RuntimeMessage,
  type SessionErrorMessage,
  type SessionStartedMessage,
  type ServerEventMessage,
  type StartFromPopupMessage,
  type StartSessionMessage,
  type StopSessionMessage
} from "../src/messaging/messages";
```

- [ ] **Step 2: Remove the action-click listener and the toggle-queue state**

Delete the `chrome.action.onClicked` listener from `defineBackground` (the `onInstalled` listener and the `onMessage` listener stay):

```ts
  chrome.action.onClicked.addListener((tab) => {
    void handleActionClick(tab);
  });
```

Delete the `pendingStartTab` declaration and its comment block (the `let pendingStartTab ...` lines near the top of the file).

Delete the `handleActionClick` and `drainPendingStart` functions entirely.

- [ ] **Step 3: Refactor `startSession` to accept the popup payload**

Replace the `startSession(tab: chrome.tabs.Tab)` signature and its `getMediaStreamId` call. The new function takes the message and uses `message.tabId` / `message.streamId` / `message.settings` instead of `tab.id`, `loadSettings()`, and `chrome.tabCapture.getMediaStreamId`. Replace the whole function with:

```ts
async function startSession(message: StartFromPopupMessage): Promise<void> {
  const { tabId, streamId, settings } = message;
  const validation = validateSettings(settings);

  if (!validation.valid) {
    // The popup gates Start on validity; this is a defensive no-op.
    return;
  }

  let localSessionId: string | undefined;

  try {
    await injectRuntimeContentScript(tabId);

    const localSession = await historyStore.createLocalSession({
      targetLanguage: settings.targetLanguage
    });
    localSessionId = localSession.id;
    await commitDetectedSourceLanguage("unknown");

    await commitSessionState(
      reduceSessionState(sessionState, {
        type: "START_CONNECTING",
        localSessionId: localSession.id,
        tabId,
        streamId,
        settings
      })
    );

    await ensureOffscreenDocument();

    await commitSessionState(
      reduceSessionState(sessionState, {
        type: "STREAM_READY",
        streamId
      })
    );

    await setBadge("...");

    await chrome.runtime.sendMessage({
      type: "START_SESSION",
      localSessionId,
      tabId,
      streamId,
      settings
    } satisfies StartSessionMessage);
  } catch (error) {
    await handleSessionError({
      type: "SESSION_ERROR",
      localSessionId:
        localSessionId ??
        (sessionState.status === "idle" ? undefined : sessionState.localSessionId),
      code: "start_failed",
      message: error instanceof Error ? error.message : "Failed to start session"
    });
  }
}
```

Note: the `START_CONNECTING` event already carries `streamId` (it did before, as `""`); now it carries the real id and the subsequent `STREAM_READY` is harmless idempotence kept to avoid touching the reducer. The `loadSettings`/`validateSettings` early-return-to-options behavior is gone — the popup owns that gate now. If `validateSettings` is no longer otherwise used in this file, leave the import as-is (it is used here).

- [ ] **Step 4: Handle `START_FROM_POPUP` in the message switch**

In `handleRuntimeMessage`'s `switch (message.type)`, add a case (next to `STOP_SESSION`):

```ts
    case "START_FROM_POPUP":
      await startSession(message);
      return;
```

`START_SESSION` and `OFFSCREEN_READY` remain in the no-op case at the bottom.

- [ ] **Step 5: Confirm `loadSettings` is still imported only if used**

`startSession` no longer calls `loadSettings`. Run a quick check that nothing else in the file uses it:

Run: `grep -n "loadSettings" apps/extension/entrypoints/background.ts`
Expected: no matches. If there are none, remove `loadSettings` from the import on line 13 so the import reads `import { validateSettings } from "../src/settings/settings";`.

- [ ] **Step 6: Typecheck and run the suite**

Run: `pnpm typecheck`
Expected: PASS (all packages). Then `pnpm --filter @echoflow/extension test` — Expected: PASS (the `sessionState` reducer tests are unaffected; no background unit tests exist).

- [ ] **Step 7: Commit**

```bash
git add apps/extension/entrypoints/background.ts
git commit -m "feat(extension): accept popup-supplied stream id; drop action-click toggle"
```

---

### Task 4: `PopupApp` presentational component + popup CSS

A props-driven control-center component in `src/popup/` (no chrome APIs), unit-tested via `renderToStaticMarkup` — the same pattern as `SubtitleOverlay`.

**Files:**
- Create: `apps/extension/src/popup/PopupApp.tsx`
- Create: `apps/extension/src/popup/PopupApp.test.tsx`

**Interfaces:**
- Consumes: `SegmentedControl` from `../ui/SegmentedControl`; `LanguagePicker` from `../ui/LanguagePicker`; `SUBTITLE_MODE_OPTIONS` from `../settings/settings`; `PopupPill`, `formatElapsed` (Task 2); `StartReason` (Task 2); `LanguageOption` from `@echoflow/protocol`; `HistorySessionRecord` from `../history/historyStore`; `SubtitleMode` from `@echoflow/protocol`; `LIGHT_THEME`, `themeStyleSheet`, `RADIUS` from `../ui/theme`.
- Produces:
  - `interface PopupView { pill: PopupPill; status: SessionState["status"]; running: boolean; tabTitle: string | null; elapsedMs: number | null; mode: SubtitleMode; sourceLanguage: string; targetLanguage: string; targetOptions: LanguageOption[]; recent: HistorySessionRecord[]; startReason: StartReason; errorMessage: string | null }` (the popup renders only a target picker; source is shown as text, so there is no `sourceOptions`)
  - `interface PopupHandlers { onStart(): void; onStop(): void; onModeChange(mode: SubtitleMode): void; onTargetChange(code: string): void; onOpenOptions(): void }`
  - `PopupApp(props: { view: PopupView; handlers: PopupHandlers })` — the default export.

(Import `SessionState` as a type for `PopupView.status`.)

- [ ] **Step 1: Write the failing component tests**

Create `apps/extension/src/popup/PopupApp.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PopupApp, type PopupView, type PopupHandlers } from "./PopupApp";

const handlers: PopupHandlers = {
  onStart() {},
  onStop() {},
  onModeChange() {},
  onTargetChange() {},
  onOpenOptions() {}
};

const baseView: PopupView = {
  pill: { tone: "idle", label: "Idle" },
  status: "idle",
  running: false,
  tabTitle: "Northern Lights — YouTube",
  elapsedMs: null,
  mode: "pipeline",
  sourceLanguage: "en",
  targetLanguage: "zh-CN",
  targetOptions: [{ code: "zh-CN", label: "中文 (简体)", pivot: true }],
  recent: [],
  startReason: "ok",
  errorMessage: null
};

function render(view: Partial<PopupView>) {
  return renderToStaticMarkup(
    <PopupApp view={{ ...baseView, ...view }} handlers={handlers} />
  );
}

describe("PopupApp", () => {
  it("idle: shows the Start action and current tab", () => {
    const html = render({});
    expect(html).toContain("Start subtitles");
    expect(html).toContain("Northern Lights — YouTube");
    expect(html).toContain("Idle");
  });

  it("running: shows Stop, the live pill, and elapsed time", () => {
    const html = render({
      status: "running",
      running: true,
      pill: { tone: "live", label: "实时 · LIVE" },
      elapsedMs: 65_000,
      mode: "interpret"
    });
    expect(html).toContain("Stop subtitles");
    expect(html).toContain("实时 · LIVE");
    expect(html).toContain("01:05");
    expect(html).toContain("applies next session");
  });

  it("finish_setup: blocks Start and points to settings", () => {
    const html = render({ startReason: "finish_setup" });
    expect(html).toContain("Finish setup in Options");
  });

  it("error: surfaces the message inline", () => {
    const html = render({
      status: "error",
      pill: { tone: "error", label: "连接错误" },
      errorMessage: "Can't reach the backend"
    });
    expect(html).toContain("连接错误");
    expect(html).toContain("Can't reach the backend");
  });

  it("renders the recent list when sessions exist", () => {
    const html = render({
      recent: [
        { id: "s1", startedAt: 1, updatedAt: 1, syncStatus: "local-only", sourceLanguage: "en", targetLanguage: "zh-CN" }
      ]
    });
    expect(html).toContain("Recent");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @echoflow/extension test PopupApp`
Expected: FAIL — cannot find module `./PopupApp`.

- [ ] **Step 3: Implement `PopupApp` and its CSS**

Create `apps/extension/src/popup/PopupApp.tsx`:

```tsx
import type { LanguageOption, SubtitleMode } from "@echoflow/protocol";
import { LIGHT_THEME, RADIUS, themeStyleSheet } from "../ui/theme";
import { SegmentedControl } from "../ui/SegmentedControl";
import { LanguagePicker } from "../ui/LanguagePicker";
import { SUBTITLE_MODE_OPTIONS } from "../settings/settings";
import type { SessionState } from "../session/sessionState";
import { formatElapsed, type PopupPill } from "./popupStatus";
import type { StartReason } from "./canStart";
import type { HistorySessionRecord } from "../history/historyStore";

export interface PopupView {
  pill: PopupPill;
  status: SessionState["status"];
  running: boolean;
  tabTitle: string | null;
  elapsedMs: number | null;
  mode: SubtitleMode;
  sourceLanguage: string;
  targetLanguage: string;
  targetOptions: LanguageOption[];
  recent: HistorySessionRecord[];
  startReason: StartReason;
  errorMessage: string | null;
}

export interface PopupHandlers {
  onStart(): void;
  onStop(): void;
  onModeChange(mode: SubtitleMode): void;
  onTargetChange(code: string): void;
  onOpenOptions(): void;
}

export function PopupApp({
  view,
  handlers
}: {
  view: PopupView;
  handlers: PopupHandlers;
}) {
  const blocked = view.startReason !== "ok";

  return (
    <>
      <PopupStyles />
      <div className="ef-popup">
        <header className="ef-phead">
          <span className="ef-brand"><span className="ef-mark" />EchoFlow</span>
          <span className={`ef-pill ef-pill-${view.pill.tone}`}>
            <span className="ef-dot" />
            {view.pill.label}
          </span>
        </header>

        <div className="ef-body">
          {view.running ? (
            <button className="ef-stop" type="button" onClick={handlers.onStop}>
              Stop subtitles
            </button>
          ) : (
            <button
              className="ef-start"
              type="button"
              onClick={handlers.onStart}
              disabled={blocked}
            >
              Start subtitles
            </button>
          )}

          {view.running ? (
            <div className="ef-livecard">
              <div className="ef-statrow">
                <span className="ef-k">Capturing</span>
                <span className="ef-v">{view.tabTitle ?? "this tab"}</span>
              </div>
              <div className="ef-statrow">
                <span className="ef-k">{view.sourceLanguage} → {view.targetLanguage}</span>
                <span className="ef-v">{formatElapsed(view.elapsedMs ?? 0)}</span>
              </div>
            </div>
          ) : view.startReason === "finish_setup" ? (
            <button className="ef-setup" type="button" onClick={handlers.onOpenOptions}>
              Finish setup in Options
            </button>
          ) : (
            <p className="ef-tabline">
              on <b>{view.tabTitle ?? "this tab"}</b>
            </p>
          )}

          {view.errorMessage ? (
            <p className="ef-error" role="status">{view.errorMessage}</p>
          ) : null}

          <div className="ef-field">
            <span className="ef-label">Mode</span>
            <SegmentedControl<SubtitleMode>
              value={view.mode}
              options={SUBTITLE_MODE_OPTIONS}
              onChange={handlers.onModeChange}
              ariaLabel="Subtitle mode"
            />
          </div>

          <div className="ef-field">
            <span className="ef-label">Translate to</span>
            <LanguagePicker
              value={view.targetLanguage}
              options={view.targetOptions}
              onChange={handlers.onTargetChange}
              ariaLabel="Target language"
            />
            {view.running ? (
              <span className="ef-hint">
                <span className="ef-badge">applies next session</span>
              </span>
            ) : null}
          </div>

          {view.recent.length ? (
            <div className="ef-field">
              <span className="ef-label ef-divlabel">Recent</span>
              <ul className="ef-recent">
                {view.recent.map((session) => (
                  <li key={session.id} className="ef-ritem">
                    <span className="ef-rt">
                      {(session.sourceLanguage ?? "?")} → {(session.targetLanguage ?? "?")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <footer className="ef-foot">
          <button className="ef-optlink" type="button" onClick={handlers.onOpenOptions}>
            ⚙ Open full settings
          </button>
        </footer>
      </div>
    </>
  );
}

function PopupStyles() {
  return (
    <style>{`
      ${themeStyleSheet(LIGHT_THEME, ":root")}

      * { box-sizing: border-box; }
      body { margin: 0; }
      .ef-popup {
        width: 360px;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        background: var(--ef-bg);
        color: var(--ef-text);
      }
      .ef-phead {
        display: flex; align-items: center; justify-content: space-between;
        padding: 13px 16px; background: var(--ef-surface);
        border-bottom: 1px solid var(--ef-border);
      }
      .ef-brand { display: flex; align-items: center; gap: 8px; font-weight: 800; font-size: 15px; }
      .ef-mark { width: 18px; height: 18px; border-radius: 6px;
        background: linear-gradient(135deg, var(--ef-accent), #3bb6a4); }
      .ef-pill {
        display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px;
        border-radius: 999px; border: 1px solid var(--ef-border); background: var(--ef-bg);
        font-size: 11px; font-weight: 700;
      }
      .ef-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ef-text-muted); }
      .ef-pill-live { color: var(--ef-accent); }
      .ef-pill-live .ef-dot { background: var(--ef-accent); box-shadow: 0 0 6px var(--ef-accent); }
      .ef-pill-connecting { color: #b5831f; }
      .ef-pill-connecting .ef-dot { background: #e0a93a; box-shadow: 0 0 6px #e0a93a; }
      .ef-pill-error { color: #c4503f; }
      .ef-pill-error .ef-dot { background: #e06a5e; box-shadow: 0 0 6px #e06a5e; }

      .ef-body { padding: 14px 16px; display: grid; gap: 14px; }

      .ef-start, .ef-stop, .ef-setup {
        width: 100%; border-radius: ${RADIUS.md}; padding: 13px; font-size: 15px;
        font-weight: 700; cursor: pointer; border: 1px solid transparent;
      }
      .ef-start { background: var(--ef-accent); color: #fff; }
      .ef-start:disabled { opacity: .5; cursor: not-allowed; }
      .ef-stop { background: #fbece9; color: #c4503f; border-color: #e7b3aa; }
      .ef-setup { background: var(--ef-accent-weak); color: var(--ef-accent); border-color: #bfe7df; }
      .ef-tabline { margin: -4px 0 0; font-size: 12px; color: var(--ef-text-muted); text-align: center;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ef-tabline b { color: var(--ef-text); font-weight: 600; }

      .ef-livecard {
        background: var(--ef-accent-weak); border: 1px solid #bfe7df;
        border-radius: ${RADIUS.md}; padding: 11px 13px; display: grid; gap: 8px;
      }
      .ef-statrow { display: flex; align-items: center; justify-content: space-between; font-size: 12px; }
      .ef-k { color: var(--ef-text-muted); }
      .ef-v { font-weight: 700; }

      .ef-error {
        margin: 0; padding: 8px 10px; border-radius: ${RADIUS.sm};
        background: #fbece9; color: #c4503f; font: 600 12px/1.3 system-ui, sans-serif;
        overflow-wrap: anywhere; text-align: center;
      }

      .ef-field { display: grid; gap: 6px; }
      .ef-label { text-transform: uppercase; letter-spacing: .08em; font-size: 10px;
        font-weight: 700; color: var(--ef-text-muted); }
      .ef-divlabel { display: flex; align-items: center; gap: 8px; }
      .ef-divlabel::after { content: ""; flex: 1; height: 1px; background: var(--ef-border); }
      .ef-hint { font-size: 11px; color: var(--ef-text-muted); }
      .ef-badge { background: var(--ef-accent-weak); color: var(--ef-accent); border-radius: 5px;
        padding: 1px 6px; font-weight: 700; font-size: 10px; }

      .ef-recent { list-style: none; margin: 0; padding: 0; display: grid; gap: 7px; }
      .ef-ritem { display: flex; align-items: center; justify-content: space-between;
        font-size: 12px; padding: 7px 9px; background: var(--ef-surface);
        border: 1px solid var(--ef-border); border-radius: ${RADIUS.sm}; }

      .ef-foot { padding: 11px 16px; border-top: 1px solid var(--ef-border); background: var(--ef-surface); }
      .ef-optlink { width: 100%; border: none; background: transparent; cursor: pointer;
        display: flex; align-items: center; justify-content: center; gap: 7px;
        font-size: 12.5px; font-weight: 600; color: var(--ef-accent); }

      .ef-start:focus-visible, .ef-stop:focus-visible, .ef-setup:focus-visible,
      .ef-optlink:focus-visible { outline: 2px solid var(--ef-accent); outline-offset: 2px; }
    `}</style>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/extension test PopupApp`
Expected: PASS (5 tests). Then `pnpm typecheck` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/popup/PopupApp.tsx apps/extension/src/popup/PopupApp.test.tsx
git commit -m "feat(extension): PopupApp control-center component + light-theme CSS"
```

---

### Task 5: Popup entrypoint wiring + `default_popup`

The thin entrypoint that mounts `PopupApp`: reads state from `sessionStore` + `chrome.storage.onChanged`, fetches capabilities/history/settings, and implements start (gesture → `getMediaStreamId` → `START_FROM_POPUP`), stop, and persistence. Activating `default_popup` makes the icon open it.

**Files:**
- Create: `apps/extension/entrypoints/popup/index.html`
- Create: `apps/extension/entrypoints/popup/main.tsx`
- Modify: `apps/extension/wxt.config.ts` (add `action.default_popup`)

**Interfaces:**
- Consumes: `PopupApp`, `PopupView`, `PopupHandlers` (Task 4); `popupPill` (Task 2); `recentSessions` (Task 2); `evaluateStartGate` (Task 2); `StartFromPopupMessage`, `StopSessionMessage` (Tasks 1 + existing); `loadSettings`/`saveSettings`/`validateSettings`/`counterpartSource` (settings); `fetchCapabilities` (capabilitiesClient); `coercePair`/`targetOptions` (languageSelection); `loadPersistedState`/`SESSION_STATE_STORAGE_KEY` (sessionStore); `createHistoryStore` (historyStore).
- Produces: nothing for later tasks.

This is entrypoint/e2e territory; its gate is a clean `pnpm typecheck`, the existing suite green, and a successful `build` (Task 6). Follow the existing `entrypoints/options/main.tsx` patterns for the capabilities fetch and `coercePair` usage.

- [ ] **Step 1: Create the popup HTML host**

Create `apps/extension/entrypoints/popup/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>EchoFlow</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Implement the entrypoint wiring**

Create `apps/extension/entrypoints/popup/main.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  CapabilitiesDescriptor,
  ModeCapabilities,
  SubtitleMode
} from "@echoflow/protocol";
import {
  PopupApp,
  type PopupHandlers,
  type PopupView
} from "../../src/popup/PopupApp";
import { popupPill } from "../../src/popup/popupStatus";
import { recentSessions } from "../../src/popup/recentSessions";
import { evaluateStartGate } from "../../src/popup/canStart";
import {
  counterpartSource,
  loadSettings,
  saveSettings,
  validateSettings,
  type ExtensionSettings
} from "../../src/settings/settings";
import { fetchCapabilities } from "../../src/settings/capabilitiesClient";
import {
  coercePair,
  targetOptions
} from "../../src/settings/languageSelection";
import {
  loadPersistedState,
  SESSION_STATE_STORAGE_KEY
} from "../../src/session/sessionStore";
import type { SessionState } from "../../src/session/sessionState";
import type {
  StartFromPopupMessage,
  StopSessionMessage
} from "../../src/messaging/messages";
import { createHistoryStore } from "../../src/history/historyStore";
import type { HistorySessionRecord } from "../../src/history/historyStore";

const historyStore = createHistoryStore();
const RECENT_LIMIT = 3;

function PopupRoot() {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [sessionState, setSessionState] = useState<SessionState>({ status: "idle" });
  const [capabilities, setCapabilities] = useState<CapabilitiesDescriptor | null>(null);
  const [recent, setRecent] = useState<HistorySessionRecord[]>([]);
  const [activeTab, setActiveTab] = useState<chrome.tabs.Tab | null>(null);

  // Load settings, persisted session state, history, and the active tab on open.
  useEffect(() => {
    void loadSettings().then(setSettings);
    void loadPersistedState().then((p) => setSessionState(p.sessionState));
    void historyStore.listSessions().then((s) => setRecent(recentSessions(s, RECENT_LIMIT)));
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => setActiveTab(tabs[0] ?? null));
  }, []);

  // Reflect live lifecycle changes while the popup is open.
  useEffect(() => {
    function onChanged(
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) {
      if (area !== "session" || !changes[SESSION_STATE_STORAGE_KEY]) {
        return;
      }
      const next = changes[SESSION_STATE_STORAGE_KEY].newValue as
        | { sessionState: SessionState }
        | undefined;
      if (next) {
        setSessionState(next.sessionState);
      }
    }
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  // Fetch capabilities once connection details are known (mirrors Options).
  useEffect(() => {
    if (!settings?.serverUrl || !settings.apiKey) {
      return;
    }
    void fetchCapabilities(settings.serverUrl, settings.apiKey).then(setCapabilities);
  }, [settings?.serverUrl, settings?.apiKey]);

  const modeCaps: ModeCapabilities | null = useMemo(
    () => (settings && capabilities ? capabilities.modes[settings.mode] : null),
    [settings, capabilities]
  );

  const running =
    sessionState.status === "running" || sessionState.status === "connecting";

  const persist = useCallback(async (next: ExtensionSettings) => {
    setSettings(next);
    await saveSettings(next);
  }, []);

  const onModeChange = useCallback(
    (mode: SubtitleMode) => {
      if (!settings) return;
      const caps = capabilities?.modes[mode] ?? null;
      if (!caps) {
        void persist({ ...settings, mode });
        return;
      }
      const pair = coercePair(caps, settings.sourceLanguage, settings.targetLanguage);
      void persist({
        ...settings,
        mode,
        sourceLanguage: pair.source,
        targetLanguage: pair.target
      });
    },
    [settings, capabilities, persist]
  );

  const onTargetChange = useCallback(
    (code: string) => {
      if (!settings) return;
      if (!modeCaps) {
        void persist({
          ...settings,
          targetLanguage: code,
          sourceLanguage: counterpartSource(code)
        });
        return;
      }
      // The popup exposes only the target; derive the source from it, then
      // snap the pair to what the mode's capabilities actually allow.
      const pair = coercePair(modeCaps, counterpartSource(code), code);
      void persist({
        ...settings,
        sourceLanguage: pair.source,
        targetLanguage: pair.target
      });
    },
    [settings, modeCaps, persist]
  );

  const onStart = useCallback(async () => {
    if (!settings || !activeTab || typeof activeTab.id !== "number") {
      return;
    }
    if (!validateSettings(settings).valid) {
      await chrome.runtime.openOptionsPage();
      return;
    }
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: activeTab.id
    });
    await chrome.runtime.sendMessage({
      type: "START_FROM_POPUP",
      tabId: activeTab.id,
      streamId,
      settings
    } satisfies StartFromPopupMessage);
    window.close();
  }, [settings, activeTab]);

  const onStop = useCallback(async () => {
    await chrome.runtime.sendMessage({
      type: "STOP_SESSION",
      reason: "popup_stop"
    } satisfies StopSessionMessage);
    window.close();
  }, []);

  const onOpenOptions = useCallback(() => {
    void chrome.runtime.openOptionsPage();
    window.close();
  }, []);

  if (!settings) {
    return null;
  }

  const gate = evaluateStartGate({
    settingsValid: validateSettings(settings).valid,
    hasActiveTab: typeof activeTab?.id === "number"
  });

  const view: PopupView = {
    pill: popupPill(sessionState.status, settings.mode),
    status: sessionState.status,
    running,
    tabTitle: activeTab?.title ?? null,
    elapsedMs:
      running && "startedAt" in sessionState
        ? Date.now() - (sessionState as { startedAt?: number }).startedAt!
        : null,
    mode: settings.mode,
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
    targetOptions: modeCaps ? targetOptions(modeCaps, settings.sourceLanguage) : [],
    recent,
    startReason: gate.reason,
    errorMessage:
      sessionState.status === "error" ? sessionState.error.message : null
  };

  const handlers: PopupHandlers = {
    onStart: () => void onStart(),
    onStop: () => void onStop(),
    onModeChange,
    onTargetChange,
    onOpenOptions
  };

  return <PopupApp view={view} handlers={handlers} />;
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<PopupRoot />);
}
```

Note on elapsed time: `ActiveSessionDetails` does not currently carry a `startedAt`. The `elapsedMs` expression above reads it defensively (`"startedAt" in sessionState`) and yields `null` when absent, so the live card simply shows `00:00` until a future change threads a start timestamp through `sessionState`. Do not add that field in this task — it is out of scope; the guard keeps the type honest. If `pnpm typecheck` rejects the `"startedAt" in sessionState` narrowing, replace the `elapsedMs` value with `null` and leave a `// elapsed: needs a session start timestamp (deferred)` comment.

- [ ] **Step 3: Register the popup in the manifest**

In `apps/extension/wxt.config.ts`, set `default_popup` in the `action` block:

```ts
    action: {
      default_title: "EchoFlow",
      default_popup: "popup.html"
    }
```

(WXT maps the `entrypoints/popup/index.html` entrypoint to `popup.html` in the built manifest.)

- [ ] **Step 4: Typecheck and run the suite**

Run: `pnpm typecheck`
Expected: PASS (all packages). Then `pnpm --filter @echoflow/extension test` — Expected: PASS (the new entrypoint has no unit tests; `PopupApp` and the helpers are already covered).

- [ ] **Step 5: Commit**

```bash
git add apps/extension/entrypoints/popup/index.html apps/extension/entrypoints/popup/main.tsx apps/extension/wxt.config.ts
git commit -m "feat(extension): wire popup entrypoint + default_popup"
```

---

### Task 6: Build verification

A final gate that the extension builds with the popup and all surfaces typecheck and test clean.

**Files:** None (verification only).

**Interfaces:** Consumes all prior tasks. Produces nothing.

- [ ] **Step 1: Full typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 2: Full extension test run**

Run: `pnpm --filter @echoflow/extension test`
Expected: PASS.

- [ ] **Step 3: Production build**

Run: `pnpm --filter @echoflow/extension build`
Expected: Build completes; the built `manifest.json` lists `action.default_popup` = `popup.html` and a `popup.html` output exists under `.output/chrome-mv3`.

- [ ] **Step 4: Confirm the popup shipped in the build**

Run: `test -f apps/extension/.output/chrome-mv3/popup.html && grep -o '"default_popup":"popup.html"' apps/extension/.output/chrome-mv3/manifest.json`
Expected: prints `"default_popup":"popup.html"` (and the `test -f` succeeds).

- [ ] **Step 5: Report**

If steps produced no file changes, report that all gates pass. Otherwise commit any incidental fixes with `chore(extension): popup build verification`.

---

## Self-Review

**Spec coverage:**
- §1 role & interaction (icon opens popup, layout A) → Task 5 (`default_popup`) + Task 4 (layout).
- §2 states (pill mapping, live card, ephemeral state read) → Task 2 (`popupPill`/`formatElapsed`) + Task 4 (render) + Task 5 (storage read).
- §3 quick controls + bare labels + editable-while-running hint → Task 1 (labels) + Task 4 (controls + hint) + Task 5 (persistence/coercePair).
- §4 capture-gesture move + storage state read → Task 3 (background refactor, remove onClicked) + Task 5 (getMediaStreamId in popup, START_FROM_POPUP, storage.onChanged).
- §5 components (reuse + 3 helpers + START_FROM_POPUP) → Tasks 1, 2, 4, 5.
- §6 error handling (finish-setup, capture failure, backend error) → Task 4 (finish_setup + error states) + Task 5 (gate + error mapping).
- §7 testing → Task 2 unit tests, Task 4 component tests, Task 6 build gate.
- §8 out of scope (live subtitle mirror, mid-session re-config, onboarding, paywall, protocol) → not built; elapsed start-timestamp explicitly deferred in Task 5.

**Placeholder scan:** No TBD/TODO/"handle edge cases". Every code step shows complete code. The two "remove if unused after review" notes (`DARK_THEME` import, `startedAt` guard) are explicit deferral instructions with a concrete fallback, not placeholders.

**Type consistency:** `PopupView`/`PopupHandlers` shapes are identical in Task 4 (definition) and Task 5 (construction). `popupPill(status, mode)`, `recentSessions(sessions, limit)`, `evaluateStartGate({settingsValid, hasActiveTab})` signatures match between Task 2 and Tasks 4/5. `StartFromPopupMessage` fields (`tabId`/`streamId`/`settings`) are identical in Task 1 (definition), Task 3 (consumption), Task 5 (construction). `SUBTITLE_MODE_OPTIONS` bare labels (Task 1) feed the `SegmentedControl` in Task 4. `LanguageOption` (code/label/pivot) matches the test fixtures and `sourceOptions`/`targetOptions` return type.
