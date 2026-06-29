import { describe, expect, it } from "vitest";
import { evaluateStartGate } from "./canStart";

describe("evaluateStartGate", () => {
  it("allows start when settings are valid and a tab is active", () => {
    expect(evaluateStartGate({ settingsValid: true, hasActiveTab: true })).toEqual({
      canStart: true,
      reason: "ok"
    });
  });
  it("blocks with finish_setup when settings are invalid", () => {
    expect(evaluateStartGate({ settingsValid: false, hasActiveTab: true })).toEqual({
      canStart: false,
      reason: "finish_setup"
    });
  });
  it("blocks with no_tab when no capturable tab is active (settings valid)", () => {
    expect(evaluateStartGate({ settingsValid: true, hasActiveTab: false })).toEqual({
      canStart: false,
      reason: "no_tab"
    });
  });
});
