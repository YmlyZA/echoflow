import { describe, expect, it } from "vitest";
import {
  INTERPRET_SUPPORTED_TARGETS,
  isSupportedInterpretTarget,
  toAstLanguageCode,
} from "./astLanguages.js";

describe("astLanguages", () => {
  it("supports exactly zh-CN, zh-TW, en", () => {
    expect([...INTERPRET_SUPPORTED_TARGETS].sort()).toEqual(["en", "zh-CN", "zh-TW"]);
  });

  it("accepts supported targets and rejects others", () => {
    expect(isSupportedInterpretTarget("zh-CN")).toBe(true);
    expect(isSupportedInterpretTarget("en")).toBe(true);
    expect(isSupportedInterpretTarget("ja")).toBe(false);
    expect(isSupportedInterpretTarget("")).toBe(false);
  });

  it("maps our codes to AST codes", () => {
    expect(toAstLanguageCode("zh-CN")).toBe("zh");
    expect(toAstLanguageCode("zh-TW")).toBe("zh");
    expect(toAstLanguageCode("en")).toBe("en");
  });
});
