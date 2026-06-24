# Options Redesign + Capability-Driven Language Selection — Design

**Date:** 2026-06-24
**Status:** Design (awaiting review)
**Slice:** 1 of the UX overhaul arc (see `docs/superpowers/backlog.md` for the full roadmap)

## 1. Context & goal

The extension works end-to-end (pipeline + interpret validated on the real wire), but its UI is utilitarian — a plain settings form and a basic in-page overlay. We are raising it to a real-product bar, starting with the **options page** as the proving ground for a shared design language, and landing the first concrete feature: **explicit, capability-driven source/target language selection** for interpret mode.

Two decisions from brainstorming anchor this slice:

1. **Design language = "Direction B" (Focus Studio):** a teal-accented system, **light theme for the options page**, **dark for the in-page overlay**, with the teal accent as the through-line. The options page is where we establish the design tokens; later slices carry them to the overlay, popup, and onboarding.
2. **Language options are server-driven.** Different providers/modes support different languages, so the **backend is the source of truth**. The extension renders whatever the backend reports for the current mode; it hardcodes no language lists.

### What this slice delivers
- A reusable **design-token foundation** (Direction B, light + dark) extracted on the options page.
- A **capabilities endpoint** on the backend describing supported languages per mode.
- The capabilities **protocol contract** in `@echoflow/protocol`.
- A redesigned **options page** in Direction B (light) consuming capabilities.
- **Explicit source + target** language selection for interpret, with the AST pivot constraint, replacing today's "target-only, source = derived counterpart."

### Non-goals (later slices / backlog)
Overlay redesign, popup surface, onboarding/first-run, Web Store assets, accessibility audit (beyond baseline), S2S mode, dialect-as-target (AST forbids it), and Backlog directions B/C/D. Pipeline-mode source override is **not** added — pipeline keeps SeedASR auto-detect (capabilities will express that as `autoDetect: true`).

## 2. Supported-language facts (authoritative)

From the AST S2T API doc (6561/1756902), captured in `docs/superpowers/references/2026-06-20-ast-wire-reference.md`:

- **20 languages** usable as source *or* target: `zh, en, pt, es, ja, id, de, fr, ru, it, ko, ar, tr, ms, vi, th, nl, ro, pl, cs`.
- **2 dialects**, source-only: `粤语` (Cantonese), `上海话` (Shanghainese).
- **Pivot rule:** every pair must have **`zh` or `en` on one side**. So `ja→zh` ✅, `ja→en` ✅, `ja→ko` ❌.

This is provider/model-specific; that is exactly why it lives on the backend, not the extension.

## 3. Design language — Direction B (the token foundation)

A single source of design tokens, themeable light/dark. Lives in a new shared module the options page imports today and the overlay/popup import later.

**Location:** `apps/extension/src/ui/theme.ts` (token definitions) + a small set of primitive components/styles under `apps/extension/src/ui/`. (Exact structure finalized in the plan; the principle: tokens defined once, consumed by every surface.)

**Tokens (initial values — refined during implementation):**

| Token | Light (options) | Dark (overlay) |
|---|---|---|
| `accent` | `#0d8a7a` (deep teal — contrast on white) | `#67d7c2` (bright teal) |
| `accent-weak` | `#e7f7f4` | `rgba(103,215,194,.16)` |
| `bg` | `#f6f7f8` | `#0c0e13` |
| `surface` | `#ffffff` | `#11141b` |
| `border` | `#e3e6ea` | `rgba(255,255,255,.08)` |
| `text` | `#14181c` | `#f7f7f2` |
| `text-muted` | `#6b7280` | `#7d8794` |
| `radius` | 9–14px scale | same |
| `font` | `Inter, system-ui, …` (existing overlay stack) | same |

The overlay's current colors (`#67d7c2` translation line, dark panel) already match the dark theme — this formalizes them as tokens rather than inventing a new look.

## 4. Architecture — capability negotiation

### 4.1 Transport: HTTP, not WS

A new authenticated endpoint:

```
GET /v1/capabilities      headers: x-api-key (same auth as the WS route)
→ 200 application/json     CapabilitiesDescriptor
→ 401 if key mismatches
```

HTTP (not a WS event) because the options page needs capabilities **without** opening a capture session — it already holds `serverUrl` + `apiKey`. Cacheable, simple, fetched on options load and on mode switch.

### 4.2 The descriptor (protocol contract)

Defined in `@echoflow/protocol` with a runtime guard (`isCapabilitiesDescriptor`) and `.test.ts`, per the project's contract convention.

