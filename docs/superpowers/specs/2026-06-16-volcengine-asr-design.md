# Volcengine Real ASR Adapter — Design

**Date:** 2026-06-16
**Status:** Approved (design); pending implementation plans

## Goal

Replace the deterministic fake speech provider with a real streaming ASR path
backed by Volcengine 大模型流式语音识别 (`sauc/bigmodel`), while keeping the
backend `SpeechProvider` abstraction **provider-neutral** so additional vendors
(阿里 / 腾讯 / Whisper / …) can be added later without touching the extension.
Switching is at **provider granularity** (pick a vendor via env); there is no
per-model switch inside a vendor for now.

## Core Principle — a provider-neutral "narrow waist"

The browser must not adopt any single vendor's wire format. Instead the
extension produces one **canonical audio representation**, and each backend
per-provider adapter converts that canonical format into the vendor's protocol.

```
Extension (capture)            ── narrow waist ──            Backend (per-provider adapter)
tabCapture 48k stereo   →   PCM 16k / 16-bit / mono   →   Volcengine adapter → Volcengine WS
                            (provider-neutral)              (future) Aliyun adapter → …
                                                            (future) Whisper adapter → …
```

**Canonical format: 16 kHz, 16-bit signed little-endian, mono PCM (`pcm_s16le`).**
This is the de-facto input for essentially all streaming ASR engines. It is also
**exactly** what Volcengine `bigmodel` expects (`format:"pcm", codec:"raw",
sample_rate:16000, bits:16, channel:1`), so the first adapter needs *zero*
resampling — only framing + gzip.

### Why this replaces the current pipeline

The extension currently captures with `MediaRecorder` → `audio/webm` (Opus)
chunks every 250 ms. Those chunks are **not independently decodable** (only the
first chunk carries the WebM init segment), so they cannot be fed to a real ASR
engine. PCM via `AudioWorklet` is simultaneously the most portable, the
lowest-latency (no Opus encode / WebM mux / chunk buffering), and the most
vendor-neutral choice. Bandwidth cost (~8× Opus) is irrelevant over the
`127.0.0.1` loopback.

## Placement of responsibilities

| Concern | Location | Rationale |
|---|---|---|
| Audio capture | Extension offscreen | Only context that can run `getUserMedia` / `tabCapture`. |
| Capture → canonical PCM | Extension offscreen | Convert at the source → backend stays free of audio-decode deps; lower latency. |
| Provider adapter (auth, vendor wire protocol, credentials) | Backend | Secrets live only in backend env (project rule); vendor protocols change → backend updates without re-publishing the extension; `SpeechProvider` already lives here. |

## Decomposition — one spec, two implementation plans

The work is two coupled halves joined by the canonical-PCM contract. Designed
together (one spec) so the contract fits both sides; implemented as two plans in
sequence, each producing working, tested software on its own.

### Half A — Extension produces canonical PCM (`apps/extension` + `packages/protocol`)

- Replace `MediaRecorder`/webm in `OffscreenAudioPipeline` with an
  **AudioWorklet** that taps the tab-capture stream, downsamples 48k→16k,
  downmixes stereo→mono, converts Float32→Int16LE, and emits ~100 ms PCM frames.
- Keep the existing `source → destination` connection so original tab audio
  still plays; PCM extraction is a parallel tap on the same source node.
- The `start` `ClientMessage` gains a self-describing **audio format descriptor**
  `{ codec: "pcm_s16le", sampleRate: 16000, channels: 1 }`. This is a
  `@echoflow/protocol` **contract change** → update the runtime type guard and
  its `.test.ts` in the same change.
- The **fake provider keeps working** with PCM frames, so Half A is shippable and
  verifiable end-to-end (fake ASR) before any Volcengine work.

### Half B — Backend Volcengine ASR adapter (`apps/backend`)

A real `SpeechProvider` implementing the verified Volcengine binary protocol,
plugged into `createSpeechProvider`, with an injectable transport seam so unit
tests run with no network and no credentials.

## Verified Volcengine `sauc/bigmodel` protocol

Sources: <https://www.volcengine.com/docs/6561/1354869>, reference implementation
<https://github.com/OpenBMB/UltraEval-Audio/blob/main/audio_evals/lib/doubao/stream_asr.py>.

- **Endpoint:** `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel`
  (bidirectional streaming — low-latency partials, correct for live subtitles).
  Not `…/bigmodel_nostream` (batched, higher accuracy, wrong latency profile).
- **Auth — WS handshake headers:**
  - `X-Api-App-Key` — appid
  - `X-Api-Access-Key` — access token
  - `X-Api-Resource-Id` — `volc.bigasr.sauc.duration`
  - `X-Api-Request-Id` — uuid v4
