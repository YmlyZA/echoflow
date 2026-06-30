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
