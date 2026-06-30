# Onboarding / First-Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A guided first-run wizard that auto-opens on install (Welcome → Connect → Languages → Ready), makes the local-backend requirement testable, and leaves the user configured.

**Architecture:** A new dedicated onboarding page (`entrypoints/onboarding/`) opened by `onInstalled` on install. A presentational `OnboardingApp` (in `src/onboarding/`, props-driven, unit-tested) is wired by a thin entrypoint that owns settings load/save, the debounced `fetchCapabilities` connection test, and step navigation. Two pure helpers carry the logic: `onboardingFlow` (step order + the Connect advance-gate) and `connectionSummary` (capabilities → honest summary). Re-entry links from the popup and Options reopen the wizard.

**Tech Stack:** WXT + React 19 (MV3), TypeScript ESM, Vitest, `renderToStaticMarkup` for component tests. pnpm monorepo.

## Global Constraints

- Internal extension change only — **do not touch `packages/protocol`**.
- Light theme via `themeStyleSheet(LIGHT_THEME, ":root")` (`src/ui/theme.ts`); colors use `var(--ef-*)` tokens (status hue literals where no token exists are fine).
- Steps, in order: `welcome`, `connect`, `languages`, `ready`. The **Connect step blocks advancing until the connection test passes**; an explicit **"Set up later — finish anyway"** escape saves typed settings and closes.
- Mode labels are bare (`一致`/`实时`, already in `SUBTITLE_MODE_OPTIONS`). `SubtitleMode` = `"pipeline" | "interpret"` from `@echoflow/protocol`.
- The connection test reuses `fetchCapabilities(serverUrl, apiKey)` (`src/settings/capabilitiesClient.ts`) → `CapabilitiesDescriptor | null`; `null` means not connected.
- Defaults for a fresh install: backend URL `http://127.0.0.1:8787`, API-key hint `dev-key`, `subtitleFontSize` = `DEFAULT_SUBTITLE_FONT_SIZE`.
- Run commands from repo root. Test: `pnpm --filter @echoflow/extension test`. Typecheck: `pnpm typecheck`. Build: `pnpm --filter @echoflow/extension build`.
- All work on branch `feat/onboarding-slice4` (already created; spec already committed there).

Reference — types from `@echoflow/protocol` (`packages/protocol/src/capabilities.ts`):
- `LanguageOption = { code: string; label: string; pivot: boolean; sourceOnly?: boolean }`
- `ModeCapabilities = { available: boolean; autoDetect: boolean; languages: LanguageOption[]; defaultPair?: { source: string; target: string } }`
- `CapabilitiesDescriptor = { modes: { pipeline: ModeCapabilities; interpret: ModeCapabilities } }`

---

### Task 1: Pure helpers — `onboardingFlow` + `connectionSummary`

Two small pure modules carrying the wizard's step model and the honest capability summary, with their unit tests.

**Files:**
- Create: `apps/extension/src/onboarding/onboardingFlow.ts` (+ `.test.ts`)
- Create: `apps/extension/src/onboarding/connectionSummary.ts` (+ `.test.ts`)

**Interfaces:**
- Consumes: `CapabilitiesDescriptor` from `@echoflow/protocol`.
- Produces:
  - `ONBOARDING_STEPS = ["welcome", "connect", "languages", "ready"] as const`
  - `type OnboardingStep = (typeof ONBOARDING_STEPS)[number]`
  - `canAdvance(step: OnboardingStep, ctx: { connected: boolean }): boolean`
  - `nextStep(step: OnboardingStep): OnboardingStep` / `prevStep(step: OnboardingStep): OnboardingStep` (clamped)
  - `type ConnectionTone = "full" | "partial" | "none"`
  - `interface ConnectionSummary { tone: ConnectionTone; detail: string; languageCount: number }`
  - `summarizeCapabilities(caps: CapabilitiesDescriptor): ConnectionSummary`

- [ ] **Step 1: Write the failing tests**

