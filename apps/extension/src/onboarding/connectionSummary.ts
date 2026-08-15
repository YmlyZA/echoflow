import type { CapabilitiesDescriptor } from "@echoflow/protocol";
import { describeBlocker } from "./describeBlocker";

export type ConnectionTone = "full" | "partial" | "none";

export interface ConnectionSummary {
  tone: ConnectionTone;
  detail: string;
  languageCount: number;
  /** Backend is serving deterministic placeholder output. */
  demo: boolean;
  /** Already-described sentences, ready to render. */
  blockers: readonly string[];
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

  const demo = caps.modes.pipeline.demo === true;
  const blockers = [
    ...(caps.modes.pipeline.blockers ?? []),
    ...(caps.modes.interpret.blockers ?? []),
  ].map(describeBlocker);

  if (pipeline && interpret) {
    return {
      tone: "full",
      detail: demo
        ? `Demo mode — deterministic sample subtitles · ${languageCount} languages`
        : `Free + Interpret available · ${languageCount} languages`,
      languageCount,
      demo,
      blockers
    };
  }
  if (pipeline) {
    return {
      tone: "partial",
      detail: demo
        ? "Demo mode — deterministic sample subtitles. Add backend credentials for real subtitles."
        : "Free mode available · Interpret needs backend AST credentials",
      languageCount,
      demo,
      blockers
    };
  }
  if (interpret) {
    return {
      tone: "partial",
      detail: `Interpret available · ${languageCount} languages`,
      languageCount,
      demo,
      blockers
    };
  }
  return {
    tone: "none",
    detail: "Backend reached, but no modes are available — check provider credentials.",
    languageCount: 0,
    demo,
    blockers
  };
}
