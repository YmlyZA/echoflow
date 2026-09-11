# OpenAI-compatible ASR + translation providers — Design

**Date:** 2026-09-12
**Status:** Draft (design); pending review → implementation plan

## Goal

Add a second first-party provider lane, `openai`, for both legs of the pipeline
mode: streaming ASR over the OpenAI Realtime API (transcription intent) and
line translation over Chat Completions. Both go through a configurable base URL
so the same adapter serves OpenAI itself and the services that clone its API.
This is the last first-party lane; every further vendor is a community adapter
per `docs/providers.md` (strategy: `backlog.md` → "Provider strategy").

No extension change. No wire-protocol change. Interpret mode stays Volcengine.

## What "compatible" honestly buys

| Leg | Surface | Who else implements it |
|---|---|---|
| Translation | `POST {base}/chat/completions` | Practically everyone: Groq, OpenRouter, DeepSeek, Ollama, vLLM, LM Studio, … |
| ASR | `wss://{base}/realtime?intent=transcription` | OpenAI; **Speaches** (self-hosted Whisper, same events); vLLM's realtime endpoint. **Not** Groq / whisper.cpp / faster-whisper-server — those are REST `/audio/transcriptions` only. |

So the translation leg is the broad win; the ASR leg covers OpenAI plus the
self-hosted Speaches path, which is exactly the "zero API fee, private" option
the OSS audience asks for. A chunked REST-transcription adapter for the
whisper.cpp family is a documented follow-up, not part of this slice: it needs
backend-side VAD and gives no partials, a different product experience.

## Verified API facts (September 2026)

Sources: OpenAI Realtime transcription guide, client/server-events reference,
model pages, pricing page; Speaches realtime docs.

- OpenAI's recommended streaming model is now **`gpt-live-transcribe`**
  ($0.017/min). `gpt-4o-transcribe` / `gpt-4o-mini-transcribe` / `whisper-1`
  still work but are labelled legacy. `gpt-live-transcribe` streams transcript
  deltas; it gives **no word timestamps, no speaker labels, no confidence**.
- Session: WebSocket `{base with wss}/realtime?intent=transcription`,
  `Authorization: Bearer <key>`. The `OpenAI-Beta: realtime=v1` header is GA-obsolete
  and must be omitted. Configure with a `session.update` event whose `session` has
  `type: "transcription"`, `audio.input.format = { type: "audio/pcm" }` (**24 kHz
  mono 16-bit** — the only PCM rate accepted), `audio.input.transcription = {
  model, prompt?, languages? }`, `audio.input.turn_detection = { type:
  "server_vad", silence_duration_ms, prefix_padding_ms, threshold }`, optional
  `audio.input.noise_reduction`. The older `transcription_session.update` name is
  gone from the reference.
- Audio in: `input_audio_buffer.append` `{ audio: <base64 pcm> }`; `input_audio_buffer.commit`
  forces the current buffer to be treated as a turn.
- Events out that we consume: `session.created`, `input_audio_buffer.speech_started`
  / `speech_stopped` / `committed` (carry `item_id`),
  `conversation.item.input_audio_transcription.delta` `{ item_id, content_index, delta }`,
  `…transcription.completed` `{ item_id, content_index, transcript }`,
  `…transcription.failed`, `error { error: { type, code, message } }`.
- Translation: Chat Completions is the surface third parties clone; the Responses
  API is not. Cheap current models: `gpt-5-nano` ($0.05 / $0.40 per 1M in/out),
  `gpt-4o-mini` ($0.15 / $0.60).

**Unconfirmed — must be verified by a real session before the reconciler is
built (Plan task 0):** whether `speech_started`/`speech_stopped` carry
`audio_start_ms` / `audio_end_ms`; the exact `transcription.failed` payload;
whether deltas arrive mid-utterance or only after `speech_stopped` (one
community report says the latter); the WebSocket max session duration / idle
timeout; whether the detected language is reported anywhere. The design below
degrades gracefully on every one of these.

## Configuration

