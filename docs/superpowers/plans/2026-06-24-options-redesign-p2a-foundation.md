# Options Redesign P2a — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the testable, UI-free foundation the redesigned options page (P2b) will consume — design tokens, a capabilities HTTP client, and the capability-driven language-selection rules.

**Architecture:** Three new, purely additive modules in `apps/extension/src`. Nothing existing is modified, so the build/UI stay unchanged and green. `theme.ts` defines Direction-B tokens (light + dark) as CSS custom properties. `capabilitiesClient.ts` fetches `GET /v1/capabilities` (P1) and validates it with the protocol guard. `languageSelection.ts` turns a `ModeCapabilities` into source/target option lists and coerces a (possibly stale) pair to a valid one using the shared `validTarget` rule.

**Tech Stack:** TypeScript ESM, Vitest. Consumes `@echoflow/protocol` (`CapabilitiesDescriptor`, `ModeCapabilities`, `LanguageOption`, `validTarget`, `isCapabilitiesDescriptor` — all shipped in P1).

## Global Constraints

- **Design language = Direction B** (spec §3). Light theme is for the options page; dark for the overlay. Token values (verbatim from spec §3):
  - Light: `accent #0d8a7a`, `accentWeak #e7f7f4`, `bg #f6f7f8`, `surface #ffffff`, `border #e3e6ea`, `text #14181c`, `textMuted #6b7280`.
  - Dark: `accent #67d7c2`, `accentWeak rgba(103,215,194,0.16)`, `bg #0c0e13`, `surface #11141b`, `border rgba(255,255,255,0.08)`, `text #f7f7f2`, `textMuted #7d8794`.
- **One rule, shared:** the pivot constraint lives in `validTarget` (`@echoflow/protocol`). `languageSelection.ts` must call it — never re-implement the rule. (Spec §11.)
- **Capabilities transport:** `GET /v1/capabilities` with header `x-api-key`; the descriptor is validated with `isCapabilitiesDescriptor` and any failure (network, non-200, malformed) yields `null` so the caller can fall back. (Spec §4.1, §9.)
- **Additive only:** this plan creates three new files + their tests. It does NOT modify the options page, settings, or remove any existing export — that is P2b.
- **Run from repo root:** `pnpm --filter @echoflow/extension test <pattern>`, `pnpm --filter @echoflow/extension typecheck`.

---

## File Structure

- Create `apps/extension/src/ui/theme.ts` — token records (light/dark) + CSS-variable helpers. One responsibility: design tokens.
- Create `apps/extension/src/ui/theme.test.ts`.
- Create `apps/extension/src/settings/capabilitiesClient.ts` — `fetchCapabilities(serverUrl, apiKey, fetchImpl?)`. One responsibility: fetch + validate the descriptor.
- Create `apps/extension/src/settings/capabilitiesClient.test.ts`.
- Create `apps/extension/src/settings/languageSelection.ts` — pure functions over `ModeCapabilities`. One responsibility: derive valid options + coerce a pair.
- Create `apps/extension/src/settings/languageSelection.test.ts`.

---

## Task 1: Design tokens (`theme.ts`)

**Files:**
- Create: `apps/extension/src/ui/theme.ts`
- Test: `apps/extension/src/ui/theme.test.ts`

**Interfaces:**
- Produces: `type ThemeTokens = { accent; accentWeak; bg; surface; border; text; textMuted: string }`; `LIGHT_THEME`/`DARK_THEME: ThemeTokens`; `RADIUS = { sm; md; lg }`; `FONT_STACK: string`; `themeVariables(theme): string` (the `--ef-*: value;` declarations); `themeStyleSheet(theme, selector?=":root"): string` (a full `selector { … }` rule).

- [ ] **Step 1: Write the failing test**

```ts
// apps/extension/src/ui/theme.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test theme`
Expected: FAIL — cannot find module `./theme.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/extension/src/ui/theme.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/extension test theme` → PASS. Then `pnpm --filter @echoflow/extension typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/ui/theme.ts apps/extension/src/ui/theme.test.ts
git commit -m "feat(extension): add Direction-B design tokens"
```

