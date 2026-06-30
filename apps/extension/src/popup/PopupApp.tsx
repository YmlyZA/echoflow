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
  onResumeSetup(): void;
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
            <button className="ef-setup" type="button" onClick={handlers.onResumeSetup}>
              Finish setup
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

      @media (prefers-reduced-motion: reduce) {
        * { transition: none !important; animation: none !important; }
      }
    `}</style>
  );
}
