import { describe, expect, it } from "vitest";
import { AST_LANGUAGES, isSupportedAstPair, toAstLanguageCode } from "./astLanguages.js";

describe("AST_LANGUAGES", () => {
  it("lists 20 languages with zh/en as the only pivots", () => {
    expect(AST_LANGUAGES).toHaveLength(20);
    const pivots = AST_LANGUAGES.filter((l) => l.pivot).map((l) => l.code).sort();
    expect(pivots).toEqual(["en", "zh"]);
  });
});

describe("toAstLanguageCode", () => {
  it("maps Chinese UI codes to zh and passes others through", () => {
    expect(toAstLanguageCode("zh-CN")).toBe("zh");
    expect(toAstLanguageCode("zh-TW")).toBe("zh");
    expect(toAstLanguageCode("en")).toBe("en");
    expect(toAstLanguageCode("ja")).toBe("ja");
  });
});

describe("isSupportedAstPair", () => {
  it("enforces the pivot rule over AST codes", () => {
    expect(isSupportedAstPair("en", "zh")).toBe(true);
    expect(isSupportedAstPair("ja", "zh")).toBe(true);
    expect(isSupportedAstPair("ja", "ko")).toBe(false);
    expect(isSupportedAstPair("zh", "zh")).toBe(false);
    expect(isSupportedAstPair("xx", "zh")).toBe(false); // unknown code
  });
});
