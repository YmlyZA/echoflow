import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PopupApp, type PopupView, type PopupHandlers } from "./PopupApp";

const handlers: PopupHandlers = {
  onStart() {},
  onStop() {},
  onModeChange() {},
  onSourceChange() {},
  onTargetChange() {},
  onOpenOptions() {},
  onResumeSetup() {}
};

const baseView: PopupView = {
  pill: { tone: "idle", label: "Idle" },
  status: "idle",
  running: false,
  tabTitle: "Northern Lights — YouTube",
  elapsedMs: null,
  mode: "pipeline",
  autoDetect: true,
  sourceLanguage: "en",
  targetLanguage: "zh-CN",
  sourceOptions: [{ code: "en", label: "English", pivot: true }],
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

  it("languages (auto-detect mode): shows the Auto-detect label + a target picker", () => {
    const html = render({ autoDetect: true });
    expect(html).toContain("Auto-detect");
    expect(html).toContain('aria-label="Target language"');
  });

  it("languages (explicit-source mode): shows a source picker, no Auto-detect label", () => {
    const html = render({
      autoDetect: false,
      mode: "interpret",
      sourceOptions: [{ code: "en", label: "English", pivot: true }]
    });
    expect(html).toContain('aria-label="Source language"');
    expect(html).toContain('aria-label="Target language"');
    expect(html).not.toContain("Auto-detect");
  });

  it("finish_setup: blocks Start and points to settings", () => {
    const html = render({ startReason: "finish_setup" });
    expect(html).toContain("Finish setup");
  });

  it("finish_setup: shows the resume-setup button", () => {
    const html = render({ startReason: "finish_setup" });
    expect(html).toContain("Finish setup");
  });

  it("error: surfaces the message inline", () => {
    const html = render({
      status: "error",
      pill: { tone: "error", label: "连接错误" },
      errorMessage: "Can't reach the backend"
    });
    expect(html).toContain("连接错误");
    expect(html).toContain("reach the backend");
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
