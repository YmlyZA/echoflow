import { FakeSpeechProvider } from "./fakeSpeechProvider.js";
import { FakeTranslationProvider } from "./fakeTranslationProvider.js";
import type {
  AsrProviderConfig,
  TranslationProviderConfig,
} from "./providerConfig.js";
import type { SpeechProvider, TranslationProvider } from "./types.js";
import { VolcengineTranslationProvider } from "./volcengineTranslationProvider.js";

export function createSpeechProvider(config: AsrProviderConfig): SpeechProvider {
  if (config.provider === "fake") {
    return new FakeSpeechProvider();
  }

  throw new Error(
    `ASR provider ${config.provider} is configured but not implemented yet; use fake until the streaming adapter is added`,
  );
}

export function createTranslationProvider(
  config: TranslationProviderConfig,
): TranslationProvider {
  if (config.provider === "fake") {
    return new FakeTranslationProvider();
  }

  if (config.provider === "volcengine") {
    if (config.volcengine === undefined || config.volcengine.apiKey.trim() === "") {
      throw new Error(
        "VOLCENGINE_API_KEY is required when ECHOFLOW_TRANSLATION_PROVIDER=volcengine",
      );
    }

    return new VolcengineTranslationProvider(config.volcengine);
  }

  throw new Error(
    `Translation provider ${config.provider} is configured but not implemented yet; use fake or volcengine`,
  );
}