Create `apps/extension/src/onboarding/onboardingFlow.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ONBOARDING_STEPS,
  canAdvance,
  nextStep,
  prevStep
} from "./onboardingFlow";

describe("onboardingFlow", () => {
  it("orders the steps welcome → connect → languages → ready", () => {
    expect(ONBOARDING_STEPS).toEqual(["welcome", "connect", "languages", "ready"]);
  });

  it("blocks advancing from connect until connected", () => {
    expect(canAdvance("connect", { connected: false })).toBe(false);
    expect(canAdvance("connect", { connected: true })).toBe(true);
  });

  it("lets every non-connect step advance freely", () => {
    expect(canAdvance("welcome", { connected: false })).toBe(true);
    expect(canAdvance("languages", { connected: false })).toBe(true);
    expect(canAdvance("ready", { connected: false })).toBe(true);
  });

  it("navigates next/prev with clamping at the ends", () => {
    expect(nextStep("welcome")).toBe("connect");
    expect(nextStep("ready")).toBe("ready");
    expect(prevStep("connect")).toBe("welcome");
    expect(prevStep("welcome")).toBe("welcome");
  });
});
```

Create `apps/extension/src/onboarding/connectionSummary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { summarizeCapabilities } from "./connectionSummary";
import type { CapabilitiesDescriptor, ModeCapabilities } from "@echoflow/protocol";

function mode(available: boolean, langs: number): ModeCapabilities {
  return {
    available,
    autoDetect: false,
    languages: Array.from({ length: langs }, (_, i) => ({
      code: `l${i}`,
      label: `L${i}`,
      pivot: i === 0
    }))
  };
}

function caps(pipeline: ModeCapabilities, interpret: ModeCapabilities): CapabilitiesDescriptor {
  return { modes: { pipeline, interpret } };
}

describe("summarizeCapabilities", () => {
  it("reports both modes available with the larger language count", () => {
    const s = summarizeCapabilities(caps(mode(true, 5), mode(true, 20)));
    expect(s.tone).toBe("full");
    expect(s.languageCount).toBe(20);
    expect(s.detail).toContain("Interpret available");
  });

  it("names the interpret limitation when only pipeline is available", () => {
    const s = summarizeCapabilities(caps(mode(true, 5), mode(false, 0)));
    expect(s.tone).toBe("partial");
    expect(s.detail).toContain("Interpret needs backend AST credentials");
  });

  it("reports none when no mode is available", () => {
    const s = summarizeCapabilities(caps(mode(false, 0), mode(false, 0)));
    expect(s.tone).toBe("none");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @echoflow/extension test onboarding/`
Expected: FAIL — cannot find modules `./onboardingFlow`, `./connectionSummary`.

- [ ] **Step 3: Implement the helpers**

Create `apps/extension/src/onboarding/onboardingFlow.ts`:

```ts
export const ONBOARDING_STEPS = ["welcome", "connect", "languages", "ready"] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export function canAdvance(
  step: OnboardingStep,
  ctx: { connected: boolean }
): boolean {
  if (step === "connect") {
    return ctx.connected;
  }
  return true;
}

export function nextStep(step: OnboardingStep): OnboardingStep {
  const index = ONBOARDING_STEPS.indexOf(step);
  return ONBOARDING_STEPS[Math.min(index + 1, ONBOARDING_STEPS.length - 1)];
}

export function prevStep(step: OnboardingStep): OnboardingStep {
  const index = ONBOARDING_STEPS.indexOf(step);
  return ONBOARDING_STEPS[Math.max(index - 1, 0)];
}
```

Create `apps/extension/src/onboarding/connectionSummary.ts`:

