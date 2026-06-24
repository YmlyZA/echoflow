export type LanguageOption = {
  code: string;
  label: string;
  pivot: boolean;
  sourceOnly?: boolean;
};

export type ModeCapabilities = {
  available: boolean;
  autoDetect: boolean;
  languages: LanguageOption[];
  defaultPair?: { source: string; target: string };
};

export type CapabilitiesDescriptor = {
  modes: { pipeline: ModeCapabilities; interpret: ModeCapabilities };
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
  return (
    typeof v.available === "boolean" &&
    typeof v.autoDetect === "boolean" &&
    Array.isArray(v.languages) &&
    v.languages.every(isLanguageOption)
  );
}

export function isCapabilitiesDescriptor(value: unknown): value is CapabilitiesDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.modes !== "object" || v.modes === null) return false;
  const modes = v.modes as Record<string, unknown>;
  return isModeCapabilities(modes.pipeline) && isModeCapabilities(modes.interpret);
}
