import { describe, expect, it } from "vitest";
import { createConfig } from "../config.js";
import { DEFAULT_PROVIDER_CONFIG } from "../providers/providerConfig.js";
import { buildCapabilities } from "./capabilities.js";

const WITH_AST = {
  ...DEFAULT_PROVIDER_CONFIG,
  interpret: { apiKey: "k", resourceId: "r", endpoint: "wss://x" },
};

describe("buildCapabilities", () => {
  it("marks interpret available and lists the AST languages when configured", () => {
    const caps = buildCapabilities(createConfig({ providers: WITH_AST }), {
      syncAvailable: false,
    });
    expect(caps.modes.interpret.available).toBe(true);
    expect(caps.modes.interpret.autoDetect).toBe(false);
    expect(caps.modes.interpret.languages.length).toBe(20);
    expect(caps.modes.interpret.defaultPair).toEqual({ source: "en", target: "zh" });
  });

  it("marks interpret unavailable with no languages when AST is not configured", () => {
    const caps = buildCapabilities(createConfig({ providers: DEFAULT_PROVIDER_CONFIG }), {
      syncAvailable: false,
    });
    expect(caps.modes.interpret.available).toBe(false);
    expect(caps.modes.interpret.languages).toEqual([]);
  });

  it("always offers pipeline with auto-detect source and target options", () => {
    const caps = buildCapabilities(createConfig({ providers: DEFAULT_PROVIDER_CONFIG }), {
      syncAvailable: false,
    });
    expect(caps.modes.pipeline.available).toBe(true);
    expect(caps.modes.pipeline.autoDetect).toBe(true);
    expect(caps.modes.pipeline.languages.length).toBeGreaterThan(0);
  });
});

describe("buildCapabilities sync flag", () => {
  const config = createConfig({
    providers: {
      asr: { provider: "fake" as const },
      translation: { provider: "fake" as const },
    },
  });

  it("reports sync availability", () => {
    expect(buildCapabilities(config, { syncAvailable: true }).sync).toEqual({
      available: true,
    });
    expect(buildCapabilities(config, { syncAvailable: false }).sync).toEqual({
      available: false,
    });
  });
});

const build = (input: Parameters<typeof createConfig>[0]) =>
  buildCapabilities(createConfig(input), { syncAvailable: false });

describe("buildCapabilities demo and blockers", () => {
  it("keeps pipeline available but flags demo when both legs are fake", () => {
    const caps = build({
      providers: { asr: { provider: "fake" }, translation: { provider: "fake" } },
    });
    expect(caps.modes.pipeline.available).toBe(true);
    expect(caps.modes.pipeline.demo).toBe(true);
  });

  it("flags demo when only the translation leg is fake", () => {
    const caps = build({
      providers: {
        asr: {
          provider: "volcengine",
          volcengine: {
            appKey: "a",
            accessKey: "b",
            resourceId: "r",
            endpoint: "wss://example.test",
          },
        },
        translation: { provider: "fake" },
      },
    });
    expect(caps.modes.pipeline.demo).toBe(true);
  });

  it("reports missing ASR credentials as a blocker", () => {
    const caps = build({
      providers: { asr: { provider: "volcengine" }, translation: { provider: "fake" } },
    });
    expect(caps.modes.pipeline.blockers).toContain("asr_credentials_missing");
  });

  it("reports a reserved provider name as unimplemented", () => {
    const caps = build({
      providers: { asr: { provider: "aliyun" }, translation: { provider: "fake" } },
    });
    expect(caps.modes.pipeline.blockers).toContain("asr_provider_unimplemented");
  });

  it("blocks interpret without AST credentials", () => {
    const caps = build({
      providers: { asr: { provider: "fake" }, translation: { provider: "fake" } },
    });
    expect(caps.modes.interpret.available).toBe(false);
    expect(caps.modes.interpret.demo).toBe(false);
    expect(caps.modes.interpret.blockers).toContain("interpret_credentials_missing");
  });
});
