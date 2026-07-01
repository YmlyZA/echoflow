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

- ✅ **CI** — *shipped* (PR #14) → `.github/workflows/ci.yml`. A `check` job (pnpm@10 + Node 22, cached) runs `install --frozen-lockfile` → `typecheck` → `test` → `build` on every PR to `main` + pushes to `main`. Excludes the skip'd Playwright e2e (Direction D). **Branch protection on `main` now requires the `check` status check** — a failing run blocks the merge, and all changes (even docs) go through a PR.
- ✅ **Packaging / distribution** — *shipped* → `.github/workflows/release.yml`, `specs/2026-07-01-packaging-release-design.md`. Tag-driven GitHub Release: pushing a `vX.Y.Z` tag (optional `-prerelease` suffix) derives the version from the tag (`apps/extension/scripts/print-version.ts` → the tested `deriveVersion` helper), runs `typecheck` + `test`, `wxt zip`s the extension, and publishes a Release with `echoflow-<version>-chrome.zip`. Version is tag-only (dev fallback `0.0.0`); WXT keeps the manifest `version` numeric and puts any suffix in `version_name`. README has a prebuilt-install section; `docs/RELEASING.md` is the maintainer guide. Remaining manual step: cut the first real `vX.Y.Z` tag to publish the first Release. Chrome Web Store submission stays deferred (self-host model).
- Consider the `repo-production-review` skill for a systematic MVP→production gap analysis.

## C — Feature expansion

- 🟡 **Speaker separation** — *contract + fake + UI shipped* → `specs/2026-07-01-speaker-labels-design.md`. Optional `speakerId` threads protocol → backend (fake multi-speaker provider + pipeline) → subtitle reducer → overlay chip (color-coded "Speaker N", revealed at ≥2 speakers), persisted in history + text/JSON export + the Options history panel. `assignSpeakerNumbers` (first-seen order) numbers speakers identically across every surface. **Follow-up (deferred):** real Volcengine speaker decode — the AST `TranslateResponse` `spk_chg`/`speaker_id` wire field is not yet confirmed in code; wire it into the interpret/ASR reconcilers once verified with a multi-speaker sample (the contract already carries the optional field).
- **Usage / billing tracking** — the `UsageResponse(154)` event is currently ignored; record usage for the paid mode.
- History/export improvements, subtitle styling options, more target languages (graduates automatically as providers expand — see the capabilities design).

## D — Quality / observability

- **Automated e2e** — bring interpret/pipeline validation into CI (Playwright + synthetic audio). Blocker: `tabCapture` needs a real user gesture; needs a workaround. As of Slice 3 the `extension-smoke` Playwright test is retargeted to the popup's `START_FROM_POPUP` path but `test.skip`'d — the popup Start gesture (and the SW→backend WS bridge) can't be synthesized headlessly. Un-skip once the gesture/connectivity workaround lands.
- ✅ **Backend↔Volcengine auto-reconnect** — *shipped* → `specs/2026-07-01-session-robustness-design.md`. A reusable `withReconnect` transport wrapper (retryable-vs-fatal classify, exponential backoff ~6 attempts, re-runs the session-init frame, drops audio during the gap) adopted by **both** pipeline ASR and interpret AST paths; a transient `status` `ServerEvent` drives the overlay's existing 重连中… pill. Accept-the-gap (no audio replay). *Follow-up:* regenerate session/request ids per reconnect if a real drop shows Volcengine rejects duplicates (currently reused).
- ✅ **Drain trailing final on stop** — *shipped* (same design) → a `createDrainGate` helper makes each adapter's `end()` await the trailing final (bounded ~1500ms timeout); pipeline `end()` also awaits the in-flight translation so the last translated line survives `close()`.
- Validated by mock-transport/timer unit tests; a real Volcengine drop is a manual post-merge check (kill/restore connectivity → 重连中… then resume; stop mid-sentence → last line retained).
- Parked Cycle-2 minors: interpret in-flight-after-`end()` and double-`close()` are untested.

## Language support note

AST interpret currently supports **20 languages + 2 dialects** with a pivot constraint (one side must be zh/en) — see the capabilities design. Japanese/Korean/French etc. as *target* depend on pairing through zh/en. Broader/arbitrary pairings depend on ByteDance expanding the model; the capabilities design absorbs new languages as a data change.
