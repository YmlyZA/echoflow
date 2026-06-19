# Interpretation Subtitle Mode (Cycle 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the paid `interpret` mode — a real-time bilingual subtitle engine (火山引擎 豆包同声传译 / AST) — behind the Cycle 1 entitlement gate, so the existing toggle flips `interpret` from "unavailable" to working (~2–3 s) when AST credentials are configured.

**Architecture:** A new `InterpretationSubtitleSource` (implementing the Cycle 1 `SubtitleSource` seam) streams 16 kHz/16-bit/mono PCM to AST over a protobuf WebSocket, receives AST's live source + translation streams, and a reconciler maps them onto the existing wire model: AST source updates → `partial` (live source line), AST translation finalize → `final` (source + translation). The wire `ServerEvent`/overlay/reducer are unchanged; the thin session gains one additive error branch. A `VolcengineAstConfig` + the factory's `interpret` branch form the config-presence entitlement gate. zh↔en is enforced in the options UI and re-validated in the factory.

**Tech Stack:** TypeScript (ESM, strict), Vitest, `ws`, `@echoflow/protocol`, WXT/React extension. Hand-rolled protobuf codec (no `protobufjs`).

**Reference:** `docs/superpowers/specs/2026-06-20-interpretation-subtitle-mode-design.md`.

## Global Constraints

