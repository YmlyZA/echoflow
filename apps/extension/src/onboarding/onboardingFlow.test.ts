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
