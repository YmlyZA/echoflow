export type ThemeTokens = {
  accent: string;
  accentWeak: string;
  bg: string;
  surface: string;
  border: string;
  text: string;
  textMuted: string;
};

export const LIGHT_THEME: ThemeTokens = {
  accent: "#0d8a7a",
  accentWeak: "#e7f7f4",
  bg: "#f6f7f8",
  surface: "#ffffff",
  border: "#e3e6ea",
  text: "#14181c",
  textMuted: "#6b7280",
};

export const DARK_THEME: ThemeTokens = {
  accent: "#67d7c2",
  accentWeak: "rgba(103,215,194,0.16)",
  bg: "#0c0e13",
  surface: "#11141b",
  border: "rgba(255,255,255,0.08)",
  text: "#f7f7f2",
  textMuted: "#7d8794",
};

export const RADIUS = { sm: "9px", md: "11px", lg: "14px" } as const;
export const FONT_STACK =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

const VAR_NAMES: Record<keyof ThemeTokens, string> = {
  accent: "--ef-accent",
  accentWeak: "--ef-accent-weak",
  bg: "--ef-bg",
  surface: "--ef-surface",
  border: "--ef-border",
  text: "--ef-text",
  textMuted: "--ef-text-muted",
};

export function themeVariables(theme: ThemeTokens): string {
  return (Object.keys(VAR_NAMES) as (keyof ThemeTokens)[])
    .map((key) => `${VAR_NAMES[key]}: ${theme[key]};`)
    .join(" ");
}

export function themeStyleSheet(theme: ThemeTokens, selector = ":root"): string {
  return `${selector} { ${themeVariables(theme)} }`;
}
