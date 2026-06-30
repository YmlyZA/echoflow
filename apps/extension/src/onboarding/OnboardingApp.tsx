import type { LanguageOption, SubtitleMode } from "@echoflow/protocol";
import { LIGHT_THEME, RADIUS, themeStyleSheet } from "../ui/theme";
import { SegmentedControl } from "../ui/SegmentedControl";
import { LanguagePicker } from "../ui/LanguagePicker";
import { SUBTITLE_MODE_OPTIONS } from "../settings/settings";
import { ONBOARDING_STEPS, type OnboardingStep } from "./onboardingFlow";
import type { ConnectionSummary } from "./connectionSummary";

export type ConnectState = "idle" | "loading" | "ok" | "error";

export interface OnboardingView {
  step: OnboardingStep;
  canContinue: boolean;
  serverUrl: string;
  apiKey: string;
  connectState: ConnectState;
  connectSummary: ConnectionSummary | null;
  mode: SubtitleMode;
  sourceLanguage: string;
  targetLanguage: string;
  targetOptions: LanguageOption[];
}

export interface OnboardingHandlers {
  onServerUrlChange(v: string): void;
  onApiKeyChange(v: string): void;
  onModeChange(m: SubtitleMode): void;
  onTargetChange(code: string): void;
  onBack(): void;
  onNext(): void;
  onFinishAnyway(): void;
  onSkip(): void;
  onDone(): void;
  onOpenOptions(): void;
  onOpenSetupGuide(): void;
}

const STEP_LABELS: Record<OnboardingStep, string> = {
  welcome: "Welcome",
  connect: "Connect",
  languages: "Languages",
  ready: "Ready"
};

export function OnboardingApp({
  view,
  handlers
}: {
  view: OnboardingView;
  handlers: OnboardingHandlers;
}) {
  const activeIndex = ONBOARDING_STEPS.indexOf(view.step);

  return (
    <>
      <OnboardingStyles />
      <div className="ef-onb-page">
        <div className="ef-onb">
          <header className="ef-onb-head">
            <span className="ef-brand"><span className="ef-mark" />EchoFlow</span>
            <ol className="ef-rail">
              {ONBOARDING_STEPS.map((step, index) => (
                <li
                  key={step}
                  className={
                    index < activeIndex ? "ef-st ef-st-done"
                      : index === activeIndex ? "ef-st ef-st-active"
                      : "ef-st"
                  }
                >
                  <span className="ef-st-bar" />
                  <span className="ef-st-tx">{index + 1} {STEP_LABELS[step]}</span>
                </li>
              ))}
            </ol>
          </header>

          <div className="ef-onb-body">
            {view.step === "welcome" ? <WelcomeStep handlers={handlers} /> : null}
            {view.step === "connect" ? <ConnectStep view={view} handlers={handlers} /> : null}
            {view.step === "languages" ? <LanguagesStep view={view} handlers={handlers} /> : null}
            {view.step === "ready" ? <ReadyStep view={view} /> : null}
          </div>

          <footer className="ef-onb-foot">
            {view.step === "welcome" ? (
              <>
                <button className="ef-btn ef-ghost" type="button" onClick={handlers.onSkip}>Skip setup</button>
                <button className="ef-btn ef-primary" type="button" onClick={handlers.onNext}>Get started →</button>
              </>
            ) : view.step === "connect" ? (
              <>
                <button className="ef-btn" type="button" onClick={handlers.onBack}>Back</button>
                <div className="ef-foot-right">
                  <button className="ef-btn ef-ghost" type="button" onClick={handlers.onFinishAnyway}>Set up later — finish anyway</button>
                  <button className="ef-btn ef-primary" type="button" onClick={handlers.onNext} disabled={!view.canContinue}>Continue</button>
                </div>
              </>
            ) : view.step === "languages" ? (
              <>
                <button className="ef-btn" type="button" onClick={handlers.onBack}>Back</button>
                <button className="ef-btn ef-primary" type="button" onClick={handlers.onNext}>Continue →</button>
              </>
            ) : (
              <>
                <button className="ef-btn" type="button" onClick={handlers.onOpenOptions}>Open full settings</button>
                <button className="ef-btn ef-primary" type="button" onClick={handlers.onDone}>Done</button>
              </>
            )}
          </footer>
        </div>
      </div>
    </>
  );
}

function WelcomeStep({ handlers }: { handlers: OnboardingHandlers }) {
  return (
    <div className="ef-step">
      <div className="ef-hero" />
      <h1 className="ef-step-ttl">Real-time bilingual subtitles for any tab's audio</h1>
      <p className="ef-step-desc">Capture a tab's audio, get live source + translated subtitles on the page. Three quick steps to set up.</p>
      <ol className="ef-check">
        <li><b>You run a local backend.</b> A self-hosted MVP — the backend runs on your machine with your own provider credentials.</li>
        <li><b>We'll connect &amp; test it.</b> Paste the URL + key; we verify it's reachable before moving on.</li>
        <li><b>Pick your languages.</b> Choose mode and target from what your backend supports.</li>
      </ol>
      <p className="ef-step-desc">
        Haven't set up the backend yet?{" "}
        <button className="ef-link" type="button" onClick={handlers.onOpenSetupGuide}>Follow the setup guide →</button>
      </p>
    </div>
  );
}

