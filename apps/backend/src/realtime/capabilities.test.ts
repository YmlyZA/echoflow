import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_CONFIG } from "../providers/providerConfig.js";
import { buildCapabilities } from "./capabilities.js";

const WITH_AST = {
  ...DEFAULT_PROVIDER_CONFIG,
  interpret: { apiKey: "k", resourceId: "r", endpoint: "wss://x" },
};

describe("buildCapabilities", () => {
  it("marks interpret available and lists the AST languages when configured", () => {
    const caps = buildCapabilities(WITH_AST, { syncAvailable: false });
    expect(caps.modes.interpret.available).toBe(true);
    expect(caps.modes.interpret.autoDetect).toBe(false);
    expect(caps.modes.interpret.languages.length).toBe(20);
    expect(caps.modes.interpret.defaultPair).toEqual({ source: "en", target: "zh" });
  });

  it("marks interpret unavailable with no languages when AST is not configured", () => {
    const caps = buildCapabilities(DEFAULT_PROVIDER_CONFIG, { syncAvailable: false });
    expect(caps.modes.interpret.available).toBe(false);
    expect(caps.modes.interpret.languages).toEqual([]);
  });

  it("always offers pipeline with auto-detect source and target options", () => {
    const caps = buildCapabilities(DEFAULT_PROVIDER_CONFIG, { syncAvailable: false });
    expect(caps.modes.pipeline.available).toBe(true);
    expect(caps.modes.pipeline.autoDetect).toBe(true);
    expect(caps.modes.pipeline.languages.length).toBeGreaterThan(0);
  });
});

describe("buildCapabilities sync flag", () => {
  const config = {
    asr: { provider: "fake" as const },
    translation: { provider: "fake" as const },
  };

  it("reports sync availability", () => {
    expect(buildCapabilities(config, { syncAvailable: true }).sync).toEqual({
      available: true,
    });
    expect(buildCapabilities(config, { syncAvailable: false }).sync).toEqual({
      available: false,
    });
  });
});
