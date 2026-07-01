# Speaker Labels Design (Direction C)

> Captured 2026-07-01. Direction C / "Speaker separation" from `docs/superpowers/backlog.md`.
> Adds multi-speaker labels to bilingual subtitles, end-to-end on the deterministic
> fake provider + UI. Real Volcengine speaker decode is a deliberate follow-up.

## Goal

When audio has multiple speakers, the overlay shows a color-coded **Speaker N** label
above each bilingual line, speaker identity is persisted in local history, and text/JSON
export carries it. Delivered on the deterministic `fake` provider so the whole vertical
(contract → backend → UI → history) is visible and fully tested without provider
credentials.

## Why this sequencing

The real Volcengine speaker wire-field is **not confirmed in the codebase**: the AST
`TranslateResponse` decoder (`astProtocol.ts`) reads only text/start/end (no speaker field
number is defined), and the pipeline `VolcengineUtterance` type has no speaker field. The
backlog asserts `spk_chg`/`speaker_id` exist, but the exact field requires an empirical
multi-speaker probe with real credentials. Rather than guess a field number, this slice
ships the contract + fake provider + UI + history, which:
- delivers a visible, testable feature now,
- fixes the wire contract every real adapter will target,
- leaves real decode as a small, well-scoped follow-up (wire the confirmed field into the
  existing reconcilers; the field is already optional, so nothing else changes).

## Non-goals (YAGNI, deferred)

- **Real Volcengine AST/ASR speaker decode** — unconfirmed wire field; separate follow-up.
- **Interpret-path speaker threading** — the interpret source emits without the field (it
  stays `undefined`); wired in the same follow-up as real decode.
- **Per-speaker styling settings** (font, voice, custom names) — not in this slice.
- **Speaker labels in the popup live card** — overlay is the subtitle surface; popup is
  unchanged.

## Data model

Speaker identity is a **stable, opaque `speakerId: string`** from the provider (e.g.
`"spk-a"`). It is optional on every carrier so untouched paths keep compiling and emitting.
The UI never shows the raw id — it derives a display **Speaker N** + color.

### Contract changes (`packages/protocol`)

- `PartialSubtitleEvent` and `FinalSubtitleEvent` gain `speakerId?: string`.
- `SubtitleSegment` (the history record shape) gains `speakerId?: string`.
- `isServerEvent` validates the field on `partial`/`final`:
  `!hasOwn(value, "speakerId") || typeof value.speakerId === "string"`.
- Per the repo convention, the matching `events.test.ts` guard tests are updated in the same
  change: speaker present (accepted), absent (accepted), wrong type e.g. number (rejected).

## Architecture & data flow

```
FakeSpeechProvider (speakerId on partial/final)
  → SegmentEvent { …, speakerId? }                     [providers/types.ts]
    → pipelineSubtitleSource (threads speakerId through the translation job)
      → ServerEvent partial/final { …, speakerId? }     [protocol]
        → subtitles/reducer (tracks seenSpeakerIds, reveal threshold)
          → SubtitleOverlay (colored "Speaker N" chip)
        → segmentMapping.finalEventToSegment → SubtitleSegment { speakerId? }
          → history store → Options history panel + text/JSON export
```

### 1. Backend

**`providers/types.ts`** — add `speakerId?: string` to the `partial` and `final`
`SegmentEvent` variants.

**`FakeSpeechProvider`** — assign a speaker per script segment so the deterministic path
demonstrates ≥2 speakers. Mapping (stable, by segment index): `seg-1 → "spk-a"`,
`seg-2 → "spk-b"`, `seg-3 → "spk-a"`. Emit `speakerId` on both the `partial` and the `final`
(and the `end()` flush) events for each segment.

**`pipelineSubtitleSource.ts`** — the translation job currently carries
`{ segmentId, sourceText, startTimeMs, endTimeMs }`; add `speakerId?`. Set it from the
incoming `SegmentEvent` on both the immediate `partial` emit and the post-translation `final`
emit, so the latest-wins translation worker preserves the speaker. `language` events are
unaffected.

### 2. Extension — display logic (the one unit of real logic)

**`src/subtitles/speakerDisplay.ts`** (new, pure, unit-tested):

```ts
/** First-seen order → 1-based display number. Stable within a session. */
export function assignSpeakerNumbers(orderedIds: readonly string[]): Map<string, number>;

/** A fixed AA-contrast-on-dark palette; cycles by number, so the palette repeats
 *  past its length but the always-shown number keeps speakers distinguishable. */
export function speakerColor(displayNumber: number): string;
```

Palette: 6 colors chosen for ≥4.5:1 contrast on **both** dark overlay backgrounds it can sit
on — `DARK_THEME.bg` (`#0c0e13`) and `DARK_THEME.surface` (`#11141b`) — verified with the
existing `src/ui/contrast.ts` helper in a test. `speakerColor` cycles with
`(displayNumber - 1) % palette.length`. It is used only by the dark overlay; the
light-themed options panel and export use the display *number*, not the color.

