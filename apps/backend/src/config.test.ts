import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConfig } from "./config.js";

const ORIGINAL_ENV = {
  ECHOFLOW_API_KEY: process.env.ECHOFLOW_API_KEY,
  ECHOFLOW_ASR_PROVIDER: process.env.ECHOFLOW_ASR_PROVIDER,
  ECHOFLOW_HOST: process.env.ECHOFLOW_HOST,
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
  VOLCENGINE_AST_API_KEY: process.env.VOLCENGINE_AST_API_KEY,
  VOLCENGINE_AST_RESOURCE_ID: process.env.VOLCENGINE_AST_RESOURCE_ID,
  VOLCENGINE_AST_ENDPOINT: process.env.VOLCENGINE_AST_ENDPOINT,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_ASR_API_KEY: process.env.OPENAI_ASR_API_KEY,
  OPENAI_ASR_BASE_URL: process.env.OPENAI_ASR_BASE_URL,
  OPENAI_ASR_MODEL: process.env.OPENAI_ASR_MODEL,
  OPENAI_ASR_SILENCE_MS: process.env.OPENAI_ASR_SILENCE_MS,
  OPENAI_ASR_PROMPT: process.env.OPENAI_ASR_PROMPT,
  OPENAI_ASR_LANGUAGES: process.env.OPENAI_ASR_LANGUAGES,
  OPENAI_TRANSLATION_API_KEY: process.env.OPENAI_TRANSLATION_API_KEY,
  OPENAI_TRANSLATION_BASE_URL: process.env.OPENAI_TRANSLATION_BASE_URL,
  OPENAI_TRANSLATION_MODEL: process.env.OPENAI_TRANSLATION_MODEL,
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
      host: "127.0.0.1",
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
      host: "127.0.0.1",
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

  it("reads VOLCENGINE_AST_* into providers.interpret", () => {
    process.env.VOLCENGINE_AST_API_KEY = "ast-api-key";
    const config = createConfig();
    expect(config.providers.interpret).toEqual({
      apiKey: "ast-api-key",
      resourceId: "volc.service_type.10053",
      endpoint: "wss://openspeech.bytedance.com/api/v4/ast/v2/translate",
    });
  });
});

describe("historyDbPath", () => {
  const ENV_KEY = "ECHOFLOW_HISTORY_DB";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = saved;
    }
  });

  it("is absent by default (sync off)", () => {
    expect(createConfig({}).historyDbPath).toBeUndefined();
  });

  it("reads ECHOFLOW_HISTORY_DB", () => {
    process.env[ENV_KEY] = "./history.db";
    expect(createConfig({}).historyDbPath).toBe("./history.db");
  });

  it("treats a blank env value as unset", () => {
    process.env[ENV_KEY] = "  ";
    expect(createConfig({}).historyDbPath).toBeUndefined();
  });

  it("prefers explicit input over env", () => {
    process.env[ENV_KEY] = "./env.db";
    expect(createConfig({ historyDbPath: ":memory:" }).historyDbPath).toBe(":memory:");
  });
});

describe("host", () => {
  it("defaults to loopback", () => {
    delete process.env.ECHOFLOW_HOST;
    expect(createConfig().host).toBe("127.0.0.1");
  });

  it("reads ECHOFLOW_HOST", () => {
    process.env.ECHOFLOW_HOST = "0.0.0.0";
    expect(createConfig().host).toBe("0.0.0.0");
  });

  it("ignores a blank ECHOFLOW_HOST", () => {
    process.env.ECHOFLOW_HOST = "   ";
    expect(createConfig().host).toBe("127.0.0.1");
  });

  it("prefers an explicit input over the environment", () => {
    process.env.ECHOFLOW_HOST = "0.0.0.0";
    expect(createConfig({ host: "127.0.0.1" }).host).toBe("127.0.0.1");
  });
});

