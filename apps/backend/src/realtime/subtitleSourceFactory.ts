import {
  createSpeechProvider,
  createTranslationProvider,
} from "../providers/providerFactory.js";
import type { ProviderConfig } from "../providers/providerConfig.js";
import { PipelineSubtitleSource } from "./pipelineSubtitleSource.js";
import {
  ModeUnavailableError,
  type SubtitleSourceFactory,
} from "./subtitleSource.js";

export function createSubtitleSourceFactory(
  config: ProviderConfig,
): SubtitleSourceFactory {
  return (mode, targetLanguage) => {
    if (mode === "pipeline") {
      return new PipelineSubtitleSource(
        createSpeechProvider(config.asr),
        createTranslationProvider(config.translation),
        targetLanguage,
      );
    }
    // "interpret" is the paid tier — implemented in Cycle 2.
    throw new ModeUnavailableError(mode);
  };
}