function ConnectStep({ view, handlers }: { view: OnboardingView; handlers: OnboardingHandlers }) {
  return (
    <div className="ef-step">
      <h1 className="ef-step-ttl">Connect to your backend</h1>
      <p className="ef-step-desc">EchoFlow streams audio to a local backend you run yourself. Point the extension at it.</p>
      <label className="ef-field">
        <span className="ef-label">Backend URL</span>
        <input className="ef-input" value={view.serverUrl} onChange={(e) => handlers.onServerUrlChange(e.currentTarget.value)} />
      </label>
      <label className="ef-field">
        <span className="ef-label">API key</span>
        <input className="ef-input" type="password" value={view.apiKey} onChange={(e) => handlers.onApiKeyChange(e.currentTarget.value)} />
      </label>

      {view.connectState === "ok" && view.connectSummary ? (
        <div className="ef-test ef-test-ok" role="status">
          <span className="ef-test-ic">✓</span>
          <div><b>Connected.</b> {view.connectSummary.detail}</div>
        </div>
      ) : view.connectState === "error" ? (
        <div className="ef-test ef-test-err" role="status">
          <span className="ef-test-ic">!</span>
          <div>
            <b>Can't reach the backend.</b> Is it running? Start it with <code>pnpm --filter @echoflow/backend dev</code>, then retry.{" "}
            <button className="ef-link" type="button" onClick={handlers.onOpenSetupGuide}>Setup guide →</button>
          </div>
        </div>
      ) : view.connectState === "loading" ? (
        <div className="ef-test" role="status">Checking…</div>
      ) : (
        <div className="ef-test" role="status">Enter your backend URL and key to test the connection.</div>
      )}

      <p className="ef-note">⚠️ Credentials live only in the backend's <b>.env</b>, never in the extension. The extension can't run the backend for you.</p>
    </div>
  );
}

function LanguagesStep({ view, handlers }: { view: OnboardingView; handlers: OnboardingHandlers }) {
  return (
    <div className="ef-step">
      <h1 className="ef-step-ttl">Choose your languages</h1>
      <p className="ef-step-desc">Pick a mode and the language to translate into. Options come from your connected backend.</p>
      <div className="ef-field">
        <span className="ef-label">Mode</span>
        <SegmentedControl<SubtitleMode> value={view.mode} options={SUBTITLE_MODE_OPTIONS} onChange={handlers.onModeChange} ariaLabel="Subtitle mode" />
      </div>
      <div className="ef-field">
        <span className="ef-label">Translate to</span>
        <LanguagePicker value={view.targetLanguage} options={view.targetOptions} onChange={handlers.onTargetChange} ariaLabel="Target language" />
      </div>
    </div>
  );
}

function ReadyStep({ view }: { view: OnboardingView }) {
  const modeLabel = view.mode === "interpret" ? "实时" : "一致";
  return (
    <div className="ef-step">
      <div className="ef-hero ef-hero-done" />
      <h1 className="ef-step-ttl">You're all set 🎉</h1>
      <p className="ef-step-desc">Everything's configured and your backend is reachable.</p>
      <div className="ef-recap">
        <div className="ef-rr"><span className="ef-k">Backend</span><span className="ef-v"><span className="ef-dot" />Connected</span></div>
        <div className="ef-rr"><span className="ef-k">Mode</span><span className="ef-v">{modeLabel}</span></div>
        <div className="ef-rr"><span className="ef-k">Translate to</span><span className="ef-v">{view.targetLanguage}</span></div>
      </div>
      <div className="ef-howto">
        <b>To start:</b> open a tab with audio, click the <b>EchoFlow toolbar icon</b>, and press <b>Start subtitles</b> in the popup.
      </div>
    </div>
  );
}

