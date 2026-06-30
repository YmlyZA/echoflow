import { describe, expect, it } from "vitest";
import { contrastRatio, meetsAA } from "./contrast";
import { LIGHT_THEME } from "./theme";

describe("contrastRatio", () => {
  it("computes the reference extremes", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });
  it("is symmetric in argument order", () => {
    expect(contrastRatio("#0d8a7a", "#ffffff")).toBeCloseTo(
      contrastRatio("#ffffff", "#0d8a7a"),
      5
    );
  });
});

describe("meetsAA", () => {
  it("requires 4.5 for normal text and 3 for large", () => {
    expect(meetsAA(4.5)).toBe(true);
    expect(meetsAA(4.49)).toBe(false);
    expect(meetsAA(3, { large: true })).toBe(true);
    expect(meetsAA(2.99, { large: true })).toBe(false);
  });
});

describe("LIGHT_THEME meets WCAG AA for normal text", () => {
  it("accent vs white surface (buttons/links) is >= 4.5:1", () => {
    expect(meetsAA(contrastRatio(LIGHT_THEME.accent, LIGHT_THEME.surface))).toBe(true);
  });
  it("muted text vs the page bg is >= 4.5:1", () => {
    expect(meetsAA(contrastRatio(LIGHT_THEME.textMuted, LIGHT_THEME.bg))).toBe(true);
  });
  it("muted text vs white surface is >= 4.5:1", () => {
    expect(meetsAA(contrastRatio(LIGHT_THEME.textMuted, LIGHT_THEME.surface))).toBe(true);
  });
  it("body text vs white surface is >= 4.5:1", () => {
    expect(meetsAA(contrastRatio(LIGHT_THEME.text, LIGHT_THEME.surface))).toBe(true);
  });
});
