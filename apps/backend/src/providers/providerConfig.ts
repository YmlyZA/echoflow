export const ASR_PROVIDER_NAMES = ["fake", "volcengine", "aliyun", "tencent"] as const;
export const TRANSLATION_PROVIDER_NAMES = [
  "fake",
  "volcengine",
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

export type AsrProviderConfig = {
  provider: AsrProviderName;
};

export type TranslationProviderConfig = {
  provider: TranslationProviderName;
  volcengine?: VolcengineTranslationConfig;
};

export type ProviderConfig = {
  asr: AsrProviderConfig;
  translation: TranslationProviderConfig;
};

export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  asr: { provider: "fake" },
  translation: { provider: "fake" },
};

export const DEFAULT_VOLCENGINE_TRANSLATION_ENDPOINT =
  "https://openspeech.bytedance.com/api/v3/machine_translation/matx_translate";
export const DEFAULT_VOLCENGINE_TRANSLATION_RESOURCE_ID = "volc.speech.mt";

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
