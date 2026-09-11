import { describe, expect, it } from "vitest";
import { degradedErrorLabel, deriveOverlayStatus, isDegradedErrorCode, modeLabel } from "./overlayStatus";

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

  it("reports degraded for a non-fatal hiccup while otherwise live", () => {
    expect(
      deriveOverlayStatus({ connectionStatus: "connected", hasError: false, hasDegradedError: true, hasSignal: true, providerReconnecting: false })
    ).toBe("degraded");
  });

  it("lets reconnecting and error outrank degraded", () => {
    expect(
      deriveOverlayStatus({ connectionStatus: "reconnecting", hasError: false, hasDegradedError: true, hasSignal: true, providerReconnecting: false })
    ).toBe("reconnecting");
    expect(
      deriveOverlayStatus({ connectionStatus: "connected", hasError: true, hasDegradedError: true, hasSignal: true, providerReconnecting: false })
    ).toBe("error");
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

describe("isDegradedErrorCode", () => {
  it("classifies translation and history hiccups as degraded, everything else as an error", () => {
    expect(isDegradedErrorCode("translation_failed")).toBe(true);
    expect(isDegradedErrorCode("history_truncated")).toBe(true);
    expect(isDegradedErrorCode("stt_unavailable")).toBe(false);
    expect(isDegradedErrorCode("invalid_client_message")).toBe(false);
  });

  it("labels each degraded code", () => {
    expect(degradedErrorLabel("translation_failed")).toBe("翻译失败");
    expect(degradedErrorLabel("history_truncated")).toBe("历史已截断");
  });
});
