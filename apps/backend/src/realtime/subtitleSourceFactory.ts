import {
  createSpeechProvider,
  createTranslationProvider,
} from "../providers/providerFactory.js";
import {
  isInterpretAvailable,
  type ProviderConfig,
} from "../providers/providerConfig.js";
import { isSupportedInterpretTarget } from "../providers/astLanguages.js";
import { PipelineSubtitleSource } from "./pipelineSubtitleSource.js";
import { InterpretationSubtitleSource } from "./interpretationSubtitleSource.js";
import {
  ModeLanguageUnsupportedError,
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
    // interpret
    if (!isInterpretAvailable(config) || config.interpret === undefined) {
      throw new ModeUnavailableError(mode);
    }
    if (!isSupportedInterpretTarget(targetLanguage)) {
      throw new ModeLanguageUnsupportedError(targetLanguage);
    }
    return new InterpretationSubtitleSource(config.interpret, targetLanguage);
  };
}
