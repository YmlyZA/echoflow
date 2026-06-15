import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SubtitleOverlay } from "./SubtitleOverlay";

describe("SubtitleOverlay", () => {
  it("renders source and translation lines", () => {
    const html = renderToStaticMarkup(
      <SubtitleOverlay
        segment={{
          segmentId: "s1",
          sourceText: "hello world",
          translatedText: "你好，世界",
          status: "partial"
        }}
        fontSize={28}
      />
    );

    expect(html).toContain("hello world");
    expect(html).toContain("你好，世界");
    expect(html).toContain("font-size:28px");
  });

  it("renders compact controls for stop, hide, drag, and font size", () => {
    const html = renderToStaticMarkup(
      <SubtitleOverlay
        segment={{
          segmentId: "s1",
          sourceText: "hello world",
          translatedText: "你好，世界",
          status: "partial"
        }}
        fontSize={24}
      />
    );

    expect(html).toContain('aria-label="Stop subtitles"');
    expect(html).toContain('aria-label="Hide subtitles"');
    expect(html).toContain('aria-label="Drag subtitles"');
    expect(html).toContain('aria-label="Decrease subtitle font size"');
    expect(html).toContain('aria-label="Increase subtitle font size"');
  });

  it("renders transient errors", () => {
    const html = renderToStaticMarkup(
      <SubtitleOverlay
        segment={null}
        fontSize={24}
        transientError={{
          code: "stt_unavailable",
          message: "Speech recognition provider unavailable"
        }}
      />
    );

    expect(html).toContain("Speech recognition provider unavailable");
  });
});

describe("SubtitleOverlay connection status", () => {
  it("renders a reconnecting banner", () => {
    const html = renderToStaticMarkup(
      <SubtitleOverlay
        segment={null}
        fontSize={24}
        connectionStatus="reconnecting"
      />
    );

    expect(html).toContain("重连中");
  });

  it("hides the banner when connected", () => {
    const html = renderToStaticMarkup(
      <SubtitleOverlay
        segment={null}
        fontSize={24}
        connectionStatus="connected"
      />
    );

    expect(html).not.toContain("重连中");
  });
});