```ts
type LanguageOption = {
  code: string;        // "en", "zh", "ja", "yue" …
  label: string;       // "English", "中文", "日本語", "粤语"
  pivot: boolean;      // true for zh/en — the constraint anchor
  sourceOnly?: boolean;// true for dialects
};

type ModeCapabilities = {
  available: boolean;          // interpret depends on AST creds
  autoDetect: boolean;         // pipeline: true (ASR detects source) → hide source picker
  languages: LanguageOption[]; // empty when !available
  defaultPair?: { source: string; target: string };
};

type CapabilitiesDescriptor = {
  modes: { pipeline: ModeCapabilities; interpret: ModeCapabilities };
};
```

**Pair-validity rule (shared pure function, shipped with the contract):**
```
validTarget(source, target) =
  source.code !== target.code &&
  !target.sourceOnly &&
  (source.pivot || target.pivot)
```
The rule is generic enough for AST today. If a future provider needs arbitrary pairings, we replace flags with explicit per-source target lists — an additive change to the descriptor. (Documented as the extensibility path.)

### 4.3 Backend: computing the descriptor

`apps/backend` computes `CapabilitiesDescriptor` from the configured providers:
- **interpret:** `available = isInterpretAvailable(config)`; `languages =` the AST 20 + 2 dialects table (a backend constant, since it is AST-model knowledge); `defaultPair = {en, zh}`.
- **pipeline:** `available = true`; `autoDetect = true`; `languages =` the translation provider's supported targets (source side is auto). For `fake`, a small fixed set; for `volcengine`, its MT targets.

The AST language table replaces the thin `astLanguages.ts` (`INTERPRET_SUPPORTED_TARGETS`, `toAstLanguageCode`, `counterpartAstLanguage`). Source-language is now explicit, so `counterpartAstLanguage` is deleted and `toAstLanguageCode` generalizes to map UI codes → AST wire codes (mostly identity now that codes align).

### 4.4 Extension: consuming capabilities

- On options mount (and whenever `serverUrl`/`apiKey`/`mode` change): fetch `/v1/capabilities`, store in component state.
- Drive the source/target pickers from `modes[mode]`.
- Pure logic (validity, default coercion, search filtering) lives in `apps/extension/src/settings/languageSelection.ts` — testable, UI-free.
- The pure pair-validity function is **imported from `@echoflow/protocol`** so backend and extension share one definition.

## 5. Settings model & migration

`ExtensionSettings` gains a source language; target stays:

```ts
interface ExtensionSettings {
  serverUrl: string;
  apiKey: string;
  sourceLanguage: string;   // NEW — interpret only; ignored when mode=pipeline (auto)
  targetLanguage: string;
  subtitleFontSize: number;
  mode: SubtitleMode;
}
```

- Remove the hardcoded `TARGET_LANGUAGE_OPTIONS` / `INTERPRET_TARGET_LANGUAGE_OPTIONS` / `targetOptionsForMode` / `coerceTargetForMode` — these become capability-driven.
- **Migration:** existing stored settings have no `sourceLanguage`. On load, default it (interpret: counterpart of the stored target, i.e. `en`↔`zh`; pipeline: unused). `loadSettings` already normalizes partial stored settings — extend that path.
- **Validation** runs against the fetched capabilities: a saved `{source,target}` that is no longer valid (e.g. capabilities changed) is coerced to `defaultPair` with a notice, not left invalid.

## 6. Protocol & backend wire changes

- `SessionHandshakeRequest` gains `sourceLanguage?: string`; `StartSessionMessage` already spreads it. Guard + test updated.
- `RealtimeSession.handleClientMessage("start")` threads `sourceLanguage` to the factory.
- `createSubtitleSourceFactory` (interpret branch): validate the **pair** against the provider's supported languages (replacing `isSupportedInterpretTarget` target-only check). On invalid pair → `ModeLanguageUnsupportedError` (non-fatal `mode_language_unsupported`, socket stays open — existing behavior).
- `InterpretationSubtitleSource` takes explicit `sourceLanguage` + `targetLanguage` (stop deriving source from target) and emits the real `sourceLanguage` in the `language` event.

## 7. Options page redesign (Direction B, light)

Restructured into labelled sections (replacing the flat form), styled with the new tokens:

1. **Header** — wordmark + a connection-status pill (driven by a lightweight `/healthz` + capabilities reachability check).
2. **Subtitle mode** — segmented control (Pipeline / Interpret). Switching re-reads capabilities for that mode.
3. **Languages** —
   - interpret: **Source** (searchable picker, 20 langs + dialects group) **→ Target** (constrained by pivot rule; invalid targets shown **greyed/disabled** with reason — the validated interaction).
   - pipeline: source shown as **"Auto-detect"** (disabled), target = provider targets.
   - If `!modes[mode].available` (e.g. interpret without AST creds): the section explains it's unavailable, not a broken control.
