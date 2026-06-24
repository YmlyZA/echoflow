import { describe, expect, it } from "vitest";
import {
  DARK_THEME,
  LIGHT_THEME,
  themeStyleSheet,
  themeVariables,
  type ThemeTokens,
} from "./theme.js";

const KEYS: (keyof ThemeTokens)[] = [
  "accent", "accentWeak", "bg", "surface", "border", "text", "textMuted",
];

describe("theme tokens", () => {
  it("defines every token for both themes with the spec's accent values", () => {
    for (const k of KEYS) {
      expect(typeof LIGHT_THEME[k]).toBe("string");
      expect(typeof DARK_THEME[k]).toBe("string");
    }
    expect(LIGHT_THEME.accent).toBe("#0d8a7a");
    expect(DARK_THEME.accent).toBe("#67d7c2");
  });

  it("themeVariables emits an --ef- custom property per token", () => {
    const vars = themeVariables(LIGHT_THEME);
    expect(vars).toContain("--ef-accent: #0d8a7a;");
    expect(vars).toContain("--ef-text-muted: #6b7280;");
  });

  it("themeStyleSheet wraps the variables in the given selector", () => {
    expect(themeStyleSheet(LIGHT_THEME)).toBe(`:root { ${themeVariables(LIGHT_THEME)} }`);
    expect(themeStyleSheet(DARK_THEME, "[data-theme='dark']")).toContain("[data-theme='dark'] {");
  });
});
