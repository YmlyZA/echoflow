# Store-Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring EchoFlow to a presentable bar — a real extension icon, a WCAG-AA accessibility pass across the four UI surfaces, prepared store-listing copy + a screenshot capture guide, and an honest self-host README.

**Architecture:** The icon ships as an SVG master rasterized to PNGs (16/32/48/128) by a Playwright-chromium script (no SVG rasterizer is installed; Playwright is already a dev dependency), wired into the WXT manifest. Accessibility work is anchored by a testable `contrast.ts` helper that asserts the theme tokens meet AA (adjusting tokens until green), plus `prefers-reduced-motion` rules and keyboard/ARIA fixes across the surfaces. Listing copy, a screenshot guide, an a11y-audit record, and the README land as committed docs.

**Tech Stack:** WXT + React 19 (MV3), TypeScript ESM, Vitest, Playwright (`@playwright/test`, already present), `renderToStaticMarkup` for component tests. pnpm monorepo.

## Global Constraints

- Internal extension change only — **do not touch `packages/protocol`**.
- Icon = concept C2: teal gradient rounded-square (`linear-gradient(135deg, #0d8a7a, #3bb6a4)`, `rx 28` at 128 viewbox) with three bold white soundwave bars over two caption lines (white full + `#bfeee6` tinted shorter). The icon SVG uses the **literal** brand gradient (`#0d8a7a`), independent of any theme-token change.
- Accessibility target: **WCAG 2.1 AA** — normal text ≥ 4.5:1, large/bold text ≥ 3:1.
- No actual store submission; listing copy + screenshots are prepared docs (screenshots = a capture guide, not images).
- Reuse the existing design language/tokens (`apps/extension/src/ui/theme.ts`); the gradient mark in components uses `var(--ef-accent)` as its start stop, so a token change subtly carries there too (acceptable).
- Run commands from repo root. Test: `pnpm --filter @echoflow/extension test`. Typecheck: `pnpm typecheck`. Build: `pnpm --filter @echoflow/extension build`.
- All work on branch `feat/store-readiness-slice5` (already created; spec already committed there).

---

### Task 1: Extension icon — SVG master, rasterizer, PNGs, manifest

**Files:**
- Create: `apps/extension/assets/icon.svg`
- Create: `apps/extension/scripts/generate-icons.mjs`
- Create (generated, committed): `apps/extension/public/icon/16.png`, `32.png`, `48.png`, `128.png`
- Modify: `apps/extension/wxt.config.ts`

**Interfaces:**
- Consumes: `@playwright/test` (already a dev dependency).
- Produces: a built `manifest.json` carrying an `icons` map (16/32/48/128) and `action.default_icon`.

- [ ] **Step 1: Create the SVG master**

Create `apps/extension/assets/icon.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0d8a7a"/>
      <stop offset="1" stop-color="#3bb6a4"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#g)"/>
  <g fill="#ffffff">
    <rect x="40" y="40" width="12" height="30" rx="6"/>
    <rect x="58" y="28" width="12" height="54" rx="6"/>
    <rect x="76" y="40" width="12" height="30" rx="6"/>
  </g>
  <rect x="30" y="86" width="68" height="11" rx="5.5" fill="#ffffff"/>
  <rect x="30" y="103" width="42" height="11" rx="5.5" fill="#bfeee6"/>
</svg>
```

- [ ] **Step 2: Create the rasterizer script**

Create `apps/extension/scripts/generate-icons.mjs`:

```js
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(resolve(here, "../assets/icon.svg"), "utf8");
const outDir = resolve(here, "../public/icon");
mkdirSync(outDir, { recursive: true });

const sizes = [16, 32, 48, 128];
const browser = await chromium.launch();
try {
  for (const size of sizes) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1
    });
    // Force the SVG to render at exactly `size`x`size` with no page margin.
    const sized = svg.replace(
      /<svg /,
      `<svg width="${size}" height="${size}" `
    );
    await page.setContent(
      `<!doctype html><html><body style="margin:0;padding:0">${sized}</body></html>`
    );
    await page.locator("svg").screenshot({
      path: resolve(outDir, `${size}.png`),
      omitBackground: true
    });
    await page.close();
    console.log(`wrote public/icon/${size}.png`);
  }
} finally {
  await browser.close();
}
```

