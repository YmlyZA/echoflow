# Interpretation Subtitle Mode (Cycle 2) — Design

**Date:** 2026-06-20
**Status:** Approved (design); pending implementation plan

## Goal

Implement the paid `interpret` mode behind the Cycle 1 entitlement gate: a real
streaming speech-translation engine (火山引擎 豆包同声传译 / Seed LiveInterpret
2.0, "AST") that produces **bilingual subtitles in ~2–3 s** — far below the
`pipeline` mode's ~10 s finalized-only lag. When the engine is configured, the
extension's existing mode toggle flips `interpret` from "unavailable" to a
working real-time mode; when it is not configured, the Cycle 1
`mode_unavailable` behavior is unchanged.

## Why

- Product direction (from Cycle 1): a free `pipeline` service upgradable to a
  paid real-time `interpret` service. Cycle 1 shipped the seam, the gate, and
  the remembered toggle with `interpret` gated/erroring. Cycle 2 builds the
  engine the gate guards.
- Latency: `pipeline` is accurate but inherently laggy (it waits for a whole
  sentence to be ASR-confirmed). AST emits revising source **and** translation
  text continuously, finalized per sentence — true simultaneous interpretation,
  ~2.2 s first-character for zh↔en.

## Key facts about the AST engine (researched 2026-06-20)

- **Endpoint:** `wss://openspeech.bytedance.com/api/v4/ast/v2/translate`.
- **Auth headers** on the WS upgrade: `X-Api-App-Key`, `X-Api-Access-Key`,
  `X-Api-Resource-Id: volc.service_type.10053`, `X-Api-Request-Id`. AST is a
  **separately-subscribed** service with its **own credential pair**, distinct
  from the ASR (`大模型流式语音识别`) resource.
- **Wire format:** the same 4-byte binary header family as the ASR adapter, but
  an **event-id protocol with protobuf payloads** (not gzip+JSON). Out events:
  `StartSession` / `TaskRequest` (audio) / `FinishSession`. In events:
  source-subtitle `650/651/652` (Start/Response/End), translation-subtitle
  `653/654/655`, `UsageResponse 154`, `SessionFailed 153`.
- **Bilingual, native, one stream:** AST emits **both** the source
  transcription (651) and the target translation (654) as separate live,
  revising streams, each finalized by its `End` event (652/655). Both carry a
  `text` field; they are disambiguated by **event id**, not a payload field.
  There is **no `definite` flag** — finality is the `End` event.
- **Audio:** raw PCM 16 kHz / 16-bit / mono is accepted directly (matches our
  `CANONICAL_PCM_AUDIO_FORMAT`); send ~80 ms packets. Use `mode:"s2t"` (skip
  the s2s TTS path).
- **Languages:** the API documents ~20 s2t languages, but the model is
  production-quality only for **zh↔en**. We treat zh↔en as the supported set.
- **Errors:** `45000151` bad audio format, `45000081` packet-wait timeout,
  `55000031` server busy, `550xxxxx` internal; `20000000` success.
- **Billing:** token-metered; the stream emits `UsageResponse 154`
  (`input_audio_tokens` / `output_text_tokens`). Per-token pricing is not
  public (console/sales).

**Load-bearing gap:** the exact protobuf field numbers and the precise
source↔translation correlation / `End`-text semantics are not fully pinned from
the docs alone. The plan's **Task 0** closes this by obtaining the vendor
`protos.tar.gz` (doc 6561/1756902) and capturing one real session's frames
before the codec is written. See Section 3.

## Architecture

Everything new lives **behind the Cycle 1 `SubtitleSource` seam**. The wire
`ServerEvent`/`ClientMessage` protocol, the overlay, and the reducer are
untouched; the session gains only **one additive catch branch** (mapping the new
language error — Section 5), staying a thin forwarder.

```
extension (mode:"interpret"; target constrained to zh/en)
   ──start{mode, targetLanguage}──▶ RealtimeSession (thin; +1 error-mapping branch)
        └ createSubtitleSource("interpret", targetLanguage)
             └ factory gate: isInterpretAvailable(config) && targetSupported
                  ? new InterpretationSubtitleSource(astConfig, targetLanguage)
                  : throw ModeUnavailableError / clean language error
                       └ open({ onEvent, onError })
                            ├ AstTransport       (binary WS + protobuf events, auth headers)
                            └ interpretReconciler(source live → partial; translation end → final)
                                 └ ServerEvent → socket → overlay (UNCHANGED)
```

