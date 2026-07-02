import { describe, expect, it } from "vitest";
import { isInternalSender, isRuntimeMessage } from "./messages";

describe("isRuntimeMessage", () => {
  it("accepts CONNECTION_STATUS messages", () => {
    expect(
      isRuntimeMessage({
        type: "CONNECTION_STATUS",
        localSessionId: "local-1",
        status: "reconnecting",
      }),
    ).toBe(true);
  });

  it("accepts a START_FROM_POPUP message", () => {
    expect(
      isRuntimeMessage({
        type: "START_FROM_POPUP",
        tabId: 7,
        streamId: "stream-1",
        settings: {
          serverUrl: "http://127.0.0.1:8787",
          apiKey: "k",
          targetLanguage: "zh-CN",
          sourceLanguage: "en",
          subtitleFontSize: 24,
          mode: "interpret"
        }
      })
    ).toBe(true);
  });

  it("accepts a SESSION_STOPPED message", () => {
    expect(
      isRuntimeMessage({ type: "SESSION_STOPPED", localSessionId: "local-1" })
    ).toBe(true);
  });

  it("rejects unknown message types", () => {
    expect(isRuntimeMessage({ type: "NOPE" })).toBe(false);
  });
});

describe("isInternalSender", () => {
  it("accepts a sender that is this extension and rejects others", () => {
    expect(isInternalSender({ id: "ext-1" }, "ext-1")).toBe(true);
    expect(isInternalSender({ id: "other-ext" }, "ext-1")).toBe(false);
    expect(isInternalSender({}, "ext-1")).toBe(false);
  });
});