- **Vendor unknowns are pinned by Task 0, which is authoritative.** AST protobuf field numbers, the exact in/out event-id values, the binary frame variable-field layout, and the source↔translation segment-boundary semantics are recorded in `docs/superpowers/references/2026-06-20-ast-wire-reference.md` (Task 0). Where any later task's inferred model conflicts with that reference, **the reference wins** — adjust constants/triggers to match the captured frames.
- **Endpoint default:** `wss://openspeech.bytedance.com/api/v4/ast/v2/translate`. **Resource-Id default:** `volc.service_type.10053`. **Auth headers:** `X-Api-App-Key`, `X-Api-Access-Key`, `X-Api-Resource-Id`, `X-Api-Request-Id` (mirror the ASR adapter's header block exactly).
- **Audio:** raw PCM, 16 kHz / 16-bit / mono (matches `CANONICAL_PCM_AUDIO_FORMAT`); AST `mode` = `"s2t"` (subtitles only, no TTS).
- **Supported interpret targets:** exactly `zh-CN`, `zh-TW`, `en`. Vendor language mapping happens ONLY in the AST adapter: `zh-CN`→`zh`, `zh-TW`→`zh`, `en`→`en`. (Provider-neutral BCP-47 codes stay standard above the adapter — same rule as the Volcengine translation adapter.)
- **No new wire/protocol fields.** Cycle 1's `ServerEvent`/`ClientMessage` shapes are frozen. New error conditions ride the existing `error` event via string `code`s (`mode_language_unsupported`). The overlay/reducer are not modified.
- **Secrets live only in backend env.** Never put AST keys in the extension. `.env` is gitignored; update `.env.example` with the new `VOLCENGINE_AST_*` block (no real values).
- TDD throughout; colocated `*.test.ts`; frequent commits. Backend tests: `pnpm --filter @echoflow/backend test <pattern>`. Extension `test` targets `src` only.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `docs/superpowers/references/2026-06-20-ast-wire-reference.md` | Captured AST event ids, protobuf field numbers, frame layout, sample frames, boundary semantics | Create (Task 0) |
| `apps/backend/src/providers/astLanguages.ts` | `toAstLanguageCode`, `INTERPRET_SUPPORTED_TARGETS`, `isSupportedInterpretTarget` | Create (Task 1) |
| `apps/backend/src/providers/astConstants.ts` | Event-id, resource/endpoint defaults, message-type nibbles, protobuf field numbers (from Task 0) | Create (Task 2) |
| `apps/backend/src/providers/astProtocol.ts` | Hand-rolled protobuf reader/writer + frame parse/build; `encodeStartSession`/`encodeAudioRequest`/`encodeFinishSession`; `parseAstMessage` → `AstServerEvent` | Create (Task 2) |
| `apps/backend/src/providers/interpretReconciler.ts` | `AstServerEvent` → `SegmentEvent` (source→partial, translation-final→final, monotonic ordinals) | Create (Task 3) |
| `apps/backend/src/providers/astTransport.ts` | WS lifecycle with auth headers; mirrors `volcengineAsrTransport.ts` | Create (Task 4) |
| `apps/backend/src/realtime/interpretationSubtitleSource.ts` | `implements SubtitleSource`; wires transport + protocol + reconciler | Create (Task 5) |
| `apps/backend/src/providers/providerConfig.ts` | `VolcengineAstConfig`, `ProviderConfig.interpret?`, `isInterpretAvailable`, AST defaults | Modify (Task 6) |
| `apps/backend/src/config.ts` | Parse `VOLCENGINE_AST_*` env into `providers.interpret` | Modify (Task 6) |
| `apps/backend/src/realtime/subtitleSource.ts` | Add `ModeLanguageUnsupportedError` | Modify (Task 7) |
| `apps/backend/src/realtime/subtitleSourceFactory.ts` | `interpret` branch: build / `ModeUnavailableError` / `ModeLanguageUnsupportedError` | Modify (Task 7) |
| `apps/backend/src/realtime/session.ts` | One catch branch → `mode_language_unsupported` (non-fatal) | Modify (Task 7) |
| `apps/extension/src/settings/settings.ts` | `INTERPRET_TARGET_LANGUAGE_OPTIONS` + `targetOptionsForMode` helper | Modify (Task 8) |
| `apps/extension/entrypoints/options/main.tsx` | Constrain target `<select>` + coerce stored target when `interpret` | Modify (Task 8) |
| `.env.example` | `VOLCENGINE_AST_*` block | Modify (Task 6) |

---

## Task 0: Ground the AST wire protocol (gating prerequisite)

**Files:**
- Create: `docs/superpowers/references/2026-06-20-ast-wire-reference.md`

This task is **discovery**, not TDD. It removes the only load-bearing unknowns before any codec is written. It has a human-in-the-loop precondition; the controller pauses here for the user.

- [ ] **Step 1: Precondition (human) — subscribe, download protos, add creds**

Confirm with the user, before proceeding:
1. The Volcengine account has **同声传译 / AST subscribed** (it is a separate subscription from ASR; resource id `volc.service_type.10053`).
2. The user has downloaded the vendor **`protos.tar.gz`** from doc `https://www.volcengine.com/docs/6561/1756902` (it ships the `.proto` schema + Go/Python/Java demos + `HOWTO.md`), and can share the `.proto` field definitions.
3. The user has added the AST credential pair + endpoint to the backend `.env`:
   `VOLCENGINE_AST_APP_KEY`, `VOLCENGINE_AST_ACCESS_KEY`, and optionally `VOLCENGINE_AST_RESOURCE_ID` / `VOLCENGINE_AST_ENDPOINT`.

If any are missing, STOP and report what is needed — the codec field numbers cannot be invented.

- [ ] **Step 2: Extract field numbers from the `.proto`**

From the vendor `.proto` files, record the message names and field numbers for: the **StartSession** request payload (and its nested `request_meta`, `source_audio` sub-messages), the **TaskRequest** (audio) and **FinishSession** payloads, and the inbound **SourceSubtitle**/**TranslationSubtitle**/**Usage**/**Error** message payloads (the `text` field number especially). Record each as `MessageName.fieldName = <number> (<wiretype>)`.

- [ ] **Step 3: Capture real frames behind a debug flag (temporary)**

Add a temporary one-line hex dump of every inbound WS buffer in a throwaway script (or behind `if (process.env.ECHOFLOW_AST_DEBUG)` in a scratch connector — do NOT commit the scratch connector). Run one short real AST session (the user drives audio through the extension or a curl/script per the vendor demo), and capture the raw bytes of at least one of each inbound frame: source-subtitle Start/Response/End, translation-subtitle Start/Response/End, a `UsageResponse`, and (if reproducible) an error frame.

- [ ] **Step 4: Write the reference doc**

Create `docs/superpowers/references/2026-06-20-ast-wire-reference.md` recording, concretely:
1. **Event ids** (out: StartSession/TaskRequest/UpdateConfig/FinishSession; in: source 650/651/652, translation 653/654/655, usage 154, session-failed 153, and any session-started/metadata event that carries a detected source language) — confirm or correct the candidate values.
2. **Frame layout**: the exact byte order of the 4-byte header + the variable fields (sequence / event id / `connect_id` / `session_id` / payload-size + payload), and the serialization + compression nibble values AST actually uses (is the payload gzip'd?).
3. **Protobuf field numbers** from Step 2, per message.
4. **Sample frames**: for each captured inbound frame, the raw hex AND the decoded interpretation (which event id, which fields, the `text` value).
5. **Segment-boundary semantics** (CRITICAL for the reconciler): does each utterance produce exactly one source Start→…→End and one translation Start→…→End? Are source segment N and translation segment N correlated by order, by a shared id field, or by the session-level sequence? Does the `End` event's `text` carry the full final line or a delta? Does any inbound event report the detected source language?

- [ ] **Step 5: Remove the temporary capture code; commit the reference**

```bash
git add docs/superpowers/references/2026-06-20-ast-wire-reference.md
git commit -m "docs(backend): capture AST wire reference (Cycle 2 Task 0)"
```

Verification checklist (all must be true before Task 1): the reference contains concrete event-id values, the protobuf field numbers for every message above, the full frame layout incl. serialization/compression nibbles, ≥1 decoded sample per inbound frame type, and an explicit statement of the source↔translation correlation + `End`-text semantics + detected-language availability.

---

## Task 1: AST language helpers

**Files:**
- Create: `apps/backend/src/providers/astLanguages.ts`
- Create: `apps/backend/src/providers/astLanguages.test.ts`

**Interfaces:**
- Produces: `INTERPRET_SUPPORTED_TARGETS: readonly string[]`; `isSupportedInterpretTarget(target: string): boolean`; `toAstLanguageCode(target: string): string`.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/providers/astLanguages.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  INTERPRET_SUPPORTED_TARGETS,
  isSupportedInterpretTarget,
  toAstLanguageCode,
} from "./astLanguages.js";

describe("astLanguages", () => {
  it("supports exactly zh-CN, zh-TW, en", () => {
    expect([...INTERPRET_SUPPORTED_TARGETS].sort()).toEqual(["en", "zh-CN", "zh-TW"]);
  });

  it("accepts supported targets and rejects others", () => {
    expect(isSupportedInterpretTarget("zh-CN")).toBe(true);
    expect(isSupportedInterpretTarget("en")).toBe(true);
    expect(isSupportedInterpretTarget("ja")).toBe(false);
    expect(isSupportedInterpretTarget("")).toBe(false);
  });

  it("maps our codes to AST codes", () => {
    expect(toAstLanguageCode("zh-CN")).toBe("zh");
    expect(toAstLanguageCode("zh-TW")).toBe("zh");
    expect(toAstLanguageCode("en")).toBe("en");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @echoflow/backend test astLanguages`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/backend/src/providers/astLanguages.ts`:

```ts
export const INTERPRET_SUPPORTED_TARGETS = ["zh-CN", "zh-TW", "en"] as const;

export function isSupportedInterpretTarget(target: string): boolean {
  return (INTERPRET_SUPPORTED_TARGETS as readonly string[]).includes(target);
}

export function toAstLanguageCode(target: string): string {
  if (target === "zh-CN" || target === "zh-TW") {
    return "zh";
  }
  return "en";
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `pnpm --filter @echoflow/backend test astLanguages`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/providers/astLanguages.ts apps/backend/src/providers/astLanguages.test.ts
git commit -m "feat(backend): add AST language helpers"
```

---

## Task 2: AST constants + protobuf/frame codec

**Files:**
- Create: `apps/backend/src/providers/astConstants.ts`
- Create: `apps/backend/src/providers/astProtocol.ts`
- Create: `apps/backend/src/providers/astProtocol.test.ts`

**Interfaces:**
- Consumes: the Task 0 reference (event ids, field numbers, frame layout — fill the constants from it).
- Produces:
  - `type AstStartSessionOptions = { sessionId: string; sourceLanguageDetect: boolean; targetLanguage: string; audio: { format: string; rate: number; bits: number; channel: number } }`
  - `encodeStartSession(opts: AstStartSessionOptions): Buffer`
  - `encodeAudioRequest(audio: Buffer): Buffer` (always a TaskRequest audio frame)
  - `encodeFinishSession(): Buffer` (the control frame `end()` sends)
  - `type AstServerEvent = { kind: "source"; text: string; final: boolean } | { kind: "translation"; text: string; final: boolean } | { kind: "usage" } | { kind: "error"; code: number; message: string } | { kind: "other" }`
  - `parseAstMessage(data: Buffer): AstServerEvent`

This is the only task that depends on Task 0's vendor specifics. The protobuf wire logic (varints, length-delimited fields) and the 4-byte header family are standard and given concretely below; the **values** of the event ids and field numbers live in `astConstants.ts` and come from the reference.

- [ ] **Step 1: Create the constants module (values from Task 0 reference)**

Create `apps/backend/src/providers/astConstants.ts`. Fill every `0x00`/`0` below with the concrete value recorded in the Task 0 reference; keep the names:

```ts
// All numeric values are pinned by docs/superpowers/references/2026-06-20-ast-wire-reference.md.
export const DEFAULT_VOLCENGINE_AST_ENDPOINT =
  "wss://openspeech.bytedance.com/api/v4/ast/v2/translate";
export const DEFAULT_VOLCENGINE_AST_RESOURCE_ID = "volc.service_type.10053";

// 4-byte header nibbles (shared bigmodel family; confirm against reference).
export const AST_PROTOCOL_VERSION = 0b0001;
export const AST_HEADER_SIZE = 0b0001;
export const AST_MSG_TYPE_FULL_CLIENT = 0b0001;
export const AST_MSG_TYPE_AUDIO_ONLY = 0b0010;
export const AST_MSG_TYPE_FULL_SERVER = 0b1001;
export const AST_MSG_TYPE_ERROR = 0b1111;
export const AST_SERIALIZATION = 0x00; // protobuf nibble value — from reference
export const AST_COMPRESSION_NONE = 0b0000;

// Out event ids.
export const AST_EVENT_START_SESSION = 100;
export const AST_EVENT_TASK_REQUEST = 200;
export const AST_EVENT_FINISH_SESSION = 102;

// In event ids (confirm/correct from reference).
export const AST_EVENT_SOURCE_RESPONSE = 651;
export const AST_EVENT_SOURCE_END = 652;
export const AST_EVENT_TRANSLATION_RESPONSE = 654;
export const AST_EVENT_TRANSLATION_END = 655;
export const AST_EVENT_USAGE = 154;
export const AST_EVENT_SESSION_FAILED = 153;

// Protobuf field numbers (from the vendor .proto, recorded in the reference).
export const AST_FIELD = {
  subtitleText: 1, // <field number of `text` in the subtitle response/end messages>
  errorCode: 1, //    <field number of the error code>
  errorMessage: 2, //  <field number of the error message>
  // StartSession assembly field numbers (request_meta, source_language,
  // target_language, mode, source_audio{format,rate,bits,channel},
  // enable_source_language_detect) — record each from the .proto:
  startMode: 0,
  startTargetLanguage: 0,
  startSourceDetect: 0,
  // ...add the remaining StartSession/source_audio field numbers from the reference.
} as const;
```

- [ ] **Step 2: Write the failing test (codec round-trip + sample decode)**

Create `apps/backend/src/providers/astProtocol.test.ts`. The decode cases use the **sample frame hex recorded in the Task 0 reference** — paste those exact bytes here:

```ts
import { describe, expect, it } from "vitest";
import {
  encodeStartSession,
  parseAstMessage,
} from "./astProtocol.js";

describe("astProtocol", () => {
  it("encodes a StartSession frame with the bigmodel header", () => {
    const frame = encodeStartSession({
      sessionId: "11111111-1111-1111-1111-111111111111",
      sourceLanguageDetect: true,
      targetLanguage: "zh",
      audio: { format: "pcm", rate: 16000, bits: 16, channel: 1 },
    });
    // Header byte 0 = (version<<4)|headerSize = 0x11 for the bigmodel family.
    expect(frame[0]).toBe(0x11);
    expect(frame.length).toBeGreaterThan(4);
  });

  it("decodes a source-subtitle response frame to a non-final source event", () => {
    // Replace with the SOURCE-RESPONSE sample hex from the Task 0 reference §4.
    const sample = Buffer.from("<source-response-hex-from-reference>", "hex");
    expect(parseAstMessage(sample)).toEqual({
      kind: "source",
      text: "<expected source text from reference>",
      final: false,
    });
  });

  it("decodes a translation-subtitle END frame to a final translation event", () => {
    // Replace with the TRANSLATION-END sample hex from the Task 0 reference §4.
    const sample = Buffer.from("<translation-end-hex-from-reference>", "hex");
    expect(parseAstMessage(sample)).toEqual({
      kind: "translation",
      text: "<expected translation text from reference>",
      final: true,
    });
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm --filter @echoflow/backend test astProtocol`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the codec**

Create `apps/backend/src/providers/astProtocol.ts`. The protobuf + header logic is concrete; field numbers/event ids come from `astConstants.ts`:

```ts
import { randomUUID } from "node:crypto";
import * as C from "./astConstants.js";

export type AstStartSessionOptions = {
  sessionId: string;
  sourceLanguageDetect: boolean;
  targetLanguage: string;
  audio: { format: string; rate: number; bits: number; channel: number };
};

export type AstServerEvent =
  | { kind: "source"; text: string; final: boolean }
  | { kind: "translation"; text: string; final: boolean }
  | { kind: "usage" }
  | { kind: "error"; code: number; message: string }
  | { kind: "other" };

// ---- minimal protobuf writer ----
function writeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v > 0) b |= 0x80;
    bytes.push(b);
  } while (v > 0);
  return Buffer.from(bytes);
}
function writeTag(field: number, wireType: number): Buffer {
  return writeVarint((field << 3) | wireType);
}
function writeStringField(field: number, value: string): Buffer {
  const body = Buffer.from(value, "utf8");
  return Buffer.concat([writeTag(field, 2), writeVarint(body.length), body]);
}
function writeVarintField(field: number, value: number): Buffer {
  return Buffer.concat([writeTag(field, 0), writeVarint(value)]);
}
function writeMessageField(field: number, body: Buffer): Buffer {
  return Buffer.concat([writeTag(field, 2), writeVarint(body.length), body]);
}

// ---- minimal protobuf reader ----
type ProtoField = { wireType: number; value: bigint | Buffer };
function readMessage(buf: Buffer): Map<number, ProtoField[]> {
  const fields = new Map<number, ProtoField[]>();
  let offset = 0;
  while (offset < buf.length) {
    const [tag, n1] = readVarint(buf, offset);
    offset = n1;
    const field = tag >> 3;
    const wireType = tag & 0x7;
    let value: bigint | Buffer;
    if (wireType === 0) {
      const [v, n2] = readVarint(buf, offset);
      value = BigInt(v);
      offset = n2;
    } else if (wireType === 2) {
      const [len, n2] = readVarint(buf, offset);
      value = buf.subarray(n2, n2 + len);
      offset = n2 + len;
    } else if (wireType === 5) {
      value = buf.subarray(offset, offset + 4);
      offset += 4;
    } else if (wireType === 1) {
      value = buf.subarray(offset, offset + 8);
      offset += 8;
    } else {
      break; // unknown wire type — stop defensively
    }
    const list = fields.get(field) ?? [];
    list.push({ wireType, value });
    fields.set(field, list);
  }
  return fields;
}
function readVarint(buf: Buffer, start: number): [number, number] {
  let result = 0;
  let shift = 0;
  let offset = start;
  for (;;) {
    const byte = buf[offset++] ?? 0;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result >>> 0, offset];
}
function getString(fields: Map<number, ProtoField[]>, field: number): string {
  const f = fields.get(field)?.[0];
  return f && Buffer.isBuffer(f.value) ? f.value.toString("utf8") : "";
}

// ---- frame header ----
function buildHeader(messageType: number): Buffer {
  return Buffer.from([
    (C.AST_PROTOCOL_VERSION << 4) | C.AST_HEADER_SIZE,
    (messageType << 4) | 0b0000,
    (C.AST_SERIALIZATION << 4) | C.AST_COMPRESSION_NONE,
    0x00,
  ]);
}
// Build a full-client frame: header + event id (int32 BE) + payload-size (int32 BE) + payload.
// NOTE: confirm the exact variable-field order (event / connect_id / session_id) against the
// Task 0 reference §2 and adjust this assembly to match.
function buildEventFrame(messageType: number, event: number, payload: Buffer): Buffer {
  const eventBuf = Buffer.alloc(4);
  eventBuf.writeInt32BE(event, 0);
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(payload.length, 0);
  return Buffer.concat([buildHeader(messageType), eventBuf, sizeBuf, payload]);
}

export function encodeStartSession(opts: AstStartSessionOptions): Buffer {
  // Assemble the StartSession protobuf payload from AST_FIELD numbers (from reference).
  const audioBody = Buffer.concat([
    writeStringField(/* format */ 1, opts.audio.format),
    writeVarintField(/* rate */ 2, opts.audio.rate),
    writeVarintField(/* bits */ 3, opts.audio.bits),
    writeVarintField(/* channel */ 4, opts.audio.channel),
  ]); // confirm sub-field numbers from reference
  const payload = Buffer.concat([
    writeVarintField(C.AST_FIELD.startMode, /* s2t enum or */ 0),
    writeStringField(C.AST_FIELD.startTargetLanguage, opts.targetLanguage),
    writeVarintField(C.AST_FIELD.startSourceDetect, opts.sourceLanguageDetect ? 1 : 0),
    writeMessageField(/* source_audio field number */ 0, audioBody),
  ]);
  return buildEventFrame(C.AST_MSG_TYPE_FULL_CLIENT, C.AST_EVENT_START_SESSION, payload);
}