Note: the SVG already has `width="128" height="128"`; the `.replace` adds a second `width`/`height` which the browser uses the first occurrence of — to avoid ambiguity, the `icon.svg` in Step 1 keeps its attributes and the script's injected ones win only if first. If the rendered PNG is the wrong size, strip the `width`/`height` attributes from `icon.svg` (keep `viewBox`) so the script's injected dimensions are authoritative. Verify the emitted PNG dimensions in Step 4.

- [ ] **Step 3: Generate the PNGs**

Run: `node apps/extension/scripts/generate-icons.mjs`
Expected: prints `wrote public/icon/16.png` … `128.png`; four files exist under `apps/extension/public/icon/`.

- [ ] **Step 4: Verify PNG dimensions**

Run: `node -e "for (const s of [16,32,48,128]) { const b=require('fs').readFileSync('apps/extension/public/icon/'+s+'.png'); const w=b.readUInt32BE(16), h=b.readUInt32BE(20); console.log(s, w+'x'+h); if(w!==s||h!==s) process.exit(1); }"`
Expected: prints `16 16x16`, `32 32x32`, `48 48x48`, `128 128x128` (PNG IHDR width/height at byte offsets 16/20). If any mismatch, apply the Step 2 note (strip `width`/`height` from `icon.svg`) and regenerate.

- [ ] **Step 5: Wire the icons into the manifest**

In `apps/extension/wxt.config.ts`, add `icons` and `action.default_icon` to the `manifest` object (alongside `name`/`description`/`version`/`action`):

```ts
    icons: {
      16: "/icon/16.png",
      32: "/icon/32.png",
      48: "/icon/48.png",
      128: "/icon/128.png"
    },
    action: {
      default_title: "EchoFlow",
      default_popup: "popup.html",
      default_icon: {
        16: "/icon/16.png",
        32: "/icon/32.png",
        48: "/icon/48.png",
        128: "/icon/128.png"
      }
    }
```

(Files in `public/` are served at the extension root, so `/icon/16.png` resolves. Keep the existing `default_popup` from Slice 3.)

- [ ] **Step 6: Build and verify the manifest carries the icons**

Run: `pnpm --filter @echoflow/extension build`
Then: `node -e "const m=require('./apps/extension/.output/chrome-mv3/manifest.json'); if(!m.icons||!m.icons['128']||!m.action.default_icon){process.exit(1)}; console.log('icons:', Object.keys(m.icons).join(','), '| action.default_icon ok')"`
Expected: build succeeds; prints `icons: 16,32,48,128 | action.default_icon ok`. Confirm `apps/extension/.output/chrome-mv3/icon/128.png` exists.

- [ ] **Step 7: Commit**

```bash
git add apps/extension/assets/icon.svg apps/extension/scripts/generate-icons.mjs apps/extension/public/icon apps/extension/wxt.config.ts
git commit -m "feat(extension): add EchoFlow icon (soundwave over bilingual captions)"
```

---

### Task 2: Contrast helper + theme-token AA pass

**Files:**
- Create: `apps/extension/src/ui/contrast.ts`
- Create: `apps/extension/src/ui/contrast.test.ts`
- Modify: `apps/extension/src/ui/theme.ts` (darken tokens until AA passes)

**Interfaces:**
- Consumes: `LIGHT_THEME` from `./theme`.
- Produces: `contrastRatio(a: string, b: string): number`; `meetsAA(ratio: number, options?: { large?: boolean }): boolean`. Possibly-adjusted `LIGHT_THEME.accent` / `LIGHT_THEME.textMuted` hex values (whatever makes the test pass).

- [ ] **Step 1: Write the failing test**

Create `apps/extension/src/ui/contrast.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @echoflow/extension test contrast`
Expected: FAIL — `./contrast` not found (and, once implemented, the accent + muted-vs-bg assertions fail because `#0d8a7a` on white ≈ 4.26:1 and `#6b7280` on `#f6f7f8` ≈ 4.49:1).

- [ ] **Step 3: Implement the contrast helper**

