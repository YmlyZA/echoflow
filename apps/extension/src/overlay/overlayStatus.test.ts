import { describe, expect, it } from "vitest";
import { deriveOverlayStatus, modeLabel } from "./overlayStatus";

describe("deriveOverlayStatus", () => {
  it("starts in connecting with no signal and no connection status", () => {
    expect(
      deriveOverlayStatus({ connectionStatus: null, hasError: false, hasSignal: false })
    ).toBe("connecting");
  });

  it("is live once a signal has been seen", () => {
    expect(
      deriveOverlayStatus({ connectionStatus: null, hasError: false, hasSignal: true })
    ).toBe("live");
  });

  it("is live when connection status is connected even before a signal", () => {
    expect(
      deriveOverlayStatus({ connectionStatus: "connected", hasError: false, hasSignal: false })
    ).toBe("live");
  });

  it("reports reconnecting", () => {
    expect(
      deriveOverlayStatus({ connectionStatus: "reconnecting", hasError: false, hasSignal: true })
    ).toBe("reconnecting");
  });

  it("prioritises error over every other state", () => {
    expect(
      deriveOverlayStatus({ connectionStatus: "reconnecting", hasError: true, hasSignal: true })
    ).toBe("error");
  });
});

describe("modeLabel", () => {
  it("maps pipeline to 一致 and interpret to 实时", () => {
    expect(modeLabel("pipeline")).toBe("一致");
    expect(modeLabel("interpret")).toBe("实时");
  });
});
