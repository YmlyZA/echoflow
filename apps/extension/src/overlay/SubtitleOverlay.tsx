import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent
} from "react";
import type {
  SubtitleDisplaySegment,
  TransientSubtitleError
} from "../subtitles/reducer";

export interface SubtitleOverlayProps {
  segment: SubtitleDisplaySegment | null;
  fontSize: number;
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

export function SubtitleOverlay({
  segment,
  fontSize,
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
          Show
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
        <div className="echoflow-controls" aria-label="Subtitle controls">
          <button
            className="echoflow-control"
            type="button"
            aria-label="Drag subtitles"
            onPointerDown={onDragStart}
          >
            Move
          </button>
          <button
            className="echoflow-control"
            type="button"
            aria-label="Stop subtitles"
            onClick={onStop}
          >
            Stop
          </button>
          <button
            className="echoflow-control"
            type="button"
            aria-label="Hide subtitles"
            onClick={onHide}
          >
            Hide
          </button>
          <button
            className="echoflow-control echoflow-font-button"
            type="button"
            aria-label="Decrease subtitle font size"
            onClick={onDecreaseFontSize}
          >
            A-
          </button>
          <output className="echoflow-font-size" aria-label="Subtitle font size">
            {fontSize}
          </output>
          <button
            className="echoflow-control echoflow-font-button"
            type="button"
            aria-label="Increase subtitle font size"
            onClick={onIncreaseFontSize}
          >
            A+
          </button>
        </div>

        <div className="echoflow-lines" style={{ fontSize }}>
          <p className="echoflow-source">{segment?.sourceText ?? ""}</p>
          <p className="echoflow-translation">
            {segment?.translatedText ?? ""}
          </p>
        </div>

        {transientError ? (
          <div className="echoflow-error" role="status">
            {transientError.message}
          </div>
        ) : null}
      </section>
    </>
  );
}

function SubtitleOverlayStyles() {
  return (
    <style>{`
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
        min-height: 132px;
        box-sizing: border-box;
        display: grid;
        grid-template-rows: 32px minmax(72px, auto) auto;
        gap: 8px;
        padding: 10px 12px;
        border: 1px solid rgba(255, 255, 255, 0.22);
        border-radius: 8px;
        background: rgba(16, 18, 24, 0.9);
        color: #f7f7f2;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.34);
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
          "Segoe UI", sans-serif;
      }

      .echoflow-controls {
        display: grid;
        grid-template-columns: 64px 56px 56px 40px 38px 40px;
        align-items: center;
        justify-content: end;
        gap: 6px;
        min-width: 0;
      }

      .echoflow-control,
      .echoflow-restore {
        min-width: 0;
        height: 28px;
        border: 1px solid rgba(255, 255, 255, 0.24);
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.1);
        color: #f7f7f2;
        font: 600 12px/1 system-ui, sans-serif;
        cursor: pointer;
      }

      .echoflow-control:focus-visible,
      .echoflow-restore:focus-visible {
        outline: 2px solid #67d7c2;
        outline-offset: 2px;
      }

      .echoflow-font-button {
        width: 40px;
      }

      .echoflow-font-size {
        color: #d9dfdf;
        font: 600 12px/1 system-ui, sans-serif;
        text-align: center;
      }

      .echoflow-lines {
        display: grid;
        align-content: center;
        gap: 4px;
        min-width: 0;
        line-height: 1.25;
        text-align: center;
      }

      .echoflow-lines p {
        min-height: 1.25em;
        margin: 0;
        overflow-wrap: anywhere;
        text-wrap: balance;
      }

      .echoflow-source {
        color: #ffffff;
        font-weight: 700;
      }

      .echoflow-translation {
        color: #67d7c2;
        font-weight: 650;
      }

      .echoflow-error {
        min-height: 20px;
        padding: 4px 8px;
        border-radius: 6px;
        background: rgba(206, 64, 64, 0.22);
        color: #ffd4d4;
        font: 600 12px/1.2 system-ui, sans-serif;
        overflow-wrap: anywhere;
      }

      .echoflow-restore {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        width: 72px;
        background: rgba(16, 18, 24, 0.9);
      }

      @media (max-width: 520px) {
        .echoflow-overlay {
          width: calc(100vw - 16px);
          bottom: 8px;
          padding: 8px;
        }

        .echoflow-controls {
          grid-template-columns: repeat(6, minmax(0, 1fr));
        }

        .echoflow-control {
          padding-inline: 2px;
          font-size: 11px;
        }
      }
    `}</style>
  );
}