Create `apps/extension/src/ui/contrast.ts`:

```ts
function channelToLinear(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const normalized = hex.replace("#", "");
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return (
    0.2126 * channelToLinear(r) +
    0.7152 * channelToLinear(g) +
    0.0722 * channelToLinear(b)
  );
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export function meetsAA(ratio: number, options: { large?: boolean } = {}): boolean {
  return ratio >= (options.large ? 3 : 4.5);
}
```

- [ ] **Step 4: Run the test — the helper tests pass, the token assertions fail**

Run: `pnpm --filter @echoflow/extension test contrast`
Expected: `contrastRatio`/`meetsAA` tests PASS; the `accent vs white surface` and `muted text vs the page bg` assertions FAIL (4.26 and 4.49 are below 4.5).

- [ ] **Step 5: Darken the failing tokens until AA passes**

In `apps/extension/src/ui/theme.ts`, darken the two failing `LIGHT_THEME` tokens minimally. Verified candidates that pass (confirm via the test, adjust if needed):

```ts
export const LIGHT_THEME: ThemeTokens = {
  accent: "#0c8273",      // was #0d8a7a (4.26:1) → ~4.71:1 on white
  accentWeak: "#e7f7f4",
  bg: "#f6f7f8",
  surface: "#ffffff",
  border: "#e3e6ea",
  text: "#14181c",
  textMuted: "#677077",   // was #6b7280 (4.49:1 on bg) → ~4.6:1 on bg
};
```

Only `accent` and `textMuted` change; leave the rest. Do NOT change `DARK_THEME` (its accent `#67d7c2` on the dark surface already far exceeds AA).

- [ ] **Step 6: Run the test to verify all pass**

Run: `pnpm --filter @echoflow/extension test contrast`
Expected: PASS (all assertions). If `accent` or `textMuted` still falls short, darken by one more step (lower the hex channels) and re-run — the test is the source of truth.

- [ ] **Step 7: Update the theme token test for the new accent**

`apps/extension/src/ui/theme.test.ts` pins the old accent literally in two places (around line 20 and line 26):

```ts
expect(LIGHT_THEME.accent).toBe("#0d8a7a");
// ...
expect(vars).toContain("--ef-accent: #0d8a7a;");
```

Update BOTH to the new accent value you set in Step 5 (e.g. `#0c8273`), so the test tracks the token rather than pinning the old hex:

```ts
expect(LIGHT_THEME.accent).toBe("#0c8273");
// ...
expect(vars).toContain("--ef-accent: #0c8273;");
```

Run: `pnpm --filter @echoflow/extension test theme`
Expected: PASS. (Add `apps/extension/src/ui/theme.test.ts` to the Step 8 commit.)

- [ ] **Step 8: Commit**

```bash
git add apps/extension/src/ui/contrast.ts apps/extension/src/ui/contrast.test.ts apps/extension/src/ui/theme.ts apps/extension/src/ui/theme.test.ts
git commit -m "feat(extension): WCAG-AA contrast helper; darken light accent/muted to pass AA"
```

---

### Task 3: Accessibility pass — reduced motion, keyboard, ARIA

**Files:**
- Modify: `apps/extension/src/overlay/SubtitleOverlay.tsx` (reduced-motion CSS)
- Modify: `apps/extension/src/popup/PopupApp.tsx` (reduced-motion CSS)
- Modify: `apps/extension/src/onboarding/OnboardingApp.tsx` (reduced-motion CSS)
- Modify: `apps/extension/src/ui/LanguagePicker.tsx` (Escape-to-close + keydown)
- Create: `docs/superpowers/a11y-audit.md`

Note: the extension has **no jsdom** — there is no `vitest.config` and the `test` script (`vitest run src`) uses the default **node** environment; the existing component tests use `renderToStaticMarkup` (server-side, no `document`). So the LanguagePicker's Escape handler (a `document` keydown listener inside a `useEffect`) is **not unit-testable here** and is verified by code review + the manual/e2e path, recorded in the audit doc (Step 4). Do not add a jsdom test.

