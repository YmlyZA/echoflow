# AST (豆包同声传译 / Seed LiveInterpret 2.0) Wire Reference

> **Authoritative source for all vendor wire specifics in Cycle 2 (interpret mode).**
> Where any task's inferred constant or boundary trigger conflicts with this doc, **this doc wins.**

**Status:** Grounded from three authoritative sources (no live capture required for the static schema):

1. **Vendor `.proto` schema** — `protobuf/protos.tar.gz`, downloaded from doc
   [6561/1756902](https://www.volcengine.com/docs/6561/1756902) ("同声传译2.0-API接入文档"),
   extracted to `protobuf/` (gitignored). Files: `common/events.proto`, `common/rpcmeta.proto`,
   `products/understanding/ast/ast_service.proto`, `products/understanding/base/au_base.proto`.
   This is the **exhaustive** field-number + event-id source.
2. **Decoded binary-frame example** from the sibling realtime-dialogue doc
   ([6561/1594356](https://www.volcengine.com/docs/6561/1594356)) — reveals the shared
   *event-protocol frame envelope* (same family as AST).
3. **`volcengine-audio` PyPI package** (official bigmodel binary-protocol constants) — pins the
   serialization/compression/message-type nibble values.

**Items marked `[confirm @ e2e]`** are high-confidence but only *runtime* behaviour (not in the
schema); confirm during the Task 9 real session and amend here if reality differs.

---

## 1. Connection & auth

- **Endpoint:** `wss://openspeech.bytedance.com/api/v4/ast/v2/translate`
- **Resource-Id:** `volc.service_type.10053` (AST is a **separate subscription** from ASR)
- **Auth headers** (new-console scheme — a single API Key, *not* the ASR adapter's app-id/access-key pair):
  - `X-Api-Key: <VOLCENGINE_AST_API_KEY>`
  - `X-Api-Resource-Id: volc.service_type.10053`
  - `X-Api-Request-Id: <uuid>` (per connection; tracing only)
  - On handshake the server returns `X-Tt-Logid` — capture/log it to correlate issues with Volcengine.
  - (Legacy old-console scheme used `X-Api-App-Id` + `X-Api-Access-Key`; we target the new console.)
- After `FinishSession`, the WS connection is **not** closed by the server and may be reused with a
  fresh `StartSession`. (We open one session per connection and close the socket; reuse is out of scope.)

---

## 2. Binary frame layout (event protocol)

This is the **event-based** variant of the Volcengine bigmodel binary protocol (NOT the
sequence-based variant the ASR adapter uses). Every frame carries an **event id** and a
length-prefixed **session id** between the header and the payload.

### 2.1 Header — 4 bytes

| Byte | Bits | Meaning | Value |
|---|---|---|---|
| 0 | `(version<<4) \| headerSize` | version=`0b0001`, headerSize=`0b0001` (×4 = 4 bytes) | `0x11` |
| 1 | `(messageType<<4) \| flags` | flags = `0b0100` = **MsgTypeFlagWithEvent** | see below |
| 2 | `(serialization<<4) \| compression` | | see below |
| 3 | reserved | | `0x00` |

**Message types** (high nibble of byte 1):

| Name | Value |
|---|---|
| `FULL_CLIENT_REQUEST` | `0b0001` |
| `AUDIO_ONLY_REQUEST` | `0b0010` |
| `FULL_SERVER_RESPONSE` | `0b1001` |
| `AUDIO_ONLY_RESPONSE` | `0b1011` |
| `ERROR_INFORMATION` | `0b1111` |

**Message-type-specific flags** (low nibble of byte 1): AST uses `0b0100` (**WITH_EVENT**) on
every frame. (Other family variants use `0b0001` pos-sequence / `0b0011` neg-sequence; AST does not.)

**Serialization** (high nibble of byte 2):

| Name | Value |
|---|---|
| `RAW` (no serialization) | `0b0000` |
| `JSON` | `0b0001` |
| **`PROTOBUF`** | **`0b0010`** |
| `THRIFT` | `0b0011` |

**Compression** (low nibble of byte 2): `NONE = 0b0000`, `GZIP = 0b0001`. **AST uses `NONE`.** `[confirm @ e2e]`

→ **Control/full frames** (StartSession, FinishSession, all server subtitle/usage/error frames):
byte 2 = `(PROTOBUF<<4) | NONE` = **`0x20`**.
→ **Audio frames** (TaskRequest, raw PCM bytes, no protobuf): byte 2 = `(RAW<<4) | NONE` = **`0x00`**.

### 2.2 Body — after the 4-byte header

```
header[4]
  event           : int32  BE  (4 bytes)   // events.proto Type enum value
  sessionIdLen    : uint32 BE  (4 bytes)
  sessionId       : bytes (UTF-8, length = sessionIdLen)   // our connection UUID
  payloadLen      : uint32 BE  (4 bytes)
  payload         : bytes (length = payloadLen)            // protobuf, or raw PCM for audio
```

Both directions use this same envelope (the server frame also carries `event` + `sessionId`). `[confirm @ e2e: server-side sessionId presence/position]`

### 2.3 Worked example (decoded from the doc's byte array)

The realtime-dialogue StartSession example (JSON variant, but identical envelope):

```
17 14 10 00 | 00 00 00 64 | 00 00 00 24 | "75a6126e-427f-49a1-a2c1-621143cb9db3" | 00 00 00 3c | <60-byte payload>
^header      ^event=100     ^sidLen=36     ^36-byte session UUID                    ^payloadLen=60
0x11 0x14 0x10 0x00
  └ ver1/hsize1  └ FULL_CLIENT(0b0001)<<4 | WITH_EVENT(0b0100)  └ JSON(0b0001)<<4|NONE  └ reserved
```

For **AST** the only envelope difference is byte 2 → `0x20` (PROTOBUF instead of JSON), and the
payload is a `TranslateRequest`/`TranslateResponse` protobuf message instead of JSON.

---

## 3. Protobuf field numbers (from the vendor `.proto`)

### 3.1 `events.proto` — `data.speech.event.Type` (the `event` int32)

**Outbound (client→server):**

| Event | Value |
|---|---|
| `StartSession` | **100** |
| `CancelSession` | 101 |
| `FinishSession` | **102** |
| `TaskRequest` (audio) | **200** |

**Inbound (server→client):**

| Event | Value |
|---|---|
| `SessionStarted` | 150 |
| `SessionCanceled` | 151 |
| `SessionFinished` | 152 |
| `SessionFailed` | **153** |
| `UsageResponse` (`ChargeData`) | **154** |
| `SourceSubtitleStart` | 650 |
| `SourceSubtitleResponse` | **651** |
| `SourceSubtitleEnd` | **652** |
| `TranslationSubtitleStart` | 653 |
| `TranslationSubtitleResponse` | **654** |
| `TranslationSubtitleEnd` | **655** |

> Also present but unused by us: `ConnectionStarted=50`, `ConnectionFailed=51`, TTS 300–362,
> ASR 450–459, chat 500–566.

### 3.2 `ast_service.proto` (`package data.speech.ast`)

**`TranslateRequest`** (the StartSession / TaskRequest payload):

| Field | # | Wire type | Notes |
|---|---|---|---|
| `request_meta` (`common.RequestMeta`) | 1 | len-delim (msg) | optional; auth is via headers, so we omit |
| `event` (`event.Type`) | 2 | varint | mirror the frame's event id |
| `user` (`understanding.User`) | 3 | len-delim (msg) | optional |
| `source_audio` (`understanding.Audio`) | 4 | len-delim (msg) | audio format params |
| `target_audio` (`understanding.Audio`) | 5 | len-delim (msg) | s2s only — omit for s2t |
| `request` (`ReqParams`) | 6 | len-delim (msg) | mode + languages |
| `denoise` | 7 | varint (bool) | optional |
| `enable_speaker_info` | 9 | varint (bool) | optional |

**`ReqParams`** (the AST-specific one, field 6 above):

| Field | # | Wire type | Notes |
|---|---|---|---|
| `mode` | 1 | string | **`"s2t"`** (subtitles only; `"s2s"` adds TTS — out of scope) |
| `source_language` | 2 | string | **empty/`"auto"` → auto-detect.** (No separate detect flag exists.) |
| `target_language` | 3 | string | AST code: `zh` or `en` |
| `speaker_id` | 4 | string | unused |
| `corpus` (`understanding.Corpus`) | 100 | len-delim | unused |

**`TranslateResponse`** (every inbound subtitle/usage/session frame):

| Field | # | Wire type | Notes |
|---|---|---|---|
| `response_meta` (`common.ResponseMeta`) | 1 | len-delim (msg) | status/billing |
| `event` (`event.Type`) | 2 | varint | duplicate of frame event id |
| `data` | 3 | bytes | binary (s2s audio) — empty for s2t |
| **`text`** | **4** | **string** | **the subtitle text (source OR translation)** ← reconciler reads this |
| `start_time` | 5 | int32 (varint) | ms |
| `end_time` | 6 | int32 (varint) | ms |
| `spk_chg` | 7 | bool | speaker change |
| `muted_duration_ms` | 8 | int32 | |
| `speaker_id` | 9 | string | |

> **⚠ Correction to the plan's placeholder:** `subtitleText` is **field 4**, not field 1.

### 3.3 `au_base.proto` — `understanding.Audio` (the `source_audio` sub-message)

| Field | # | Wire type | Our value |
|---|---|---|---|
| `data` | 1 | string | — |
| `format` | 4 | string | `"pcm"` |
| `codec` | 5 | string | (omit / `"raw"`) |
| `rate` | 7 | int32 | `16000` |
| `bits` | 8 | int32 | `16` |
| `channel` | 9 | int32 | `1` |
| `binary_data` | 14 | bytes | (streaming audio goes in the TaskRequest frame payload, not here) |

> **⚠ Correction to the plan's placeholder:** Audio sub-fields are `format=4, rate=7, bits=8,
> channel=9` — NOT 1/2/3/4.

### 3.4 `rpcmeta.proto` — `common.ResponseMeta` (status/error on inbound frames)

| Field | # | Wire type | Notes |
|---|---|---|---|
| `SessionID` | 1 | string | |
| `Sequence` | 2 | int32 | |
| `StatusCode` | 3 | int32 | **error code on `SessionFailed`** |
| `Message` | 4 | string | **error message on `SessionFailed`** |
| `Billing` | 5 | len-delim (msg) | on `UsageResponse` |

> **⚠ Correction to the plan's placeholder:** the error code/message are NOT top-level protobuf
> fields 1/2 — they live in `TranslateResponse.response_meta` (field 1) → `ResponseMeta.StatusCode`
> (field 3) / `ResponseMeta.Message` (field 4). The codec must descend one level. The simplest robust
> approach: on `SessionFailed (153)`, read `response_meta` (field 1) as a nested message and pull
> `StatusCode`/`Message`. `[confirm @ e2e]`

### 3.5 Error codes — `au_base.proto` `understanding.Code` enum

| Name | Value |
|---|---|
| `SUCCESS` | 21000 |
| `INVALID_REQUEST` | 11100 |
| `LONG_AUDIO` | 11101 |
| `LARGE_PACKET` | 11102 |
| `INVALID_FORMAT` | 11103 |
| `SILENT_AUDIO` | 11104 |
| `EMPTY_AUDIO` | 11105 |
| `PERMISSION_DENIED` | 11200 |
| `LIMIT_QPS` | 11301 |
| `LIMIT_COUNT` | 11302 |
| `SERVER_BUSY` | 11303 |
| `ERROR_PARAMS` | 11500 |
| `TIMEOUT_WAITING` | 21200 |
| `TIMEOUT_PROCESSING` | 21201 |
| `ERROR_PROCESSING` | 21100 |
| `ERROR_UNKNOWN` | 29900 |

> These are the gateway/business codes. (The user-facing error-code research earlier referenced
> `45000xxx`-style gateway codes — those are HTTP/gateway-layer; the in-band protobuf `StatusCode`
> uses this `Code` enum. `[confirm @ e2e]`)

---

## 4. Outbound frame assembly (what our codec sends)

### `encodeStartSession` — event 100

- Header: `0x11 0x14 0x20 0x00` (FULL_CLIENT | WITH_EVENT, PROTOBUF/NONE)
- event = `100`, sessionId = our UUID
- payload = `TranslateRequest`:
  - `event` (2) = `100`
  - `source_audio` (4) = `Audio { format(4)="pcm", rate(7)=16000, bits(8)=16, channel(9)=1 }`
  - `request` (6) = `ReqParams { mode(1)="s2t", source_language(2)="" /*auto*/, target_language(3)=<zh|en> }`

### `encodeAudioRequest(audio)` — event 200

- Header: `0x11 0x24 0x00 0x00` (AUDIO_ONLY | WITH_EVENT, RAW/NONE) `[confirm @ e2e: AUDIO_ONLY vs FULL_CLIENT-wrapping]`
- event = `200`, sessionId = our UUID
- payload = **raw PCM bytes** (16 kHz/16-bit/mono, ~80 ms packets), no protobuf wrapper

### `encodeFinishSession()` — event 102

- Header: `0x11 0x14 0x20 0x00`
- event = `102`, sessionId = our UUID
- payload = empty (or a `TranslateRequest { event:102 }`) `[confirm @ e2e]`

---

## 5. Inbound parsing & segment-boundary semantics (CRITICAL for the reconciler)

Parse: header → `event` (int32 BE @ offset 4) → `sessionIdLen` (uint32 @ 8) → skip sessionId →
`payloadLen` (uint32) → payload. Decode payload as `TranslateResponse`; read `text` (field 4).

**Per-utterance lifecycle** (each spoken sentence):

```
SourceSubtitleStart(650)      → source line begins
SourceSubtitleResponse(651)*  → revising source text   (CUMULATIVE full line, not a delta) [confirm @ e2e]
SourceSubtitleEnd(652)        → source line finalized
TranslationSubtitleStart(653) → translation begins
TranslationSubtitleResponse(654)* → revising translation (cumulative) [confirm @ e2e]
TranslationSubtitleEnd(655)   → translation finalized   ← our render boundary
```

- **`text` is the full line so far (cumulative), not an incremental delta.** Each Response replaces the
  prior partial. `[confirm @ e2e]`
- **Source↔translation correlation is by ORDER** (the per-utterance source cycle precedes its
  translation cycle). `TranslateResponse` carries **no segment-id field** to join on; `start_time`/
  `end_time` (5/6) can corroborate but ordering is the primary key. `[confirm @ e2e]`
- **Detected source language is NOT in the subtitle payload.** `TranslateResponse` has no `language`
  field. → the source emits `sourceLanguage: "auto"`. (If `SessionStarted(150)` turns out to carry a
  detected language, amend here.) `[confirm @ e2e]`

**Mapping to our `AstServerEvent` → reconciler (matches the plan's model):**

| Inbound event | `AstServerEvent` | Reconciler action |
|---|---|---|
| 651 `SourceSubtitleResponse` | `{kind:"source", text, final:false}` | emit `partial` (live source line) |
| 652 `SourceSubtitleEnd` | `{kind:"source", text, final:true}` | buffer source; **no** boundary |
| 654 `TranslationSubtitleResponse` | `{kind:"translation", text, final:false}` | buffer; no emit |
| 655 `TranslationSubtitleEnd` | `{kind:"translation", text, final:true}` | emit `final` (source + translation), advance ordinal |
| 154 `UsageResponse` | `{kind:"usage"}` | ignore |
| 153 `SessionFailed` | `{kind:"error", code, message}` | surface error |
| 650/653/150/152 | `{kind:"other"}` | ignore |

This yields the intended UX: **source live (651 → partial), translation a beat later
(655 → final)** — no protocol change, exactly the Cycle 2 wire-mapping decision.

---

## 6. Open items to confirm at Task 9 (real session)

1. Compression really `NONE` (not gzip) for protobuf payloads.
2. Audio frames are `AUDIO_ONLY_REQUEST` + raw PCM (vs. a `TranslateRequest` wrapping `binary_data`).
3. Server frame envelope includes `sessionId` at the same offset (symmetric with client).
4. `text` in Response frames is cumulative (replace) vs. delta (append).
5. `SessionFailed` error code/message live in `response_meta` → `StatusCode`/`Message`.
6. Whether any inbound frame (e.g. `SessionStarted`) reports the detected source language.
7. Observed end-to-end latency (expected ~2–3 s for s2t).
8. That `start_time` (field 5) / `end_time` (field 6) on the subtitle frames carry meaningful
   utterance-relative ms. **The codec now parses these and the reconciler emits them on the `final`**
   (so interpret-mode history timestamps work); the *values* still need a real session to confirm
   they aren't always 0 / aren't in some other unit.

If any differs, amend the relevant section above and adjust `astConstants.ts` / the codec — **this
reference remains authoritative.**
