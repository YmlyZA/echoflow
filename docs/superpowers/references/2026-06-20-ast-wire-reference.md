# AST (豆包同声传译 / Seed LiveInterpret 2.0) Wire Reference

> **Authoritative source for all vendor wire specifics in Cycle 2 (interpret mode).**
> Where any task's inferred constant or boundary trigger conflicts with this doc, **this doc wins.**

> **✅ VALIDATED & CORRECTED at live e2e (2026-06-22).** A real AST session
> (`scripts/volcengine-ast-smoke.ts`) proved the **frame envelope derived from sources 2+3 was WRONG**:
> `/api/v4/ast/v2/translate` is a **gRPC `ASTService.Translate` stream over WebSocket** that exchanges
> **bare serialized protobuf** messages (one `TranslateRequest`/`TranslateResponse` per ws binary
> message) — there is **no 4-byte header, no event-int32, no sessionId-length envelope**. The protobuf
> **schema (field numbers, event ids) from source 1 was correct.** §2, §4, §5 below are the corrected,
> e2e-confirmed protocol; the original envelope derivation is struck through for the record.

**Status:** Schema grounded from three sources; **framing + runtime behaviour confirmed by live e2e**:

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

## 2. Frame layout — bare protobuf (e2e-confirmed)

**Each WebSocket binary message is exactly ONE serialized protobuf message** — `TranslateRequest`
upstream, `TranslateResponse` downstream. There is **no binary header, no event-int32 prefix, and no
sessionId-length envelope.** The event id and session id are **protobuf fields** (`event` = field 2;
`SessionID` = `request_meta`/`response_meta` field 6). The ws frame itself delimits the message.

How we know: the live server returned a bare `TranslateResponse` (`0a …` = field 1 `response_meta`,
decodes cleanly from byte 0), and rejected our original enveloped frame with
`"unmarshal payload: proto unmarshal: proto: cannot parse"` — i.e. it tried to unmarshal the whole ws
message directly as protobuf and choked on the `0x11`-header bytes.

```
ws binary message  ==  serialize(TranslateRequest)     // client → server
ws binary message  ==  serialize(TranslateResponse)    // server → client
```

> <details><summary>❌ Original (WRONG) envelope derivation — kept for the record</summary>
>
> Derived from the bigmodel *event-protocol* family (sources 2+3): a 4-byte header
> `0x11 (msgType<<4|0x04) (ser<<4|0x00) 0x00`, then `event:int32BE | sidLen:uint32BE | sid | payloadLen:uint32BE | payload`.
> **This is a DIFFERENT protocol** (realtime-dialogue / sauc bigmodel), not AST v2. AST v2 uses plain
> gRPC-over-WS protobuf. The header/serialization/message-type nibbles do **not** apply here.
> </details>

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
| `request_meta` (`common.RequestMeta`) | 1 | len-delim (msg) | **REQUIRED** — carries `SessionID` (6) for WS multiplexing; we also set `ResourceID` (4). e2e: session fails to start without it |
| `event` (`event.Type`) | 2 | varint | the event id (100/102/200) — there is no separate header event |
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
| `source_language` | 2 | string | **MUST be explicit** (`"en"`/`"zh"`). ⚠ e2e: empty source → `langPair:"2zh"` → `InvalidData ... not found`. **Auto-detect is NOT supported by `model:default`.** We send the EN↔ZH counterpart of the target. |
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

> ⚠ **e2e correction:** the in-band `ResponseMeta.StatusCode` does **NOT** use this `Code` enum — it
> carries **8-digit gateway codes**. Observed live:
> - `20000000` + `"OK"` → success (on `SessionStarted`, subtitle frames). **This, not `21000`, is the success code.**
> - `45000000` + `"unmarshal payload…"` / `45000001` + `"[Invalid argument] InvalidData…"` → client error.
> - Pattern: `2xxxxxxx` = success, `4xxxxxxx` = client error, `5xxxxxxx` = server error.
>
> The codec's `isAstOkStatus` treats `0`, `21000`, and the whole `[20000000, 30000000)` range as
> non-errors; everything else surfaces as `{kind:"error"}`. The `Code` enum above (21000/11xxx) is the
> *backend service* layer and may appear nested, but the gateway codes are what reach us.

---

## 4. Outbound frame assembly (what our codec sends) — bare `TranslateRequest` protobuf

No header on any frame. Each is one serialized `TranslateRequest`. `SessionID` is the same UUID for
the whole connection, set in `request_meta` on **every** frame.

### `encodeStartSession` — event 100

```
TranslateRequest {
  request_meta (1) = RequestMeta { ResourceID(4)="volc.service_type.10053", SessionID(6)=<uuid> }
  event        (2) = 100
  source_audio (4) = Audio { format(4)="pcm", rate(7)=16000, bits(8)=16, channel(9)=1 }
  request      (6) = ReqParams { mode(1)="s2t", source_language(2)=<en|zh>, target_language(3)=<zh|en> }
}
```

