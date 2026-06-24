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