export function encodeAudioRequest(audio: Buffer): Buffer {
  return buildEventFrame(C.AST_MSG_TYPE_AUDIO_ONLY, C.AST_EVENT_TASK_REQUEST, audio);
}

export function encodeFinishSession(): Buffer {
  return buildEventFrame(C.AST_MSG_TYPE_FULL_CLIENT, C.AST_EVENT_FINISH_SESSION, Buffer.alloc(0));
}

export function parseAstMessage(data: Buffer): AstServerEvent {
  // Parse header → event id → payload, per the reference frame layout.
  const event = data.readInt32BE(4); // adjust offset if the reference differs
  const sizeOffset = 8; // adjust per reference
  const payloadStart = sizeOffset + 4;
  const size = data.readUInt32BE(sizeOffset);
  const payload = data.subarray(payloadStart, payloadStart + size);
  const fields = readMessage(payload);

  switch (event) {
    case C.AST_EVENT_SOURCE_RESPONSE:
      return { kind: "source", text: getString(fields, C.AST_FIELD.subtitleText), final: false };
    case C.AST_EVENT_SOURCE_END:
      return { kind: "source", text: getString(fields, C.AST_FIELD.subtitleText), final: true };
    case C.AST_EVENT_TRANSLATION_RESPONSE:
      return { kind: "translation", text: getString(fields, C.AST_FIELD.subtitleText), final: false };
    case C.AST_EVENT_TRANSLATION_END:
      return { kind: "translation", text: getString(fields, C.AST_FIELD.subtitleText), final: true };
    case C.AST_EVENT_USAGE:
      return { kind: "usage" };
    case C.AST_EVENT_SESSION_FAILED:
      return {
        kind: "error",
        code: Number(fields.get(C.AST_FIELD.errorCode)?.[0]?.value ?? 0n),
        message: getString(fields, C.AST_FIELD.errorMessage),
      };
    default:
      return { kind: "other" };
  }
}

