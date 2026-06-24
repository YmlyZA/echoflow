import { describe, expect, it } from "vitest";
import type { ModeCapabilities } from "@echoflow/protocol";
import {
  coercePair,
  filterLanguages,
  sourceOptions,
  targetOptions,
} from "./languageSelection.js";

const INTERPRET: ModeCapabilities = {
  available: true,
  autoDetect: false,
  defaultPair: { source: "en", target: "zh" },
  languages: [
    { code: "zh", label: "中文", pivot: true },
    { code: "en", label: "English", pivot: true },
    { code: "ja", label: "日本語", pivot: false },
    { code: "ko", label: "한국어", pivot: false },
    { code: "yue", label: "粤语", pivot: false, sourceOnly: true },
  ],
};

const PIPELINE: ModeCapabilities = {
  available: true,
  autoDetect: true,
  defaultPair: { source: "auto", target: "en" },
  languages: [
    { code: "en", label: "English", pivot: false },
    { code: "zh-CN", label: "Chinese (Simplified)", pivot: false },
  ],
};

describe("sourceOptions", () => {
  it("is empty for auto-detect modes, all languages otherwise", () => {
    expect(sourceOptions(PIPELINE)).toEqual([]);
    expect(sourceOptions(INTERPRET).map((l) => l.code)).toEqual(["zh", "en", "ja", "ko", "yue"]);
  });
});

describe("targetOptions", () => {
  it("constrains by the pivot rule for a foreign source", () => {
    expect(targetOptions(INTERPRET, "ja").map((l) => l.code)).toEqual(["zh", "en"]);
  });
  it("opens up for a pivot source and excludes self + source-only", () => {
    expect(targetOptions(INTERPRET, "zh").map((l) => l.code)).toEqual(["en", "ja", "ko"]);
  });
  it("returns [] for an unknown source", () => {
    expect(targetOptions(INTERPRET, "xx")).toEqual([]);
  });
  it("for auto-detect returns all non-source-only languages", () => {
    expect(targetOptions(PIPELINE, "auto").map((l) => l.code)).toEqual(["en", "zh-CN"]);
  });
});

describe("coercePair", () => {
  it("keeps a valid interpret pair", () => {
    expect(coercePair(INTERPRET, "ja", "en")).toEqual({ source: "ja", target: "en" });
  });
  it("repairs a now-invalid target when source makes it same-language", () => {
    // source en, target en is invalid → falls back to defaultPair.target "zh"
    expect(coercePair(INTERPRET, "en", "en")).toEqual({ source: "en", target: "zh" });
  });
  it("repairs an unknown source to the default pair", () => {
    expect(coercePair(INTERPRET, "xx", "en")).toEqual({ source: "en", target: "zh" });
  });
  it("forces source to auto and validates target for auto-detect modes", () => {
    expect(coercePair(PIPELINE, "ignored", "zh-CN")).toEqual({ source: "auto", target: "zh-CN" });
    expect(coercePair(PIPELINE, "ignored", "xx")).toEqual({ source: "auto", target: "en" });
  });
});

describe("filterLanguages", () => {
  it("matches code or label case-insensitively; empty query returns all", () => {
    expect(filterLanguages(INTERPRET.languages, "").length).toBe(5);
    expect(filterLanguages(INTERPRET.languages, "ENG").map((l) => l.code)).toEqual(["en"]);
    expect(filterLanguages(INTERPRET.languages, "中").map((l) => l.code)).toEqual(["zh"]);
    expect(filterLanguages(INTERPRET.languages, "ko").map((l) => l.code)).toEqual(["ko"]);
  });
});