**Interfaces:**
- Consumes: nothing new.
- Produces: a `prefers-reduced-motion` rule in each surface's `<style>`; `LanguagePicker` closes on Escape.

- [ ] **Step 1: Add reduced-motion rules to the three surface stylesheets**

In each of `SubtitleOverlay.tsx`, `PopupApp.tsx`, and `OnboardingApp.tsx`, inside the component's `<style>` template literal (at the end, before the closing backtick), append:

```css
      @media (prefers-reduced-motion: reduce) {
        * { transition: none !important; animation: none !important; }
      }
```

(Scope is the surface's shadow/root style block, so the `*` is bounded to that surface.)

- [ ] **Step 2: Add Escape-to-close + keyboard handling to LanguagePicker**

In `apps/extension/src/ui/LanguagePicker.tsx`, the existing `useEffect` (lines ~24-35) adds a `mousedown` outside-close listener while `open`. Extend that effect to also close on Escape, and refocus the trigger. Replace the effect body so it registers both listeners:

```tsx
  useEffect(() => {
    if (!open) {
      return;
    }
    function onDocPointer(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
```

(The trigger and option `<button>`s are already focusable and have `:focus-visible` outlines from the options CSS; the panel input has `autoFocus`. This delivers the minimum AA bar: open, type-to-filter, Tab through options, Escape to close.)

- [ ] **Step 3: Write the a11y audit record**

Create `docs/superpowers/a11y-audit.md` documenting what was checked across the four surfaces and the resolution of each: contrast (Task 2 — accent/muted darkened to AA), reduced-motion (this task — added to all three animated surfaces), keyboard/focus (icon controls have aria-labels; `:focus-visible` outlines present; LanguagePicker now closes on Escape), ARIA/semantics (overlay subtitles `aria-live="polite"`, status pills `role="status"`, onboarding step rail is an ordered list, form inputs labeled). List anything deferred (full arrow-key roving for the picker — see spec out-of-scope). Use concise checklist prose.

- [ ] **Step 4: Record the picker-keyboard verification in the audit doc**

There is no jsdom in this project (confirmed: no `vitest.config`, node environment), so the Escape handler can't be unit-tested in the established style. In `docs/superpowers/a11y-audit.md`, under the keyboard/focus section, record: "LanguagePicker closes on Escape (document keydown listener gated on `open`, registered/torn down in the same effect as the outside-click handler); verified by code review and manual keyboard testing — no jsdom unit test exists in this package." Do NOT add a jsdom test file.

- [ ] **Step 5: Run the tests + typecheck**

Run: `pnpm --filter @echoflow/extension test` then `pnpm typecheck`
Expected: both PASS. The existing `SubtitleOverlay`/`PopupApp`/`OnboardingApp` render tests still pass (the reduced-motion block adds CSS text but doesn't change asserted markup); the picker change is behavior-only and typechecks.

- [ ] **Step 6: Commit**

```bash
git add apps/extension/src/overlay/SubtitleOverlay.tsx apps/extension/src/popup/PopupApp.tsx apps/extension/src/onboarding/OnboardingApp.tsx apps/extension/src/ui/LanguagePicker.tsx docs/superpowers/a11y-audit.md
git commit -m "feat(extension): a11y pass — reduced-motion, picker Escape, audit record"
```

---

### Task 4: Listing copy, screenshot guide, README polish

**Files:**
- Create: `docs/store-listing.md`
- Modify: `README.md`

**Interfaces:** None (documentation).

- [ ] **Step 1: Write the store-listing draft**

Create `docs/store-listing.md` with these sections (fill with real, accurate copy — keep the short description ≤ 132 characters):
- **Name:** EchoFlow
- **Short description** (≤132 chars): a one-line hook, e.g. "Real-time bilingual subtitles for any browser tab's audio — powered by your own self-hosted backend."
- **Detailed description:** what it does (live source + translated subtitles over tab audio), how it works (captures tab audio → your local backend → subtitles on the page), the self-host model (you run the backend with your own provider keys), and the modes (一致 free pipeline / 实时 interpret).
- **Category:** Accessibility (or Productivity); **Primary language:** English.
- **Permission justifications** — one line each, accurate to `wxt.config.ts`: `activeTab` (act on the tab you start capture on), `tabCapture` (capture the tab's audio), `storage` (save your settings + local history), `offscreen` (run the audio pipeline / getUserMedia in MV3), `scripting` (inject the subtitle overlay on demand), `host_permissions` localhost (the extension only talks to your own backend at 127.0.0.1).
- **Privacy:** tab audio is streamed only to the user's own local backend; nothing is sent to the extension authors; no analytics or telemetry; settings/history stay in the browser.
- **Screenshot capture guide:** the shots to take (onboarding "Connected" step, popup live state, overlay over a video, options page), target size 1280×800, and the steps to capture them (build the extension, load unpacked, start the backend, drive each surface). Note this is a manual follow-up.
- **Status note:** not yet submitted — the localhost/self-host model isn't Web-Store-eligible today; this draft is ready for when distribution becomes viable.

- [ ] **Step 2: Polish the README**

In `README.md`, make these targeted edits (do not rewrite unrelated sections):
- Update the **Load the Extension in Chrome** section so first-run reflects onboarding: after loading unpacked, the extension **opens the setup wizard automatically**; the user connects (URL `http://127.0.0.1:8787`, key `dev-key`), picks languages, and is ready — rather than "open the options page and set the backend URL."
- Add a short **"Why localhost / self-host"** subsection (under MVP Scope or Setup): EchoFlow runs a backend on your machine with your own provider credentials; the extension only talks to your server; nothing leaves your machine except the audio you send to your own backend.
- Note that the extension now ships an **icon**.
- Add a link to `docs/store-listing.md` ("Store listing draft (prepared, not published)").

- [ ] **Step 3: Verify docs don't break the build**

Run: `pnpm typecheck && pnpm --filter @echoflow/extension test`
Expected: PASS (docs-only change; nothing should regress).

- [ ] **Step 4: Commit**

```bash
git add docs/store-listing.md README.md
git commit -m "docs: store-listing draft + screenshot guide + self-host README polish"
```

---

### Task 5: Build verification

**Files:** None (verification only).

**Interfaces:** Consumes all prior tasks. Produces nothing.

- [ ] **Step 1: Full typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 2: Full extension test run**

Run: `pnpm --filter @echoflow/extension test`
Expected: PASS.

- [ ] **Step 3: Production build with icons**

Run: `pnpm --filter @echoflow/extension build`
Expected: build completes; `apps/extension/.output/chrome-mv3/manifest.json` has the `icons` map + `action.default_icon`, and `apps/extension/.output/chrome-mv3/icon/128.png` exists.

- [ ] **Step 4: Report**

If steps produced no file changes, report all gates pass. Otherwise commit incidental fixes with `chore(extension): store-readiness build verification`.

---

## Self-Review

**Spec coverage:**
- §1 Icon (C2, SVG→PNG via Playwright, manifest) → Task 1.
- §2 A11y: contrast (testable helper + token AA) → Task 2; reduced-motion + keyboard + ARIA + audit doc → Task 3.
- §3 Listing copy → Task 4 (`store-listing.md`).
- §4 Screenshot guide → Task 4 (section of `store-listing.md`).
- §5 README polish → Task 4.
- Testing → Task 2 unit, Task 3 picker test (env-conditional), Task 5 build gate.
- Out of scope (store submission, real screenshots, full picker combobox, CI) → not built.

**Placeholder scan:** No TBD/TODO. Code steps carry complete code. The conditional notes (SVG dimension fallback in Task 1 Step 2; jsdom-vs-static test path in Task 3 Step 4; token re-darkening in Task 2 Step 6) are explicit verify-then-branch instructions with concrete fallbacks, not placeholders.

**Type consistency:** `contrastRatio(a, b)` / `meetsAA(ratio, { large })` signatures are identical in Task 2's test and implementation. The token names (`accent`, `textMuted`, `surface`, `bg`) match `ThemeTokens` in `theme.ts`. The icon public paths (`/icon/{16,32,48,128}.png`) are identical in the manifest wiring (Task 1 Step 5) and the verification (Step 6) and Task 5. The reduced-motion CSS block is identical across the three surfaces (Task 3 Step 1).
