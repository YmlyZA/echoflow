import type { CapabilitiesDescriptor } from "@echoflow/protocol";

export type ConnectionTone = "full" | "partial" | "none";

export interface ConnectionSummary {
  tone: ConnectionTone;
  detail: string;
  languageCount: number;
}

export function summarizeCapabilities(
  caps: CapabilitiesDescriptor
): ConnectionSummary {
  const pipeline = caps.modes.pipeline.available;
  const interpret = caps.modes.interpret.available;
  const languageCount = Math.max(
    caps.modes.pipeline.languages.length,
    caps.modes.interpret.languages.length
  );

  if (pipeline && interpret) {
    return {
      tone: "full",
      detail: `Free + Interpret available · ${languageCount} languages`,
      languageCount
    };
  }
  if (pipeline) {
    return {
      tone: "partial",
      detail: "Free mode available · Interpret needs backend AST credentials",
      languageCount
    };
  }
  if (interpret) {
    return {
      tone: "partial",
      detail: `Interpret available · ${languageCount} languages`,
      languageCount
    };
  }
  return {
    tone: "none",
    detail: "Backend reached, but no modes are available — check provider credentials.",
    languageCount: 0
  };
}
