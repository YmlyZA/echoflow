# Overlay Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the in-page subtitle overlay to the Direction-B product bar — an on-brand contained panel, hover-reveal icon controls, and a single status pill carrying connection lifecycle + the live mode (一致/实时).

**Architecture:** Mode rides on the `SERVER_EVENT` runtime message (stamped from `sessionState.mode` in the background), since `RealtimeClient.onStatus` only fires on reconnect and never on first connect. A new pure helper `overlayStatus.ts` maps the signals the content script already receives into one of four pill states; the overlay defaults to `"connecting"` on mount. The overlay's colors are wired to the existing `DARK_THEME` tokens (`theme.ts`) injected into the shadow root, replacing today's hardcoded literals.

**Tech Stack:** WXT + React 19 (MV3), TypeScript ESM, Vitest, `renderToStaticMarkup` for component tests. pnpm monorepo.

## Global Constraints

- Internal extension messaging change only — **do not touch `packages/protocol`** (the backend wire contract).
- `SubtitleMode` is `"pipeline" | "interpret"`, exported from `@echoflow/protocol`.
- Mode pill labels: `pipeline → 一致`, `interpret → 实时` (exact CJK glyphs).
- Pill state labels (exact): connecting `连接中…`, live `<modeLabel> · LIVE`, reconnecting `重连中…`, error `连接错误`.
- Source line uses `var(--ef-text)` weight 700; translation line uses `var(--ef-accent)` weight 650.
- Every interactive control keeps an `aria-label`; controls are icon-only.
- Hover-reveal must use `:hover` **and** `:focus-within` so keyboard focus reveals controls.
- Font size range 12–48, default `DEFAULT_SUBTITLE_FONT_SIZE` (24) — unchanged.
- Run commands from the repo root. Test: `pnpm --filter @echoflow/extension test`. Typecheck: `pnpm typecheck`.
- All work on branch `feat/overlay-redesign-slice2` (already created; the spec is already committed there).

---

### Task 1: Mode plumbing — `ServerEventMessage` + `sessionState` carry the mode

Deliver the one new datum (mode) end-to-end from session start to the content script, so later tasks can render it. No visual change yet.

**Files:**
- Modify: `apps/extension/src/messaging/messages.ts` (add `mode` to `ServerEventMessage`; import `SubtitleMode`)
- Modify: `apps/extension/src/session/sessionState.ts` (add `mode` to `ActiveSessionDetails`; set in `START_CONNECTING`)
- Modify: `apps/extension/entrypoints/background.ts` (`forwardServerEvent` stamps `mode`)
- Test: `apps/extension/src/session/sessionState.test.ts` (extend existing)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `ServerEventMessage` now has `mode: SubtitleMode`.
  - `ActiveSessionDetails` now has `mode: SubtitleMode`; populated for every active (connecting/running/stopping/error) session state.

- [ ] **Step 1: Write the failing test** — `START_CONNECTING` records the mode.

In `apps/extension/src/session/sessionState.test.ts`, add (inside the existing top-level `describe`):

```ts
it("records the subtitle mode from settings on START_CONNECTING", () => {
  const next = reduceSessionState(createInitialSessionState(), {
    type: "START_CONNECTING",
    localSessionId: "local-1",
    tabId: 7,
    streamId: "",
    settings: {
      serverUrl: "http://127.0.0.1:8787",
      apiKey: "k",
      targetLanguage: "zh-CN",
      sourceLanguage: "en",
      subtitleFontSize: 24,
      mode: "interpret"
    }
  });

  expect(next.status).toBe("connecting");
  if (next.status === "connecting") {
    expect(next.mode).toBe("interpret");
  }
});
```

If `sessionState.test.ts` does not already import `createInitialSessionState` / `reduceSessionState`, add them to the existing import from `"./sessionState"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test sessionState`
Expected: FAIL — TypeScript error that `mode` does not exist on the connecting state / `next.mode` is not a property.

- [ ] **Step 3: Add `mode` to `ActiveSessionDetails` and set it in the reducer**

In `apps/extension/src/session/sessionState.ts`, update the import and the interface:

```ts
import {
  validateSettings,
  type ExtensionSettings,
  type SettingsValidationErrors
} from "../settings/settings";
import type { SubtitleMode } from "@echoflow/protocol";
```