describe("openai provider", () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_ASR_API_KEY;
    delete process.env.OPENAI_ASR_BASE_URL;
    delete process.env.OPENAI_ASR_MODEL;
    delete process.env.OPENAI_ASR_SILENCE_MS;
    delete process.env.OPENAI_ASR_PROMPT;
    delete process.env.OPENAI_ASR_LANGUAGES;
    delete process.env.OPENAI_TRANSLATION_API_KEY;
    delete process.env.OPENAI_TRANSLATION_BASE_URL;
    delete process.env.OPENAI_TRANSLATION_MODEL;
  });

  it("reads the asr leg from the shared key and default base url", () => {
    process.env.ECHOFLOW_ASR_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-shared";

    expect(createConfig().providers.asr).toEqual({
      provider: "openai",
      openai: {
        apiKey: "sk-shared",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-live-transcribe",
        silenceMs: 600,
      },
    });
  });

  it("lets the asr leg override key, base url, model, silence, prompt and languages", () => {
    process.env.ECHOFLOW_ASR_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-shared";
    process.env.OPENAI_BASE_URL = "https://shared.example/v1";
    process.env.OPENAI_ASR_API_KEY = "sk-asr";
    process.env.OPENAI_ASR_BASE_URL = "http://127.0.0.1:8000/v1/";
    process.env.OPENAI_ASR_MODEL = "Systran/faster-whisper-small";
    process.env.OPENAI_ASR_SILENCE_MS = "800";
    process.env.OPENAI_ASR_PROMPT = "EchoFlow, Volcengine";
    process.env.OPENAI_ASR_LANGUAGES = "en, zh,";

    expect(createConfig().providers.asr.openai).toEqual({
      apiKey: "sk-asr",
      baseUrl: "http://127.0.0.1:8000/v1",
      model: "Systran/faster-whisper-small",
      silenceMs: 800,
      prompt: "EchoFlow, Volcengine",
      languages: ["en", "zh"],
    });
  });

  it("falls back to the shared base url for a leg without its own", () => {
    process.env.ECHOFLOW_TRANSLATION_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-shared";
    process.env.OPENAI_BASE_URL = "https://shared.example/v1/";

    expect(createConfig().providers.translation.openai?.baseUrl).toBe(
      "https://shared.example/v1",
    );
  });

  it("drops the asr leg when no key resolves", () => {
    process.env.ECHOFLOW_ASR_PROVIDER = "openai";
    process.env.OPENAI_ASR_MODEL = "whatever";

    expect(createConfig().providers.asr).toEqual({ provider: "openai" });
  });

  it("reads the translation leg with its own overrides", () => {
    process.env.ECHOFLOW_TRANSLATION_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-shared";
    process.env.OPENAI_TRANSLATION_BASE_URL = "https://api.groq.com/openai/v1";
    process.env.OPENAI_TRANSLATION_MODEL = "llama-3.3-70b-versatile";

    expect(createConfig().providers.translation).toEqual({
      provider: "openai",
      openai: {
        apiKey: "sk-shared",
        baseUrl: "https://api.groq.com/openai/v1",
        model: "llama-3.3-70b-versatile",
      },
    });
  });

  it("defaults the translation model to gpt-5-nano", () => {
    process.env.ECHOFLOW_TRANSLATION_PROVIDER = "openai";
    process.env.OPENAI_TRANSLATION_API_KEY = "sk-t";

    expect(createConfig().providers.translation.openai?.model).toBe("gpt-5-nano");
  });

  it("ignores openai variables when another provider is selected", () => {
    process.env.ECHOFLOW_ASR_PROVIDER = "fake";
    process.env.OPENAI_API_KEY = "sk-shared";

    expect(createConfig().providers.asr).toEqual({ provider: "fake" });
  });

  it("rejects a non-integer OPENAI_ASR_SILENCE_MS", () => {
    process.env.ECHOFLOW_ASR_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk";
    process.env.OPENAI_ASR_SILENCE_MS = "soon";

    expect(() => createConfig()).toThrow("Invalid OPENAI_ASR_SILENCE_MS value: soon");
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
  restoreEnv("ECHOFLOW_HOST", ORIGINAL_ENV.ECHOFLOW_HOST);
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
  restoreEnv("VOLCENGINE_AST_API_KEY", ORIGINAL_ENV.VOLCENGINE_AST_API_KEY);
  restoreEnv("VOLCENGINE_AST_RESOURCE_ID", ORIGINAL_ENV.VOLCENGINE_AST_RESOURCE_ID);
  restoreEnv("VOLCENGINE_AST_ENDPOINT", ORIGINAL_ENV.VOLCENGINE_AST_ENDPOINT);
  restoreEnv("OPENAI_API_KEY", ORIGINAL_ENV.OPENAI_API_KEY);
  restoreEnv("OPENAI_BASE_URL", ORIGINAL_ENV.OPENAI_BASE_URL);
  restoreEnv("OPENAI_ASR_API_KEY", ORIGINAL_ENV.OPENAI_ASR_API_KEY);
  restoreEnv("OPENAI_ASR_BASE_URL", ORIGINAL_ENV.OPENAI_ASR_BASE_URL);
  restoreEnv("OPENAI_ASR_MODEL", ORIGINAL_ENV.OPENAI_ASR_MODEL);
  restoreEnv("OPENAI_ASR_SILENCE_MS", ORIGINAL_ENV.OPENAI_ASR_SILENCE_MS);
  restoreEnv("OPENAI_ASR_PROMPT", ORIGINAL_ENV.OPENAI_ASR_PROMPT);
  restoreEnv("OPENAI_ASR_LANGUAGES", ORIGINAL_ENV.OPENAI_ASR_LANGUAGES);
  restoreEnv("OPENAI_TRANSLATION_API_KEY", ORIGINAL_ENV.OPENAI_TRANSLATION_API_KEY);
  restoreEnv("OPENAI_TRANSLATION_BASE_URL", ORIGINAL_ENV.OPENAI_TRANSLATION_BASE_URL);
  restoreEnv("OPENAI_TRANSLATION_MODEL", ORIGINAL_ENV.OPENAI_TRANSLATION_MODEL);
});
