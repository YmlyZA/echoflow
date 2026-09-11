import { FakeSpeechProvider } from "./fakeSpeechProvider.js";
import { FakeTranslationProvider } from "./fakeTranslationProvider.js";
import type {
  AsrProviderConfig,
  TranslationProviderConfig,
} from "./providerConfig.js";
import type { SpeechProvider, TranslationProvider } from "./types.js";
import { VolcengineSpeechProvider } from "./volcengineSpeechProvider.js";
import { VolcengineTranslationProvider } from "./volcengineTranslationProvider.js";
import { OpenAiTranslationProvider } from "./openAiTranslationProvider.js";

export function createSpeechProvider(config: AsrProviderConfig): SpeechProvider {
  if (config.provider === "fake") {
    return new FakeSpeechProvider();
  }

  if (config.provider === "volcengine") {
    if (
      config.volcengine === undefined ||
      config.volcengine.appKey.trim() === "" ||
      config.volcengine.accessKey.trim() === ""
    ) {
      throw new Error(
        "VOLCENGINE_ASR_APP_KEY and VOLCENGINE_ASR_ACCESS_KEY are required when ECHOFLOW_ASR_PROVIDER=volcengine",
      );
    }

    return new VolcengineSpeechProvider(config.volcengine);
  }

  if (config.provider === "openai") {
    if (config.openai === undefined || config.openai.apiKey.trim() === "") {
      throw new Error(
        "OPENAI_API_KEY (or OPENAI_ASR_API_KEY) is required when ECHOFLOW_ASR_PROVIDER=openai",
      );
    }
    // Adapter lands in plan Task 6.
    throw new Error("openai ASR adapter is not wired yet");
  }

  throw new Error(
    `ASR provider ${config.provider} is configured but not implemented yet; use fake, volcengine or openai`,
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

  if (config.provider === "openai") {
    if (config.openai === undefined || config.openai.apiKey.trim() === "") {
      throw new Error(
        "OPENAI_API_KEY (or OPENAI_TRANSLATION_API_KEY) is required when ECHOFLOW_TRANSLATION_PROVIDER=openai",
      );
    }
    return new OpenAiTranslationProvider(config.openai);
  }

  throw new Error(
    `Translation provider ${config.provider} is configured but not implemented yet; use fake, volcengine or openai`,
  );
}