### `encodeAudioRequest(pcm)` — event 200

```
TranslateRequest {
  request_meta (1) = RequestMeta { SessionID(6)=<uuid> }
  event        (2) = 200            // TaskRequest
  source_audio (4) = Audio { binary_data(14) = <raw 16k/16-bit/mono PCM chunk> }
}
```

⚠ Audio rides in `source_audio.binary_data` (field 14, bytes) — **not** a raw-PCM frame payload.

### `encodeFinishSession()` — event 102

```
TranslateRequest {
  request_meta (1) = RequestMeta { SessionID(6)=<uuid> }
  event        (2) = 102
}
```

---

## 5. Inbound parsing & segment-boundary semantics (CRITICAL for the reconciler)

Parse: decode the whole ws message as a `TranslateResponse`; read `event` (field 2), and
`response_meta` (field 1) for status. Read subtitle `text` (4), `start_time` (5), `end_time` (6).

**Per-utterance lifecycle** (each spoken sentence) — confirmed live:

```
SourceSubtitleStart(650)          → source line begins
SourceSubtitleResponse(651)*      → DELTA fragments: "Hello" · "." · " "   (ts = 0)
SourceSubtitleEnd(652)            → CUMULATIVE line "Hello. " + REAL ts [20..340]
TranslationSubtitleStart(653)     → translation begins
TranslationSubtitleResponse(654)* → DELTA fragments: "你" · "好" · "。"      (ts = 0)
TranslationSubtitleEnd(655)       → CUMULATIVE "你好。" + REAL ts [20..340]   ← our render boundary
```

- ⚠ **MIXED delta/cumulative (the load-bearing finding):** non-final Responses (651/654) are
  **DELTA fragments**; the End frames (652/655) carry the **CUMULATIVE** full line. The reconciler
  **accumulates** 651 deltas for live partials, then overwrites with the 652 cumulative line.
- ⚠ **Timestamps live only on the End frames.** 651/654 report `start_time=end_time=0`; 652/655 carry
  the real utterance-relative ms (observed `[20..340]`, `[820..2740]`, `[3220..5620]`). The reconciler
  captures bounds from the source-End (652) and emits them on the `final`.
- **Source↔translation correlation is by ORDER** (source cycle precedes its translation cycle); no
  segment-id field. Confirmed: `start_time`/`end_time` match between the paired 652 and 655.
- **Detected source language is NOT reported** — `TranslateResponse` has no `language` field, and since
  the source must be sent explicitly anyway, the adapter emits the known source code (the target's
  EN↔ZH counterpart), not `"auto"`.

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

## 6. Resolved at live e2e (2026-06-22)

All items below were confirmed (or corrected) by `scripts/volcengine-ast-smoke.ts` against the real endpoint:

1. ~~Compression `NONE`~~ — **N/A.** No binary header exists; framing is bare protobuf (§2).
2. ~~Audio = `AUDIO_ONLY_REQUEST` + raw PCM~~ — **CORRECTED.** Audio is a `TranslateRequest` with the PCM
   in `source_audio.binary_data` (field 14). No raw-PCM frame.
3. ~~Server sessionId at symmetric offset~~ — **N/A.** Session id is a protobuf field (`response_meta.SessionID`), not an envelope field.
4. **`text` cumulative vs delta — RESOLVED (mixed):** non-final 651/654 = **delta**, final 652/655 =
   **cumulative**. Reconciler accumulates deltas, finalizes on the cumulative End frame (§5).
5. **Error in `response_meta` — CONFIRMED**, but the code is an **8-digit gateway code**, not the `Code`
   enum, and errors can arrive with `event=0` (None). See §3.5.
6. **Detected source language — RESOLVED:** not reported, and **auto-detect is unsupported** (§3.2). The
   adapter sends an explicit source (target's EN↔ZH counterpart) and emits that as `sourceLanguage`.
7. **Latency — measured:** ~0.85 s from speech to paired `final` for a short utterance; partials track
   within ~1 s. Well under the expected 2–3 s.
8. **`start_time`/`end_time` — CONFIRMED meaningful** (utterance-relative ms, on the End frames only):
   `[20..340]`, `[820..2740]`, `[3220..5620]` across three sentences. Reconciler emits them on `final`.

**New product-level finding:** AST interpret only works for an explicit, known source language. With
Cycle 2's zh/en-constrained targets this is fine (source = the counterpart), but it is **not**
arbitrary-language auto-detect — content whose spoken language isn't the target's counterpart will
mistranslate. Broader source selection is future work.

This reference is now e2e-accurate. If the vendor protocol changes, amend the relevant section and
adjust `astConstants.ts` / the codec — **this reference remains authoritative.**
