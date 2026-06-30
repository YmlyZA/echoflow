# EchoFlow Accessibility Audit

**Date:** 2026-06-30
**Scope:** Four UI surfaces — SubtitleOverlay, PopupApp, OnboardingApp, LanguagePicker

---

## Colour contrast

- **Status:** AA pass (addressed in Task 2 — overlay redesign slice).
- Accent colour (`--ef-accent`) and muted text (`--ef-text-muted`) were darkened on both the light (popup/onboarding) and dark (overlay) themes to meet WCAG 2.1 AA 4.5:1 for normal text and 3:1 for large/bold text.
- No further contrast regressions found in Task 3.

---

## Reduced motion

- **Status:** Added in this task (Task 3).
- `@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }` appended to the `<style>` block in each animated surface:
  - `apps/extension/src/overlay/SubtitleOverlay.tsx` (controls fade-in/out, dot glow)
  - `apps/extension/src/popup/PopupApp.tsx` (pill box-shadow pulse)
  - `apps/extension/src/onboarding/OnboardingApp.tsx` (step bar transitions)
- The `*` selector is scoped to each surface's own style block (shadow root for the overlay; document root for popup/onboarding), so it does not bleed across surfaces.

---

## Keyboard / focus

- **Icon controls** (drag, font-size, hide, stop in the overlay): all are `<button>` elements with `aria-label` text; they receive `:focus-visible` outlines styled via `outline: 2px solid var(--ef-accent); outline-offset: 2px`.
- **Popup buttons** (Start, Stop, Finish setup, Open full settings): same focus-visible treatment.
- **Onboarding buttons and links**: same focus-visible treatment.
- **LanguagePicker — Escape to close:** The existing `useEffect` that registers the outside-click `mousedown` listener (gated on `open`) has been extended to also register a `keydown` listener. Pressing Escape while the picker panel is open calls `setOpen(false)` and both listeners are torn down in the same cleanup function.

  Verification note: There is no jsdom in this project (confirmed: no `vitest.config`, node environment; component tests use `renderToStaticMarkup`), so the Escape handler cannot be unit-tested in the established style. The handler is verified by code review and manual keyboard testing — no jsdom unit test exists in this package.

- **LanguagePicker panel input:** has `autoFocus`, so focus moves into the search field on open. Tab moves through option `<button>`s which each have `:focus-visible` outlines.
- **Deferred (out of scope per spec):** Full arrow-key roving within the picker option list (ARIA `listbox` roving tabindex pattern). The current implementation is keyboard-reachable but does not implement `ArrowUp`/`ArrowDown` navigation between options. Logged for a future ARIA enhancement pass.

---

## ARIA / semantics

- **Overlay subtitles:** `<section aria-live="polite">` — subtitle updates are announced to screen readers without interrupting.
- **Status pills:** `role="status"` on the lifecycle pill in the overlay and on error messages in popup/onboarding — changes are announced as status updates.
- **Onboarding step rail:** rendered as `<ol>` (ordered list) with `<li>` per step — correct semantic structure for a numbered progress indicator.
- **Form inputs in onboarding:** wrapped in `<label>` elements with visible `<span class="ef-label">` text — inputs are correctly labelled for assistive technology.
- **LanguagePicker trigger:** `aria-haspopup="listbox"` + `aria-expanded={open}` + `aria-label={ariaLabel}` — state is correctly communicated.
- **LanguagePicker panel:** `role="listbox"` with `aria-label`; each option has `role="option"` and `aria-selected`.

---

## Deferred / known gaps

| Item | Status |
|---|---|
| Arrow-key roving in LanguagePicker option list | Out of scope (spec §Slice 3); future pass |
| Screen-reader testing with VoiceOver / NVDA | Manual; not automated |
| Colour contrast audit for all dynamic states (hover, disabled) | Spot-checked; full automated scan deferred |
