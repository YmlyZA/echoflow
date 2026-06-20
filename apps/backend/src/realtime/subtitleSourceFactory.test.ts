import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_CONFIG } from "../providers/providerConfig.js";
import { PipelineSubtitleSource } from "./pipelineSubtitleSource.js";
import { ModeLanguageUnsupportedError, ModeUnavailableError } from "./subtitleSource.js";
import { InterpretationSubtitleSource } from "./interpretationSubtitleSource.js";
import { createSubtitleSourceFactory } from "./subtitleSourceFactory.js";

const AST_CONFIG = {
  asr: { provider: "fake" as const },
  translation: { provider: "fake" as const },
  interpret: { appKey: "a", accessKey: "b", resourceId: "r", endpoint: "wss://x" },
};

describe("createSubtitleSourceFactory", () => {
  it("builds a PipelineSubtitleSource for pipeline mode", () => {
    const factory = createSubtitleSourceFactory(DEFAULT_PROVIDER_CONFIG);
    expect(factory("pipeline", "zh-CN")).toBeInstanceOf(PipelineSubtitleSource);
  });

  it("throws ModeUnavailableError for interpret mode (not yet available)", () => {
    const factory = createSubtitleSourceFactory(DEFAULT_PROVIDER_CONFIG);
    expect(() => factory("interpret", "zh-CN")).toThrow(ModeUnavailableError);
  });
});

describe("createSubtitleSourceFactory — interpret", () => {
  it("builds an InterpretationSubtitleSource when configured + target supported", () => {
    const factory = createSubtitleSourceFactory(AST_CONFIG);
    expect(factory("interpret", "zh-CN")).toBeInstanceOf(InterpretationSubtitleSource);
  });

  it("throws ModeUnavailableError when interpret is not configured", () => {
    const factory = createSubtitleSourceFactory(DEFAULT_PROVIDER_CONFIG);
    expect(() => factory("interpret", "zh-CN")).toThrow(ModeUnavailableError);
  });

  it("throws ModeLanguageUnsupportedError for an unsupported target", () => {
    const factory = createSubtitleSourceFactory(AST_CONFIG);
    expect(() => factory("interpret", "ja")).toThrow(ModeLanguageUnsupportedError);
  });
});
