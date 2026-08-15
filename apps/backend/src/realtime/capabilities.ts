import type {
  CapabilitiesDescriptor,
  CapabilityBlockerCode,
  LanguageOption,
} from "@echoflow/protocol";
import type { BackendConfig } from "../config.js";
import { describeConfigHealth } from "../configHealth.js";
import { isInterpretAvailable } from "../providers/providerConfig.js";
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
  config: BackendConfig,
  options: { syncAvailable: boolean },
): CapabilitiesDescriptor {
  const health = describeConfigHealth(config);
  const asr = health.find((c) => c.name === "asr");
  const translation = health.find((c) => c.name === "translation");

  const pipelineBlockers: CapabilityBlockerCode[] = [];
  if (asr !== undefined && !asr.ready) {
    pipelineBlockers.push(
      asr.unimplemented ? "asr_provider_unimplemented" : "asr_credentials_missing",
    );
  }
  if (translation !== undefined && !translation.ready) {
    pipelineBlockers.push(
      translation.unimplemented
        ? "translation_provider_unimplemented"
        : "translation_credentials_missing",
    );
  }

  const interpretAvailable = isInterpretAvailable(config.providers);

  return {
    modes: {
      pipeline: {
        available: true,
        autoDetect: true,
        languages: PIPELINE_TARGET_LANGUAGES,
        defaultPair: { source: "auto", target: "en" },
        // Either fake leg means the output is not real, so say so.
        demo: (asr?.demo ?? false) || (translation?.demo ?? false),
        blockers: pipelineBlockers,
      },
      interpret: {
        available: interpretAvailable,
        autoDetect: false,
        languages: interpretAvailable ? AST_LANGUAGES : [],
        defaultPair: { source: "en", target: "zh" },
        demo: false,
        blockers: interpretAvailable ? [] : ["interpret_credentials_missing"],
      },
    },
    sync: { available: options.syncAvailable },
  };
}