```ts
import type { CapabilitiesDescriptor } from "@echoflow/protocol";

export type ConnectionTone = "full" | "partial" | "none";

export interface ConnectionSummary {
  tone: ConnectionTone;
  detail: string;
  languageCount: number;
}

export function summarizeCapabilities(
  caps: CapabilitiesDescriptor
): ConnectionSummary {
  const pipeline = caps.modes.pipeline.available;
  const interpret = caps.modes.interpret.available;
  const languageCount = Math.max(
    caps.modes.pipeline.languages.length,
    caps.modes.interpret.languages.length
  );

  if (pipeline && interpret) {
    return {
      tone: "full",
      detail: `Free + Interpret available · ${languageCount} languages`,
      languageCount
    };
  }
  if (pipeline) {
    return {
      tone: "partial",
      detail: "Free mode available · Interpret needs backend AST credentials",
      languageCount
    };
  }
  if (interpret) {
    return {
      tone: "partial",
      detail: `Interpret available · ${languageCount} languages`,
      languageCount
    };
  }
  return {
    tone: "none",
    detail: "Backend reached, but no modes are available — check provider credentials.",
    languageCount: 0
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/extension test onboarding/`
Expected: PASS (onboardingFlow 4, connectionSummary 3).

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/onboarding/onboardingFlow.ts apps/extension/src/onboarding/onboardingFlow.test.ts apps/extension/src/onboarding/connectionSummary.ts apps/extension/src/onboarding/connectionSummary.test.ts
git commit -m "feat(extension): onboarding pure helpers (step flow + connection summary)"
```

---

### Task 2: `OnboardingApp` presentational wizard + CSS

A props-driven 4-step wizard in `src/onboarding/` (no chrome APIs), unit-tested via `renderToStaticMarkup`.

**Files:**
- Create: `apps/extension/src/onboarding/OnboardingApp.tsx` (+ `.test.tsx`)

**Interfaces:**
- Consumes: `OnboardingStep` (Task 1); `ConnectionSummary` (Task 1); `SegmentedControl`, `LanguagePicker`, `SUBTITLE_MODE_OPTIONS`, `LIGHT_THEME`/`themeStyleSheet`/`RADIUS`; `SubtitleMode`, `LanguageOption` from `@echoflow/protocol`.
- Produces:
  - `type ConnectState = "idle" | "loading" | "ok" | "error"`
  - `interface OnboardingView { step: OnboardingStep; canContinue: boolean; serverUrl: string; apiKey: string; connectState: ConnectState; connectSummary: ConnectionSummary | null; mode: SubtitleMode; sourceLanguage: string; targetLanguage: string; targetOptions: LanguageOption[] }`
  - `interface OnboardingHandlers { onServerUrlChange(v: string): void; onApiKeyChange(v: string): void; onModeChange(m: SubtitleMode): void; onTargetChange(code: string): void; onBack(): void; onNext(): void; onFinishAnyway(): void; onSkip(): void; onDone(): void; onOpenOptions(): void; onOpenSetupGuide(): void }`
  - `OnboardingApp(props: { view: OnboardingView; handlers: OnboardingHandlers })`

- [ ] **Step 1: Write the failing component tests**

Create `apps/extension/src/onboarding/OnboardingApp.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OnboardingApp, type OnboardingView, type OnboardingHandlers } from "./OnboardingApp";

const handlers: OnboardingHandlers = {
  onServerUrlChange() {}, onApiKeyChange() {}, onModeChange() {}, onTargetChange() {},
  onBack() {}, onNext() {}, onFinishAnyway() {}, onSkip() {}, onDone() {},
  onOpenOptions() {}, onOpenSetupGuide() {}
};

const base: OnboardingView = {
  step: "welcome",
  canContinue: true,
  serverUrl: "http://127.0.0.1:8787",
  apiKey: "dev-key",
  connectState: "idle",
  connectSummary: null,
  mode: "pipeline",
  sourceLanguage: "en",
  targetLanguage: "zh-CN",
  targetOptions: [{ code: "zh-CN", label: "中文 (简体)", pivot: true }]
};

function render(view: Partial<OnboardingView>) {
  return renderToStaticMarkup(
    <OnboardingApp view={{ ...base, ...view }} handlers={handlers} />
  );
}