- **Binary framing** — 4-byte header followed by payload:
  - byte 0: `(PROTOCOL_VERSION=0b0001 << 4) | header_size=0b0001`
  - byte 1: `(message_type << 4) | message_type_specific_flags`
  - byte 2: `(serialization << 4) | compression`
  - byte 3: reserved `0x00`
  - Message types: `FULL_CLIENT_REQUEST=0b0001`, `AUDIO_ONLY_REQUEST=0b0010`,
    `FULL_SERVER_RESPONSE=0b1001`, `SERVER_ACK=0b1011`, `SERVER_ERROR_RESPONSE=0b1111`.
  - Flags: `NO_SEQUENCE=0b0000`, `POS_SEQUENCE=0b0001`, `NEG_WITH_SEQUENCE=0b0011` (last packet).
  - Serialization: `JSON=0b0001`. Compression: `GZIP=0b0001`.
  - Payload layout: `sequence (4-byte big-endian signed)` + `payload_size (4-byte big-endian)` + `gzip( JSON | PCM )`.
- **Full client request** (first message): header with `POS_SEQUENCE`, `seq=1`,
  then gzipped config JSON:

  ```json
  {
    "user": { "uid": "echoflow" },
    "audio": { "format": "pcm", "sample_rate": 16000, "bits": 16, "channel": 1, "codec": "raw" },
    "request": { "model_name": "bigmodel", "enable_punc": true }
  }
  ```

- **Audio-only request** (each PCM frame): header `AUDIO_ONLY_REQUEST` +
  `POS_SEQUENCE`; `seq` increments per frame. The final frame uses
  `NEG_WITH_SEQUENCE` and a **negated** seq to signal end-of-stream.
- **Server response:** `FULL_SERVER_RESPONSE` payload is gzipped JSON containing
  `result.text` (cumulative transcript) and `result.utterances[]`, where each
  utterance has `text`, `definite` (boolean; `true` = finalized), `start_time`,
  `end_time` (ms). `SERVER_ERROR_RESPONSE` carries a 4-byte error code + message.

### The central adapter challenge: cumulative → incremental

Volcengine streams **cumulative** state (the whole transcript + a re-sent
utterances array each packet). Our `SpeechProvider` contract emits **incremental**
`partial`/`final` events per `segmentId`. The adapter must hold the last-seen
utterances and:

- emit a `partial` while an utterance is `definite:false`,
- emit **exactly one** `final` when an utterance flips to `definite:true`,
- never re-emit a finalized utterance.

## Backend adapter components

Four small, single-responsibility units (pure logic isolated from I/O):

### 1. `apps/backend/src/providers/volcengineAsrProtocol.ts` — pure wire codec

- `encodeFullClientRequest(config): Uint8Array` — header + `seq=1` + size + `gzip(json(config))`.
- `encodeAudioRequest(pcm, seq, isLast): Uint8Array` — header
  (`AUDIO_ONLY_REQUEST`; `NEG_WITH_SEQUENCE` when `isLast`) + seq (negated when
  `isLast`) + size + `gzip(pcm)`.
- `parseServerMessage(bytes): { type, seq, isLast, payload?, errorCode?, errorMessage? }`
  — header parse + gunzip + JSON.
- The only place that knows the 4-byte framing. Byte-for-byte unit-testable.

### 2. `VolcengineAsrTransport` — injectable transport seam

- Interface: `{ send(bytes: Uint8Array): void; close(): void }`, created by a
  `connect(endpoint, headers, callbacks)` factory where
  `callbacks = { onMessage(bytes), onClose(code, reason), onError(err) }`.
- Default implementation wraps the `ws` package (a Node WebSocket **client**;
  `@fastify/websocket` is server-side only, and `ws` is already a transitive
  dependency — promote it to a direct dependency). Custom handshake headers are
  set here.
- A scripted fake implementation lets `volcengineSpeechProvider.test.ts` run with
  **no network and no credentials** — the same seam pattern as the injectable
  `fetchImpl` in `volcengineTranslationProvider.ts`.

### 3. `apps/backend/src/providers/utteranceReconciler.ts` — pure state machine

- Holds last-seen utterances keyed by index; `reconcile(utterances[]): SegmentEvent[]`.
- Non-`definite` utterance → `partial`; first flip to `definite` → exactly one
  `final`; never re-emits a finalized index.
- Assigns a stable `segmentId` per utterance index and maps `start_time` /
  `end_time` → `startTimeMs` / `endTimeMs`.
- Pure → tested with hand-crafted utterance sequences. The bug-prone logic, fully
  isolated.