**`src/subtitles/reducer.ts`**:
- `SubtitleDisplaySegment` gains `speakerId?: string`; `reduceSubtitleEvent` copies it from
  `partial`/`final` events onto the current segment.
- `SubtitleState` gains `seenSpeakerIds: readonly string[]` (first-seen order, deduped),
  updated whenever a `partial`/`final` carries a `speakerId`.
- **Reveal rule:** labels are shown only once `seenSpeakerIds.length >= 2`. This is computed
  at the render site from `seenSpeakerIds` (no extra reducer field) — the overlay treats
  `seenSpeakerIds.length >= 2` as "multi-speaker active". Single-speaker sessions therefore
  show no chip.

**`src/overlay/SubtitleOverlay.tsx`**: when the current segment has a `speakerId` **and**
multi-speaker is active, render a chip above `.echoflow-source`:
`<span class="echoflow-speaker" style={{ color }}>● Speaker {n}</span>`, where `n` and
`color` come from `assignSpeakerNumbers(seenSpeakerIds)` + `speakerColor(n)`. New CSS
`.echoflow-speaker` (small, weight 600, the speaker color; the `●` dot inherits it). The
label text ("Speaker N") is the accessible cue — color is secondary.

### 3. History + export + Options panel

**`src/history/segmentMapping.ts`** — `finalEventToSegment` carries `speakerId` from the
`final` event into the `SubtitleSegment` it builds.

**Export + panel numbering (shared, DRY):** the Options history panel and both export paths
call `assignSpeakerNumbers` over the session's ordered segment ids to produce the same
"Speaker N" as the overlay.
- `exportSessionAsText`: prefix each line with `Speaker N: ` **only when the session has ≥2
  distinct speakers** (mirrors the overlay reveal rule); single-speaker exports are
  unchanged.
- `exportSessionAsJson`: include `speakerId` (raw) and `speakerNumber` (derived) per segment
  when present.
- Options history panel: show a small `Speaker N` tag on segments when the session is
  multi-speaker. The panel is **light-themed**, so it uses neutral tag styling (the theme's
  muted/accent tokens) and the *number* to convey identity — `speakerColor` is **not** used
  here. Per-speaker color-coding is an overlay-only affordance: one palette cannot be
  AA-as-text on both the dark overlay and the light options page, and the number alone
  identifies the speaker.

## Error handling / edge cases

- **No speaker data** (real adapters today, single-speaker fake): field is `undefined`
  everywhere; no chip, no export prefix, panel unchanged. The reveal threshold guarantees
  single-speaker sessions look exactly as they do now.
- **Speaker returns after a gap** (`spk-a` → `spk-b` → `spk-a`): first-seen order keeps
  `spk-a` = Speaker 1 throughout; the third segment re-shows Speaker 1.
- **>6 speakers:** colors repeat but the number is always shown, so speakers remain
  distinguishable by label.
- **Stale/replaced session:** unaffected — `seenSpeakerIds` resets with the reducer's initial
  state; existing `localSessionId` message-tagging still discards stale events.

## Testing

- **Protocol:** `isServerEvent` guard — speaker present/absent/wrong-type on partial+final.
- **`assignSpeakerNumbers`:** first-seen ordering; a returning speaker keeps its number;
  cycling for >6; empty/single input.
- **`speakerColor` + palette:** each palette color ≥4.5:1 on `--ef-bg` via `contrast.ts`.
- **Reducer:** `speakerId` flows onto the current segment; `seenSpeakerIds` dedupes in
  first-seen order; the derived `seenSpeakerIds.length >= 2` flips only at the 2nd distinct
  speaker.
- **Fake provider:** emits ≥2 distinct `speakerId`s across its script (partial + final).
- **Pipeline source:** `speakerId` survives the translation round-trip onto the `final`.
- **Overlay:** chip renders with correct number/label when multi-speaker + speakerId present;
  hidden for single-speaker or missing id.
- **History/export:** `finalEventToSegment` carries the id; text export prefixes only when
  multi-speaker; JSON includes raw + derived; panel numbering matches the overlay.
- Extension component tests use `renderToStaticMarkup` (node env) — assert on class/text, not
  color pixels; avoid literal apostrophes per the known escaping gotcha.

## Rollout

1. Land the vertical on `feat/speaker-labels` via PR (CI `check` gates the merge).
2. Manual check with the fake provider: run the backend, start a session, confirm the
   overlay cycles Speaker 1/Speaker 2 chips and export/history carry them.
3. Mark "Speaker separation" progressed in the backlog; note the real-decode follow-up
   (confirm the Volcengine wire field with a multi-speaker sample, then wire it into the
   reconcilers — contract already supports it).