```
ECHOFLOW_ASR_PROVIDER=openai
ECHOFLOW_TRANSLATION_PROVIDER=openai

OPENAI_API_KEY=                     # shared default for both legs
OPENAI_BASE_URL=https://api.openai.com/v1

# ASR leg (all optional; fall back to the shared values)
OPENAI_ASR_API_KEY=
OPENAI_ASR_BASE_URL=                 # e.g. http://127.0.0.1:8000/v1 for Speaches
OPENAI_ASR_MODEL=gpt-live-transcribe
OPENAI_ASR_SILENCE_MS=600            # server_vad silence_duration_ms
OPENAI_ASR_PROMPT=                   # free-text context hint
OPENAI_ASR_LANGUAGES=                # comma list of ISO 639-1 hints, empty = auto

# Translation leg (all optional; fall back to the shared values)
OPENAI_TRANSLATION_API_KEY=
OPENAI_TRANSLATION_BASE_URL=         # e.g. https://api.groq.com/openai/v1
OPENAI_TRANSLATION_MODEL=gpt-5-nano
```

Per-leg overrides exist because the realistic self-host setup is *ASR on a
local Speaches, translation on a cheap hosted LLM* — two base URLs, two keys.
`config.ts` resolves `OPENAI_ASR_*` → `OPENAI_*` → default, same for
translation, and drops the leg's config object entirely when no key resolves,
which is what `configHealth` keys on. Base URLs are stored with a trailing
slash stripped; the WebSocket URL is derived by swapping `http(s)` → `ws(s)`
and appending `/realtime?intent=transcription`.

Types in `providerConfig.ts`: `OpenAiAsrConfig { apiKey, baseUrl, model,
silenceMs, prompt?, languages? }`, `OpenAiTranslationConfig { apiKey, baseUrl,
model }`; `ASR_PROVIDER_NAMES` / `TRANSLATION_PROVIDER_NAMES` gain `"openai"`.
`UNIMPLEMENTED_PROVIDER_NAMES` keeps excluding it automatically once the
factory handles it (the filter lists implemented names explicitly — extend it).

Health (`configHealth.ts`): `missing` for the ASR leg is `["OPENAI_API_KEY"]`
(the shared var is the one a user should set first; the override is mentioned
in `.env.example`, not in the fail-fast message). Capabilities blockers reuse
the existing `asr_credentials_missing` / `translation_credentials_missing`
codes — no protocol change.

## ASR adapter — `OpenAiSpeechProvider`

Mirrors `VolcengineSpeechProvider` in shape: injectable transport factory,
`withReconnect`, `createDrainGate`, `ending`/`closed`/`disposed` guards. New
pieces:

**Resampler.** `resamplePcm16(input: Buffer, fromHz: 16000, toHz: 24000): Buffer`
— linear interpolation over Int16LE samples, carrying the fractional read
position and the last sample across calls so frame boundaries don't click. Pure,
unit-tested (a 1 kHz sine at 16 k in → the same tone at 24 k out; length ratio
exactly 3:2 over many frames). Lives in `providers/pcmResample.ts` so a future
adapter can reuse it.

**Framing.** Each canonical 100 ms frame becomes one `input_audio_buffer.append`
with the resampled bytes base64-encoded. No batching: the extension already
frames at ~100 ms, which is the rate OpenAI's own examples use.

**Audio clock.** The adapter tracks `pushedMs` = total canonical audio pushed
since the *first* connection (not reset on reconnect — timestamps must stay
relative to stream start, as `pipelineSubtitleSource` and the extension's
video-time alignment assume). This is the fallback source of segment timing.

**Reconciler** (`openAiTranscriptReconciler.ts`, pure, tested with captured
frames):

- `speech_started { item_id?, audio_start_ms? }` → open an utterance keyed by
  `item_id` (or a placeholder that is bound on the first event that carries an
  `item_id`), `startTimeMs = audio_start_ms ?? pushedMs`.
- `delta { item_id, delta }` → append; emit `partial { segmentId, text, startTimeMs }`
  for the utterance. If real sessions show deltas only arrive after
  `speech_stopped`, partials are still correct, just late — the reducer treats
  them as the current line either way.
- `speech_stopped { item_id?, audio_end_ms? }` → `endTimeMs = audio_end_ms ?? pushedMs`.
- `completed { item_id, transcript }` → emit **one** `final { segmentId, text:
  transcript, startTimeMs, endTimeMs }`, `segmentId = seg-<ordinal>` in emission
  order, drop the utterance. Blank transcript → drop silently (VAD false
  positive). `failed` → `onError` (non-fatal in the session) and drop the
  utterance.
- `segmentId` ordinals are assigned on `final` only, so two overlapping
  utterances (server VAD can commit one while the next has started) still
  emit in completion order and stay monotonic for the extension's
  `compareSegmentId`.
- `language` event: emitted once, `"auto"` unless a session event turns out to
  report a detected language (unconfirmed → do not depend on it).