### 4. `apps/backend/src/providers/volcengineSpeechProvider.ts` — the `SpeechProvider`

Wires transport + codec + reconciler:

- `open({ onSegment, onError })`: `connect` → send full client request → return
  `{ pushFrame, end, close }`.
- `pushFrame(frame)`: `encodeAudioRequest` → `transport.send` (incrementing `seq`).
- On transport message: `parseServerMessage` → emit the one-time `language` event
  (from the response if a language field is present, else `"auto"`) →
  `reconciler.reconcile` → `onSegment` for each event.
- `end()`: send the final packet (`isLast`, negated seq); resolve when the last
  server response / close arrives. `close()`: `transport.close()`.

## Contract changes

- `packages/protocol` — `start` `ClientMessage` gains
  `audioFormat: { codec: "pcm_s16le"; sampleRate: number; channels: number }`.
  Update `isClientMessage` and its `.test.ts` in the same change.
- `apps/backend/src/providers/types.ts` — `SpeechProvider.open` opts gain an
  optional `onError(err: Error): void` (backward-compatible; the fake ignores it).

## Error handling

- The adapter routes to `onError`: WS handshake failure (bad creds → 401 on
  upgrade), `SERVER_ERROR_RESPONSE` (code + message), unexpected mid-session
  close, gzip/JSON parse failure.
- `RealtimeSession` wires `onError` → emits the existing protocol `error`
  `ServerEvent` → ends the session.
- **Two distinct WS connections — do not conflate:** the backend↔Volcengine WS is
  separate from the extension↔backend WS. A Volcengine failure surfaces as an
  `error` `ServerEvent` to the extension; it does **not** trigger the extension's
  Spec-2 reconnect (that path is only for extension↔backend).
- **No auto-reconnect to Volcengine** in this spec (YAGNI): surface the error, end
  the session, user re-triggers. Future work.

## Config / env (backend only)

- New env vars:
  - `VOLCENGINE_ASR_APP_KEY` — `X-Api-App-Key` (appid).
  - `VOLCENGINE_ASR_ACCESS_KEY` — `X-Api-Access-Key`.
  - `VOLCENGINE_ASR_RESOURCE_ID` — default `volc.bigasr.sauc.duration`.
  - `VOLCENGINE_ASR_ENDPOINT` — default `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel`.
  - `model_name` is hardcoded `"bigmodel"` (provider-level switching only).
- `providerConfig.ts`: add `VolcengineAsrConfig { appKey, accessKey, resourceId, endpoint }`;
  extend `AsrProviderConfig` with optional `volcengine?: VolcengineAsrConfig`.
- `config.ts`: when `asrProvider === "volcengine"`, populate `config.asr.volcengine`
  from env (mirroring the existing translation block).
- `providerFactory.ts`: `createSpeechProvider` validates `appKey` / `accessKey`
  are present (throws a clear message, like the translation adapter) then
  constructs `VolcengineSpeechProvider`.
- Docs: README + CLAUDE.md + `.env.example`. **Call out that ASR creds
  (appid + access key) are different from the translation `VOLCENGINE_API_KEY`.**

## Testing strategy

### Hermetic unit tests (default `pnpm test`, no network/creds)

- `volcengineAsrProtocol.test.ts` — byte-exact encode/parse round-trips (header
  bits, gzip, seq, last-packet negation).
- `utteranceReconciler.test.ts` — crafted cumulative sequences → expected
  partial/final; no re-emit of finalized; timestamp mapping.
- `volcengineSpeechProvider.test.ts` — scripted fake transport drives
  open → pushFrame → server-response → onSegment, error-response → onError,
  end → last-packet.
- `config` + `providerFactory` tests — env → config wiring; missing creds throws.
- protocol guard test for the new `audioFormat` descriptor.
- Extension Half A: isolate the pure DSP function
  `resampleToPcm16(float32, inRate, outRate)` and test downsample + downmix +
  Int16 conversion on synthetic Float32 buffers. (The AudioWorklet shell is
  covered by e2e, consistent with the existing entrypoints/e2e split.)

### Real end-to-end (manual, opt-in, gated on creds)

- `scripts/volcengine-asr-smoke.ts` — streams a bundled short speech PCM/WAV
  fixture through the real provider and prints recognized text. Skipped
  automatically when creds are absent, so CI stays hermetic.
- Browser manual test — play a video, observe real bilingual subtitles.

## Out of scope (future work)

- Per-model switching inside a vendor.
- Auto-reconnect from backend to Volcengine.
- Additional vendor adapters (阿里 / 腾讯 / Whisper).
- `bigmodel_nostream` high-accuracy batched mode.