4. **Connection** — Server URL + API key fields.
5. **Subtitles** — font-size stepper.
6. **Save** — unchanged semantics (applies on next capture).
7. **History** — the existing `HistoryPanel`, restyled to the tokens (functionally unchanged this slice).

**Component breakdown** (each small, single-purpose, testable where it has logic):
- `ThemeProvider` / token CSS — shared.
- `Section`, `SegmentedControl`, `LanguagePicker` (searchable + constrained), `Stepper`, `StatusPill`, `Field` primitives under `src/ui/`.
- `languageSelection.ts` — pure: validity, default coercion, search.
- `OptionsApp` orchestrates: load settings → fetch capabilities → render → validate → save.

## 8. Data flow

```
mount → loadSettings() ─┐
                         ├→ fetch /v1/capabilities (serverUrl, apiKey)
mode change ────────────┘        │
                                  ▼
                    modes[mode] drives pickers
                                  │
        user edits source/target │ (validity from shared rule)
                                  ▼
              validate pair vs capabilities → coerce if stale
                                  ▼
                    Save → chrome.storage  (applies next capture)
                                  ▼
        next capture: START_SESSION carries {mode, sourceLanguage, targetLanguage}
                                  ▼
            backend factory validates pair → InterpretationSubtitleSource(source,target)
```

## 9. Error handling

- **Capabilities fetch fails** (backend down / wrong URL / 401): show an inline, non-blocking banner ("Can't reach backend — check Server URL & API key"); language pickers fall back to a **minimal built-in safe set** (interpret: en↔zh; pipeline: current targets) so the page is still usable and saveable. Status pill shows disconnected.
- **Stale saved pair** after capabilities change: coerce to `defaultPair`, surface a one-line notice.
- **Mode unavailable** (interpret, no AST creds): the Languages section renders an explanatory empty-state; Save still works for other settings.
- Backend pair-rejection at session start remains the existing non-fatal `mode_language_unsupported`.

## 10. Testing strategy

Unit tests (Vitest), colocated, pure-logic-first:
- **Protocol:** `isCapabilitiesDescriptor` guard + `validTarget` rule (`packages/protocol`).
- **Backend:** descriptor computation per mode/provider (interpret available vs not; pipeline targets); factory pair-validation (valid pair builds source; invalid → `ModeLanguageUnsupportedError`); `InterpretationSubtitleSource` sends explicit source on the wire; capabilities route returns 200/401.
- **Extension:** `languageSelection.ts` (validity, coercion, search) ; settings migration (no `sourceLanguage` → defaulted); validation against a fetched descriptor.
- **Capabilities endpoint** covered in `server.test.ts`.
- Options-page React rendering: light smoke per existing `SubtitleOverlay.test.tsx` precedent; full interaction is e2e (entrypoints are e2e-covered by convention).

Manual: verify a real interpret session still works with explicit source after the wire change (the smoke harness already exercises this path).

## 11. Boundaries & isolation

- **One contract, one rule:** the descriptor shape and `validTarget` live in `@echoflow/protocol`; backend and extension both import them. No duplicated language logic.
- **Pure logic separated from UI:** `languageSelection.ts` and the backend descriptor builder are UI-free and fully testable; React components stay thin.
- **Tokens defined once:** `src/ui/theme.ts` is the only place colors/spacing are declared; surfaces consume tokens.

## 12. Open decisions (resolved)

- Invalid targets: **greyed/disabled with reason** (validated in the companion), not hidden.
- Source for pipeline: **auto-detect, no picker**.
- Transport: **HTTP `/v1/capabilities`**, not a WS event.
- Pair rule representation: **per-language flags + shared rule fn**, with explicit-list as the documented future escape hatch.

## 13. Implementation phasing — two separate PRs (decided)

Split into two independently-shippable plans/PRs:

- **P1 — language plumbing (full-stack, behind the existing UI).** Protocol `CapabilitiesDescriptor` + `validTarget` rule + guard; backend AST language table, descriptor builder, `GET /v1/capabilities`; wire `sourceLanguage` through `start` → factory pair-validation → `InterpretationSubtitleSource`; settings gains `sourceLanguage` + migration. The existing options form keeps working (it just starts sending an explicit source). Fully unit-testable; the smoke harness validates the real wire.
- **P2 — options redesign (additive UI).** Direction-B tokens (`src/ui/theme.ts` + primitives), the sectioned options page, and the searchable-source → constrained-target pickers consuming P1's capabilities.

This (P1) plan covers **P1 only**. P2 gets its own brainstorm-light → plan once P1 lands.
