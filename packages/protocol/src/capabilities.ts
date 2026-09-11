export type LanguageOption = {
  code: string;
  label: string;
  pivot: boolean;
  sourceOnly?: boolean;
};

/**
 * Why a mode is not fully usable. The backend emits codes; all wording lives in
 * the extension, so the backend never acquires opinions about UI copy.
 */
export const CAPABILITY_BLOCKER_CODES = [
  "asr_credentials_missing",
  "translation_credentials_missing",
  "interpret_credentials_missing",
  "asr_provider_unimplemented",
  "translation_provider_unimplemented",
] as const;

export type CapabilityBlockerCode = (typeof CAPABILITY_BLOCKER_CODES)[number];

export type ModeCapabilities = {
  available: boolean;
  autoDetect: boolean;
  languages: LanguageOption[];
  defaultPair?: { source: string; target: string };
  /** Served by deterministic fakes. `available` stays true — the demo is a feature. */
  demo?: boolean;
  /**
   * Reason codes. Typed as string[] on the wire on purpose: an unknown code from
   * a newer backend must not fail validation of the whole descriptor.
   */
  blockers?: readonly string[];
};

export type SyncCapability = {
  available: boolean;
};

export type CapabilitiesDescriptor = {
  modes: { pipeline: ModeCapabilities; interpret: ModeCapabilities };
  /** Absent on servers older than SP4a; treat as unavailable. */
  sync?: SyncCapability;
};

/** A {source,target} pair is valid iff distinct, target is selectable, and one side is a pivot (zh/en). */
export function validTarget(source: LanguageOption, target: LanguageOption): boolean {
  return (
    source.code !== target.code &&
    target.sourceOnly !== true &&
    (source.pivot || target.pivot)
  );
}

function isLanguageOption(value: unknown): value is LanguageOption {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.code === "string" &&
    typeof v.label === "string" &&
    typeof v.pivot === "boolean" &&
    (v.sourceOnly === undefined || typeof v.sourceOnly === "boolean")
  );
}

function isModeCapabilities(value: unknown): value is ModeCapabilities {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const defaultPairValid =
    v.defaultPair === undefined ||
    (typeof v.defaultPair === "object" &&
      v.defaultPair !== null &&
      typeof (v.defaultPair as Record<string, unknown>).source === "string" &&
      typeof (v.defaultPair as Record<string, unknown>).target === "string");
  const demoValid = v.demo === undefined || typeof v.demo === "boolean";
  const blockersValid =
    v.blockers === undefined ||
    (Array.isArray(v.blockers) && v.blockers.every((code) => typeof code === "string"));
  return (
    typeof v.available === "boolean" &&
    typeof v.autoDetect === "boolean" &&
    Array.isArray(v.languages) &&
    v.languages.every(isLanguageOption) &&
    defaultPairValid &&
    demoValid &&
    blockersValid
  );
}

export function isCapabilitiesDescriptor(value: unknown): value is CapabilitiesDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.modes !== "object" || v.modes === null) return false;
  const modes = v.modes as Record<string, unknown>;
  const syncValid =
    v.sync === undefined ||
    (typeof v.sync === "object" &&
      v.sync !== null &&
      typeof (v.sync as Record<string, unknown>).available === "boolean");
  return isModeCapabilities(modes.pipeline) && isModeCapabilities(modes.interpret) && syncValid;
}