describe("OnboardingApp", () => {
  it("welcome: shows the value line and the self-host checklist", () => {
    const html = render({ step: "welcome" });
    expect(html).toContain("Get started");
    expect(html).toContain("local backend");
  });

  it("connect (error): shows the fix-it and disables Continue but offers finish-anyway", () => {
    const html = render({ step: "connect", connectState: "error", canContinue: false });
    expect(html).toContain("Can't reach the backend");
    expect(html).toContain("finish anyway");
    expect(html).toContain("disabled");
  });

  it("connect (ok): shows the connection summary and enables Continue", () => {
    const html = render({
      step: "connect",
      connectState: "ok",
      canContinue: true,
      connectSummary: { tone: "full", detail: "Free + Interpret available · 20 languages", languageCount: 20 }
    });
    expect(html).toContain("Connected");
    expect(html).toContain("Interpret available");
  });

  it("languages: renders the mode control and target picker", () => {
    const html = render({ step: "languages" });
    expect(html).toContain('aria-label="Subtitle mode"');
    expect(html).toContain('aria-label="Target language"');
  });

  it("ready: recaps config and points at the toolbar popup", () => {
    const html = render({ step: "ready" });
    expect(html).toContain("all set");
    expect(html).toContain("toolbar");
    expect(html).toContain("Done");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @echoflow/extension test OnboardingApp`
Expected: FAIL — cannot find module `./OnboardingApp`.

- [ ] **Step 3: Implement the component + CSS**

Create `apps/extension/src/onboarding/OnboardingApp.tsx`:

```tsx
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/extension test OnboardingApp`
Expected: PASS (5 tests). Then `pnpm typecheck` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/onboarding/OnboardingApp.tsx apps/extension/src/onboarding/OnboardingApp.test.tsx
git commit -m "feat(extension): OnboardingApp 4-step wizard component + light-theme CSS"
```

---

### Task 3: Onboarding entrypoint wiring

The thin entrypoint that mounts `OnboardingApp`: seeds settings, runs the debounced connection test, owns step navigation, and persists on exit.

**Files:**
- Create: `apps/extension/entrypoints/onboarding/index.html`
- Create: `apps/extension/entrypoints/onboarding/main.tsx`

**Interfaces:**
- Consumes: `OnboardingApp`/`OnboardingView`/`OnboardingHandlers`/`ConnectState` (Task 2); `ONBOARDING_STEPS`/`canAdvance`/`nextStep`/`prevStep` (Task 1); `summarizeCapabilities` (Task 1); `loadSettings`/`saveSettings`/`counterpartSource` (settings); `fetchCapabilities` (capabilitiesClient); `coercePair`/`targetOptions` (languageSelection).
- Produces: nothing for later tasks.

Entrypoint/e2e territory; gate is a clean `pnpm typecheck`, the suite staying green, and (Task 5) a build emitting `onboarding.html`. Mirror the capabilities-fetch pattern in `entrypoints/options/main.tsx`.

- [ ] **Step 1: Create the host HTML**

Create `apps/extension/entrypoints/onboarding/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>EchoFlow — Setup</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Implement the wiring**

Create `apps/extension/entrypoints/onboarding/main.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  CapabilitiesDescriptor,
  ModeCapabilities,
  SubtitleMode
} from "@echoflow/protocol";
import {
  OnboardingApp,
  type ConnectState,
  type OnboardingHandlers,
  type OnboardingView
} from "../../src/onboarding/OnboardingApp";
import {
  canAdvance,
  nextStep,
  prevStep,
  type OnboardingStep
} from "../../src/onboarding/onboardingFlow";
import { summarizeCapabilities } from "../../src/onboarding/connectionSummary";
import {
  counterpartSource,
  loadSettings,
  saveSettings,
  DEFAULT_SUBTITLE_FONT_SIZE,
  type ExtensionSettings
} from "../../src/settings/settings";
import { fetchCapabilities } from "../../src/settings/capabilitiesClient";
import { coercePair, targetOptions } from "../../src/settings/languageSelection";

const SETUP_GUIDE_URL =
  "https://github.com/YmlyZA/echoflow#readme";

function OnboardingRoot() {
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilitiesDescriptor | null>(null);
  const [connectState, setConnectState] = useState<ConnectState>("idle");

  useEffect(() => {
    void loadSettings().then((loaded) =>
      setSettings({
        ...loaded,
        serverUrl: loaded.serverUrl || "http://127.0.0.1:8787",
        subtitleFontSize: loaded.subtitleFontSize || DEFAULT_SUBTITLE_FONT_SIZE
      })
    );
  }, []);

  // Debounced connection test (mirrors Options).
  useEffect(() => {
    const serverUrl = settings?.serverUrl.trim() ?? "";
    const apiKey = settings?.apiKey.trim() ?? "";
    if (!serverUrl || !apiKey) {
      setCapabilities(null);
      setConnectState("idle");
      return;
    }
    let active = true;
    setConnectState("loading");
    const timer = setTimeout(() => {
      void fetchCapabilities(serverUrl, apiKey).then((caps) => {
        if (!active) return;
        setCapabilities(caps);
        setConnectState(caps ? "ok" : "error");
      });
    }, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [settings?.serverUrl, settings?.apiKey]);

  const modeCaps: ModeCapabilities | null = useMemo(
    () => (settings && capabilities ? capabilities.modes[settings.mode] : null),
    [settings, capabilities]
  );
  const connected = connectState === "ok";

  const patch = useCallback((next: Partial<ExtensionSettings>) => {
    setSettings((current) => (current ? { ...current, ...next } : current));
  }, []);

  const persistAndClose = useCallback(async () => {
    if (settings) await saveSettings(settings);
    window.close();
  }, [settings]);

  if (!settings) return null;

  const view: OnboardingView = {
    step,
    canContinue: canAdvance(step, { connected }),
    serverUrl: settings.serverUrl,
    apiKey: settings.apiKey,
    connectState,
    connectSummary: capabilities ? summarizeCapabilities(capabilities) : null,
    mode: settings.mode,
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
    targetOptions: modeCaps ? targetOptions(modeCaps, settings.sourceLanguage) : []
  };

  const handlers: OnboardingHandlers = {
    onServerUrlChange: (v) => patch({ serverUrl: v }),
    onApiKeyChange: (v) => patch({ apiKey: v }),
    onModeChange: (mode) => {
      const caps = capabilities?.modes[mode] ?? null;
      if (!caps) return patch({ mode });
      const pair = coercePair(caps, settings.sourceLanguage, settings.targetLanguage);
      patch({ mode, sourceLanguage: pair.source, targetLanguage: pair.target });
    },
    onTargetChange: (code) => {
      if (!modeCaps) return patch({ targetLanguage: code, sourceLanguage: counterpartSource(code) });
      const pair = coercePair(modeCaps, counterpartSource(code), code);
      patch({ sourceLanguage: pair.source, targetLanguage: pair.target });
    },
    onBack: () => setStep((s) => prevStep(s)),
    onNext: () => setStep((s) => (canAdvance(s, { connected }) ? nextStep(s) : s)),
    onFinishAnyway: () => void persistAndClose(),
    onSkip: () => void persistAndClose(),
    onDone: () => void persistAndClose(),
    onOpenOptions: () => void chrome.runtime.openOptionsPage(),
    onOpenSetupGuide: () => void chrome.tabs.create({ url: SETUP_GUIDE_URL })
  };

  return <OnboardingApp view={view} handlers={handlers} />;
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<OnboardingRoot />);
}
```

Note: if `pnpm typecheck` reports `DEFAULT_SUBTITLE_FONT_SIZE` is not exported from `../../src/settings/settings`, confirm its export name there and use it (it is defined and exported in `settings.ts`).

- [ ] **Step 3: Typecheck and run the suite**

Run: `pnpm typecheck`
Expected: PASS (all packages). Then `pnpm --filter @echoflow/extension test` — Expected: PASS (no new unit tests; `OnboardingApp` + helpers already covered).

- [ ] **Step 4: Commit**

```bash
git add apps/extension/entrypoints/onboarding/index.html apps/extension/entrypoints/onboarding/main.tsx
git commit -m "feat(extension): wire onboarding entrypoint (connect test + navigation)"
```

---

### Task 4: Install trigger + re-entry links

Auto-open onboarding on install, and make it reachable again from the popup and Options.

**Files:**
- Modify: `apps/extension/entrypoints/background.ts` (`onInstalled`)
- Modify: `apps/extension/src/popup/PopupApp.tsx` (finish-setup button → new handler)
- Modify: `apps/extension/entrypoints/popup/main.tsx` (provide the handler)
- Modify: `apps/extension/entrypoints/options/main.tsx` ("Run setup again" link)

**Interfaces:**
- Consumes: the built `onboarding.html` page (Task 3).
- Produces: nothing for later tasks.

Entrypoint/integration; gate is a clean `pnpm typecheck` plus the suite green (the popup component test gains one assertion).

- [ ] **Step 1: Open onboarding on install**

In `apps/extension/entrypoints/background.ts`, replace the `onInstalled` listener:

```ts
  chrome.runtime.onInstalled.addListener((details) => {
    chrome.action.setTitle({ title: "EchoFlow" });
    if (details.reason === "install") {
      void chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
    }
  });
```

- [ ] **Step 2: Route the popup's finish-setup to onboarding (test first)**

In `apps/extension/src/popup/PopupApp.test.tsx`, add an assertion to the existing finish-setup test (the test that renders `startReason: "finish_setup"`): after rendering, assert the finish-setup button is wired to the new handler by checking the button text remains and a new `onResumeSetup` handler exists. Concretely, extend the handlers object in that test file with `onResumeSetup() {}` and add:

```tsx
  it("finish_setup: shows the resume-setup button", () => {
    const html = render({ startReason: "finish_setup" });
    expect(html).toContain("Finish setup");
  });
```

(If the test file's shared `handlers` object is typed against `PopupHandlers`, adding `onResumeSetup` there is required for it to compile once Step 3 adds the prop.)

- [ ] **Step 3: Add the `onResumeSetup` handler prop and use it**

In `apps/extension/src/popup/PopupApp.tsx`, add `onResumeSetup(): void;` to the `PopupHandlers` interface, and change the finish-setup button's `onClick` from `handlers.onOpenOptions` to `handlers.onResumeSetup`:

```tsx
            <button className="ef-setup" type="button" onClick={handlers.onResumeSetup}>
              Finish setup in Options
            </button>
```

Change the button label to drop "in Options" since it now opens the guided setup:

```tsx
            <button className="ef-setup" type="button" onClick={handlers.onResumeSetup}>
              Finish setup
            </button>
```

(The footer "Open full settings" button keeps `handlers.onOpenOptions`.)

- [ ] **Step 4: Provide the handler in the popup entrypoint**

In `apps/extension/entrypoints/popup/main.tsx`, add to the `handlers` object:

```tsx
    onResumeSetup: () => {
      void chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
      window.close();
    },
```

- [ ] **Step 5: Add "Run setup again" to Options**

In `apps/extension/entrypoints/options/main.tsx`, the header (around line 172) is:

```tsx
      <header className="ef-header">
        <span className="ef-wordmark">EchoFlow</span>
        <StatusPill capsState={capsState} />
      </header>
```

Add a "Run setup again" button to that header using the existing `ef-secondary` button class (already defined in this file's CSS — do not add new CSS):

```tsx
      <header className="ef-header">
        <span className="ef-wordmark">EchoFlow</span>
        <StatusPill capsState={capsState} />
        <button
          type="button"
          className="ef-secondary"
          onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") })}
        >
          Run setup again
        </button>
      </header>
```

- [ ] **Step 6: Typecheck and run the suite**

Run: `pnpm typecheck`
Expected: PASS. Then `pnpm --filter @echoflow/extension test` — Expected: PASS (the popup finish-setup test still green with the new handler).

- [ ] **Step 7: Commit**

```bash
git add apps/extension/entrypoints/background.ts apps/extension/src/popup/PopupApp.tsx apps/extension/src/popup/PopupApp.test.tsx apps/extension/entrypoints/popup/main.tsx apps/extension/entrypoints/options/main.tsx
git commit -m "feat(extension): auto-open onboarding on install + re-entry from popup/options"
```

---

### Task 5: Build verification

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
Expected: Build completes; `apps/extension/.output/chrome-mv3/onboarding.html` exists.

- [ ] **Step 4: Confirm the onboarding page shipped**

Run: `test -f apps/extension/.output/chrome-mv3/onboarding.html && echo "onboarding present"`
Expected: prints `onboarding present`.

- [ ] **Step 5: Report**

If steps produced no file changes, report all gates pass. Otherwise commit any incidental fixes with `chore(extension): onboarding build verification`.

---

## Self-Review

**Spec coverage:**
- §1 surface/trigger/re-entry → Task 3 (page), Task 4 (onInstalled + popup/options links).
- §2 four steps → Task 2 (component), Task 3 (navigation + connect fetch).
- §3 connection summary → Task 1 (`summarizeCapabilities`) + Task 2 (render) + Task 3 (wire).
- §4 step model → Task 1 (`onboardingFlow`).
- §5 state & persistence → Task 3 (seed/save/close, capabilities fetch).
- §6 file structure → all files mapped.
- §7 edge cases → Task 2 (connect idle/loading/ok/error states), Task 3 (null caps → not-connected, empty url/key → idle, seed from loadSettings).
- §8 testing → Task 1/2 unit + component tests, Task 5 build gate.
- Out of scope (backend automation, e2e, telemetry, protocol) → untouched.

**Placeholder scan:** No TBD/TODO. Every code step shows complete code. The two "confirm export / reuse existing class" notes are explicit verification instructions with a concrete fallback, not placeholders.

**Type consistency:** `OnboardingView`/`OnboardingHandlers` identical in Task 2 (def) and Task 3 (construction). `OnboardingStep`/`canAdvance`/`nextStep`/`prevStep` identical in Task 1 and Task 3. `ConnectionSummary` (`tone`/`detail`/`languageCount`) identical in Task 1, consumed in Task 2/3. `summarizeCapabilities(caps)` signature matches. `coercePair` returns `{ source, target }` — mapped to `sourceLanguage`/`targetLanguage` in Task 3 (same as the popup). `PopupHandlers` gains `onResumeSetup` in Task 4 (component + both the test's handlers object and the entrypoint construct it). `SUBTITLE_MODE_OPTIONS` bare labels feed the mode control.
