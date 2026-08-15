import { describe, expect, it } from "vitest";
import {
  isCapabilitiesDescriptor,
  validTarget,
  type CapabilitiesDescriptor,
  type LanguageOption,
} from "./capabilities.js";

const zh: LanguageOption = { code: "zh", label: "中文", pivot: true };
const en: LanguageOption = { code: "en", label: "English", pivot: true };
const ja: LanguageOption = { code: "ja", label: "日本語", pivot: false };
const ko: LanguageOption = { code: "ko", label: "한국어", pivot: false };
const yue: LanguageOption = { code: "yue", label: "粤语", pivot: false, sourceOnly: true };

const valid: CapabilitiesDescriptor = {
  modes: {
    pipeline: { available: true, autoDetect: true, languages: [en] },
    interpret: {
      available: true,
      autoDetect: false,
      languages: [zh, en, ja],
      defaultPair: { source: "en", target: "zh" },
    },
  },
};

describe("validTarget", () => {
  it("allows a foreign source only against a pivot target", () => {
    expect(validTarget(ja, zh)).toBe(true);
    expect(validTarget(ja, en)).toBe(true);
    expect(validTarget(ja, ko)).toBe(false); // neither side pivot
  });
  it("allows a pivot source against any other language", () => {
    expect(validTarget(zh, ja)).toBe(true);
    expect(validTarget(en, ja)).toBe(true);
  });
  it("rejects same-language and source-only targets", () => {
    expect(validTarget(zh, zh)).toBe(false);
    expect(validTarget(en, yue)).toBe(false); // yue is source-only
  });
});

describe("isCapabilitiesDescriptor", () => {
  it("accepts a well-formed descriptor", () => {
    expect(isCapabilitiesDescriptor(valid)).toBe(true);
  });
  it("rejects malformed input", () => {
    expect(isCapabilitiesDescriptor(null)).toBe(false);
    expect(isCapabilitiesDescriptor({ modes: {} })).toBe(false);
    expect(isCapabilitiesDescriptor({ modes: { pipeline: {}, interpret: {} } })).toBe(false);
  });
  it("rejects descriptor with non-string source in defaultPair", () => {
    const malformed: unknown = {
      modes: {
        pipeline: { available: true, autoDetect: true, languages: [en] },
        interpret: {
          available: true,
          autoDetect: false,
          languages: [zh, en, ja],
          defaultPair: { source: 42, target: "zh" },
        },
      },
    };
    expect(isCapabilitiesDescriptor(malformed)).toBe(false);
  });
  it("rejects descriptor with non-string target in defaultPair", () => {
    const malformed: unknown = {
      modes: {
        pipeline: { available: true, autoDetect: true, languages: [en] },
        interpret: {
          available: true,
          autoDetect: false,
          languages: [zh, en, ja],
          defaultPair: { source: "en", target: 42 },
        },
      },
    };
    expect(isCapabilitiesDescriptor(malformed)).toBe(false);
  });
});

describe("isCapabilitiesDescriptor sync flag", () => {
  const mode = {
    available: true,
    autoDetect: true,
    languages: [],
  };
  const base = { modes: { pipeline: mode, interpret: mode } };

  it("accepts a descriptor without sync (older servers)", () => {
    expect(isCapabilitiesDescriptor(base)).toBe(true);
  });

  it("accepts sync: { available: boolean }", () => {
    expect(isCapabilitiesDescriptor({ ...base, sync: { available: true } })).toBe(true);
    expect(isCapabilitiesDescriptor({ ...base, sync: { available: false } })).toBe(true);
  });

  it("rejects a malformed sync field", () => {
    expect(isCapabilitiesDescriptor({ ...base, sync: {} })).toBe(false);
    expect(isCapabilitiesDescriptor({ ...base, sync: { available: "yes" } })).toBe(false);
    expect(isCapabilitiesDescriptor({ ...base, sync: null })).toBe(false);
  });
});

describe("isCapabilitiesDescriptor demo and blockers", () => {
  const withPipeline = (extra: Record<string, unknown>) => ({
    ...valid,
    modes: { ...valid.modes, pipeline: { ...valid.modes.pipeline, ...extra } },
  });

  it("accepts a descriptor without the new fields", () => {
    expect(isCapabilitiesDescriptor(valid)).toBe(true);
  });

  it("accepts a boolean demo flag", () => {
    expect(isCapabilitiesDescriptor(withPipeline({ demo: true }))).toBe(true);
  });

  it("rejects a non-boolean demo flag", () => {
    expect(isCapabilitiesDescriptor(withPipeline({ demo: "yes" }))).toBe(false);
  });

  it("accepts known blocker codes", () => {
    expect(
      isCapabilitiesDescriptor(withPipeline({ blockers: ["asr_credentials_missing"] })),
    ).toBe(true);
  });

  it("accepts an unknown blocker code from a newer backend", () => {
    expect(isCapabilitiesDescriptor(withPipeline({ blockers: ["quantum_flux"] }))).toBe(
      true,
    );
  });

  it("rejects blockers that are not an array of strings", () => {
    expect(isCapabilitiesDescriptor(withPipeline({ blockers: "nope" }))).toBe(false);
    expect(isCapabilitiesDescriptor(withPipeline({ blockers: [1] }))).toBe(false);
  });
});