**Session init** (`initialize` of `withReconnect`): send `session.update` with
the config above; `turn_detection.silence_duration_ms = silenceMs`. On reconnect
the reconciler's open utterances are dropped (audio in the gap is lost by
design, same as Volcengine) but `ordinal` and `pushedMs` persist.

**Error classification.** `error.error.type === "invalid_request_error"` or
HTTP 401/403 on upgrade → fatal (no retry; surfaces at first session as
`stt_unavailable`-style error and, at boot, is caught by the health check only
as "credentials present", so the README says to check the backend log).
`server_error`, socket close 1006/1011/1012, and any transport error → retryable
under the existing backoff. Rate-limit (`429` / `rate_limit_exceeded`) →
retryable.

**End / drain.** `end()` sends `input_audio_buffer.commit` so the trailing
partial turn is transcribed, arms the drain gate, and resolves on the next
`final` or the ~1500 ms timeout. `close()` cancels the drain and closes the
socket. Stop stays instant per the product decision on #8.

## Translation adapter — `OpenAiTranslationProvider`

`POST {baseUrl}/chat/completions`, `Authorization: Bearer`, body:

```json
{
  "model": "<model>",
  "temperature": 0,
  "messages": [
    { "role": "system", "content": "You translate subtitle lines. Reply with the translation only — no quotes, no notes, no romanization. Target language: <name (code)>. Source language: <name (code) | detect automatically>." },
    { "role": "user", "content": "<line>" }
  ]
}
```

Non-streaming. Response `choices[0].message.content` trimmed, with a surrounding
matched pair of straight or curly quotes stripped (small models add them).
Blank input → `""` without a request. Non-2xx, missing `choices`, or an empty
`content` → throw (non-fatal upstream: source-only final + `translation_failed`).
`max_tokens` is not set; a subtitle line is short and truncation would be worse
than a slightly larger bill. Language names come from a small BCP-47 → English
name table in the adapter (`zh-CN` → "Simplified Chinese"), unknown codes pass
the code itself. `close()` is a no-op.

`PIPELINE_TARGET_LANGUAGES` is unchanged: an LLM handles every language on that
list, and the list is what the extension offers regardless of provider.

## Testing

- `pcmResample.test.ts` — ratio, continuity across frames, tone preservation.
- `openAiTranscriptReconciler.test.ts` — with a **captured real event log**
  checked in beside it (Plan task 0 produces it): one utterance, two
  overlapping utterances, blank transcript, `failed`, timing from
  `audio_*_ms` when present and from the audio clock when absent.
- `openAiSpeechProvider.test.ts` — fake transport: `session.update` sent on
  connect and on reconnect, append frames are base64 24 k PCM, no audio after
  `end()`, `end()` sends commit and resolves on final / timeout, `close()`
  idempotent and cancels drain, fatal vs retryable error routing. Mirror the
  eight lifecycle tests the Volcengine adapter has.
- `openAiTranslationProvider.test.ts` — stubbed fetch: body shape, per-leg base
  URL/key precedence, quote stripping, each error path throws.
- `config.test.ts` / `configHealth.test.ts` / `providerFactory.test.ts` —
  `openai` name accepted, override precedence, fail-fast names `OPENAI_API_KEY`.
- CI is unchanged (fake providers). The PR records a real session against
  OpenAI and, if available, against a local Speaches: first-final latency,
  reconnect behaviour, Stop keeping the last line.

## Docs

`.env.example` block per the Configuration section; README provider list gains
`openai` for both legs with the Speaches + Groq example; `docs/providers.md`
gets a one-line pointer to this adapter as the second reference implementation.

## Non-goals

- REST `/audio/transcriptions` chunked adapter (whisper.cpp, Groq ASR) — follow-up.
- Interpret mode through OpenAI (no equivalent single-stream translate API).
- Diarization (`gpt-4o-transcribe-diarize` is legacy and non-streaming).
- Streaming translation, glossary/context carry-over between lines.
- Any change to the extension or the wire protocol.

## Open questions for review

1. Default translation model: `gpt-5-nano` (cheapest, quality unverified for
   zh↔en subtitles) vs `gpt-4o-mini` (3× the price, known-good). Proposal:
   `gpt-5-nano`, and let the real-session notes in the PR decide.
2. Should the adapter send `OPENAI_ASR_LANGUAGES` as `languages` hints when the
   extension's source language is set explicitly? Today the pipeline source is
   always `auto`, so this is a config-only knob for now.
3. Whether to expose `prefix_padding_ms` / `threshold`. Proposal: no — defaults
   until a real session shows a reason.