```ts
export interface ActiveSessionDetails {
  localSessionId: string;
  tabId: number;
  streamId: string;
  targetLanguage: string;
  mode: SubtitleMode;
  remoteSessionId?: string;
}
```

In the `START_CONNECTING` branch's returned `"connecting"` object, add `mode`:

```ts
      return {
        status: "connecting",
        localSessionId: event.localSessionId,
        tabId: event.tabId,
        streamId: event.streamId,
        targetLanguage: event.settings.targetLanguage,
        mode: event.settings.mode
      };
```

(The other branches spread the prior `ActiveSessionDetails`, so they carry `mode` forward automatically — no further edits in this file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/extension test sessionState`
Expected: PASS.

- [ ] **Step 5: Add `mode` to `ServerEventMessage` and stamp it in the background**

In `apps/extension/src/messaging/messages.ts`, update the protocol import and the message interface:

```ts
import type { ServerEvent, SubtitleMode } from "@echoflow/protocol";
```

```ts
export interface ServerEventMessage {
  type: "SERVER_EVENT";
  localSessionId: string;
  mode: SubtitleMode;
  event: ServerEvent;
}
```

In `apps/extension/entrypoints/background.ts`, in `forwardServerEvent`, add `mode` to the message sent to the tab (the function already reads `sessionState` for `tabId`):

```ts
  await sendMessageToTab(sessionState.tabId, {
    type: "SERVER_EVENT",
    localSessionId: message.localSessionId,
    mode: sessionState.mode,
    event: message.event
  });
```

- [ ] **Step 6: Verify typecheck is clean across the workspace**

Run: `pnpm typecheck`
Expected: PASS, no errors. (This confirms the offscreen's `ServerEventMessage` construction and every other consumer still satisfy the type — the offscreen sends `SERVER_EVENT` to the background **without** `mode`, so confirm that send is typed loosely enough; if `pnpm typecheck` flags the offscreen `onEvent` send in `apps/extension/entrypoints/offscreen/main.ts`, add `mode: message.settings.mode` to that `chrome.runtime.sendMessage({ type: "SERVER_EVENT", ... })` call as well.)

- [ ] **Step 7: Run the full extension test suite**

Run: `pnpm --filter @echoflow/extension test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/extension/src/messaging/messages.ts apps/extension/src/session/sessionState.ts apps/extension/src/session/sessionState.test.ts apps/extension/entrypoints/background.ts apps/extension/entrypoints/offscreen/main.ts
git commit -m "feat(extension): carry subtitle mode to the overlay via SERVER_EVENT"
```

---

### Task 2: `overlayStatus` pure helper — lifecycle derivation + mode label

A small, pure module the overlay and content script both depend on. No rendering.

**Files:**
- Create: `apps/extension/src/overlay/overlayStatus.ts`
- Test: `apps/extension/src/overlay/overlayStatus.test.ts`

**Interfaces:**
- Consumes: `SubtitleMode` from `@echoflow/protocol`.
- Produces:
  - `type OverlayLifecycle = "connecting" | "live" | "reconnecting" | "error"`
  - `deriveOverlayStatus(input: { connectionStatus: "reconnecting" | "connected" | null; hasError: boolean; hasSignal: boolean }): OverlayLifecycle`
  - `modeLabel(mode: SubtitleMode): string` → `"一致"` | `"实时"`

- [ ] **Step 1: Write the failing test**

Create `apps/extension/src/overlay/overlayStatus.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveOverlayStatus, modeLabel } from "./overlayStatus";

describe("deriveOverlayStatus", () => {
  it("starts in connecting with no signal and no connection status", () => {
    expect(
      deriveOverlayStatus({ connectionStatus: null, hasError: false, hasSignal: false })
    ).toBe("connecting");
  });

  it("is live once a signal has been seen", () => {
    expect(
      deriveOverlayStatus({ connectionStatus: null, hasError: false, hasSignal: true })
    ).toBe("live");
  });

  it("is live when connection status is connected even before a signal", () => {
    expect(
      deriveOverlayStatus({ connectionStatus: "connected", hasError: false, hasSignal: false })
    ).toBe("live");
  });

  it("reports reconnecting", () => {
    expect(
      deriveOverlayStatus({ connectionStatus: "reconnecting", hasError: false, hasSignal: true })
    ).toBe("reconnecting");
  });

  it("prioritises error over every other state", () => {
    expect(
      deriveOverlayStatus({ connectionStatus: "reconnecting", hasError: true, hasSignal: true })
    ).toBe("error");
  });
});

