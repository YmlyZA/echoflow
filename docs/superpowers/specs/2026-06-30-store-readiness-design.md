# Store-Readiness — Design Spec

**Slice 5 (final) of the UX overhaul arc** (see `docs/superpowers/backlog.md`). Date: 2026-06-30.

## Goal

Bring EchoFlow to a polished, presentable bar: a real extension **icon**, an **accessibility pass** across the four UI surfaces, **prepared store-listing copy + a screenshot capture guide**, and a **README/distribution polish** that's honest about the self-host model — without pretending the localhost MVP is Chrome-Web-Store-publishable yet.

## Background

EchoFlow is a **self-hosted, localhost-only MVP**: `host_permissions` is `127.0.0.1`/`localhost`, and it requires the user to run the backend with their own Volcengine credentials. A Chrome Web Store reviewer would reject a subtitles extension that only talks to localhost and needs a self-run, bring-your-own-key backend. So **actual store submission is out of scope** — this slice prepares the *materials and quality* that "store-readiness" implies, valuable regardless of when/if publishing becomes viable.

Current state:
- **No icon.** The manifest (`apps/extension/wxt.config.ts`) has no `icons` field and there are zero icon assets — Chrome shows the default puzzle piece.
- **No store assets** — no screenshots, no listing copy, no privacy/permissions documentation.
- **Accessibility is partial:** `:focus-visible` outlines exist in the overlay/popup/onboarding components, status regions use `role="status"`, the overlay subtitles use `aria-live="polite"`. But there is **no `prefers-reduced-motion` handling anywhere** (the overlay/popup have CSS transitions), contrast has never been audited against WCAG, and the custom `LanguagePicker` dropdown is click-driven (keyboard listbox semantics unverified).
- **No SVG rasterizer** (`rsvg-convert`/`magick`/`sharp`) is installed, but Playwright + chromium are already a dev dependency (used by the e2e smoke), so icon PNGs can be rasterized headlessly.

Established design language (reused): teal accent (`#0d8a7a` light / `#67d7c2` dark), the gradient mark (`linear-gradient(135deg, #0d8a7a, #3bb6a4)`), tokens in `apps/extension/src/ui/theme.ts`.

## Decisions (validated via visual brainstorming)

