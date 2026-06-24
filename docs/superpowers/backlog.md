# EchoFlow Backlog

Captured 2026-06-24. Directions agreed but deferred while we focus on the UX overhaul (Direction A).

## UX overhaul arc (Direction A — in progress)

Raising the extension to a real-product bar. Each slice = its own spec → plan → build.

1. **Options redesign + capability-driven language selection** — *designing now* → `specs/2026-06-24-options-redesign-language-capabilities-design.md`. Establishes the Direction-B design language (teal "Focus Studio", light options / dark overlay) and ships explicit source/target language selection.
2. **Overlay redesign** — in-page subtitles + controls, on the dark theme; must stay legible over any video.
3. **Popup** (new surface) — status + quick controls (today the toolbar only toggles).
4. **Onboarding / first-run** — guided setup (server URL, API key, mode); the backend+creds step is the hardest for new users.
5. **Store-readiness** — icon, screenshots, listing copy, accessibility audit.

## B — Productionization / engineering baseline

- **CI** — GitHub Actions running `pnpm test` / `typecheck` on every PR (currently green but ungated).
- **Packaging / distribution** — beyond load-unpacked: a distributable build, eventually Chrome Web Store.
- Consider the `repo-production-review` skill for a systematic MVP→production gap analysis.

## C — Feature expansion

- **Speaker separation** — AST `TranslateResponse` carries `spk_chg` / `speaker_id` (currently ignored); show speaker labels for multi-speaker audio.
- **Usage / billing tracking** — the `UsageResponse(154)` event is currently ignored; record usage for the paid mode.
- History/export improvements, subtitle styling options, more target languages (graduates automatically as providers expand — see the capabilities design).

## D — Quality / observability

- **Automated e2e** — bring interpret/pipeline validation into CI (Playwright + synthetic audio). Blocker: `tabCapture` needs a real user gesture; needs a workaround.
- **Backend↔Volcengine auto-reconnect** — neither pipeline nor interpret reconnects on a mid-session drop (deferred since Cycle 1).
- **Drain trailing final on stop** — stopping mid-utterance drops the in-progress final (known deferred edge).
- Parked Cycle-2 minors: interpret in-flight-after-`end()` and double-`close()` are untested.

## Language support note

AST interpret currently supports **20 languages + 2 dialects** with a pivot constraint (one side must be zh/en) — see the capabilities design. Japanese/Korean/French etc. as *target* depend on pairing through zh/en. Broader/arbitrary pairings depend on ByteDance expanding the model; the capabilities design absorbs new languages as a data change.
