# Onboarding / First-Run — Design Spec

**Slice 4 of the UX overhaul arc** (see `docs/superpowers/backlog.md`). Date: 2026-06-30.

## Goal

Give a new user a guided first-run flow that auto-opens on install, sets honest self-host expectations, makes the local-backend requirement obvious and **testable**, and walks them through connect → languages → ready — so they reach a working state instead of an empty settings form.

## Background

Today there is **no onboarding**. `chrome.runtime.onInstalled` (`apps/extension/entrypoints/background.ts`) only sets the toolbar title. A freshly installed extension gives the user no guidance: clicking the icon opens the Slice-3 popup, which (with empty settings) shows "Finish setup in Options" and routes to the full Options form — a dense editor with no hint that **a local backend must be running** with the user's own provider credentials.

The structural reality: the backend is a **local dev server the user runs themselves** (`pnpm --filter @echoflow/backend dev`) with Volcengine credentials in a gitignored `.env` (documented in `README.md`). The extension **cannot** run the backend or set credentials — its leverage is to make that requirement clear, verify reachability, and smooth configuration.

Reusable pieces already exist:
- `apps/extension/src/settings/capabilitiesClient.ts` — `fetchCapabilities(serverUrl, apiKey, fetchImpl?)` → `CapabilitiesDescriptor | null` (the connection test).
- `apps/extension/entrypoints/options/main.tsx` — already does a debounced capabilities fetch with an `idle/loading/ok/error` status pill (the pattern the Connect step mirrors).
- `apps/extension/src/ui/SegmentedControl.tsx` (mode), `apps/extension/src/ui/LanguagePicker.tsx` (target), `apps/extension/src/settings/languageSelection.ts` (`coercePair`/`targetOptions`), `apps/extension/src/ui/theme.ts` (`LIGHT_THEME`/`themeStyleSheet`/`RADIUS`), `apps/extension/src/settings/settings.ts` (`loadSettings`/`saveSettings`/`validateSettings`, `SUBTITLE_MODE_OPTIONS`, `counterpartSource`).

## Decisions (validated via visual brainstorming)

1. **Auto-trigger on install** — `onInstalled` (reason `"install"`) opens a dedicated onboarding page; re-runnable later via links from the popup and Options.
2. **Dedicated full-page wizard** — a new `entrypoints/onboarding/` page (not an Options "mode"), light-themed, reusing the shared components. Keeps onboarding isolated from the Options editor.
3. **Four steps** — Welcome → Connect → Languages → Ready.
4. **Connect is the centerpiece** — a live connection test (`/v1/capabilities`); **block Continue until it passes**, with an explicit **"Set up later — finish anyway"** escape that saves typed values and exits.
5. **Honest self-host framing** — Welcome front-loads "you run a local backend"; the Connect step explains creds live only in the backend `.env` and links to the setup guide.

## Design

### 1. Surface, trigger, and re-entry

- **New entrypoint** `apps/extension/entrypoints/onboarding/` (`index.html` + `main.tsx`) — WXT builds it to `onboarding.html`. Opened via `chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") })` (an extension page; no `web_accessible_resources` needed).
- **Auto-open on install:** `background.ts` `onInstalled` listener gains the install branch:
  ```ts
  chrome.runtime.onInstalled.addListener((details) => {
    chrome.action.setTitle({ title: "EchoFlow" });
    if (details.reason === "install") {
      void chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
    }
  });
  ```
  Reason `"install"` fires once per install, so no extra "seen" flag is needed for the auto-open.
- **Re-entry (re-runnable):**
  - The popup's **"Finish setup"** affordance (Slice 3 `finish_setup` state) opens onboarding instead of Options — a not-yet-configured user gets the guided flow. The popup footer's "Open full settings" still opens Options.
  - The Options page gains a small **"Run setup again"** link that opens onboarding.

### 2. Wizard steps

A single React app (`OnboardingApp`) driven by a step index over four steps. The footer carries Back / primary-advance, plus per-step extras.

**Step 1 — Welcome.** A one-line value statement ("Real-time bilingual subtitles for any tab's audio") + an honest 3-point checklist: (1) *you run a local backend* (self-hosted MVP, your own creds), (2) *we'll connect & test it*, (3) *pick your languages*. A "Follow the setup guide →" link (to the README/setup section). Footer: **Get started →**; a ghost **Skip setup** that exits the tab.

**Step 2 — Connect.** `Backend URL` (default `http://127.0.0.1:8787`) + `API key` (default hint `dev-key`) inputs. A debounced connection test runs `fetchCapabilities` on change, producing a status block:
- **idle/empty:** neutral prompt.
- **loading:** "Checking…".
- **error:** red "Can't reach the backend." + a concrete fix-it ("Is it running? Start it with `pnpm --filter @echoflow/backend dev`, then retry.") + setup-guide link.
- **ok:** green "Connected." + a capability summary (see §3).
An honest note: credentials live only in the backend `.env`, never in the extension. **Continue is disabled unless the test is `ok`.** A ghost **"Set up later — finish anyway"** is always present: it persists the typed settings via `saveSettings` and exits.

**Step 3 — Languages.** Mode `SegmentedControl` over `SUBTITLE_MODE_OPTIONS` (`一致`/`实时`) + target `LanguagePicker`, both driven by the `CapabilitiesDescriptor` fetched in Connect (via `coercePair`/`targetOptions`, exactly as Options/popup do). Source is derived (`counterpartSource`/`coercePair`). Footer: Back / **Continue →**.

