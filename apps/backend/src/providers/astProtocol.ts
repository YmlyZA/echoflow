import * as C from "./astConstants.js";

// ---- public types ----

export type AstStartSessionOptions = {
  sessionId: string;
  resourceId: string;
  /**
   * Explicit AST source language code (e.g. "en"). model:default has no
   * language pair for an empty source ("2zh" → "InvalidData ... not found"),
   * so auto-detect is NOT supported — a concrete source language is required.
   */
  sourceLanguage: string;
  targetLanguage: string;
  audio: { format: string; rate: number; bits: number; channel: number };
};

export type AstServerEvent =
  | { kind: "source"; text: string; final: boolean; startTime: number; endTime: number }
  | { kind: "translation"; text: string; final: boolean; startTime: number; endTime: number }
  | { kind: "usage"; details: string }
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

function writeBytesField(field: number, body: Buffer): Buffer {
  return Buffer.concat([writeTag(field, 2), writeVarint(body.length), body]);
}

// ---- minimal protobuf reader ----

type ProtoField = { wireType: number; value: bigint | Buffer };

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

function getString(fields: Map<number, ProtoField[]>, field: number): string {
  const f = fields.get(field)?.[0];
  return f && Buffer.isBuffer(f.value) ? f.value.toString("utf8") : "";
}

function getVarintNumber(fields: Map<number, ProtoField[]>, field: number): number {
  const f = fields.get(field)?.[0];
  return f && typeof f.value === "bigint" ? Number(f.value) : 0;
}

// ---- public encoders ----
//
// Each returns ONE bare serialized TranslateRequest protobuf (no frame header).
// The ws layer delivers it as a single binary message.

/** RequestMeta { SessionID(6), ResourceID(4)? }. */
function buildRequestMeta(sessionId: string, resourceId?: string): Buffer {
  const parts: Buffer[] = [];
  if (resourceId !== undefined) {
    parts.push(writeStringField(C.AST_REQMETA_FIELD_RESOURCE_ID, resourceId));
  }
  parts.push(writeStringField(C.AST_REQMETA_FIELD_SESSION_ID, sessionId));
  return Buffer.concat(parts);
}

export function encodeStartSession(opts: AstStartSessionOptions): Buffer {
  // Audio { format(4), rate(7), bits(8), channel(9) }
  const audioBody = Buffer.concat([
    writeStringField(C.AST_AUDIO_FIELD_FORMAT, opts.audio.format),
    writeVarintField(C.AST_AUDIO_FIELD_RATE, opts.audio.rate),
    writeVarintField(C.AST_AUDIO_FIELD_BITS, opts.audio.bits),
    writeVarintField(C.AST_AUDIO_FIELD_CHANNEL, opts.audio.channel),
  ]);

  // ReqParams { mode(1), source_language(2), target_language(3) }
  // source_language "" = auto-detect (no separate detect flag in AST proto)
  const reqBody = Buffer.concat([
    writeStringField(C.AST_REQPARAMS_FIELD_MODE, "s2t"),
    writeStringField(C.AST_REQPARAMS_FIELD_SOURCE_LANGUAGE, opts.sourceLanguage),
    writeStringField(C.AST_REQPARAMS_FIELD_TARGET_LANGUAGE, opts.targetLanguage),
  ]);

  // TranslateRequest { request_meta(1), event(2), source_audio(4), request(6) }
  return Buffer.concat([
    writeMessageField(
      C.AST_REQ_FIELD_REQUEST_META,
      buildRequestMeta(opts.sessionId, opts.resourceId),
    ),
    writeVarintField(C.AST_REQ_FIELD_EVENT, C.AST_EVENT_START_SESSION),
    writeMessageField(C.AST_REQ_FIELD_SOURCE_AUDIO, audioBody),
    writeMessageField(C.AST_REQ_FIELD_REQUEST, reqBody),
  ]);
}