export { randomUUID };
```

> If the reference shows AST payloads are gzip-compressed, add a `gunzipSync` on `payload` before `readMessage` and set `AST_COMPRESSION_NONE`→gzip in the header builder; the reference's compression nibble dictates this.

- [ ] **Step 5: Run it to confirm it passes**

Run: `pnpm --filter @echoflow/backend test astProtocol`
Expected: PASS (once the reference hex + field numbers are filled in).
Run: `pnpm --filter @echoflow/backend typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/providers/astConstants.ts apps/backend/src/providers/astProtocol.ts apps/backend/src/providers/astProtocol.test.ts
git commit -m "feat(backend): add AST protobuf/frame codec"
```

---

## Task 3: Interpret reconciler (AST events → SegmentEvent)

**Files:**
- Create: `apps/backend/src/providers/interpretReconciler.ts`
- Create: `apps/backend/src/providers/interpretReconciler.test.ts`

**Interfaces:**
- Consumes: `AstServerEvent` (Task 2); `SegmentEvent` from `./types.js`.
- Produces: `class InterpretReconciler { reconcile(event: AstServerEvent): SegmentEvent[] }`.

Model (adjust the boundary trigger to the Task 0 reference if it differs): one monotonic `ordinal` per utterance. A source event sets the current segment's buffered source text and emits a `partial`. A translation `final` (the `End` event) emits a `final` pairing the buffered source with the translation, then advances the ordinal so the next source event starts a new segment.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/providers/interpretReconciler.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { InterpretReconciler } from "./interpretReconciler.js";

describe("InterpretReconciler", () => {
  it("emits a live partial for a source response", () => {
    const r = new InterpretReconciler();
    expect(r.reconcile({ kind: "source", text: "hello", final: false })).toEqual([
      { kind: "partial", segmentId: "ast-0", text: "hello", startTimeMs: 0 },
    ]);
  });

  it("updates the same segment's partial as the source revises", () => {
    const r = new InterpretReconciler();
    r.reconcile({ kind: "source", text: "hel", final: false });
    expect(r.reconcile({ kind: "source", text: "hello there", final: false })).toEqual([
      { kind: "partial", segmentId: "ast-0", text: "hello there", startTimeMs: 0 },
    ]);
  });

  it("emits a final pairing buffered source + translation on translation end", () => {
    const r = new InterpretReconciler();
    r.reconcile({ kind: "source", text: "hello there", final: false });
    r.reconcile({ kind: "translation", text: "你好", final: false });
    expect(r.reconcile({ kind: "translation", text: "你好啊", final: true })).toEqual([
      {
        kind: "final",
        segmentId: "ast-0",
        text: "hello there",
        translatedText: "你好啊",
        startTimeMs: 0,
        endTimeMs: 0,
      },
    ]);
  });

  it("advances the ordinal for the next utterance after a final", () => {
    const r = new InterpretReconciler();
    r.reconcile({ kind: "source", text: "one", final: false });
    r.reconcile({ kind: "translation", text: "一", final: true });
    expect(r.reconcile({ kind: "source", text: "two", final: false })).toEqual([
      { kind: "partial", segmentId: "ast-1", text: "two", startTimeMs: 0 },
    ]);
  });

  it("ignores usage and non-final source-end without emitting", () => {
    const r = new InterpretReconciler();
    r.reconcile({ kind: "source", text: "hi", final: false });
    expect(r.reconcile({ kind: "usage" })).toEqual([]);
    expect(r.reconcile({ kind: "source", text: "hi", final: true })).toEqual([]);
  });
});
```

> Note: `SegmentEvent.final` carries `translatedText`? No — `SegmentEvent` (in `types.ts`) is the SPEECH-layer event and has NO `translatedText`. The reconciler must instead emit a richer object the source layer consumes. **Decision:** define a local `InterpretSegment` type rather than reuse `SegmentEvent`, because the interpret final already contains the translation (unlike the ASR path where translation is added later). Use the type below; the test above asserts that shape.

```ts
export type InterpretSegment =
  | { kind: "language"; sourceLanguage: string }
  | { kind: "partial"; segmentId: string; text: string; startTimeMs: number }
  | {
      kind: "final";
      segmentId: string;
      text: string;
      translatedText: string;
      startTimeMs: number;
      endTimeMs: number;
    };
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @echoflow/backend test interpretReconciler`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/backend/src/providers/interpretReconciler.ts`:

```ts
import type { AstServerEvent } from "./astProtocol.js";

export type InterpretSegment =
  | { kind: "language"; sourceLanguage: string }
  | { kind: "partial"; segmentId: string; text: string; startTimeMs: number }
  | {
      kind: "final";
      segmentId: string;
      text: string;
      translatedText: string;
      startTimeMs: number;
      endTimeMs: number;
    };

export class InterpretReconciler {
  private ordinal = 0;
  private sourceText = "";
  private translationText = "";
  private started = false;

