import { describe, expect, it } from "vitest";
import { summarizeCapabilities } from "./connectionSummary";
import type { CapabilitiesDescriptor, ModeCapabilities } from "@echoflow/protocol";

function mode(available: boolean, langs: number): ModeCapabilities {
  return {
    available,
    autoDetect: false,
    languages: Array.from({ length: langs }, (_, i) => ({
      code: `l${i}`,
      label: `L${i}`,
      pivot: i === 0
    }))
  };
}

function caps(pipeline: ModeCapabilities, interpret: ModeCapabilities): CapabilitiesDescriptor {
  return { modes: { pipeline, interpret } };
}

describe("summarizeCapabilities", () => {
  it("reports both modes available with the larger language count", () => {
    const s = summarizeCapabilities(caps(mode(true, 5), mode(true, 20)));
    expect(s.tone).toBe("full");
    expect(s.languageCount).toBe(20);
    expect(s.detail).toContain("Interpret available");
  });

  it("names the interpret limitation when only pipeline is available", () => {
    const s = summarizeCapabilities(caps(mode(true, 5), mode(false, 0)));
    expect(s.tone).toBe("partial");
    expect(s.detail).toContain("Interpret needs backend AST credentials");
  });

  it("reports none when no mode is available", () => {
    const s = summarizeCapabilities(caps(mode(false, 0), mode(false, 0)));
    expect(s.tone).toBe("none");
  });
});
