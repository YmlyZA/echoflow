# EchoFlow Backlog

Captured 2026-06-24. Directions agreed but deferred while we focus on the UX overhaul (Direction A).

## UX overhaul arc (Direction A — ✅ complete)

Raised the extension to a real-product bar. Each slice = its own spec → plan → build. All five shipped (PRs #5–12).

1. ✅ **Options redesign + capability-driven language selection** — *shipped* (PRs #5–7) → `specs/2026-06-24-options-redesign-language-capabilities-design.md`. Established the Direction-B design language (teal "Focus Studio", light options / dark overlay) and explicit source/target language selection.
2. ✅ **Overlay redesign** — *shipped* (PR #9) → `specs/2026-06-25-overlay-redesign-design.md`. On-brand panel wired to `DARK_THEME` tokens, hover-reveal icon controls, single status pill (connection lifecycle + live mode 一致/实时), client-side `SESSION_ERROR` surfaced inline.
3. ✅ **Popup** (new surface) — *shipped* (PR #10) → `specs/2026-06-27-popup-control-center-design.md`. Toolbar icon opens a light-theme control center: start/stop (capture gesture moved into the popup), status pill + live card, quick mode/language controls, recent-history peek, Open-Options link. Bare mode labels (`一致/实时`).
4. ✅ **Onboarding / first-run** — *shipped* (PR #11) → `specs/2026-06-30-onboarding-first-run-design.md`. Auto-opening 4-step wizard (Welcome → Connect → Languages → Ready); the Connect step is a live `/v1/capabilities` test that blocks advancing until the backend is reachable + usable, with a "finish anyway" escape. Honest self-host framing; re-runnable from popup/Options.
5. ✅ **Store-readiness** — *shipped* (PR #12) → `specs/2026-06-30-store-readiness-design.md`. EchoFlow icon (soundwave over bilingual captions), WCAG-AA contrast pass + `prefers-reduced-motion` + picker Escape, prepared store-listing copy + screenshot guide (`docs/store-listing.md`), self-host README polish. Actual Web Store submission stays deferred (localhost/self-host model).

## B — Productionization / engineering baseline

- ✅ **CI** — *shipped* (PR #14) → `.github/workflows/ci.yml`. A `check` job (pnpm@10 + Node 22, cached) runs `install --frozen-lockfile` → `typecheck` → `test` → `build` on every PR to `main` + pushes to `main`. Excludes the skip'd Playwright e2e (Direction D). **Remaining one-time manual step:** enable branch protection on `main` (Settings → Branches → require the `check` status check) to actually *block* failing merges — the workflow only reports until then.
- **Packaging / distribution** — beyond load-unpacked: a distributable build, eventually Chrome Web Store.
- Consider the `repo-production-review` skill for a systematic MVP→production gap analysis.

## C — Feature expansion

- **Speaker separation** — AST `TranslateResponse` carries `spk_chg` / `speaker_id` (currently ignored); show speaker labels for multi-speaker audio.
- **Usage / billing tracking** — the `UsageResponse(154)` event is currently ignored; record usage for the paid mode.
- History/export improvements, subtitle styling options, more target languages (graduates automatically as providers expand — see the capabilities design).

## D — Quality / observability

- **Automated e2e** — bring interpret/pipeline validation into CI (Playwright + synthetic audio). Blocker: `tabCapture` needs a real user gesture; needs a workaround. As of Slice 3 the `extension-smoke` Playwright test is retargeted to the popup's `START_FROM_POPUP` path but `test.skip`'d — the popup Start gesture (and the SW→backend WS bridge) can't be synthesized headlessly. Un-skip once the gesture/connectivity workaround lands.
- **Backend↔Volcengine auto-reconnect** — neither pipeline nor interpret reconnects on a mid-session drop (deferred since Cycle 1).
- **Drain trailing final on stop** — stopping mid-utterance drops the in-progress final (known deferred edge).
- Parked Cycle-2 minors: interpret in-flight-after-`end()` and double-`close()` are untested.

## Language support note

AST interpret currently supports **20 languages + 2 dialects** with a pivot constraint (one side must be zh/en) — see the capabilities design. Japanese/Korean/French etc. as *target* depend on pairing through zh/en. Broader/arbitrary pairings depend on ByteDance expanding the model; the capabilities design absorbs new languages as a data change.
