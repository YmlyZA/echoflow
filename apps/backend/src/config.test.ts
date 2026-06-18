import { afterEach, describe, expect, it } from "vitest";
import { createConfig } from "./config.js";

const ORIGINAL_ENV = {
  ECHOFLOW_API_KEY: process.env.ECHOFLOW_API_KEY,
  ECHOFLOW_ASR_PROVIDER: process.env.ECHOFLOW_ASR_PROVIDER,
  ECHOFLOW_PORT: process.env.ECHOFLOW_PORT,
  ECHOFLOW_TRANSLATION_PROVIDER: process.env.ECHOFLOW_TRANSLATION_PROVIDER,
  PORT: process.env.PORT,
  VOLCENGINE_API_KEY: process.env.VOLCENGINE_API_KEY,
  VOLCENGINE_TRANSLATION_ENDPOINT: process.env.VOLCENGINE_TRANSLATION_ENDPOINT,
  VOLCENGINE_ASR_APP_KEY: process.env.VOLCENGINE_ASR_APP_KEY,
  VOLCENGINE_ASR_ACCESS_KEY: process.env.VOLCENGINE_ASR_ACCESS_KEY,
  VOLCENGINE_ASR_RESOURCE_ID: process.env.VOLCENGINE_ASR_RESOURCE_ID,
  VOLCENGINE_ASR_ENDPOINT: process.env.VOLCENGINE_ASR_ENDPOINT,
  VOLCENGINE_ASR_VAD_MS: process.env.VOLCENGINE_ASR_VAD_MS,
};

describe("createConfig", () => {
  afterEach(() => {
    restoreEnv("ECHOFLOW_API_KEY", ORIGINAL_ENV.ECHOFLOW_API_KEY);
    restoreEnv("ECHOFLOW_PORT", ORIGINAL_ENV.ECHOFLOW_PORT);
    restoreEnv("PORT", ORIGINAL_ENV.PORT);
  });

  it("uses EchoFlow environment defaults", () => {
    process.env.ECHOFLOW_API_KEY = "custom-key";
    process.env.ECHOFLOW_PORT = "9999";
    delete process.env.PORT;

    expect(createConfig()).toEqual({
      apiKey: "custom-key",
      port: 9999,
      providers: {
        asr: { provider: "fake" },
        translation: { provider: "fake" },
      },
    });
  });

  it("keeps PORT as a compatibility fallback", () => {
    delete process.env.ECHOFLOW_PORT;
    process.env.PORT = "7777";

    expect(createConfig().port).toBe(7777);
  });

  it("prefers explicit input over environment values", () => {
    process.env.ECHOFLOW_API_KEY = "env-key";
    process.env.ECHOFLOW_PORT = "9999";

    expect(
      createConfig({
        apiKey: "input-key",
        port: 8888,
        providers: {
          asr: { provider: "tencent" },
          translation: {
            provider: "volcengine",
            volcengine: {
              apiKey: "input-volc-key",
              endpoint: "https://example.test/translate",
              resourceId: "volc.speech.mt",
            },
          },
        },
      }),
    ).toEqual({
      apiKey: "input-key",
      port: 8888,
      providers: {
        asr: { provider: "tencent" },
        translation: {
          provider: "volcengine",
          volcengine: {
            apiKey: "input-volc-key",
            endpoint: "https://example.test/translate",
            resourceId: "volc.speech.mt",
          },
        },
      },
    });
  });

  it("reads domestic provider settings from environment", () => {
    process.env.ECHOFLOW_ASR_PROVIDER = "aliyun";
    process.env.ECHOFLOW_TRANSLATION_PROVIDER = "volcengine";
    process.env.VOLCENGINE_API_KEY = "volc-key";
    process.env.VOLCENGINE_TRANSLATION_ENDPOINT = "https://example.test/mt";

    expect(createConfig().providers).toEqual({
      asr: { provider: "aliyun" },
      translation: {
        provider: "volcengine",
        volcengine: {
          apiKey: "volc-key",
          endpoint: "https://example.test/mt",
          resourceId: "volc.speech.mt",
        },
      },
    });
  });

  it("rejects unknown provider names", () => {
    process.env.ECHOFLOW_ASR_PROVIDER = "not-real";

    expect(() => createConfig()).toThrow("Invalid ECHOFLOW_ASR_PROVIDER value: not-real");
  });

  it("reads Volcengine ASR credentials into the asr provider config", () => {
    process.env.ECHOFLOW_ASR_PROVIDER = "volcengine";
    process.env.VOLCENGINE_ASR_APP_KEY = "app-123";
    process.env.VOLCENGINE_ASR_ACCESS_KEY = "secret-456";

    const config = createConfig();

    expect(config.providers.asr).toEqual({
      provider: "volcengine",
      volcengine: {
        appKey: "app-123",
        accessKey: "secret-456",
        resourceId: "volc.bigasr.sauc.duration",
        endpoint: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
        vadSegmentDurationMs: 1000,
      },
    });
  });

  it("reads the Volcengine ASR VAD segment duration from env (default 1000)", () => {
    process.env.ECHOFLOW_ASR_PROVIDER = "volcengine";
    process.env.VOLCENGINE_ASR_APP_KEY = "app";
    process.env.VOLCENGINE_ASR_ACCESS_KEY = "secret";

    expect(createConfig().providers.asr.volcengine?.vadSegmentDurationMs).toBe(1000);

    process.env.VOLCENGINE_ASR_VAD_MS = "800";
    expect(createConfig().providers.asr.volcengine?.vadSegmentDurationMs).toBe(800);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

afterEach(() => {
  restoreEnv("ECHOFLOW_ASR_PROVIDER", ORIGINAL_ENV.ECHOFLOW_ASR_PROVIDER);
  restoreEnv(
    "ECHOFLOW_TRANSLATION_PROVIDER",
    ORIGINAL_ENV.ECHOFLOW_TRANSLATION_PROVIDER,
  );
  restoreEnv("VOLCENGINE_API_KEY", ORIGINAL_ENV.VOLCENGINE_API_KEY);
  restoreEnv(
    "VOLCENGINE_TRANSLATION_ENDPOINT",
    ORIGINAL_ENV.VOLCENGINE_TRANSLATION_ENDPOINT,
  );
  restoreEnv("VOLCENGINE_ASR_APP_KEY", ORIGINAL_ENV.VOLCENGINE_ASR_APP_KEY);
  restoreEnv("VOLCENGINE_ASR_ACCESS_KEY", ORIGINAL_ENV.VOLCENGINE_ASR_ACCESS_KEY);
  restoreEnv("VOLCENGINE_ASR_RESOURCE_ID", ORIGINAL_ENV.VOLCENGINE_ASR_RESOURCE_ID);
  restoreEnv("VOLCENGINE_ASR_ENDPOINT", ORIGINAL_ENV.VOLCENGINE_ASR_ENDPOINT);
  restoreEnv("VOLCENGINE_ASR_VAD_MS", ORIGINAL_ENV.VOLCENGINE_ASR_VAD_MS);
});