  reconcile(event: AstServerEvent): InterpretSegment[] {
    if (event.kind === "source") {
      this.started = true;
      this.sourceText = event.text;
      if (event.final) {
        return []; // source end is not a render boundary; translation end is
      }
      return [
        {
          kind: "partial",
          segmentId: `ast-${this.ordinal}`,
          text: this.sourceText,
          startTimeMs: 0,
        },
      ];
    }
    if (event.kind === "translation") {
      this.translationText = event.text;
      if (!event.final) {
        return []; // buffer revising translation; surface only on end
      }
      const final: InterpretSegment = {
        kind: "final",
        segmentId: `ast-${this.ordinal}`,
        text: this.sourceText,
        translatedText: this.translationText,
        startTimeMs: 0,
        endTimeMs: 0,
      };
      this.ordinal += 1;
      this.sourceText = "";
      this.translationText = "";
      this.started = false;
      return [final];
    }
    return [];
  }
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `pnpm --filter @echoflow/backend test interpretReconciler`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/providers/interpretReconciler.ts apps/backend/src/providers/interpretReconciler.test.ts
git commit -m "feat(backend): add interpret reconciler"
```

---

## Task 4: AST transport (WebSocket lifecycle)

**Files:**
- Create: `apps/backend/src/providers/astTransport.ts`
- Create: `apps/backend/src/providers/astTransport.test.ts`

**Interfaces:**
- Produces (mirror the ASR transport exactly so it is injectable in tests):
  - `type AstConnectOptions = { endpoint: string; headers: Record<string, string> }`
  - `type AstTransportCallbacks = { onMessage: (data: Buffer) => void; onError: (error: Error) => void; onClose: (code: number, reason: string) => void }`
  - `interface AstTransport { send(data: Buffer): void; close(): void }`
  - `type AstTransportFactory = (options: AstConnectOptions, callbacks: AstTransportCallbacks) => AstTransport`
  - `const connectAstTransport: AstTransportFactory`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/providers/astTransport.test.ts`. Test the buffering contract via a fake `ws` is overkill; instead assert the module exports a factory with the right shape and that a custom factory can stand in (the real socket is covered by e2e). Use a contract test:

```ts
import { describe, expect, it } from "vitest";
import type { AstTransport, AstTransportFactory } from "./astTransport.js";

describe("AstTransport contract", () => {
  it("a stub factory satisfies the interface used by the provider", () => {
    const sent: Buffer[] = [];
    const factory: AstTransportFactory = (_options, _callbacks) => {
      const transport: AstTransport = {
        send: (data) => sent.push(data),
        close: () => {},
      };
      return transport;
    };
    const t = factory(
      { endpoint: "wss://x", headers: {} },
      { onMessage: () => {}, onError: () => {}, onClose: () => {} },
    );
    t.send(Buffer.from([1, 2, 3]));
    expect(sent).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @echoflow/backend test astTransport`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement (mirror `volcengineAsrTransport.ts`)**

Create `apps/backend/src/providers/astTransport.ts`:

```ts
import { WebSocket } from "ws";

export type AstConnectOptions = {
  endpoint: string;
  headers: Record<string, string>;
};

export type AstTransportCallbacks = {
  onMessage: (data: Buffer) => void;
  onError: (error: Error) => void;
  onClose: (code: number, reason: string) => void;
};

export interface AstTransport {
  send(data: Buffer): void;
  close(): void;
}

export type AstTransportFactory = (
  options: AstConnectOptions,
  callbacks: AstTransportCallbacks,
) => AstTransport;

export const connectAstTransport: AstTransportFactory = (options, callbacks) => {
  const socket = new WebSocket(options.endpoint, { headers: options.headers });
  socket.binaryType = "nodebuffer";

  let open = false;
  const queue: Buffer[] = [];

  socket.on("open", () => {
    open = true;
    for (const buffered of queue) {
      socket.send(buffered);
    }
    queue.length = 0;
  });
  socket.on("message", (data: WebSocket.RawData, _isBinary: boolean) => {
    callbacks.onMessage(data as Buffer);
  });
  socket.on("error", (error: Error) => {
    callbacks.onError(error);
  });
  socket.on("close", (code: number, reason: Buffer) => {
    callbacks.onClose(code, reason.toString("utf8"));
  });

  return {
    send(data: Buffer): void {
      if (open && socket.readyState === socket.OPEN) {
        socket.send(data);
      } else {
        queue.push(data);
      }
    },
    close(): void {
      socket.close();
    },
  };
};
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `pnpm --filter @echoflow/backend test astTransport`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/providers/astTransport.ts apps/backend/src/providers/astTransport.test.ts
git commit -m "feat(backend): add AST WebSocket transport"
```

---

## Task 5: InterpretationSubtitleSource

**Files:**
- Create: `apps/backend/src/realtime/interpretationSubtitleSource.ts`
- Create: `apps/backend/src/realtime/interpretationSubtitleSource.test.ts`

**Interfaces:**
- Consumes: `VolcengineAstConfig` (Task 6 — for this task, accept the structural type below; Task 6 exports the canonical one and this import path resolves once Task 6 lands. To keep tasks independently compilable, define the constructor param against `VolcengineAstConfig` imported from `../providers/providerConfig.js`, which Task 6 adds — sequence Task 6 BEFORE this task if compiling in isolation, OR inline a local type. The plan orders Task 6 after this; therefore inline the minimal type here and have Task 6 keep the same field names.) `AstTransportFactory`, `encode*`, `parseAstMessage`, `InterpretReconciler`, `toAstLanguageCode`.
- Produces: `class InterpretationSubtitleSource implements SubtitleSource`.

> Sequencing note: this task references `VolcengineAstConfig`. To avoid a forward dependency, the constructor takes a **local structural type** `AstSourceConfig = { appKey: string; accessKey: string; resourceId: string; endpoint: string }`; Task 6's `VolcengineAstConfig` has identical fields, and Task 7's factory passes `config.interpret` (a `VolcengineAstConfig`) which is assignable. This keeps each task independently compilable.

- [ ] **Step 1: Write the failing test (stub transport)**

Create `apps/backend/src/realtime/interpretationSubtitleSource.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ServerEvent } from "@echoflow/protocol";
import type {
  AstTransport,
  AstTransportCallbacks,
  AstTransportFactory,
} from "../providers/astTransport.js";
import { InterpretationSubtitleSource } from "./interpretationSubtitleSource.js";

function stubTransport(): {
  factory: AstTransportFactory;
  emit: (data: Buffer) => void;
  fail: (error: Error) => void;
  sent: Buffer[];
} {
  let cbs: AstTransportCallbacks | undefined;
  const sent: Buffer[] = [];
  const factory: AstTransportFactory = (_options, callbacks) => {
    cbs = callbacks;
    const transport: AstTransport = { send: (d) => sent.push(d), close: () => {} };
    return transport;
  };
  return {
    factory,
    emit: (data) => cbs?.onMessage(data),
    fail: (error) => cbs?.onError(error),
    sent,
  };
}

const CONFIG = {
  appKey: "ak",
  accessKey: "sk",
  resourceId: "volc.service_type.10053",
  endpoint: "wss://x",
};

// parseAstMessage is real; feed it bytes that decode to the events we want by
// reusing the encoder is not possible (encoder builds OUT frames). So this test
// injects a fake parse via dependency is unnecessary — instead assert behavior
// through the reconciler path using the SOURCE/TRANSLATION sample frames from
// the Task 0 reference. Paste those hex samples here.
describe("InterpretationSubtitleSource", () => {
  it("emits a language event and forwards a partial for a source frame", () => {
    const t = stubTransport();
    const events: ServerEvent[] = [];
    const source = new InterpretationSubtitleSource(CONFIG, "zh-CN", t.factory);
    source.open({ onEvent: (e) => events.push(e) });
    t.emit(Buffer.from("<source-response-hex-from-reference>", "hex"));
    expect(events).toContainEqual({
      type: "language",
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
    });
    expect(events).toContainEqual({
      type: "partial",
      segmentId: "ast-0",
      sourceText: "<expected source text>",
    });
  });

  it("emits a final with translation on a translation-end frame", () => {
    const t = stubTransport();
    const events: ServerEvent[] = [];
    const source = new InterpretationSubtitleSource(CONFIG, "zh-CN", t.factory);
    source.open({ onEvent: (e) => events.push(e) });
    t.emit(Buffer.from("<source-response-hex>", "hex"));
    t.emit(Buffer.from("<translation-end-hex>", "hex"));
    expect(events.some((e) => e.type === "final" && "translatedText" in e)).toBe(true);
  });

  it("routes a transport error to onError", () => {
    const t = stubTransport();
    let errored: Error | undefined;
    const source = new InterpretationSubtitleSource(CONFIG, "zh-CN", t.factory);
    source.open({ onEvent: () => {}, onError: (e) => (errored = e) });
    t.fail(new Error("boom"));
    expect(errored?.message).toBe("boom");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @echoflow/backend test interpretationSubtitleSource`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/backend/src/realtime/interpretationSubtitleSource.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { ServerEvent } from "@echoflow/protocol";
import {
  encodeAudioRequest,
  encodeFinishSession,
  encodeStartSession,
  parseAstMessage,
} from "../providers/astProtocol.js";
import {
  connectAstTransport,
  type AstTransportFactory,
} from "../providers/astTransport.js";
import { toAstLanguageCode } from "../providers/astLanguages.js";
import { InterpretReconciler } from "../providers/interpretReconciler.js";
import type { AudioFrame } from "../providers/types.js";
import type { SubtitleSource, SubtitleSourceStream } from "./subtitleSource.js";

export type AstSourceConfig = {
  appKey: string;
  accessKey: string;
  resourceId: string;
  endpoint: string;
};

export class InterpretationSubtitleSource implements SubtitleSource {
  constructor(
    private readonly config: AstSourceConfig,
    private readonly targetLanguage: string,
    private readonly connect: AstTransportFactory = connectAstTransport,
  ) {}