export function encodeAudioRequest(audio: Buffer, sessionId: string): Buffer {
  // Audio { binary_data(14) }
  const audioBody = writeBytesField(C.AST_AUDIO_FIELD_BINARY_DATA, audio);

  // TranslateRequest { request_meta(1), event(2)=TaskRequest, source_audio(4) }
  return Buffer.concat([
    writeMessageField(C.AST_REQ_FIELD_REQUEST_META, buildRequestMeta(sessionId)),
    writeVarintField(C.AST_REQ_FIELD_EVENT, C.AST_EVENT_TASK_REQUEST),
    writeMessageField(C.AST_REQ_FIELD_SOURCE_AUDIO, audioBody),
  ]);
}

export function encodeFinishSession(sessionId: string): Buffer {
  // TranslateRequest { request_meta(1), event(2)=FinishSession }
  return Buffer.concat([
    writeMessageField(C.AST_REQ_FIELD_REQUEST_META, buildRequestMeta(sessionId)),
    writeVarintField(C.AST_REQ_FIELD_EVENT, C.AST_EVENT_FINISH_SESSION),
  ]);
}

// ---- public parser ----

export function parseAstMessage(data: Buffer): AstServerEvent {
  // A bare TranslateResponse protobuf: { response_meta(1), event(2), text(4),
  // start_time(5), end_time(6) }.
  const fields = readMessage(data);
  const event = getVarintNumber(fields, C.AST_RESP_FIELD_EVENT);

  // Errors arrive via response_meta.StatusCode — sometimes with event=0 (None),
  // e.g. a gateway "cannot parse payload" rejection — so check status first.
  const error = parseError(fields);
  if (error !== undefined) {
    return error;
  }

  switch (event) {
    case C.AST_EVENT_SOURCE_RESPONSE:
      return { kind: "source", final: false, ...parseSubtitle(fields) };

    case C.AST_EVENT_SOURCE_END:
      return { kind: "source", final: true, ...parseSubtitle(fields) };

    case C.AST_EVENT_TRANSLATION_RESPONSE:
      return { kind: "translation", final: false, ...parseSubtitle(fields) };

    case C.AST_EVENT_TRANSLATION_END:
      return { kind: "translation", final: true, ...parseSubtitle(fields) };

    case C.AST_EVENT_USAGE:
      return { kind: "usage", details: describeFields(fields) };

    default:
      return { kind: "other" };
  }
}

/** Read TranslateResponse text (4), start_time (5), end_time (6). */
function parseSubtitle(
  fields: Map<number, ProtoField[]>,
): { text: string; startTime: number; endTime: number } {
  return {
    text: getString(fields, C.AST_RESP_FIELD_TEXT),
    startTime: getVarintNumber(fields, C.AST_RESP_FIELD_START_TIME),
    endTime: getVarintNumber(fields, C.AST_RESP_FIELD_END_TIME),
  };
}

/**
 * Compact, deterministic rendering of a message's top-level fields — varints
 * as `n=value`, length-delimited as `n=bytes(len)` — ascending field order,
 * skipping the event field. No semantic interpretation: the usage payload's
 * field meanings are unverified, and each logged line doubles as a sample for
 * a future structured decode.
 */
function describeFields(fields: Map<number, ProtoField[]>): string {
  const parts: string[] = [];
  for (const field of [...fields.keys()].sort((a, b) => a - b)) {
    if (field === C.AST_RESP_FIELD_EVENT) {
      continue;
    }
    for (const entry of fields.get(field) ?? []) {
      parts.push(
        Buffer.isBuffer(entry.value)
          ? `${field}=bytes(${entry.value.length})`
          : `${field}=${entry.value}`,
      );
    }
  }
  return parts.join(" ");
}

/**
 * Surface an error if response_meta (field 1) carries a failing StatusCode.
 * 0 (unset) and SUCCESS(21000) are not errors; anything else is.
 */
function parseError(
  fields: Map<number, ProtoField[]>,
): (AstServerEvent & { kind: "error" }) | undefined {
  const metaRaw = fields.get(C.AST_RESP_FIELD_RESPONSE_META)?.[0]?.value;
  if (!Buffer.isBuffer(metaRaw)) {
    return undefined;
  }
  const meta = readMessage(metaRaw);
  const code = getVarintNumber(meta, C.AST_META_FIELD_STATUS_CODE);
  if (C.isAstOkStatus(code)) {
    return undefined;
  }
  return { kind: "error", code, message: getString(meta, C.AST_META_FIELD_MESSAGE) };
}