### Section 1 — Wire mapping (chosen): source live, translation a beat later

The wire model is **unchanged**: `partial{segmentId, sourceText}` (source only,
live) and `final{segmentId, sourceText, translatedText}` (both, at
confirmation). The reconciler maps AST's two streams onto it:

- Source `Start` (650) → begin a new segment (monotonic `ordinal`).
- Source `Response` (651) → emit `partial{segmentId, sourceText}` live (the
  source line types out as the speaker talks).
- Translation `End` (655) → emit `final{segmentId, sourceText, translatedText}`,
  pairing the buffered source text for that segment with the finalized
  translation.

This yields the authentic simultaneous-interpretation feel — the speaker's
words appear live, the interpreted line follows a beat later — with **zero
protocol or overlay change**. Translation `Response` (654) updates are buffered
(latest text wins) and surfaced only on the `End`, so the translation line does
not flicker through revisions. (Rejected alternatives: extending `partial` with
`translatedText` for both-lines-live — a contract change; and a
translation-led latest-wins `final` — loses the independent live source line.)

### Section 2 — Components (new backend files; mirror the ASR adapter split)

| File | Responsibility |
|---|---|
| `apps/backend/src/providers/astProtocol.ts` | Pure encode/decode of AST binary frames + a **minimal hand-rolled protobuf** codec for the events/fields we use. |
| `apps/backend/src/providers/astTransport.ts` | WS lifecycle: connect with the four `X-Api-*` headers, send `StartSession` then audio `TaskRequest`s, surface parsed in-events / errors / close. Mirrors `volcengineAsrTransport.ts`. |
| `apps/backend/src/providers/interpretReconciler.ts` | Two-stream correlation → `partial`/`final` segment events with monotonic ordinals (the `utteranceReconciler` analogue for AST). |
| `apps/backend/src/realtime/interpretationSubtitleSource.ts` | `implements SubtitleSource`; owns transport + reconciler; `pushFrame`→audio, AST events→`onEvent(ServerEvent)`, `end`/`close`. |

Each pure module is unit-tested in isolation, exactly like the ASR adapter
(`volcengineAsrProtocol.test.ts`, `utteranceReconciler.test.ts`).

### Section 3 — Protobuf approach + the grounding prerequisite

AST payloads are protobuf. We **hand-roll a minimal protobuf codec** for the
handful of events/fields we use (varint tags `(field<<3)|wiretype`,
length-delimited strings, varints) — keeping the backend dependency-free and
self-contained, consistent with how the ASR binary header protocol was
hand-rolled. We do **not** add `protobufjs`.

This requires the real field numbers, so the plan begins with:

- **Task 0 (gating prerequisite):** obtain the vendor `protos.tar.gz` from doc
  6561/1756902 **and** capture one real AST session's frames behind a debug
  flag (`ECHOFLOW_AST_DEBUG=1`), as Cycle 1's movie-subtitle spec did for
  SeedASR. This locks the protobuf field numbers, the source↔translation
  segment correlation, and the partial/final (`End`-event) semantics **before**
  `astProtocol.ts` is implemented. Remove the debug log afterward.

### Section 4 — Config + entitlement gate

- New `VolcengineAstConfig { appKey, accessKey, resourceId, endpoint }`, carried
  on `ProviderConfig` as an **optional `interpret?` field** (its absence is the
  default — interpret stays unavailable, exactly like Cycle 1). Parsed in
  `config.ts` from `VOLCENGINE_AST_APP_KEY` / `VOLCENGINE_AST_ACCESS_KEY` /
  `VOLCENGINE_AST_RESOURCE_ID` (default `volc.service_type.10053`) /
  `VOLCENGINE_AST_ENDPOINT` (default the v4 URL).
- `isInterpretAvailable(config)` = AST app key + access key both present.
- `subtitleSourceFactory.ts` `interpret` branch flips from "always throw" to:
  - creds present **and** target ∈ {`zh-CN`, `zh-TW`, `en`} →
    `new InterpretationSubtitleSource(astConfig, targetLanguage)`;
  - creds absent → `throw new ModeUnavailableError("interpret")` (unchanged
    Cycle 1 behavior);
  - creds present but target unsupported → `throw new
    ModeLanguageUnsupportedError(targetLanguage)` — a **new sibling error class**
    in `subtitleSource.ts` (alongside `ModeUnavailableError`), so the throw →
    session-maps → connection-stays-alive contract is reused (see Section 5),
    not a crash.
