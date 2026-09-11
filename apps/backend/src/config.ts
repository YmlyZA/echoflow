import {
  DEFAULT_OPENAI_ASR_MODEL,
  DEFAULT_OPENAI_ASR_SILENCE_MS,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_TRANSLATION_MODEL,
  DEFAULT_VOLCENGINE_ASR_ENDPOINT,
  DEFAULT_VOLCENGINE_ASR_RESOURCE_ID,
  DEFAULT_VOLCENGINE_ASR_VAD_MS,
  DEFAULT_VOLCENGINE_AST_ENDPOINT,
  DEFAULT_VOLCENGINE_AST_RESOURCE_ID,
  DEFAULT_VOLCENGINE_TRANSLATION_ENDPOINT,
  DEFAULT_VOLCENGINE_TRANSLATION_RESOURCE_ID,
  type ProviderConfig,
  parseAsrProviderName,
  parseTranslationProviderName,
} from "./providers/providerConfig.js";

export type BackendConfig = {
  apiKey: string;
  port: number;
  /** Listen address. Loopback by default; containers set ECHOFLOW_HOST=0.0.0.0. */
  host: string;
  providers: ProviderConfig;
  /** Path (or ":memory:") for the history sync store; unset → sync disabled. */
  historyDbPath?: string;
};

export type BackendConfigInput = Partial<BackendConfig>;

const DEFAULT_API_KEY = "dev-key";
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";

export function createConfig(input: BackendConfigInput = {}): BackendConfig {
  const historyDbPath =
    input.historyDbPath ?? readNonEmpty(process.env.ECHOFLOW_HISTORY_DB);
  return {
    apiKey: input.apiKey ?? process.env.ECHOFLOW_API_KEY ?? DEFAULT_API_KEY,
    port:
      input.port ??
      readPort(process.env.ECHOFLOW_PORT, "ECHOFLOW_PORT") ??
      readPort(process.env.PORT, "PORT") ??
      DEFAULT_PORT,
    host: input.host ?? readNonEmpty(process.env.ECHOFLOW_HOST) ?? DEFAULT_HOST,
    providers: input.providers ?? readProviderConfig(),
    ...(historyDbPath !== undefined ? { historyDbPath } : {}),
  };
}

function readNonEmpty(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return value;
}

function readPort(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }

  return parsed;
}

function readPositiveInt(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }
  return parsed;
}

function readCsv(value: string | undefined): readonly string[] | undefined {
  const items = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  return items.length > 0 ? items : undefined;
}

/**
 * One OpenAI-compatible leg: `OPENAI_<LEG>_*` overrides the shared `OPENAI_*`
 * values, so ASR can point at a local Speaches while translation goes to a
 * hosted LLM. Returns undefined when no API key resolves — configHealth reads
 * that absence as "credentials missing".
 */
function readOpenAiLeg(
  prefix: "OPENAI_ASR" | "OPENAI_TRANSLATION",
): { apiKey: string; baseUrl: string } | undefined {
  const apiKey =
    readNonEmpty(process.env[`${prefix}_API_KEY`]) ??
    readNonEmpty(process.env.OPENAI_API_KEY);
  if (apiKey === undefined) {
    return undefined;
  }
  const baseUrl =
    readNonEmpty(process.env[`${prefix}_BASE_URL`]) ??
    readNonEmpty(process.env.OPENAI_BASE_URL) ??
    DEFAULT_OPENAI_BASE_URL;
  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, "") };
}

function readProviderConfig(): ProviderConfig {
  const asrProvider = parseAsrProviderName(process.env.ECHOFLOW_ASR_PROVIDER);
  const translationProvider = parseTranslationProviderName(
    process.env.ECHOFLOW_TRANSLATION_PROVIDER,
  );

  const config: ProviderConfig = {
    asr: { provider: asrProvider },
    translation: { provider: translationProvider },
  };

  if (
    asrProvider === "volcengine" &&
    process.env.VOLCENGINE_ASR_APP_KEY &&
    process.env.VOLCENGINE_ASR_ACCESS_KEY
  ) {
    config.asr.volcengine = {
      appKey: process.env.VOLCENGINE_ASR_APP_KEY,
      accessKey: process.env.VOLCENGINE_ASR_ACCESS_KEY,
      resourceId:
        process.env.VOLCENGINE_ASR_RESOURCE_ID ?? DEFAULT_VOLCENGINE_ASR_RESOURCE_ID,
      endpoint:
        process.env.VOLCENGINE_ASR_ENDPOINT ?? DEFAULT_VOLCENGINE_ASR_ENDPOINT,
      vadSegmentDurationMs: readPositiveInt(
        process.env.VOLCENGINE_ASR_VAD_MS,
        "VOLCENGINE_ASR_VAD_MS",
        DEFAULT_VOLCENGINE_ASR_VAD_MS,
      ),
    };
  }

  if (asrProvider === "openai") {
    const leg = readOpenAiLeg("OPENAI_ASR");
    if (leg !== undefined) {
      const prompt = readNonEmpty(process.env.OPENAI_ASR_PROMPT);
      const languages = readCsv(process.env.OPENAI_ASR_LANGUAGES);
      config.asr.openai = {
        ...leg,
        model: readNonEmpty(process.env.OPENAI_ASR_MODEL) ?? DEFAULT_OPENAI_ASR_MODEL,
        silenceMs: readPositiveInt(
          process.env.OPENAI_ASR_SILENCE_MS,
          "OPENAI_ASR_SILENCE_MS",
          DEFAULT_OPENAI_ASR_SILENCE_MS,
        ),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(languages !== undefined ? { languages } : {}),
      };
    }
  }

  if (translationProvider === "volcengine" && process.env.VOLCENGINE_API_KEY) {
    config.translation.volcengine = {
      apiKey: process.env.VOLCENGINE_API_KEY,
      endpoint:
        process.env.VOLCENGINE_TRANSLATION_ENDPOINT ??
        DEFAULT_VOLCENGINE_TRANSLATION_ENDPOINT,
      resourceId:
        process.env.VOLCENGINE_TRANSLATION_RESOURCE_ID ??
        DEFAULT_VOLCENGINE_TRANSLATION_RESOURCE_ID,
    };
  }

  if (translationProvider === "openai") {
    const leg = readOpenAiLeg("OPENAI_TRANSLATION");
    if (leg !== undefined) {
      config.translation.openai = {
        ...leg,
        model:
          readNonEmpty(process.env.OPENAI_TRANSLATION_MODEL) ??
          DEFAULT_OPENAI_TRANSLATION_MODEL,
      };
    }
  }

  if (process.env.VOLCENGINE_AST_API_KEY) {
    config.interpret = {
      apiKey: process.env.VOLCENGINE_AST_API_KEY,
      resourceId:
        process.env.VOLCENGINE_AST_RESOURCE_ID ?? DEFAULT_VOLCENGINE_AST_RESOURCE_ID,
      endpoint:
        process.env.VOLCENGINE_AST_ENDPOINT ?? DEFAULT_VOLCENGINE_AST_ENDPOINT,
    };
  }

  return config;
}
