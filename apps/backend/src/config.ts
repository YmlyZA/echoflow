import {
  DEFAULT_PROVIDER_CONFIG,
  DEFAULT_VOLCENGINE_TRANSLATION_ENDPOINT,
  DEFAULT_VOLCENGINE_TRANSLATION_RESOURCE_ID,
  type ProviderConfig,
  parseAsrProviderName,
  parseTranslationProviderName,
} from "./providers/providerConfig.js";

export type BackendConfig = {
  apiKey: string;
  port: number;
  providers: ProviderConfig;
};

export type BackendConfigInput = Partial<BackendConfig>;

const DEFAULT_API_KEY = "dev-key";
const DEFAULT_PORT = 8787;

export function createConfig(input: BackendConfigInput = {}): BackendConfig {
  return {
    apiKey: input.apiKey ?? process.env.ECHOFLOW_API_KEY ?? DEFAULT_API_KEY,
    port:
      input.port ??
      readPort(process.env.ECHOFLOW_PORT, "ECHOFLOW_PORT") ??
      readPort(process.env.PORT, "PORT") ??
      DEFAULT_PORT,
    providers: input.providers ?? readProviderConfig(),
  };
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

function readProviderConfig(): ProviderConfig {
  const asrProvider = parseAsrProviderName(process.env.ECHOFLOW_ASR_PROVIDER);
  const translationProvider = parseTranslationProviderName(
    process.env.ECHOFLOW_TRANSLATION_PROVIDER,
  );

  if (asrProvider === "fake" && translationProvider === "fake") {
    return DEFAULT_PROVIDER_CONFIG;
  }

  const config: ProviderConfig = {
    asr: { provider: asrProvider },
    translation: { provider: translationProvider },
  };

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

  return config;
}