- `toAstLanguageCode` maps `zh-CN`/`zh-TW`→`zh`, `en`→`en`. `StartSession` sets
  `mode:"s2t"`, `target_language`, `enable_source_language_detect:true`, and
  `source_audio` = 16 kHz/16-bit/mono PCM. (Source is auto-detected; the user's
  `targetLanguage` is the viewer's language. When the spoken source equals the
  target, AST's translation line mirrors the source — acceptable for MVP.)

The gate remains the **single entitlement chokepoint** where real per-user
auth/billing will later attach.

### Section 5 — Error handling

- AST upstream errors (`45000151` bad audio, `45000081` timeout, `55000031`
  busy, `550xxxxx` internal, `SessionFailed 153`) → existing `error`
  `ServerEvent` with code `provider_error` and a readable message; a fatal
  session failure also closes the source (same path as the ASR adapter's
  `onError`).
- **Language unsupported** (interpret selected with a non-zh/en target that
  bypassed the UI): the factory throws `ModeLanguageUnsupportedError`; the
  session's `openSource` catch is extended with a branch that maps it to an
  `error` `ServerEvent` (code `mode_language_unsupported`) **without closing**
  the connection — the same non-fatal contract as Cycle 1's `mode_unavailable`,
  so the user can toggle target/mode and retry. (The session's existing
  `ModeUnavailableError` branch is the model; this adds a sibling branch.)
- `UsageResponse 154` token counts are logged (a future-billing hook), never
  surfaced to the client.

### Section 6 — Extension (kept in this cycle)

- Options page (`entrypoints/options/main.tsx`): when `mode === "interpret"`,
  the target-language `<select>` narrows to Chinese (Simplified/Traditional) +
  English. If the stored target is outside that set when interpret is selected,
  it is coerced to a sensible default (`zh-CN`).
- Settings (`src/settings/settings.ts`): a small helper exposes the
  interpret-supported target subset; `resolveSettings` is unchanged for
  `pipeline`. No new persisted field, no new wire field — `realtimeClient` and
  `offscreen` already send `mode` + `targetLanguage`.

The wire `ServerEvent` shape is unchanged, so the overlay/reducer need no
changes.

## Testing

- **`astProtocol`**: encode a `StartSession` to the expected bytes; decode
  crafted `651`/`654`/`655`/`154`/`153` frames (mirroring the captured real
  shapes) to typed events. Grounded by Task 0.
- **`interpretReconciler`**: source `Response` → `partial`; translation `End` →
  `final` with the paired buffered source; monotonic `ordinal` across segments;
  a translation `End` with no newer source still finalizes; robustness to
  interleaved source/translation events.
- **`interpretationSubtitleSource`**: via a stub transport — AST events →
  the expected `ServerEvent`s; an upstream error → `onError`; `close` tears down
  the transport.
- **Factory**: interpret available + supported target → builds an
  `InterpretationSubtitleSource`; creds absent → `ModeUnavailableError`; creds
  present + unsupported target → language-unsupported error. `pipeline`
  unaffected.
- **Config**: `VOLCENGINE_AST_*` env → `interpret` config; absent → `undefined`
  (interpret unavailable).
- **Extension**: options-page target list is constrained when interpret is
  selected; a stored unsupported target is coerced.
- **Manual e2e**: real AST session — bilingual subtitles in ~2–3 s, source line
  live + interpreted line a beat behind; toggling back to `pipeline` resumes the
  finalized-only path.
- Full `pnpm test`/build/typecheck/lint green; the `pipeline` path and all
  Cycle 1 behavior are unchanged.

## Scope / decomposition

One cohesive **Cycle 2** (larger than Cycle 1 but single-purpose): the AST
protocol codec, transport, reconciler, `InterpretationSubtitleSource`, config +
gate flip, error mapping, and the extension target constraint. **Task 0**
(proto + frame grounding) is a sequenced prerequisite within the plan.

## Out of scope (future)

- **s2s / TTS + voice cloning** — we use `mode:"s2t"` (subtitles only).
- **Real per-user authentication / billing** for the paid tier — the gate and
  the `UsageResponse` log are the attach points; the mechanism is a later cycle.
- **Languages beyond zh↔en** — the API lists more, but the model is reliable
  only for zh↔en today.
- **WS auto-reconnect / `end()` drain** for AST (carried over from the ASR
  adapter's out-of-scope list).
- A popup quick-toggle and per-mode UI affordances beyond the existing toggle +
  error banner.
