import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_CONFIG } from "../providers/providerConfig.js";
import { PipelineSubtitleSource } from "./pipelineSubtitleSource.js";
import { ModeLanguageUnsupportedError, ModeUnavailableError } from "./subtitleSource.js";
import { InterpretationSubtitleSource } from "./interpretationSubtitleSource.js";
import { createSubtitleSourceFactory } from "./subtitleSourceFactory.js";

const AST_CONFIG = {
  asr: { provider: "fake" as const },
  translation: { provider: "fake" as const },
  interpret: { apiKey: "a", resourceId: "r", endpoint: "wss://x" },
};

describe("createSubtitleSourceFactory", () => {
  it("builds a PipelineSubtitleSource for pipeline mode", () => {
    const factory = createSubtitleSourceFactory(DEFAULT_PROVIDER_CONFIG);
    expect(factory("pipeline", "auto", "zh-CN")).toBeInstanceOf(PipelineSubtitleSource);
  });
});

describe("createSubtitleSourceFactory — interpret", () => {
  it("builds an InterpretationSubtitleSource when configured + pair supported", () => {
    const factory = createSubtitleSourceFactory(AST_CONFIG);
    expect(factory("interpret", "en", "zh-CN")).toBeInstanceOf(InterpretationSubtitleSource);
  });

  it("throws ModeUnavailableError when interpret is not configured", () => {
    const factory = createSubtitleSourceFactory(DEFAULT_PROVIDER_CONFIG);
    expect(() => factory("interpret", "en", "zh-CN")).toThrow(ModeUnavailableError);
  });

  it("throws ModeLanguageUnsupportedError for an unsupported pair", () => {
    const factory = createSubtitleSourceFactory(AST_CONFIG);
    expect(() => factory("interpret", "ja", "ko")).toThrow(ModeLanguageUnsupportedError);
  });
});
