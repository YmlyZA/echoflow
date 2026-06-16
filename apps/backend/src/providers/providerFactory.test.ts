import { describe, expect, it } from "vitest";
import { FakeSpeechProvider } from "./fakeSpeechProvider.js";
import { FakeTranslationProvider } from "./fakeTranslationProvider.js";
import {
  createSpeechProvider,
  createTranslationProvider,
} from "./providerFactory.js";
import { VolcengineSpeechProvider } from "./volcengineSpeechProvider.js";
import { VolcengineTranslationProvider } from "./volcengineTranslationProvider.js";

describe("provider factories", () => {
  it("creates fake providers for local development defaults", () => {
    expect(createSpeechProvider({ provider: "fake" })).toBeInstanceOf(
      FakeSpeechProvider,
    );
    expect(createTranslationProvider({ provider: "fake" })).toBeInstanceOf(
      FakeTranslationProvider,
    );
  });

  it("fails explicitly when a domestic ASR provider is selected before its streaming adapter exists", () => {
    expect(() => createSpeechProvider({ provider: "aliyun" })).toThrow(
      "ASR provider aliyun is configured but not implemented yet",
    );
    expect(() => createSpeechProvider({ provider: "tencent" })).toThrow(
      "ASR provider tencent is configured but not implemented yet",
    );
  });

  it("constructs the Volcengine speech provider when configured with credentials", () => {
    const provider = createSpeechProvider({
      provider: "volcengine",
      volcengine: {
        appKey: "app",
        accessKey: "secret",
        resourceId: "volc.bigasr.sauc.duration",
        endpoint: "wss://example.test/asr",
      },
    });
    expect(provider).toBeInstanceOf(VolcengineSpeechProvider);
  });

  it("throws when Volcengine ASR is selected without credentials", () => {
    expect(() => createSpeechProvider({ provider: "volcengine" })).toThrow(
      /VOLCENGINE_ASR_APP_KEY/,
    );
  });

  it("creates the Volcengine translation provider when credentials are present", () => {
    const provider = createTranslationProvider({
      provider: "volcengine",
      volcengine: {
        apiKey: "volc-key",
        endpoint: "https://example.test/mt",
        resourceId: "volc.speech.mt",
      },
    });

    expect(provider).toBeInstanceOf(VolcengineTranslationProvider);
  });

  it("requires Volcengine credentials when selected for translation", () => {
    expect(() => createTranslationProvider({ provider: "volcengine" })).toThrow(
      "VOLCENGINE_API_KEY is required when ECHOFLOW_TRANSLATION_PROVIDER=volcengine",
    );
  });
});
