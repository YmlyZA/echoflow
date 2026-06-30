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

      @media (prefers-reduced-motion: reduce) {
        * { transition: none !important; animation: none !important; }
      }
    `}</style>
  );
}
