import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOLCENGINE_ASR_ENDPOINT,
  DEFAULT_VOLCENGINE_ASR_RESOURCE_ID,
  isInterpretAvailable,
  type ProviderConfig,
} from "./providerConfig.js";

describe("Volcengine ASR defaults", () => {
  it("targets the bidirectional bigmodel endpoint and duration resource", () => {
    expect(DEFAULT_VOLCENGINE_ASR_ENDPOINT).toBe(
      "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
    );
    expect(DEFAULT_VOLCENGINE_ASR_RESOURCE_ID).toBe("volc.bigasr.sauc.duration");
  });
});

describe("isInterpretAvailable", () => {
  it("is false without interpret config", () => {
    const config: ProviderConfig = { asr: { provider: "fake" }, translation: { provider: "fake" } };
    expect(isInterpretAvailable(config)).toBe(false);
  });
  it("is true when interpret creds are present", () => {
    const config: ProviderConfig = {
      asr: { provider: "fake" },
      translation: { provider: "fake" },
      interpret: { appKey: "a", accessKey: "b", resourceId: "r", endpoint: "wss://x" },
    };
    expect(isInterpretAvailable(config)).toBe(true);
  });
});
