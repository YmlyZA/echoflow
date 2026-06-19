import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_CONFIG } from "../providers/providerConfig.js";
import { PipelineSubtitleSource } from "./pipelineSubtitleSource.js";
import { ModeUnavailableError } from "./subtitleSource.js";
import { createSubtitleSourceFactory } from "./subtitleSourceFactory.js";

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
