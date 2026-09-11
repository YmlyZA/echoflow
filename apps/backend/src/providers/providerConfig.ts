export const ASR_PROVIDER_NAMES = [
  "fake",
  "volcengine",
  "openai",
  "aliyun",
  "tencent",
] as const;
export const TRANSLATION_PROVIDER_NAMES = [
  "fake",
  "volcengine",
  "openai",
  "aliyun",
  "tencent",
] as const;

export type AsrProviderName = (typeof ASR_PROVIDER_NAMES)[number];
export type TranslationProviderName = (typeof TRANSLATION_PROVIDER_NAMES)[number];

export type VolcengineTranslationConfig = {
  apiKey: string;
  endpoint: string;
  resourceId: string;
};

export type VolcengineAsrConfig = {
  appKey: string;
  accessKey: string;
  resourceId: string;
  endpoint: string;
  vadSegmentDurationMs?: number;
};

/**
 * OpenAI Realtime transcription, or any server that speaks that protocol
 * (Speaches, vLLM). `baseUrl` is the REST base (no trailing slash); the
 * WebSocket URL is derived from it by the adapter.
 */
export type OpenAiAsrConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** server_vad silence_duration_ms */
  silenceMs: number;
  prompt?: string;
  /** ISO 639-1 hints; absent = auto-detect */
  languages?: readonly string[];
};

/** Chat Completions — the surface every OpenAI-compatible service clones. */
export type OpenAiTranslationConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type AsrProviderConfig = {
  provider: AsrProviderName;
  volcengine?: VolcengineAsrConfig;
  openai?: OpenAiAsrConfig;
};

export type TranslationProviderConfig = {
  provider: TranslationProviderName;
  volcengine?: VolcengineTranslationConfig;
  openai?: OpenAiTranslationConfig;
};

export type VolcengineAstConfig = {
  apiKey: string;
  resourceId: string;
  endpoint: string;
};

export type ProviderConfig = {
  asr: AsrProviderConfig;
  translation: TranslationProviderConfig;
  interpret?: VolcengineAstConfig;
};

export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  asr: { provider: "fake" },
  translation: { provider: "fake" },
};

export const DEFAULT_VOLCENGINE_TRANSLATION_ENDPOINT =
  "https://openspeech.bytedance.com/api/v3/machine_translation/matx_translate";
export const DEFAULT_VOLCENGINE_TRANSLATION_RESOURCE_ID = "volc.speech.mt";

export const DEFAULT_VOLCENGINE_ASR_ENDPOINT =
  "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";
export const DEFAULT_VOLCENGINE_ASR_RESOURCE_ID = "volc.bigasr.sauc.duration";
export const DEFAULT_VOLCENGINE_ASR_VAD_MS = 1000;

export const DEFAULT_VOLCENGINE_AST_ENDPOINT =
  "wss://openspeech.bytedance.com/api/v4/ast/v2/translate";
export const DEFAULT_VOLCENGINE_AST_RESOURCE_ID = "volc.service_type.10053";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_ASR_MODEL = "gpt-live-transcribe";
export const DEFAULT_OPENAI_ASR_SILENCE_MS = 600;
export const DEFAULT_OPENAI_TRANSLATION_MODEL = "gpt-5-nano";

export function isInterpretAvailable(config: ProviderConfig): boolean {
  return config.interpret !== undefined && config.interpret.apiKey.trim() !== "";
}

export function parseAsrProviderName(value: string | undefined): AsrProviderName {
  return parseProviderName(value, "ECHOFLOW_ASR_PROVIDER", ASR_PROVIDER_NAMES);
}

export function parseTranslationProviderName(
  value: string | undefined,
): TranslationProviderName {
  return parseProviderName(
    value,
    "ECHOFLOW_TRANSLATION_PROVIDER",
    TRANSLATION_PROVIDER_NAMES,
  );
}

function parseProviderName<const T extends readonly string[]>(
  value: string | undefined,
  envName: string,
  allowed: T,
): T[number] {
  if (value === undefined || value.trim() === "") {
    return "fake";
  }

  const normalized = value.trim().toLowerCase();
  if (allowed.includes(normalized)) {
    return normalized;
  }

  throw new Error(`Invalid ${envName} value: ${value}`);
}
