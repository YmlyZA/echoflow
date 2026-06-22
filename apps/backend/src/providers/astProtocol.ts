import * as C from "./astConstants.js";

// ---- public types ----

export type AstStartSessionOptions = {
  sessionId: string;
  /** When true, source_language is sent as "" (auto-detect). No separate proto field exists. */
  sourceLanguageDetect: boolean;
  targetLanguage: string;
  audio: { format: string; rate: number; bits: number; channel: number };
};

export type AstServerEvent =
  | { kind: "source"; text: string; final: boolean; startTime: number; endTime: number }
  | { kind: "translation"; text: string; final: boolean; startTime: number; endTime: number }
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

// ---- frame header & envelope ----

function buildHeader(messageType: number, serialization: number): Buffer {
  return Buffer.from([
    (C.AST_PROTOCOL_VERSION << 4) | C.AST_HEADER_SIZE,
    (messageType << 4) | C.AST_FLAGS_WITH_EVENT,
    (serialization << 4) | C.AST_COMPRESSION_NONE,
    0x00,
  ]);
}

/**
 * Build an AST event-protocol frame.
 * Layout: header[4] | event(int32BE)[4] | sidLen(uint32BE)[4] | sessionId(UTF-8) | payloadLen(uint32BE)[4] | payload
 */
function buildEventFrame(
  messageType: number,
  serialization: number,
  event: number,
  sessionId: string,
  payload: Buffer,
): Buffer {
  const header = buildHeader(messageType, serialization);

  const eventBuf = Buffer.alloc(4);
  eventBuf.writeInt32BE(event, 0);

  const sidBytes = Buffer.from(sessionId, "utf8");
  const sidLenBuf = Buffer.alloc(4);
  sidLenBuf.writeUInt32BE(sidBytes.length, 0);

  const payloadLenBuf = Buffer.alloc(4);
  payloadLenBuf.writeUInt32BE(payload.length, 0);

  return Buffer.concat([header, eventBuf, sidLenBuf, sidBytes, payloadLenBuf, payload]);
}

// ---- public encoders ----

export function encodeStartSession(opts: AstStartSessionOptions): Buffer {
  // Audio sub-message: Audio { format(4), rate(7), bits(8), channel(9) }
  const audioBody = Buffer.concat([
    writeStringField(C.AST_AUDIO_FIELD_FORMAT, opts.audio.format),
    writeVarintField(C.AST_AUDIO_FIELD_RATE, opts.audio.rate),
    writeVarintField(C.AST_AUDIO_FIELD_BITS, opts.audio.bits),
    writeVarintField(C.AST_AUDIO_FIELD_CHANNEL, opts.audio.channel),
  ]);

  // ReqParams sub-message: { mode(1), source_language(2), target_language(3) }
  // source_language "" = auto-detect (no separate detect flag in AST proto)
  const reqBody = Buffer.concat([
    writeStringField(C.AST_REQPARAMS_FIELD_MODE, "s2t"),
    writeStringField(C.AST_REQPARAMS_FIELD_SOURCE_LANGUAGE, ""),
    writeStringField(C.AST_REQPARAMS_FIELD_TARGET_LANGUAGE, opts.targetLanguage),
  ]);

  // TranslateRequest: { event(2), source_audio(4), request(6) }
  const payload = Buffer.concat([
    writeVarintField(C.AST_REQ_FIELD_EVENT, C.AST_EVENT_START_SESSION),
    writeMessageField(C.AST_REQ_FIELD_SOURCE_AUDIO, audioBody),
    writeMessageField(C.AST_REQ_FIELD_REQUEST, reqBody),
  ]);

  return buildEventFrame(
    C.AST_MSG_TYPE_FULL_CLIENT,
    C.AST_SERIALIZATION_PROTOBUF,
    C.AST_EVENT_START_SESSION,
    opts.sessionId,
    payload,
  );
}

export function encodeAudioRequest(audio: Buffer, sessionId: string): Buffer {
  return buildEventFrame(
    C.AST_MSG_TYPE_AUDIO_ONLY,
    C.AST_SERIALIZATION_NONE,
    C.AST_EVENT_TASK_REQUEST,
    sessionId,
    audio,
  );
}

export function encodeFinishSession(sessionId: string): Buffer {
  return buildEventFrame(
    C.AST_MSG_TYPE_FULL_CLIENT,
    C.AST_SERIALIZATION_PROTOBUF,
    C.AST_EVENT_FINISH_SESSION,
    sessionId,
    Buffer.alloc(0),
  );
}

// ---- public parser ----

export function parseAstMessage(data: Buffer): AstServerEvent {
  // Frame layout: header[4] | event(int32BE)[4] | sidLen(uint32BE)[4] | sessionId | payloadLen(uint32BE)[4] | payload
  const event = data.readInt32BE(4);
  const sidLen = data.readUInt32BE(8);
  const payloadLenOffset = 12 + sidLen;
  const payloadLen = data.readUInt32BE(payloadLenOffset);
  const payloadStart = payloadLenOffset + 4;
  const payload = data.subarray(payloadStart, payloadStart + payloadLen);

  switch (event) {
    case C.AST_EVENT_SOURCE_RESPONSE:
      return { kind: "source", final: false, ...parseSubtitleFrame(payload) };

    case C.AST_EVENT_SOURCE_END:
      return { kind: "source", final: true, ...parseSubtitleFrame(payload) };

    case C.AST_EVENT_TRANSLATION_RESPONSE:
      return { kind: "translation", final: false, ...parseSubtitleFrame(payload) };

    case C.AST_EVENT_TRANSLATION_END:
      return { kind: "translation", final: true, ...parseSubtitleFrame(payload) };

    case C.AST_EVENT_USAGE:
      return { kind: "usage" };

    case C.AST_EVENT_SESSION_FAILED:
      return parseSessionFailed(payload);

    default:
      return { kind: "other" };
  }
}

/** Read TranslateResponse text (field 4), start_time (field 5), end_time (field 6) from a subtitle payload. */
function parseSubtitleFrame(payload: Buffer): { text: string; startTime: number; endTime: number } {
  const fields = readMessage(payload);
  return {
    text: getString(fields, C.AST_RESP_FIELD_TEXT),
    startTime: getVarintNumber(fields, C.AST_RESP_FIELD_START_TIME),
    endTime: getVarintNumber(fields, C.AST_RESP_FIELD_END_TIME),
  };
}

/**
 * Parse a SessionFailed(153) payload.
 * Error code/message live in TranslateResponse.response_meta (field 1) →
 * ResponseMeta.StatusCode (field 3) / ResponseMeta.Message (field 4).
 */
function parseSessionFailed(payload: Buffer): AstServerEvent & { kind: "error" } {
  const fields = readMessage(payload);
  const metaRaw = fields.get(C.AST_RESP_FIELD_RESPONSE_META)?.[0]?.value;
  const metaBuf = Buffer.isBuffer(metaRaw) ? metaRaw : Buffer.alloc(0);
  const meta = readMessage(metaBuf);

  const codeField = meta.get(C.AST_META_FIELD_STATUS_CODE)?.[0]?.value;
  const code = typeof codeField === "bigint" ? Number(codeField) : 0;
  const message = getString(meta, C.AST_META_FIELD_MESSAGE);

  return { kind: "error", code, message };
}