  open(opts: {
    onEvent: (event: ServerEvent) => void;
    onError?: (error: Error) => void;
  }): SubtitleSourceStream {
    const targetLanguage = this.targetLanguage;
    const reconciler = new InterpretReconciler();
    const sessionId = randomUUID();
    let languageEmitted = false;
    let closed = false;

    const transport = this.connect(
      {
        endpoint: this.config.endpoint,
        headers: {
          "X-Api-App-Key": this.config.appKey,
          "X-Api-Access-Key": this.config.accessKey,
          "X-Api-Resource-Id": this.config.resourceId,
          "X-Api-Request-Id": sessionId,
        },
      },
      {
        onMessage: (data) => {
          if (closed) return;
          const event = parseAstMessage(data);
          if (event.kind === "error") {
            opts.onError?.(new Error(`AST error ${event.code}: ${event.message}`));
            return;
          }
          if (event.kind === "other" || event.kind === "usage") {
            return;
          }
          if (!languageEmitted) {
            languageEmitted = true;
            opts.onEvent({ type: "language", sourceLanguage: "auto", targetLanguage });
          }
          for (const seg of reconciler.reconcile(event)) {
            if (seg.kind === "partial") {
              opts.onEvent({ type: "partial", segmentId: seg.segmentId, sourceText: seg.text });
            } else if (seg.kind === "final") {
              opts.onEvent({
                type: "final",
                segmentId: seg.segmentId,
                sourceText: seg.text,
                translatedText: seg.translatedText,
                startTimeMs: seg.startTimeMs,
                endTimeMs: seg.endTimeMs,
              });
            }
          }
        },
        onError: (error) => {
          if (!closed) opts.onError?.(error);
        },
        onClose: () => {
          // session drains via end(); nothing on normal close
        },
      },
    );

    transport.send(
      encodeStartSession({
        sessionId,
        sourceLanguageDetect: true,
        targetLanguage: toAstLanguageCode(targetLanguage),
        audio: { format: "pcm", rate: 16000, bits: 16, channel: 1 },
      }),
    );

    return {
      pushFrame(frame: AudioFrame): void {
        if (closed) return;
        const audio = Buffer.isBuffer(frame.data) ? frame.data : Buffer.from(frame.data);
        transport.send(encodeAudioRequest(audio));
      },
      async end(): Promise<void> {
        if (closed) return;
        transport.send(encodeFinishSession());
        closed = true;
      },
      async close(): Promise<void> {
        closed = true;
        transport.close();
      },
    };
  }
}
```

- [ ] **Step 4: Run it to confirm it passes + typecheck**

Run: `pnpm --filter @echoflow/backend test interpretationSubtitleSource`
Expected: PASS.
Run: `pnpm --filter @echoflow/backend typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/realtime/interpretationSubtitleSource.ts apps/backend/src/realtime/interpretationSubtitleSource.test.ts
git commit -m "feat(backend): add InterpretationSubtitleSource"
```

---

## Task 6: AST config + entitlement predicate

**Files:**
- Modify: `apps/backend/src/providers/providerConfig.ts`
- Modify: `apps/backend/src/config.ts`
- Modify: `apps/backend/src/providers/providerConfig.test.ts`
- Modify: `apps/backend/src/config.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `type VolcengineAstConfig = { appKey; accessKey; resourceId; endpoint }`; `ProviderConfig.interpret?: VolcengineAstConfig`; `isInterpretAvailable(config: ProviderConfig): boolean`; AST default consts.

- [ ] **Step 1: Write the failing tests**

In `apps/backend/src/providers/providerConfig.test.ts`, add:

```ts
import { isInterpretAvailable, type ProviderConfig } from "./providerConfig.js";

describe("isInterpretAvailable", () => {
  it("is false without interpret config", () => {
    const config: ProviderConfig = { asr: { provider: "fake" }, translation: { provider: "fake" } };
    expect(isInterpretAvailable(config)).toBe(false);
  });
  it("is true when interpret creds are present", () => {
    const config: ProviderConfig = {
      asr: { provider: "fake" },
      translation: { provider: "fake" },
      interpret: { appKey: "a", accessKey: "b", resourceId: "r", endpoint: "wss://x" },
    };
    expect(isInterpretAvailable(config)).toBe(true);
  });
});
```

In `apps/backend/src/config.test.ts`, add a case (match the file's existing env-stubbing style — it sets `process.env` then calls `createConfig()`):

```ts
it("reads VOLCENGINE_AST_* into providers.interpret", () => {
  process.env.VOLCENGINE_AST_APP_KEY = "ast-app";
  process.env.VOLCENGINE_AST_ACCESS_KEY = "ast-access";
  const config = createConfig();
  expect(config.providers.interpret).toEqual({
    appKey: "ast-app",
    accessKey: "ast-access",
    resourceId: "volc.service_type.10053",
    endpoint: "wss://openspeech.bytedance.com/api/v4/ast/v2/translate",
  });
});
```

(Restore/delete these env vars in the test teardown the file already uses.)

- [ ] **Step 2: Run them to confirm they fail**

Run: `pnpm --filter @echoflow/backend test providerConfig config`
Expected: FAIL — `isInterpretAvailable`/`interpret` not defined.

- [ ] **Step 3: Implement providerConfig.ts**

In `apps/backend/src/providers/providerConfig.ts` add:

```ts
export type VolcengineAstConfig = {
  appKey: string;
  accessKey: string;
  resourceId: string;
  endpoint: string;
};
```

Add `interpret?` to `ProviderConfig`:

```ts
export type ProviderConfig = {
  asr: AsrProviderConfig;
  translation: TranslationProviderConfig;
  interpret?: VolcengineAstConfig;
};
```

Add defaults + the predicate:

```ts
export const DEFAULT_VOLCENGINE_AST_ENDPOINT =
  "wss://openspeech.bytedance.com/api/v4/ast/v2/translate";
export const DEFAULT_VOLCENGINE_AST_RESOURCE_ID = "volc.service_type.10053";

export function isInterpretAvailable(config: ProviderConfig): boolean {
  return (
    config.interpret !== undefined &&
    config.interpret.appKey.trim() !== "" &&
    config.interpret.accessKey.trim() !== ""
  );
}
```

- [ ] **Step 4: Implement config.ts parsing**

In `apps/backend/src/config.ts`, import the new defaults, and in `readProviderConfig()` add (after the translation block, before `return config;`) — and ensure `interpret` is also attached when ASR/translation are both fake (the early `if (asrProvider === "fake" && translationProvider === "fake") return DEFAULT_PROVIDER_CONFIG;` must not bypass interpret). Refactor that early return:

Replace:
```ts
  if (asrProvider === "fake" && translationProvider === "fake") {
    return DEFAULT_PROVIDER_CONFIG;
  }

  const config: ProviderConfig = {
    asr: { provider: asrProvider },
    translation: { provider: translationProvider },
  };
```
with:
```ts
  const config: ProviderConfig = {
    asr: { provider: asrProvider },
    translation: { provider: translationProvider },
  };
```
(The `DEFAULT_PROVIDER_CONFIG` fast-path is dropped so interpret creds are honored even when ASR/translation are fake. `DEFAULT_PROVIDER_CONFIG` stays exported for tests/other callers.)

Then before `return config;` add:
```ts
  if (process.env.VOLCENGINE_AST_APP_KEY && process.env.VOLCENGINE_AST_ACCESS_KEY) {
    config.interpret = {
      appKey: process.env.VOLCENGINE_AST_APP_KEY,
      accessKey: process.env.VOLCENGINE_AST_ACCESS_KEY,
      resourceId:
        process.env.VOLCENGINE_AST_RESOURCE_ID ?? DEFAULT_VOLCENGINE_AST_RESOURCE_ID,
      endpoint:
        process.env.VOLCENGINE_AST_ENDPOINT ?? DEFAULT_VOLCENGINE_AST_ENDPOINT,
    };
  }
```
Add `DEFAULT_VOLCENGINE_AST_ENDPOINT` and `DEFAULT_VOLCENGINE_AST_RESOURCE_ID` to the import from `./providers/providerConfig.js`.

- [ ] **Step 5: Update `.env.example`**

Append an AST block (no real values):
```
# Interpretation mode (豆包同声传译 / AST) — separately subscribed; resource volc.service_type.10053
VOLCENGINE_AST_APP_KEY=
VOLCENGINE_AST_ACCESS_KEY=
# Optional overrides:
# VOLCENGINE_AST_RESOURCE_ID=volc.service_type.10053
# VOLCENGINE_AST_ENDPOINT=wss://openspeech.bytedance.com/api/v4/ast/v2/translate
```

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm --filter @echoflow/backend test providerConfig config`
Expected: PASS. NOTE: dropping the `DEFAULT_PROVIDER_CONFIG` fast-path may change one existing `config.test.ts`/`providerConfig.test.ts` assertion that expected `DEFAULT_PROVIDER_CONFIG` identity when all-fake — update it to assert the equivalent `{ asr:{provider:"fake"}, translation:{provider:"fake"} }` shape (do NOT weaken intent). Run the full backend suite to catch it: `pnpm --filter @echoflow/backend test`.
Run: `pnpm --filter @echoflow/backend typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/providers/providerConfig.ts apps/backend/src/config.ts apps/backend/src/providers/providerConfig.test.ts apps/backend/src/config.test.ts .env.example
git commit -m "feat(backend): add AST interpret config + entitlement predicate"
```

---

## Task 7: Factory gate flip + language error + session branch

**Files:**
- Modify: `apps/backend/src/realtime/subtitleSource.ts`
- Modify: `apps/backend/src/realtime/subtitleSourceFactory.ts`
- Modify: `apps/backend/src/realtime/subtitleSourceFactory.test.ts`
- Modify: `apps/backend/src/realtime/session.ts`
- Modify: `apps/backend/src/realtime/session.test.ts`

**Interfaces:**
- Consumes: `isInterpretAvailable`, `InterpretationSubtitleSource`, `isSupportedInterpretTarget`.
- Produces: `class ModeLanguageUnsupportedError extends Error { targetLanguage: string }`; the factory now builds interpret; the session maps the new error to `mode_language_unsupported`.

- [ ] **Step 1: Add the error class (failing factory test first)**

In `apps/backend/src/realtime/subtitleSource.ts`, add alongside `ModeUnavailableError`:

```ts
export class ModeLanguageUnsupportedError extends Error {
  constructor(public readonly targetLanguage: string) {
    super(`Target language "${targetLanguage}" is not supported in this mode`);
    this.name = "ModeLanguageUnsupportedError";
  }
}
```

In `apps/backend/src/realtime/subtitleSourceFactory.test.ts`, add:

```ts
import { ModeLanguageUnsupportedError } from "./subtitleSource.js";
import { InterpretationSubtitleSource } from "./interpretationSubtitleSource.js";

const AST_CONFIG = {
  asr: { provider: "fake" as const },
  translation: { provider: "fake" as const },
  interpret: { appKey: "a", accessKey: "b", resourceId: "r", endpoint: "wss://x" },
};

describe("createSubtitleSourceFactory — interpret", () => {
  it("builds an InterpretationSubtitleSource when configured + target supported", () => {
    const factory = createSubtitleSourceFactory(AST_CONFIG);
    expect(factory("interpret", "zh-CN")).toBeInstanceOf(InterpretationSubtitleSource);
  });
  it("throws ModeUnavailableError when interpret is not configured", () => {
    const factory = createSubtitleSourceFactory(DEFAULT_PROVIDER_CONFIG);
    expect(() => factory("interpret", "zh-CN")).toThrow(ModeUnavailableError);
  });
  it("throws ModeLanguageUnsupportedError for an unsupported target", () => {
    const factory = createSubtitleSourceFactory(AST_CONFIG);
    expect(() => factory("interpret", "ja")).toThrow(ModeLanguageUnsupportedError);
  });
});
```

(Keep the existing `ModeUnavailableError`/`pipeline` cases; ensure `ModeUnavailableError` is imported.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @echoflow/backend test subtitleSourceFactory`
Expected: FAIL — interpret still always throws `ModeUnavailableError`.

- [ ] **Step 3: Implement the factory branch**

Rewrite `apps/backend/src/realtime/subtitleSourceFactory.ts`:

```ts
import {
  createSpeechProvider,
  createTranslationProvider,
} from "../providers/providerFactory.js";
import {
  isInterpretAvailable,
  type ProviderConfig,
} from "../providers/providerConfig.js";
import { isSupportedInterpretTarget } from "../providers/astLanguages.js";
import { PipelineSubtitleSource } from "./pipelineSubtitleSource.js";
import { InterpretationSubtitleSource } from "./interpretationSubtitleSource.js";
import {
  ModeLanguageUnsupportedError,
  ModeUnavailableError,
  type SubtitleSourceFactory,
} from "./subtitleSource.js";

export function createSubtitleSourceFactory(
  config: ProviderConfig,
): SubtitleSourceFactory {
  return (mode, targetLanguage) => {
    if (mode === "pipeline") {
      return new PipelineSubtitleSource(
        createSpeechProvider(config.asr),
        createTranslationProvider(config.translation),
        targetLanguage,
      );
    }
    // interpret
    if (!isInterpretAvailable(config) || config.interpret === undefined) {
      throw new ModeUnavailableError(mode);
    }
    if (!isSupportedInterpretTarget(targetLanguage)) {
      throw new ModeLanguageUnsupportedError(targetLanguage);
    }
    return new InterpretationSubtitleSource(config.interpret, targetLanguage);
  };
}
```

- [ ] **Step 4: Add the session catch branch (test first)**

In `apps/backend/src/realtime/session.test.ts`, add a case mirroring the existing `mode_unavailable` test but for a factory that throws `ModeLanguageUnsupportedError`, asserting the socket receives `{ type: "error", code: "mode_language_unsupported" }` and is NOT closed (reuse the suite's stub-factory + FakeSocket helpers):

```ts
import { ModeLanguageUnsupportedError } from "./subtitleSource.js";

it("maps ModeLanguageUnsupportedError to a non-fatal mode_language_unsupported error", async () => {
  // build a session whose createSubtitleSource throws ModeLanguageUnsupportedError,
  // deliver a start message, then assert (mirror the mode_unavailable test):
  // - sentEvents contains { type: "error", code: "mode_language_unsupported", ... }
  // - the socket was NOT closed (readyState still OPEN)
});
```

- [ ] **Step 5: Run it to confirm it fails**

Run: `pnpm --filter @echoflow/backend test session`
Expected: FAIL — the new error currently falls through to `provider_error`.

- [ ] **Step 6: Implement the session branch**

In `apps/backend/src/realtime/session.ts`, extend the `openSource` catch (add a branch before the `ModeUnavailableError` check or after — order does not matter since they are distinct types), and import the error:

```ts
import {
  ModeLanguageUnsupportedError,
  ModeUnavailableError,
  type SubtitleSourceFactory,
  type SubtitleSourceStream,
} from "./subtitleSource.js";
```
```ts
    } catch (error: unknown) {
      if (error instanceof ModeUnavailableError) {
        this.sendError("mode_unavailable", error.message);
        return;
      }
      if (error instanceof ModeLanguageUnsupportedError) {
        this.sendError("mode_language_unsupported", error.message);
        return;
      }
      this.sendError("provider_error", getErrorMessage(error));
      return;
    }
```

- [ ] **Step 7: Run the full backend suite + typecheck**

Run: `pnpm --filter @echoflow/backend test`
Expected: all green (factory + session + everything else).
Run: `pnpm --filter @echoflow/backend typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/realtime/subtitleSource.ts apps/backend/src/realtime/subtitleSourceFactory.ts apps/backend/src/realtime/subtitleSourceFactory.test.ts apps/backend/src/realtime/session.ts apps/backend/src/realtime/session.test.ts
git commit -m "feat(backend): flip interpret gate to AST + language-unsupported error"
```

---

## Task 8: Extension — constrain target language for interpret

**Files:**
- Modify: `apps/extension/src/settings/settings.ts`
- Modify: `apps/extension/src/settings/settings.test.ts`
- Modify: `apps/extension/entrypoints/options/main.tsx`

**Interfaces:**
- Produces: `INTERPRET_TARGET_LANGUAGE_OPTIONS`; `targetOptionsForMode(mode): readonly {value;label}[]`; `coerceTargetForMode(mode, target): string`.

- [ ] **Step 1: Write the failing test**

In `apps/extension/src/settings/settings.test.ts`, add:

```ts
import {
  INTERPRET_TARGET_LANGUAGE_OPTIONS,
  TARGET_LANGUAGE_OPTIONS,
  targetOptionsForMode,
  coerceTargetForMode,
} from "./settings";

describe("interpret target constraints", () => {
  it("pipeline mode offers the full target list", () => {
    expect(targetOptionsForMode("pipeline")).toEqual(TARGET_LANGUAGE_OPTIONS);
  });
  it("interpret mode offers only zh-CN, zh-TW, en", () => {
    expect(targetOptionsForMode("interpret").map((o) => o.value).sort()).toEqual([
      "en",
      "zh-CN",
      "zh-TW",
    ]);
  });
  it("coerces an unsupported target to zh-CN for interpret, leaves it for pipeline", () => {
    expect(coerceTargetForMode("interpret", "ja")).toBe("zh-CN");
    expect(coerceTargetForMode("interpret", "en")).toBe("en");
    expect(coerceTargetForMode("pipeline", "ja")).toBe("ja");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @echoflow/extension test settings`
Expected: FAIL — helpers not defined.

- [ ] **Step 3: Implement the settings helpers**

In `apps/extension/src/settings/settings.ts`, after `TARGET_LANGUAGE_OPTIONS`, add:

```ts
export const INTERPRET_TARGET_LANGUAGE_OPTIONS = TARGET_LANGUAGE_OPTIONS.filter(
  (option) => option.value === "zh-CN" || option.value === "zh-TW" || option.value === "en"
);

export function targetOptionsForMode(
  mode: SubtitleMode
): readonly { value: string; label: string }[] {
  return mode === "interpret"
    ? INTERPRET_TARGET_LANGUAGE_OPTIONS
    : TARGET_LANGUAGE_OPTIONS;
}

export function coerceTargetForMode(mode: SubtitleMode, target: string): string {
  if (mode !== "interpret") {
    return target;
  }
  return INTERPRET_TARGET_LANGUAGE_OPTIONS.some((option) => option.value === target)
    ? target
    : "zh-CN";
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `pnpm --filter @echoflow/extension test settings`
Expected: PASS.

- [ ] **Step 5: Wire the options page**

In `apps/extension/entrypoints/options/main.tsx`:
1. Import the helpers:
```ts
import {
  type ExtensionSettings,
  type SettingsValidationErrors,
  SUBTITLE_MODE_OPTIONS,
  TARGET_LANGUAGE_OPTIONS,
  coerceTargetForMode,
  targetOptionsForMode,
  loadSettings,
  saveSettings,
  validateSettings
} from "../../src/settings/settings";
```
(`TARGET_LANGUAGE_OPTIONS` may become unused after the change — remove it from the import if so, to keep typecheck clean.)
2. Replace the target-language `<select>`'s option source with `targetOptionsForMode(settings.mode)`:
```tsx
            {targetOptionsForMode(settings.mode).map((language) => (
              <option key={language.value} value={language.value}>
                {language.label}
              </option>
            ))}
```
3. When the mode changes, coerce the target so an unsupported stored value cannot persist. Update the mode `<select>` `onChange`:
```tsx
            onChange={(event) => {
              const nextMode = event.currentTarget.value as ExtensionSettings["mode"];
              updateSetting("mode", nextMode);
              updateSetting(
                "targetLanguage",
                coerceTargetForMode(nextMode, settings.targetLanguage)
              );
            }}
```

- [ ] **Step 6: Typecheck + tests**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: clean.
Run: `pnpm --filter @echoflow/extension test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add apps/extension/src/settings/settings.ts apps/extension/src/settings/settings.test.ts apps/extension/entrypoints/options/main.tsx
git commit -m "feat(extension): constrain target language to zh/en for interpret mode"
```

---

## Task 9: Full verification + manual e2e

**Files:** none (verification only)

- [ ] **Step 1: Whole workspace**

Run: `pnpm test`
Expected: protocol + backend + extension all green.

- [ ] **Step 2: Build/typecheck/lint**

Run: `pnpm build && pnpm typecheck && pnpm lint`
Expected: all succeed; `apps/extension/.output/chrome-mv3` builds.

- [ ] **Step 3: Manual e2e (record outcome)**

With real AST creds in `.env` and AST subscribed:
1. Backend up; extension loaded; options set mode = **实时 (付费)** — confirm the target list shows only Chinese/English and a previously-`ja` target was coerced to `zh-CN`.
2. Play English audio in a tab → confirm bilingual subtitles appear in ~2–3 s: the source (English) line updates live, the Chinese line lands a beat later.
3. Toggle back to **一致 (免费)** → confirm the finalized-only pipeline path resumes and the full 8-language target list returns.
4. With AST creds REMOVED from `.env`, select interpret → confirm the overlay shows the `mode_unavailable` banner (gate closed), and pipeline still works.

Record the observed latency and any frame-shape corrections back into the Task 0 reference if reality differed.

---

## Notes

- The wire `ServerEvent` shape is unchanged; the overlay/reducer are untouched. The thin session gains only the one `mode_language_unsupported` catch branch.
- `interpret` remains gated by config-presence; real per-user auth/billing attaches at the factory gate and the `UsageResponse` log (future cycle).
- Task 0 is the authoritative source for all vendor wire specifics; if a later task's inferred constant or boundary trigger conflicts with the captured frames, the reference wins.
