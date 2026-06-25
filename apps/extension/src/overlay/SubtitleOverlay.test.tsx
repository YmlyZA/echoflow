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