describe("modeLabel", () => {
  it("maps pipeline to 一致 and interpret to 实时", () => {
    expect(modeLabel("pipeline")).toBe("一致");
    expect(modeLabel("interpret")).toBe("实时");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test overlayStatus`
Expected: FAIL — cannot find module `./overlayStatus`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/extension/src/overlay/overlayStatus.ts`:

```ts
import type { SubtitleMode } from "@echoflow/protocol";

export type OverlayLifecycle = "connecting" | "live" | "reconnecting" | "error";

export interface OverlayStatusInput {
  connectionStatus: "reconnecting" | "connected" | null;
  hasError: boolean;
  hasSignal: boolean;
}

export function deriveOverlayStatus(input: OverlayStatusInput): OverlayLifecycle {
  if (input.hasError) {
    return "error";
  }

  if (input.connectionStatus === "reconnecting") {
    return "reconnecting";
  }

  if (input.hasSignal || input.connectionStatus === "connected") {
    return "live";
  }

  return "connecting";
}

export function modeLabel(mode: SubtitleMode): string {
  return mode === "interpret" ? "实时" : "一致";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/extension test overlayStatus`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/overlay/overlayStatus.ts apps/extension/src/overlay/overlayStatus.test.ts
git commit -m "feat(extension): add overlayStatus lifecycle + mode-label helper"
```

---

### Task 3: Redesign `SubtitleOverlay` — panel, status pill, hover-reveal icon controls

Rewrite the presentational component to the new design, wired to `DARK_THEME` tokens. This is the visual core.

**Files:**
- Modify: `apps/extension/src/overlay/SubtitleOverlay.tsx`
- Test: `apps/extension/src/overlay/SubtitleOverlay.test.tsx` (rewrite assertions for the new structure)

**Interfaces:**
- Consumes: `OverlayLifecycle`, `modeLabel` from `./overlayStatus` (Task 2); `SubtitleDisplaySegment`, `TransientSubtitleError` from `../subtitles/reducer`; `DARK_THEME`, `themeStyleSheet`, `RADIUS` from `../ui/theme`; `SubtitleMode` from `@echoflow/protocol`.
- Produces: `SubtitleOverlay` component with new props `lifecycle: OverlayLifecycle` and `mode: SubtitleMode` added to the existing `SubtitleOverlayProps`. The existing prop `connectionStatus` is **removed** (its information now arrives via `lifecycle`); `transientError` stays (it feeds the inline error body). All existing callback props (`onStop`, `onHide`, `onShow`, `onDecreaseFontSize`, `onIncreaseFontSize`, `onDragStart`) and `segment`, `fontSize`, `hidden`, `position` are unchanged.

- [ ] **Step 1: Rewrite the component test for the new structure**

Replace the entire contents of `apps/extension/src/overlay/SubtitleOverlay.test.tsx` with:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SubtitleOverlay } from "./SubtitleOverlay";

const segment = {
  segmentId: "s1",
  sourceText: "hello world",
  translatedText: "你好，世界",
  status: "partial" as const
};

describe("SubtitleOverlay", () => {
  it("renders source and translation lines at the given font size", () => {
    const html = renderToStaticMarkup(
      <SubtitleOverlay segment={segment} fontSize={28} lifecycle="live" mode="pipeline" />
    );

    expect(html).toContain("hello world");
    expect(html).toContain("你好，世界");
    expect(html).toContain("font-size:28px");
  });

  it("renders icon controls with accessible labels", () => {
    const html = renderToStaticMarkup(
      <SubtitleOverlay segment={segment} fontSize={24} lifecycle="live" mode="pipeline" />
    );

    expect(html).toContain('aria-label="Stop subtitles"');
    expect(html).toContain('aria-label="Hide subtitles"');
    expect(html).toContain('aria-label="Drag subtitles"');
    expect(html).toContain('aria-label="Decrease subtitle font size"');
    expect(html).toContain('aria-label="Increase subtitle font size"');
  });

  it("shows the live pill with the interpret mode label", () => {
    const html = renderToStaticMarkup(
      <SubtitleOverlay segment={segment} fontSize={24} lifecycle="live" mode="interpret" />
    );

    expect(html).toContain("实时");
    expect(html).toContain("LIVE");
  });

  it("shows the live pill with the pipeline mode label", () => {
    const html = renderToStaticMarkup(
      <SubtitleOverlay segment={segment} fontSize={24} lifecycle="live" mode="pipeline" />
    );

    expect(html).toContain("一致");
  });

  it("shows the connecting pill", () => {
    const html = renderToStaticMarkup(
      <SubtitleOverlay segment={null} fontSize={24} lifecycle="connecting" mode="pipeline" />
    );

    expect(html).toContain("连接中");
  });

  it("shows the reconnecting pill", () => {
    const html = renderToStaticMarkup(
      <SubtitleOverlay segment={segment} fontSize={24} lifecycle="reconnecting" mode="pipeline" />
    );

    expect(html).toContain("重连中");
  });

  it("folds the error message into the panel in the error state", () => {
    const html = renderToStaticMarkup(
      <SubtitleOverlay
        segment={null}
        fontSize={24}
        lifecycle="error"
        mode="pipeline"
        transientError={{ code: "stt_unavailable", message: "Speech recognition provider unavailable" }}
      />
    );

    expect(html).toContain("连接错误");
    expect(html).toContain("Speech recognition provider unavailable");
  });

  it("renders the restore control when hidden", () => {
    const html = renderToStaticMarkup(
      <SubtitleOverlay segment={segment} fontSize={24} lifecycle="live" mode="pipeline" hidden />
    );

    expect(html).toContain('aria-label="Show subtitles"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test SubtitleOverlay`
Expected: FAIL — `lifecycle`/`mode` are not valid props (TS) and the new pill strings are absent.

- [ ] **Step 3: Rewrite the component**

Replace the entire contents of `apps/extension/src/overlay/SubtitleOverlay.tsx` with:

```tsx
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent
} from "react";
import type { SubtitleMode } from "@echoflow/protocol";
import { DARK_THEME, RADIUS, themeStyleSheet } from "../ui/theme";
import type { OverlayLifecycle } from "./overlayStatus";
import { modeLabel } from "./overlayStatus";
import type {
  SubtitleDisplaySegment,
  TransientSubtitleError
} from "../subtitles/reducer";

export interface SubtitleOverlayProps {
  segment: SubtitleDisplaySegment | null;
  fontSize: number;
  lifecycle: OverlayLifecycle;
  mode: SubtitleMode;
  transientError?: TransientSubtitleError | null;
  hidden?: boolean;
  position?: {
    x: number;
    y: number;
  };
  onStop?: () => void;
  onHide?: () => void;
  onShow?: () => void;
  onDecreaseFontSize?: () => void;
  onIncreaseFontSize?: () => void;
  onDragStart?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

function pillText(lifecycle: OverlayLifecycle, mode: SubtitleMode): string {
  switch (lifecycle) {
    case "connecting":
      return "连接中…";
    case "reconnecting":
      return "重连中…";
    case "error":
      return "连接错误";
    case "live":
      return `${modeLabel(mode)} · LIVE`;
  }
}

export function SubtitleOverlay({
  segment,
  fontSize,
  lifecycle,
  mode,
  transientError = null,
  hidden = false,
  position,
  onStop,
  onHide,
  onShow,
  onDecreaseFontSize,
  onIncreaseFontSize,
  onDragStart
}: SubtitleOverlayProps) {
  if (hidden) {
    return (
      <>
        <SubtitleOverlayStyles />
        <button
          className="echoflow-restore"
          type="button"
          aria-label="Show subtitles"
          onClick={onShow}
        >
          ▣
        </button>
      </>
    );
  }

  const overlayStyle = position
    ? ({
        "--echoflow-x": `${position.x}px`,
        "--echoflow-y": `${position.y}px`
      } as CSSProperties)
    : undefined;

  return (
    <>
      <SubtitleOverlayStyles />
      <section
        className="echoflow-overlay"
        aria-live="polite"
        style={overlayStyle}
      >
        <span className={`echoflow-pill echoflow-pill-${lifecycle}`} role="status">
          <span className="echoflow-dot" />
          {pillText(lifecycle, mode)}
        </span>

        <div className="echoflow-lines" style={{ fontSize }}>
          <p className="echoflow-source">{segment?.sourceText ?? ""}</p>
          <p className="echoflow-translation">{segment?.translatedText ?? ""}</p>
        </div>

        {lifecycle === "error" && transientError ? (
          <p className="echoflow-error">{transientError.message}</p>
        ) : null}

        <div className="echoflow-controls" aria-label="Subtitle controls">
          <button
            className="echoflow-control"
            type="button"
            aria-label="Drag subtitles"
            onPointerDown={onDragStart}
          >
            ⠿
          </button>
          <button
            className="echoflow-control"
            type="button"
            aria-label="Decrease subtitle font size"
            onClick={onDecreaseFontSize}
          >
            A−
          </button>
          <output className="echoflow-font-size" aria-label="Subtitle font size">
            {fontSize}
          </output>
          <button
            className="echoflow-control"
            type="button"
            aria-label="Increase subtitle font size"
            onClick={onIncreaseFontSize}
          >
            A+
          </button>
          <button
            className="echoflow-control"
            type="button"
            aria-label="Hide subtitles"
            onClick={onHide}
          >
            ▽
          </button>
          <button
            className="echoflow-control"
            type="button"
            aria-label="Stop subtitles"
            onClick={onStop}
          >
            ✕
          </button>
        </div>
      </section>
    </>
  );
}

function SubtitleOverlayStyles() {
  return (
    <style>{`
      ${themeStyleSheet(DARK_THEME, ":host")}

      :host {
        all: initial;
      }

      .echoflow-overlay {
        position: fixed;
        left: var(--echoflow-x, 50%);
        bottom: var(--echoflow-y, 32px);
        transform: translateX(-50%);
        z-index: 2147483647;
        width: min(760px, calc(100vw - 32px));
        box-sizing: border-box;
        display: grid;
        justify-items: center;
        gap: 8px;
        padding: 14px 18px 10px;
        border: 1px solid var(--ef-border);
        border-radius: ${RADIUS.lg};
        background: color-mix(in srgb, var(--ef-surface) 86%, transparent);
        color: var(--ef-text);
        box-shadow: 0 14px 40px rgba(0, 0, 0, 0.42);
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
          "Segoe UI", sans-serif;
      }

      .echoflow-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 10px;
        border-radius: 999px;
        border: 1px solid var(--ef-border);
        background: var(--ef-bg);
        font-size: 11px;
        font-weight: 700;
        line-height: 1;
        white-space: nowrap;
      }

      .echoflow-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--ef-text-muted);
      }

      .echoflow-pill-live .echoflow-dot {
        background: var(--ef-accent);
        box-shadow: 0 0 6px var(--ef-accent);
      }
      .echoflow-pill-live { color: var(--ef-accent); }

      .echoflow-pill-connecting .echoflow-dot,
      .echoflow-pill-reconnecting .echoflow-dot {
        background: #e0a93a;
        box-shadow: 0 0 6px #e0a93a;
      }
      .echoflow-pill-connecting,
      .echoflow-pill-reconnecting { color: #f0c878; }

      .echoflow-pill-error .echoflow-dot {
        background: #e06a5e;
        box-shadow: 0 0 6px #e06a5e;
      }
      .echoflow-pill-error { color: #f0a59c; }

      .echoflow-lines {
        display: grid;
        align-content: center;
        gap: 4px;
        min-width: 0;
        width: 100%;
        line-height: 1.3;
        text-align: center;
      }

      .echoflow-lines p {
        min-height: 1.3em;
        margin: 0;
        overflow-wrap: anywhere;
        text-wrap: balance;
      }

      .echoflow-source {
        color: var(--ef-text);
        font-weight: 700;
      }

      .echoflow-translation {
        color: var(--ef-accent);
        font-weight: 650;
      }

      .echoflow-error {
        margin: 0;
        max-width: 100%;
        padding: 4px 10px;
        border-radius: ${RADIUS.sm};
        background: rgba(206, 64, 64, 0.18);
        color: #f0a59c;
        font: 600 12px/1.3 system-ui, sans-serif;
        overflow-wrap: anywhere;
        text-align: center;
      }

      .echoflow-controls {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        opacity: 0;
        max-height: 0;
        overflow: hidden;
        transition: opacity 0.18s ease, max-height 0.18s ease;
      }

      .echoflow-overlay:hover .echoflow-controls,
      .echoflow-overlay:focus-within .echoflow-controls {
        opacity: 1;
        max-height: 40px;
      }

      .echoflow-control {
        width: 28px;
        height: 26px;
        border: 1px solid var(--ef-border);
        border-radius: ${RADIUS.sm};
        background: color-mix(in srgb, var(--ef-text) 8%, transparent);
        color: var(--ef-text);
        font: 600 13px/1 system-ui, sans-serif;
        cursor: pointer;
      }

      .echoflow-control:focus-visible,
      .echoflow-restore:focus-visible {
        outline: 2px solid var(--ef-accent);
        outline-offset: 2px;
      }

      .echoflow-font-size {
        min-width: 22px;
        color: var(--ef-text-muted);
        font: 600 12px/1 system-ui, sans-serif;
        text-align: center;
      }

      .echoflow-restore {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        width: 40px;
        height: 32px;
        border: 1px solid var(--ef-border);
        border-radius: ${RADIUS.md};
        background: color-mix(in srgb, var(--ef-surface) 90%, transparent);
        color: var(--ef-text);
        font-size: 15px;
        cursor: pointer;
      }

      @media (max-width: 520px) {
        .echoflow-overlay {
          width: calc(100vw - 16px);
          bottom: 8px;
          padding: 10px 10px 8px;
        }
      }
    `}</style>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/extension test SubtitleOverlay`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/overlay/SubtitleOverlay.tsx apps/extension/src/overlay/SubtitleOverlay.test.tsx
git commit -m "feat(extension): redesign subtitle overlay (panel, status pill, hover controls)"
```

---

### Task 4: Wire the content script — track lifecycle + mode, feed the redesigned overlay

Update the mount/orchestration layer so the live overlay receives `lifecycle` and `mode`. This is the integration that makes Tasks 1–3 visible in the browser.

**Files:**
- Modify: `apps/extension/entrypoints/content.tsx`

**Interfaces:**
- Consumes: `deriveOverlayStatus` from `../src/overlay/overlayStatus` (Task 2); `ServerEventMessage`'s new `mode` field (Task 1); `SubtitleOverlay`'s new `lifecycle`/`mode` props and removed `connectionStatus` prop (Task 3).
- Produces: nothing for later tasks (final integration).

- [ ] **Step 1: Replace the connection-status state and message handling with lifecycle + mode tracking**

In `apps/extension/entrypoints/content.tsx`:

(a) Update the imports to add the helper and `SubtitleMode`:

```tsx
import type { SubtitleMode } from "@echoflow/protocol";
import { deriveOverlayStatus } from "../src/overlay/overlayStatus";
```

(b) Replace the `connectionStatus` state declaration:

```tsx
  const [connectionStatus, setConnectionStatus] = useState<
    "reconnecting" | "connected" | null
  >(null);
```

with the new tracking state:

```tsx
  const [connectionStatus, setConnectionStatus] = useState<
    "reconnecting" | "connected" | null
  >(null);
  const [hasSignal, setHasSignal] = useState(false);
  const [mode, setMode] = useState<SubtitleMode>("pipeline");
```

(c) In the `handleRuntimeMessage` callback, in the `SERVER_EVENT` branch, record signal + mode before re-dispatching. Replace:

```tsx
      if (message.type === "SERVER_EVENT") {
        window.dispatchEvent(
          new CustomEvent("echoflow:server-event", {
            detail: message.event
          })
        );
        return;
      }
```

with:

```tsx
      if (message.type === "SERVER_EVENT") {
        setHasSignal(true);
        setMode(message.mode);
        window.dispatchEvent(
          new CustomEvent("echoflow:server-event", {
            detail: message.event
          })
        );
        return;
      }
```

(d) The existing `CONNECTION_STATUS` branch already calls `setConnectionStatus(message.status)` — leave it. The `SESSION_ERROR` branch currently calls `setConnectionStatus(null)`; leave that too (error is surfaced via `transientError` in the subtitle reducer, which drives `hasError` below).

- [ ] **Step 2: Derive lifecycle and pass the new props to the overlay**

Still in `content.tsx`, just before the `return (`, compute the lifecycle:

```tsx
  const lifecycle = deriveOverlayStatus({
    connectionStatus,
    hasError: subtitleState.transientError !== null,
    hasSignal
  });
```

Then update the `<SubtitleOverlay ... />` JSX: remove the `connectionStatus={connectionStatus}` prop and add `lifecycle={lifecycle}` and `mode={mode}`:

```tsx
    <SubtitleOverlay
      segment={subtitleState.currentSegment}
      transientError={subtitleState.transientError}
      lifecycle={lifecycle}
      mode={mode}
      fontSize={fontSize}
      hidden={hidden}
      position={position ?? undefined}
      onStop={handleStop}
      onHide={() => setHidden(true)}
      onShow={() => setHidden(false)}
      onDecreaseFontSize={handleDecreaseFontSize}
      onIncreaseFontSize={handleIncreaseFontSize}
      onDragStart={handleDragStart}
    />
```

- [ ] **Step 3: Typecheck the workspace**

Run: `pnpm typecheck`
Expected: PASS — confirms `content.tsx` matches the new `SubtitleOverlayProps` (no leftover `connectionStatus` prop) and the `ServerEventMessage.mode` field is read correctly.

- [ ] **Step 4: Run the full extension test suite**

Run: `pnpm --filter @echoflow/extension test`
Expected: PASS — all overlay, helper, session, and reducer tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/entrypoints/content.tsx
git commit -m "feat(extension): drive redesigned overlay with lifecycle + mode in content script"
```

---

### Task 5: Build verification + theme-consistency check

A final gate that the extension builds and the overlay no longer carries off-brand literals where tokens exist.

**Files:**
- None (verification only).

**Interfaces:**
- Consumes: all prior tasks.
- Produces: nothing.

- [ ] **Step 1: Full typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 2: Full extension test run**

Run: `pnpm --filter @echoflow/extension test`
Expected: PASS.

- [ ] **Step 3: Production build of the extension**

Run: `pnpm --filter @echoflow/extension build`
Expected: Build completes; output written to `apps/extension/.output/chrome-mv3`. No type errors.

- [ ] **Step 4: Confirm the overlay references theme tokens**

Run: `grep -c "var(--ef-" apps/extension/src/overlay/SubtitleOverlay.tsx`
Expected: a count of **10 or more** (panel, pill, lines, controls all use `--ef-*` tokens). The amber/red status hues and the error tint are intentional literals (no token exists for them), so a few literal colors remain by design.

- [ ] **Step 5: Commit (if anything changed) and report**

If steps produced no file changes, there is nothing to commit; report that all gates pass. Otherwise:

```bash
git add -A
git commit -m "chore(extension): overlay redesign build verification"
```

---

### Task 6: Surface client-side `SESSION_ERROR` in the error pill

The final whole-branch review found that `content.tsx` receives the `SESSION_ERROR` runtime message (forwarded from the background at `background.ts:264`) but only calls `setConnectionStatus(null)` — it never drives `hasError`, so client-side failures (wrong API key, backend down at start; `connection_lost` mid-session) never show as the error pill. Spec §4 defines `hasError = transientError != null || a SESSION_ERROR was received`, and §7 calls out the "error with no prior subtitles (auth failure at start)" case. Close that gap.

**Files:**
- Modify: `apps/extension/entrypoints/content.tsx`

**Interfaces:**
- Consumes: `TransientSubtitleError` from `../src/subtitles/reducer` (already the type behind `subtitleState.transientError`); `deriveOverlayStatus` (Task 2); the `SubtitleOverlay` `transientError` prop (Task 3 renders it inline when `lifecycle === "error"`).
- Produces: nothing for later tasks (final fix).

This is an entrypoint change; per project convention (`CLAUDE.md`: the extension `test` script targets `src` only — entrypoints are covered by e2e) its gate is a clean `pnpm typecheck` plus the existing suite staying green. No new unit test.

- [ ] **Step 1: Import the error type**

In `apps/extension/entrypoints/content.tsx`, extend the existing import from `../src/subtitles/reducer` to add the type:

```tsx
import {
  createInitialSubtitleState,
  reduceSubtitleEvent,
  type TransientSubtitleError
} from "../src/subtitles/reducer";
```

- [ ] **Step 2: Add session-error state**

Immediately after the `mode` state added in Task 4 (near the other `useState` declarations), add:

```tsx
  const [sessionError, setSessionError] = useState<TransientSubtitleError | null>(
    null
  );
```

- [ ] **Step 3: Set the error in the `SESSION_ERROR` branch; clear it on a fresh signal**

In the `SERVER_EVENT` branch, where Task 4 added `setHasSignal(true)` / `setMode(message.mode)`, also clear any stale session error (a fresh event means we're live again):

```tsx
      if (message.type === "SERVER_EVENT") {
        setHasSignal(true);
        setMode(message.mode);
        setSessionError(null);
        window.dispatchEvent(
          new CustomEvent("echoflow:server-event", {
            detail: message.event
          })
        );
        return;
      }
```

In the `SESSION_ERROR` branch, record the error (keep the existing `setConnectionStatus(null)`):

```tsx
      if (message.type === "SESSION_ERROR") {
        setConnectionStatus(null);
        setSessionError({ code: message.code, message: message.message });
      }
```

- [ ] **Step 4: Feed the error into `hasError` and into the overlay's message**

Update the `lifecycle` derivation to OR in the session error:

```tsx
  const lifecycle = deriveOverlayStatus({
    connectionStatus,
    hasError: subtitleState.transientError !== null || sessionError !== null,
    hasSignal
  });
```

And update the `<SubtitleOverlay ... />` `transientError` prop so the message renders inline (the reducer error wins when both exist):

```tsx
      transientError={subtitleState.transientError ?? sessionError}
```

- [ ] **Step 5: Typecheck the workspace**

Run: `pnpm typecheck`
Expected: PASS — confirms the new state, the `TransientSubtitleError` import, and the `transientError` prop union all typecheck.

- [ ] **Step 6: Run the full extension test suite**

Run: `pnpm --filter @echoflow/extension test`
Expected: PASS — no regressions (the existing component test already covers the error pill rendering given `lifecycle="error"` + a `transientError`).

- [ ] **Step 7: Commit**

```bash
git add apps/extension/entrypoints/content.tsx
git commit -m "fix(extension): surface client-side SESSION_ERROR in the overlay error pill"
```

---

## Self-Review

**Spec coverage:**
- §1 visual model (on-brand panel, tokens) → Task 3 (component + CSS), Task 5 step 4 (token check).
- §2 hover-reveal icon controls (`:hover`+`:focus-within`, aria-labels) → Task 3.
- §3 status pill (4 states, error fold-in, mode label) → Task 2 (labels/derivation) + Task 3 (rendering) + Task 4 (wiring).
- §4 data flow (lifecycle default-connecting, mode on SERVER_EVENT) → Task 1 (mode plumbing) + Task 2 (derivation) + Task 4 (content tracking).
- §5 file structure → all files mapped across Tasks 1–4.
- §6 testing → Tasks 2/3 unit + component tests; Task 5 build gate; `reducer.test.ts` deliberately untouched.
- §7 edge cases → connecting placeholder (Task 3 empty lines + pill), long lines (`overflow-wrap`/`text-wrap`), reconnect keeps last line (segment retained), error with/without subtitles (Task 3 error test covers no-segment case), keyboard focus (`:focus-within`).
- Out-of-scope (speaker labels, auto-reconnect logic, popup, protocol) → not touched.

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". Every code step shows complete code.

**Type consistency:** `SubtitleMode` imported from `@echoflow/protocol` everywhere (messages, sessionState, overlayStatus, SubtitleOverlay, content). `deriveOverlayStatus` input shape `{ connectionStatus, hasError, hasSignal }` is identical in Task 2 definition and Task 4 call. `OverlayLifecycle` union identical in helper and component. `SubtitleOverlay` prop changes (`+lifecycle`, `+mode`, `−connectionStatus`) are applied in Task 3 and consumed in Task 4; the old `connectionStatus` prop is removed from both the component (Task 3) and its caller (Task 4), and the stale `connectionStatus`-based tests are replaced wholesale in Task 3 step 1.
