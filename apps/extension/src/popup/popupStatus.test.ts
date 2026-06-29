import { describe, expect, it } from "vitest";
import { popupPill, formatElapsed } from "./popupStatus";

describe("popupPill", () => {
  it("maps idle to a neutral Idle pill", () => {
    expect(popupPill("idle", "pipeline")).toEqual({ tone: "idle", label: "Idle" });
  });
  it("maps connecting and stopping to amber labels", () => {
    expect(popupPill("connecting", "pipeline")).toEqual({ tone: "connecting", label: "连接中…" });
    expect(popupPill("stopping", "pipeline")).toEqual({ tone: "connecting", label: "停止中…" });
  });
  it("maps running to a live pill carrying the mode label", () => {
    expect(popupPill("running", "interpret")).toEqual({ tone: "live", label: "实时 · LIVE" });
    expect(popupPill("running", "pipeline")).toEqual({ tone: "live", label: "一致 · LIVE" });
  });
  it("maps error to a red 连接错误 pill", () => {
    expect(popupPill("error", "pipeline")).toEqual({ tone: "error", label: "连接错误" });
  });
});

describe("formatElapsed", () => {
  it("formats milliseconds as mm:ss", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(65_000)).toBe("01:05");
    expect(formatElapsed(600_000)).toBe("10:00");
  });
});