function OnboardingStyles() {
  return (
    <style>{`
      ${themeStyleSheet(LIGHT_THEME, ":root")}
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--ef-bg); }
      .ef-onb-page { min-height: 100vh; display: flex; align-items: flex-start; justify-content: center;
        padding: 48px 20px; font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
      .ef-onb { width: 460px; background: var(--ef-bg); color: var(--ef-text);
        border: 1px solid var(--ef-border); border-radius: 16px; overflow: hidden;
        box-shadow: 0 18px 50px rgba(0,0,0,.12); }
      .ef-onb-head { padding: 16px 24px 0; background: var(--ef-surface); }
      .ef-brand { display: flex; align-items: center; gap: 9px; font-weight: 800; font-size: 15px; }
      .ef-mark { width: 20px; height: 20px; border-radius: 6px; background: linear-gradient(135deg, var(--ef-accent), #3bb6a4); }
      .ef-rail { display: flex; gap: 6px; margin: 16px 0 0; padding: 0 0 14px; list-style: none;
        border-bottom: 1px solid var(--ef-border); }
      .ef-st { flex: 1; display: flex; flex-direction: column; gap: 5px; }
      .ef-st-bar { height: 3px; border-radius: 2px; background: var(--ef-border); }
      .ef-st-done .ef-st-bar, .ef-st-active .ef-st-bar { background: var(--ef-accent); }
      .ef-st-tx { font-size: 10.5px; font-weight: 700; color: var(--ef-text-muted); }
      .ef-st-active .ef-st-tx { color: var(--ef-accent); }
      .ef-st-done .ef-st-tx { color: var(--ef-text); }
      .ef-onb-body { padding: 20px 24px; }
      .ef-step { display: grid; gap: 13px; }
      .ef-hero { width: 46px; height: 46px; border-radius: 12px; background: linear-gradient(135deg, var(--ef-accent), #3bb6a4); }
      .ef-hero-done { background: linear-gradient(135deg, #0d8a7a, #27c2a8); }
      .ef-step-ttl { font-size: 19px; font-weight: 800; margin: 0; line-height: 1.3; }
      .ef-step-desc { font-size: 13px; color: var(--ef-text-muted); margin: 0; line-height: 1.5; }
      .ef-check { margin: 2px 0 0; padding-left: 18px; display: grid; gap: 8px; font-size: 12.5px; line-height: 1.45; color: var(--ef-text-muted); }
      .ef-check b { color: var(--ef-text); font-weight: 700; }
      .ef-link { border: none; background: none; padding: 0; color: var(--ef-accent); font-weight: 600; cursor: pointer; font: inherit; }
      .ef-field { display: grid; gap: 5px; }
      .ef-label { text-transform: uppercase; letter-spacing: .08em; font-size: 10px; font-weight: 700; color: var(--ef-text-muted); }
      .ef-input { border: 1px solid var(--ef-border); border-radius: ${RADIUS.sm}; padding: 9px 11px; font-size: 13px;
        background: var(--ef-surface); color: var(--ef-text); font-family: inherit; }
      .ef-test { border-radius: ${RADIUS.md}; padding: 11px 13px; display: flex; gap: 10px; align-items: flex-start;
        font-size: 12.5px; line-height: 1.45; background: var(--ef-surface); border: 1px solid var(--ef-border); color: var(--ef-text-muted); }
      .ef-test-ok { background: var(--ef-accent-weak); border-color: #bfe7df; color: #0a6e60; }
      .ef-test-err { background: #fbece9; border-color: #e7b3aa; color: #c4503f; }
      .ef-test-ic { flex: none; width: 18px; height: 18px; border-radius: 50%; color: #fff; font-size: 12px; font-weight: 800;
        display: flex; align-items: center; justify-content: center; }
      .ef-test-ok .ef-test-ic { background: #0d8a7a; }
      .ef-test-err .ef-test-ic { background: #c4503f; }
      .ef-note { font-size: 11.5px; color: var(--ef-text-muted); background: var(--ef-surface);
        border: 1px dashed var(--ef-border); border-radius: ${RADIUS.sm}; padding: 9px 11px; margin: 0; line-height: 1.45; }
      .ef-note b { color: var(--ef-text); }
      .ef-recap { background: var(--ef-surface); border: 1px solid var(--ef-border); border-radius: ${RADIUS.md}; padding: 2px 13px; }
      .ef-rr { display: flex; align-items: center; justify-content: space-between; padding: 9px 0; font-size: 12.5px;
        border-bottom: 1px solid var(--ef-border); }
      .ef-rr:last-child { border-bottom: none; }
      .ef-k { color: var(--ef-text-muted); }
      .ef-v { font-weight: 700; display: flex; align-items: center; gap: 6px; }
      .ef-dot { width: 7px; height: 7px; border-radius: 50%; background: #0d8a7a; box-shadow: 0 0 6px #0d8a7a; }
      .ef-howto { background: var(--ef-accent-weak); border: 1px solid #bfe7df; border-radius: ${RADIUS.md};
        padding: 12px 13px; font-size: 12.5px; color: #0a6e60; line-height: 1.45; }
      .ef-onb-foot { display: flex; align-items: center; justify-content: space-between; padding: 14px 24px;
        border-top: 1px solid var(--ef-border); background: var(--ef-surface); }
      .ef-foot-right { display: flex; align-items: center; gap: 10px; }
      .ef-btn { border-radius: ${RADIUS.sm}; padding: 9px 16px; font-size: 13px; font-weight: 700; cursor: pointer;
        border: 1px solid var(--ef-border); background: var(--ef-surface); color: var(--ef-text); }
      .ef-btn.ef-primary { background: var(--ef-accent); color: #fff; border-color: var(--ef-accent); }
      .ef-btn.ef-primary:disabled { opacity: .45; cursor: not-allowed; }
      .ef-btn.ef-ghost { border: none; background: transparent; color: var(--ef-text-muted); font-weight: 600; font-size: 12px; }
      .ef-btn:focus-visible, .ef-link:focus-visible { outline: 2px solid var(--ef-accent); outline-offset: 2px; }
    `}</style>
  );
}
