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

- 🟡 **Automated e2e** — *substantially shipped* → `specs/2026-07-01-automated-e2e-design.md`. The backend request path (WS auth, `ClientMessage` parsing, `RealtimeSession` incl. the `stop`→clean-close teardown, fake providers, `ServerEvent` protocol) is CI-gated in-process via `server.test.ts` (`createServer` + `injectWS`, no browser/port). The `extension-smoke` Playwright test is **un-skipped**: its WebSocket now runs in Node (the SW-can't-open-outbound-WS blocker is gone) with per-message `SERVER_EVENT` injection into the extension — validated headlessly (`1 passed`, real overlay + IndexedDB history). It stays a **local** smoke (`test:e2e` / `dev-smoke.sh`), out of the required `check` (browser + backend boot is flake-prone). **Still deferred:** the real `tabCapture` gesture + offscreen audio pipeline (`getUserMedia`→AudioWorklet→PCM→`RealtimeClient`) — Node substitutes for the offscreen WS client — and interpret/AST e2e (credential-gated).
- ✅ **Backend↔Volcengine auto-reconnect** — *shipped* → `specs/2026-07-01-session-robustness-design.md`. A reusable `withReconnect` transport wrapper (retryable-vs-fatal classify, exponential backoff ~6 attempts, re-runs the session-init frame, drops audio during the gap) adopted by **both** pipeline ASR and interpret AST paths; a transient `status` `ServerEvent` drives the overlay's existing 重连中… pill. Accept-the-gap (no audio replay). *Follow-up:* regenerate session/request ids per reconnect if a real drop shows Volcengine rejects duplicates (currently reused).
- ✅ **Drain trailing final on stop** — *shipped* (same design) → a `createDrainGate` helper makes each adapter's `end()` await the trailing final (bounded ~1500ms timeout); pipeline `end()` also awaits the in-flight translation so the last translated line survives `close()`.
- Validated by mock-transport/timer unit tests; a real Volcengine drop is a manual post-merge check (kill/restore connectivity → 重连中… then resume; stop mid-sentence → last line retained).
- ✅ **Cycle-2 lifecycle minors** — *shipped* → `specs/2026-07-01-stream-lifecycle-hardening-design.md`. `ending` + `disposed` guards on **both** adapter streams: no audio sent after `end()` (incl. during the drain window), `end()` single-shot, `close()` idempotent. Closed the interpret in-flight-after-`end()` and double-`close()` gaps (mirrored to pipeline ASR). 8 adapter-unit tests.

## Audit remediation (2026-07-02/03) — repo-wide audit findings

A multi-agent audit (8 dimensions, adversarial verification) confirmed 21 findings. Fixed across
four slices, each spec → plan → subagent-driven build → PR, all merged behind the `check` gate:

- ✅ **Slice A — Session teardown consistency** (PR #21) → `specs/2026-07-02-session-teardown-consistency-design.md`. #2 `RealtimeClient.connect()` honors `stop()` mid-connect (no orphaned socket/backend session); #5 `handleSessionError` filters by `localSessionId`; #6 offscreen start-failure teardown is ownership-scoped; #7 background+offscreen serialize lifecycle messages via `createSerialQueue`; #14 unique local session ids + offscreen-doc race tolerated.
- ✅ **Slice B — Tab lifecycle & overlay teardown** (PR #22) → `specs/2026-07-02-tab-lifecycle-and-overlay-teardown-design.md`. #4 `tabs.onRemoved`/`onUpdated` end the session on tab close/navigate (+ pipeline `onCaptureEnded` backstop); #13 removed the page-writable `window` CustomEvent bridge (direct reducer dispatch); `SESSION_STOPPED` unmounts the overlay on stop; overlay Stop carries `localSessionId`; re-injection unmounts the prior React root. (Whole-branch review also fixed a terminal-state zombie: `stopSession` now stops offscreen for `error`/`stopping` too.)
- ✅ **Slice C — Backend fault tolerance** (PR #23) → `specs/2026-07-02-backend-fault-tolerance-design.md`. #1 a transient translation failure is non-fatal (source-only final + non-fatal error, session survives); #10 ASR audio sequence resets on reconnect; #11 reconciler dedupes by utterance boundary not text (verbatim repeats surface); #12 a fatal runtime provider error closes the client socket.
- ✅ **Slice E — WS origin & auth hardening** (PR #24) → `specs/2026-07-02-ws-origin-and-auth-hardening-design.md`. #3 WS handshake Origin allowlist (web-page origins → 403, closes CSWSH/quota-abuse); constant-time key compare; extension runtime-message sender validation.

**Resolved after the product decision:**
- ✅ **#8 — stop tail-final** (PR #26) → per the decision to keep Stop instant (no tail-final capture), fixed the backend-only half: `drainGate.cancel()` on `close()` so a stop no longer sits out the ~1.5s drain timeout for a final that can't arrive. → `specs/2026-07-02-... ` (commit in PR #26).
- ✅ **#9 — history completeness** → resolved by the **video-anchored history foundation (SP1a)**, PR #TBD → `specs/2026-07-03-video-anchored-history-foundation-design.md`. Backend emits **every** confirmed final (bounded FIFO queue, no latest-wins drop); the extension reducer keeps the on-screen current line **monotonic** (`compareSegmentId`, covers pipeline `seg-` and interpret `ast-` ids) so history is complete while rendering stays a clean single line. Sessions now also store `videoUrl`/`videoTitle` (Dexie v2) — the identity for cache reuse.

**History-as-user-data arc (local, video-aware — no accounts):**
- ✅ **SP1a — foundation** (complete history + video identity) — shipped, see above.
- ⬜ **SP1b — capture→video-time alignment**: content-script `video.currentTime` sampling → background aligns each final to a video position (`videoStartSec`/`videoEndSec`). HTML5 `<video>` first.
- ⬜ **SP2 — scrub-sync playback**: the overlay follows `video.currentTime` (incl. seeks) from stored video-time.
- ⬜ **SP3 — per-video cache reuse**: revisiting a known `videoUrl` loads its transcript; identity normalization / provider `videoId` (e.g. YouTube).
- ⬜ **SP4 — accounts / cloud sync** (uses the existing `syncStatus`) — separate product decision, deferred.

**Minor deferred (from per-task/whole-branch reviews):**
- `translation_failed` error events now surface once per failed line during a translation outage (self-clearing "connection error" pill; wording is pre-existing/misleading for a translation hiccup) — future UX polish (dedicated non-connection error style / debounce).
- Spurious `capture_ended` history entry on clean tab close (cosmetic); reconciler silently drops a distinct definite sharing a `start_time` (speculative SeedASR edge); `onUpdated("loading")` during start can stop a just-started session on redirect-heavy pages (by design).

## Language support note

AST interpret currently supports **20 languages + 2 dialects** with a pivot constraint (one side must be zh/en) — see the capabilities design. Japanese/Korean/French etc. as *target* depend on pairing through zh/en. Broader/arbitrary pairings depend on ByteDance expanding the model; the capabilities design absorbs new languages as a data change.
