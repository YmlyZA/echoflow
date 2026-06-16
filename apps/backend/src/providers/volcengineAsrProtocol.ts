import { gunzipSync, gzipSync } from "node:zlib";

const PROTOCOL_VERSION = 0b0001;
const HEADER_SIZE = 0b0001;

const FULL_CLIENT_REQUEST = 0b0001;
const AUDIO_ONLY_REQUEST = 0b0010;
const SERVER_ERROR_RESPONSE = 0b1111;

const POS_SEQUENCE = 0b0001;
const NEG_WITH_SEQUENCE = 0b0011;

const JSON_SERIALIZATION = 0b0001;
const GZIP = 0b0001;

const FLAG_HAS_SEQUENCE = 0b0001;
const FLAG_LAST_PACKET = 0b0010;

export type VolcengineAsrRequestConfig = {
  user: { uid: string };
  audio: {
    format: string;
    sample_rate: number;
    bits: number;
    channel: number;
    codec: string;
  };
  request: { model_name: string; enable_punc: boolean };
};

export type VolcengineUtterance = {
  text?: string;
  definite?: boolean;
  start_time?: number;
  end_time?: number;
};

export type VolcengineAsrResult = {
  result?: {
    text?: string;
    language?: string;
    utterances?: VolcengineUtterance[];
  };
};

export type VolcengineServerMessage =
  | { type: "response"; isLast: boolean; payload: VolcengineAsrResult }
  | { type: "error"; code: number; message: string };

function buildHeader(messageType: number, flags: number): Buffer {
  return Buffer.from([
    (PROTOCOL_VERSION << 4) | HEADER_SIZE,
    (messageType << 4) | flags,
    (JSON_SERIALIZATION << 4) | GZIP,
    0x00,
  ]);
}

function framePayload(header: Buffer, sequence: number, payload: Buffer): Buffer {
  const sequenceBytes = Buffer.alloc(4);
  sequenceBytes.writeInt32BE(sequence, 0);
  const sizeBytes = Buffer.alloc(4);
  sizeBytes.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, sequenceBytes, sizeBytes, payload]);
}

export function encodeFullClientRequest(config: VolcengineAsrRequestConfig): Buffer {
  const header = buildHeader(FULL_CLIENT_REQUEST, POS_SEQUENCE);
  const payload = gzipSync(Buffer.from(JSON.stringify(config), "utf8"));
  return framePayload(header, 1, payload);
}

export function encodeAudioRequest(
  audio: Buffer,
  sequence: number,
  isLast: boolean,
): Buffer {
  const flags = isLast ? NEG_WITH_SEQUENCE : POS_SEQUENCE;
  const header = buildHeader(AUDIO_ONLY_REQUEST, flags);
  const payload = gzipSync(audio);
  return framePayload(header, isLast ? -sequence : sequence, payload);
}

export function parseServerMessage(data: Buffer): VolcengineServerMessage {
  const headerSize = data[0]! & 0x0f;
  const messageType = data[1]! >> 4;
  const flags = data[1]! & 0x0f;
  const compression = data[2]! & 0x0f;

  let offset = headerSize * 4;
  const isLast = (flags & FLAG_LAST_PACKET) !== 0;
  if ((flags & FLAG_HAS_SEQUENCE) !== 0) {
    offset += 4; // skip the sequence prefix
  }

  if (messageType === SERVER_ERROR_RESPONSE) {
    const code = data.readUInt32BE(offset);
    offset += 4;
    const size = data.readUInt32BE(offset);
    offset += 4;
    const body = decode(data.subarray(offset, offset + size), compression);
    return { type: "error", code, message: body.toString("utf8") };
  }

  const size = data.readUInt32BE(offset);
  offset += 4;
  const body = decode(data.subarray(offset, offset + size), compression);
  return {
    type: "response",
    isLast,
    payload: JSON.parse(body.toString("utf8")) as VolcengineAsrResult,
  };
}

function decode(body: Buffer, compression: number): Buffer {
  return compression === GZIP ? gunzipSync(body) : body;
}