1. **Icon = concept C2** — the teal gradient rounded-square with **three bold white soundwave bars** over **two caption lines** (solid white source + teal-tinted shorter translation). The two-line treatment carries the bilingual idea; the three chunky bars survive 16px.
2. **All four deliverables in scope** — icon, accessibility pass, prepared listing copy + screenshot guide, README polish.
3. **No actual store submission** — listing copy + screenshots are prepared as committed docs/assets; capture of real screenshots is a documented manual step (it needs the running app + a live backend, which can't be synthesized in CI).

## Design

### 1. Icon (concept C2)

- **Master SVG** committed at `apps/extension/assets/icon.svg` — the C2 artwork at a 128 viewbox: gradient rounded-square (`rx 28`), three bold white wave bars (rounded, center bar tallest), two caption lines below (white full-width + `#bfeee6` tinted shorter).
- **Rasterized PNGs** at 16/32/48/128 generated from the SVG by a committed, re-runnable Node script (`apps/extension/scripts/generate-icons.mjs`) that uses Playwright's chromium (already a dev dependency) to render the SVG at each pixel size and screenshot it to PNG. The PNGs are committed (build inputs, not regenerated at build time).
- **Manifest wiring:** the PNGs live where WXT auto-detects them (`apps/extension/public/icon/{16,32,48,128}.png`); if WXT's auto-detection doesn't populate the manifest, set `manifest.icons` + `manifest.action.default_icon` explicitly in `wxt.config.ts` to those paths. The built `manifest.json` must carry an `icons` map (16/32/48/128) and `action.default_icon`.

### 2. Accessibility pass

Audit and fix the four surfaces (options, popup, overlay, onboarding). Concrete work:

- **Contrast (WCAG AA), testable:** add a pure helper `apps/extension/src/ui/contrast.ts` — `contrastRatio(hex, hex): number` and `meetsAA(ratio, { large }): boolean` — and a test asserting the theme's load-bearing pairs meet AA: body/muted text on their backgrounds (≥ 4.5:1) and accent-as-large/bold-text + white-on-accent-button (≥ 3:1 for large/bold). If a pair fails, adjust the token (e.g. darken the light accent for text use, or introduce an `accentText` token) until it passes — the test encodes the requirement.
- **Reduced motion (new):** add a global `@media (prefers-reduced-motion: reduce)` rule to each surface's stylesheet (overlay, popup, onboarding) that disables/zeroes transitions and animations (the overlay control-reveal fade, popup pill dot glow, any transitions).
- **Keyboard & focus:** verify every interactive control is Tab-reachable with a visible `:focus-visible` outline across all four surfaces; fill any gaps. For the custom `LanguagePicker` listbox, add keyboard semantics: Escape closes the panel, and the trigger/options are focusable with visible focus (full arrow-key roving is a nice-to-have but Escape + focusable options + `aria-activedescendant`-free Tab navigation is the minimum AA bar).
- **ARIA/semantics audit:** confirm icon-only controls keep `aria-label` (overlay already does), status pills use `role="status"`, the onboarding step rail uses an ordered list, headings are ordered, and form inputs are associated with labels. Fix gaps found.

The audit findings + resolutions are recorded in `docs/superpowers/a11y-audit.md` (what was checked, what was fixed, what's deferred).

### 3. Listing copy (prepared, not published)

A committed `docs/store-listing.md` with:
- **Name:** EchoFlow.
- **Short description** (≤ 132 chars, Chrome's limit).
- **Detailed description** — the honest pitch: real-time bilingual subtitles for any tab's audio, self-hosted backend, bring-your-own provider keys.
- **Category / primary language.**
- **Permission justifications** — one line each for `activeTab`, `tabCapture`, `storage`, `offscreen`, `scripting`, and the localhost `host_permissions`, explaining why each is required (store review demands this).
- **Privacy** — data handling: tab audio is streamed only to the user's own local backend; nothing is sent to the extension authors; no analytics/telemetry.
- **"Not yet published — why"** note: the localhost/self-host model isn't store-eligible today; this doc is the ready-to-use draft for when distribution becomes viable.

### 4. Screenshot capture guide

Chrome Web Store wants 1280×800 (or 640×400) screenshots. Real capture needs the running app + a live backend, which can't be synthesized in CI — so this slice delivers a **capture guide** (a section of `docs/store-listing.md` or a sibling `docs/store-screenshots.md`), not the images: the exact shots to take (onboarding "Connected" step, popup live state, overlay over a video, options page), their framing/size, and a short how-to (load the built extension, start the backend, capture at the target resolution). Producing the actual PNGs is a documented manual follow-up.

### 5. README / distribution polish

Update `README.md`:
- Tighten the install/run story and make it match the current state — onboarding now exists, so the first-run flow is "load the extension → it opens the setup wizard → connect → go" (not "open the options page and set the URL").
- A clear **"Why localhost / self-host"** section explaining the model (you run the backend with your own provider keys; the extension only talks to your machine).
- Link to `docs/store-listing.md`.
- Note the extension icon now ships.

## File structure

- **New** `apps/extension/assets/icon.svg` — C2 master artwork.
- **New** `apps/extension/scripts/generate-icons.mjs` — Playwright-chromium SVG→PNG rasterizer (re-runnable).
- **New** `apps/extension/public/icon/{16,32,48,128}.png` — committed rasterized icons.
- **Modify** `apps/extension/wxt.config.ts` — ensure `icons` + `action.default_icon` resolve (explicit map if WXT auto-detect is insufficient).
- **New** `apps/extension/src/ui/contrast.ts` (+ `.test.ts`) — contrast-ratio helper + theme-token AA assertions.
- **Modify** theme tokens (`src/ui/theme.ts`) only if the contrast test demands it.
- **Modify** the surface stylesheets (overlay `SubtitleOverlay.tsx`, popup `PopupApp.tsx`, onboarding `OnboardingApp.tsx`, options CSS) — `prefers-reduced-motion` + any focus/aria fixes.
- **Modify** `src/ui/LanguagePicker.tsx` — Escape-to-close + focus handling.
- **New** `docs/store-listing.md` — listing copy + permission/privacy + screenshot guide.
- **New** `docs/superpowers/a11y-audit.md` — audit findings + resolutions.
- **Modify** `README.md` — install/run + self-host section + links.

## Testing

- `contrast.test.ts` — `contrastRatio` against known reference pairs (black/white = 21:1, etc.); `meetsAA`; and the theme-token pairs meet their AA thresholds.
- Component render tests (existing patterns) gain assertions where a fix is structural (e.g. a reduced-motion class hook, a new aria attribute, the picker's Escape handling if unit-testable).
- Icon: verify the build emits the manifest `icons` map + the four `public/icon` PNGs exist in `.output/chrome-mv3`.
- Docs (store-listing, a11y-audit, README) are prose — reviewed for accuracy, not unit-tested.
- Gates: `pnpm typecheck` clean; `pnpm --filter @echoflow/extension test` green; `pnpm --filter @echoflow/extension build` succeeds with icons in the manifest.

## Out of scope (stays in backlog)

- Actual Chrome Web Store submission (blocked by the localhost/self-host model).
- Capturing the real screenshot PNGs (documented manual step; needs app + live backend).
- Full arrow-key roving/`aria-activedescendant` for the LanguagePicker (minimum AA bar is implemented; richer combobox semantics deferred).
- CI / packaging / distribution build (backlog Direction B).
- No change to `packages/protocol`.