---

## Task 2: Capabilities client (`capabilitiesClient.ts`)

**Files:**
- Create: `apps/extension/src/settings/capabilitiesClient.ts`
- Test: `apps/extension/src/settings/capabilitiesClient.test.ts`

**Interfaces:**
- Consumes: `isCapabilitiesDescriptor`, `CapabilitiesDescriptor` from `@echoflow/protocol`.
- Produces: `fetchCapabilities(serverUrl: string, apiKey: string, fetchImpl?: typeof fetch): Promise<CapabilitiesDescriptor | null>` — resolves the descriptor on a valid 200, else `null` (bad URL, non-200, malformed body, or thrown fetch). Sends `x-api-key`. Requests `<origin>/v1/capabilities`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/extension/src/settings/capabilitiesClient.test.ts
import { describe, expect, it, vi } from "vitest";
import { fetchCapabilities } from "./capabilitiesClient.js";

const DESCRIPTOR = {
  modes: {
    pipeline: { available: true, autoDetect: true, languages: [{ code: "en", label: "English", pivot: false }] },
    interpret: { available: true, autoDetect: false, languages: [{ code: "zh", label: "中文", pivot: true }] },
  },
};

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn(impl) as unknown as typeof fetch;
}

describe("fetchCapabilities", () => {
  it("requests <origin>/v1/capabilities with the api key and returns the descriptor", async () => {
    const f = mockFetch(async (url, init) => {
      expect(url).toBe("http://127.0.0.1:8787/v1/capabilities");
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("k");
      return new Response(JSON.stringify(DESCRIPTOR), { status: 200 });
    });
    const result = await fetchCapabilities("http://127.0.0.1:8787", "k", f);
    expect(result).toEqual(DESCRIPTOR);
  });

  it("returns null on a non-200 response", async () => {
    const f = mockFetch(async () => new Response("nope", { status: 401 }));
    expect(await fetchCapabilities("http://127.0.0.1:8787", "k", f)).toBeNull();
  });

  it("returns null on a malformed body", async () => {
    const f = mockFetch(async () => new Response(JSON.stringify({ modes: {} }), { status: 200 }));
    expect(await fetchCapabilities("http://127.0.0.1:8787", "k", f)).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    const f = mockFetch(async () => { throw new Error("network"); });
    expect(await fetchCapabilities("http://127.0.0.1:8787", "k", f)).toBeNull();
  });

  it("returns null for an unparseable serverUrl", async () => {
    const f = mockFetch(async () => new Response("{}", { status: 200 }));
    expect(await fetchCapabilities("not a url", "k", f)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test capabilitiesClient`
Expected: FAIL — cannot find module `./capabilitiesClient.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/extension/src/settings/capabilitiesClient.ts
import {
  isCapabilitiesDescriptor,
  type CapabilitiesDescriptor,
} from "@echoflow/protocol";

export async function fetchCapabilities(
  serverUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CapabilitiesDescriptor | null> {
  let url: string;
  try {
    url = new URL("/v1/capabilities", serverUrl).toString();
  } catch {
    return null;
  }

  try {
    const response = await fetchImpl(url, { headers: { "x-api-key": apiKey } });
    if (!response.ok) {
      return null;
    }
    const data: unknown = await response.json();
    return isCapabilitiesDescriptor(data) ? data : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/extension test capabilitiesClient` → PASS (5 tests). Then `pnpm --filter @echoflow/extension typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/settings/capabilitiesClient.ts apps/extension/src/settings/capabilitiesClient.test.ts
git commit -m "feat(extension): add capabilities HTTP client"
```

---

## Task 3: Language-selection rules (`languageSelection.ts`)

**Files:**
- Create: `apps/extension/src/settings/languageSelection.ts`
- Test: `apps/extension/src/settings/languageSelection.test.ts`

**Interfaces:**
- Consumes: `validTarget`, `LanguageOption`, `ModeCapabilities` from `@echoflow/protocol`.
- Produces:
  - `type LanguagePair = { source: string; target: string }`
  - `sourceOptions(caps: ModeCapabilities): LanguageOption[]` — `[]` when `autoDetect`, else all `caps.languages`.
  - `targetOptions(caps: ModeCapabilities, sourceCode: string): LanguageOption[]` — when `autoDetect`, all non-source-only languages; else every language for which `validTarget(source, target)` holds (`[]` if `sourceCode` unknown).
  - `coercePair(caps: ModeCapabilities, source: string, target: string): LanguagePair` — returns a valid pair, preferring the given values, then `caps.defaultPair`, then the first valid option; `source` is `"auto"` when `autoDetect`.
  - `filterLanguages(options: LanguageOption[], query: string): LanguageOption[]` — case-insensitive match on `code` or `label`; empty query returns all.

- [ ] **Step 1: Write the failing test**

```ts
// apps/extension/src/settings/languageSelection.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test languageSelection`
Expected: FAIL — cannot find module `./languageSelection.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/extension/src/settings/languageSelection.ts
import {
  validTarget,
  type LanguageOption,
  type ModeCapabilities,
} from "@echoflow/protocol";

export type LanguagePair = { source: string; target: string };

export function sourceOptions(caps: ModeCapabilities): LanguageOption[] {
  return caps.autoDetect ? [] : caps.languages;
}

export function targetOptions(
  caps: ModeCapabilities,
  sourceCode: string,
): LanguageOption[] {
  if (caps.autoDetect) {
    return caps.languages.filter((l) => l.sourceOnly !== true);
  }
  const source = caps.languages.find((l) => l.code === sourceCode);
  if (source === undefined) {
    return [];
  }
  return caps.languages.filter((target) => validTarget(source, target));
}

/** Prefer `wanted`, then `fallback`, then the first option; "" if none. */
function pickCode(options: LanguageOption[], wanted: string, fallback: string): string {
  if (options.some((o) => o.code === wanted)) return wanted;
  if (options.some((o) => o.code === fallback)) return fallback;
  return options[0]?.code ?? "";
}

export function coercePair(
  caps: ModeCapabilities,
  source: string,
  target: string,
): LanguagePair {
  const fallback = caps.defaultPair ?? { source: "", target: "" };

  if (caps.autoDetect) {
    const targets = targetOptions(caps, source);
    return { source: "auto", target: pickCode(targets, target, fallback.target) };
  }

  const resolvedSource = pickCode(sourceOptions(caps), source, fallback.source);
  const targets = targetOptions(caps, resolvedSource);
  return { source: resolvedSource, target: pickCode(targets, target, fallback.target) };
}

export function filterLanguages(
  options: LanguageOption[],
  query: string,
): LanguageOption[] {
  const q = query.trim().toLowerCase();
  if (q === "") {
    return options;
  }
  return options.filter(
    (o) => o.code.toLowerCase().includes(q) || o.label.toLowerCase().includes(q),
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/extension test languageSelection` → PASS. Then `pnpm --filter @echoflow/extension typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/settings/languageSelection.ts apps/extension/src/settings/languageSelection.test.ts
git commit -m "feat(extension): add capability-driven language-selection rules"
```

---

## Final verification

- [ ] **Full extension gate:** `pnpm --filter @echoflow/extension test` (all prior tests + the new theme/capabilitiesClient/languageSelection suites pass) and `pnpm --filter @echoflow/extension typecheck` clean. Nothing else changed, so backend/protocol are untouched.

## Out of scope (P2b — inline, visual)

The options page rewrite (sections, the searchable source / constrained target pickers, the connection/font/history sections), applying the theme via an injected stylesheet, removing the now-superseded `TARGET_LANGUAGE_OPTIONS`/`INTERPRET_TARGET_LANGUAGE_OPTIONS`/`targetOptionsForMode`/`coerceTargetForMode` and the interim source-derivation, and fetching capabilities on mount. P2b consumes all three modules built here.
