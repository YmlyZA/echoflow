import { describe, expect, it } from "vitest";
import { isMessageForActiveSession } from "./activeSession";
import type { SessionState } from "./sessionState";

const running: SessionState = {
  status: "running",
  localSessionId: "local-active",
  tabId: 1,
  streamId: "stream-1",
  targetLanguage: "zh-CN",
  mode: "pipeline"
};

describe("isMessageForActiveSession", () => {
  it("is false when idle", () => {
    expect(isMessageForActiveSession({ status: "idle" }, "local-active")).toBe(false);
  });

  it("is true when the id matches the active session", () => {
    expect(isMessageForActiveSession(running, "local-active")).toBe(true);
  });

  it("is false when the id belongs to a replaced session", () => {
    expect(isMessageForActiveSession(running, "local-stale")).toBe(false);
  });

  it("treats a message with no id as targeting the active session", () => {
    expect(isMessageForActiveSession(running, undefined)).toBe(true);
  });
});
