import { describe, expect, it } from "vitest";
import { deriveOverlayStatus, modeLabel } from "./overlayStatus";

describe("deriveOverlayStatus", () => {
  it("starts in connecting with no signal and no connection status", () => {
    expect(
      deriveOverlayStatus({ connectionStatus: null, hasError: false, hasSignal: false, providerReconnecting: false })
    ).toBe("connecting");
  });

  it("is live once a signal has been seen", () => {
    expect(
      deriveOverlayStatus({ connectionStatus: null, hasError: false, hasSignal: true, providerReconnecting: false })
    ).toBe("live");
  });

  it("is live when connection status is connected even before a signal", () => {
    expect(
      deriveOverlayStatus({ connectionStatus: "connected", hasError: false, hasSignal: false, providerReconnecting: false })
    ).toBe("live");
  });

  it("reports reconnecting", () => {
    expect(
      deriveOverlayStatus({ connectionStatus: "reconnecting", hasError: false, hasSignal: true, providerReconnecting: false })
    ).toBe("reconnecting");
  });

  it("prioritises error over every other state", () => {
    expect(
      deriveOverlayStatus({ connectionStatus: "reconnecting", hasError: true, hasSignal: true, providerReconnecting: false })
    ).toBe("error");
  });

  it("shows reconnecting when the provider is reconnecting", () => {
    expect(
      deriveOverlayStatus({ connectionStatus: "connected", hasError: false, hasSignal: true, providerReconnecting: true })
    ).toBe("reconnecting");
  });

  it("lets an error outrank provider reconnecting", () => {
    expect(
      deriveOverlayStatus({ connectionStatus: "connected", hasError: true, hasSignal: true, providerReconnecting: true })
    ).toBe("error");
  });
});

describe("modeLabel", () => {
  it("maps pipeline to 一致 and interpret to 实时", () => {
    expect(modeLabel("pipeline")).toBe("一致");
    expect(modeLabel("interpret")).toBe("实时");
  });
});