**Step 4 — Ready.** A recap card (Backend ✓ Connected · Mode · Translate to) and a prominent **how-to-start** callout pointing at the Slice-3 popup: "open a tab with audio, click the EchoFlow toolbar icon, press Start subtitles." Footer: **Done** (saves settings, closes the tab) and **Open full settings** (→ Options).

### 3. Connection summary (pure)

`fetchCapabilities` returns a `CapabilitiesDescriptor` whose `modes.pipeline.available` / `modes.interpret.available` already encode which providers are configured. A pure helper `summarizeCapabilities(caps)` turns it into the Connect/Ready summary text so the green state is **truthful about interpret**:
- both available → "Free + Interpret available · N languages".
- pipeline only (interpret needs AST creds) → "Free mode available · Interpret needs backend AST credentials".
- neither / null → treated as a failed connection.

`N` = the larger mode's language count. This helper is pure and unit-tested.

### 4. Step model (pure)

A pure module `onboardingFlow.ts` defines the ordered steps and the advance gate, so the gating logic is testable apart from the component:
- `ONBOARDING_STEPS = ["welcome", "connect", "languages", "ready"] as const`; `type OnboardingStep = …`.
- `canAdvance(step: OnboardingStep, ctx: { connected: boolean }): boolean` — every step advances freely **except** `"connect"`, which requires `ctx.connected === true`. (The "finish anyway" escape bypasses the wizard entirely and is not an "advance".)
- `nextStep(step)` / `prevStep(step)` — clamped navigation helpers.

### 5. State & persistence

`OnboardingApp` is presentational (props + handlers injected); the entrypoint `main.tsx` owns:
- working settings (seeded from `loadSettings`, defaults for a fresh install);
- the debounced capabilities fetch (`fetchCapabilities`) → `connected` + `capabilities` (mirrors Options);
- step index + navigation (`onboardingFlow`);
- persistence: **Done**, **Skip setup**, and **finish anyway** all call `saveSettings(workingSettings)` before closing; mode/target edits update working settings in memory (saved at exit). `subtitleFontSize` defaults to `DEFAULT_SUBTITLE_FONT_SIZE`.
- `window.close()` on Done/Skip/finish-anyway; `chrome.runtime.openOptionsPage()` for "Open full settings".

### 6. File structure

- **New** `apps/extension/entrypoints/onboarding/index.html` + `main.tsx` — entrypoint wiring (chrome APIs, settings, capabilities fetch, navigation).
- **New** `apps/extension/src/onboarding/OnboardingApp.tsx` (+ `.test.tsx`) — presentational 4-step wizard, light theme, reusing `SegmentedControl`/`LanguagePicker`; render-tested per step.
- **New** `apps/extension/src/onboarding/onboardingFlow.ts` (+ `.test.ts`) — step order + `canAdvance`/`nextStep`/`prevStep`.
- **New** `apps/extension/src/onboarding/connectionSummary.ts` (+ `.test.ts`) — `summarizeCapabilities`.
- **Modify** `apps/extension/entrypoints/background.ts` — `onInstalled` opens onboarding on install.
- **Modify** `apps/extension/entrypoints/popup/main.tsx` (+ `src/popup/PopupApp.tsx` if a new handler prop is needed) — the `finish_setup` affordance opens onboarding.
- **Modify** `apps/extension/entrypoints/options/main.tsx` — add a "Run setup again" link opening onboarding.

### 7. Error handling & edge cases

- **Backend unreachable / wrong key:** the Connect test shows the red state; Continue stays disabled; "finish anyway" remains the escape. (`fetchCapabilities` already returns `null` on any failure — the step treats `null` as not-connected.)
- **Interpret unavailable (ASR-only backend):** the green state still connects but the summary names the limitation (§3); Languages still works for pipeline.
- **User closes the tab:** nothing persisted unless they hit Done/Skip/finish-anyway; re-opening (install only fires once) is via the popup/Options links.
- **Empty URL/key:** test is `idle`; Continue disabled; "finish anyway" still available.
- **Re-running onboarding with existing valid settings:** fields seed from `loadSettings`, so the test goes green immediately and the user can breeze through or adjust.

### 8. Testing

- `onboardingFlow.test.ts` — step order; `canAdvance` blocks `connect` until `connected`, allows others; `nextStep`/`prevStep` clamping.
- `connectionSummary.test.ts` — both-available, pipeline-only (interpret-needs-creds), null/none.
- `OnboardingApp.test.tsx` (`renderToStaticMarkup`) — Welcome checklist; Connect idle/ok/error states + the "finish anyway" escape + Continue disabled-vs-enabled; Languages controls present; Ready recap + how-to-start.
- Entrypoint wiring + `onInstalled` auto-open are entrypoint/e2e territory (the `test` script targets `src` only).
- Gates: `pnpm typecheck` clean; `pnpm --filter @echoflow/extension test` green; `pnpm --filter @echoflow/extension build` succeeds and emits `onboarding.html`.

## Out of scope (stays in backlog)

- Automating backend setup (`.env`, running the server) — impossible from the extension; onboarding links to docs.
- Bringing the onboarding/start path into automated e2e — the popup gesture limitation (Direction D).
- Telemetry/analytics on onboarding completion.
- Store-readiness assets (Slice 5).
- No change to `packages/protocol` (the backend wire contract).
