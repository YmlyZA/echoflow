import type { CapabilitiesDescriptor, LanguageOption } from "@echoflow/protocol";
import { isInterpretAvailable, type ProviderConfig } from "../providers/providerConfig.js";
import { AST_LANGUAGES } from "../providers/astLanguages.js";

// Pipeline targets are the translation provider's supported output languages.
// (Source is auto-detected by ASR, so no source list is needed.)
export const PIPELINE_TARGET_LANGUAGES: LanguageOption[] = [
  { code: "en", label: "English", pivot: false },
  { code: "zh-CN", label: "Chinese (Simplified)", pivot: false },
  { code: "zh-TW", label: "Chinese (Traditional)", pivot: false },
  { code: "ja", label: "日本語", pivot: false },
  { code: "ko", label: "한국어", pivot: false },
  { code: "es", label: "Español", pivot: false },
  { code: "fr", label: "Français", pivot: false },
  { code: "de", label: "Deutsch", pivot: false },
];

export function buildCapabilities(
  config: ProviderConfig,
  options: { syncAvailable: boolean },
): CapabilitiesDescriptor {
  const interpretAvailable = isInterpretAvailable(config);
  return {
    modes: {
      pipeline: {
        available: true,
        autoDetect: true,
        languages: PIPELINE_TARGET_LANGUAGES,
        defaultPair: { source: "auto", target: "en" },
      },
      interpret: {
        available: interpretAvailable,
        autoDetect: false,
        languages: interpretAvailable ? AST_LANGUAGES : [],
        defaultPair: { source: "en", target: "zh" },
      },
    },
    sync: { available: options.syncAvailable },
  };
}
