import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  encodeAudioRequest,
  encodeFullClientRequest,
  parseServerMessage,
  type VolcengineAsrRequestConfig,
} from "./volcengineAsrProtocol.js";

const CONFIG: VolcengineAsrRequestConfig = {
  user: { uid: "echoflow" },
  audio: { format: "pcm", sample_rate: 16000, bits: 16, channel: 1, codec: "raw" },
  request: { model_name: "bigmodel", enable_punc: true },
};

// Helpers that build server->client frames the same way the real server does,
// so parseServerMessage can be tested without a network.
function buildServerResponse(payload: unknown, isLast = false): Buffer {
  const header = Buffer.from([
    (0b0001 << 4) | 0b0001, // version | header size
    (0b1001 << 4) | (isLast ? 0b0010 : 0b0000), // FULL_SERVER_RESPONSE | flags
    (0b0001 << 4) | 0b0001, // JSON | GZIP
    0x00,
  ]);
  const body = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, size, body]);
}

function buildServerError(code: number, message: string): Buffer {
  const header = Buffer.from([
    (0b0001 << 4) | 0b0001,
    (0b1111 << 4) | 0b0000, // SERVER_ERROR_RESPONSE
    (0b0001 << 4) | 0b0001,
    0x00,
  ]);
  const codeBuf = Buffer.alloc(4);
  codeBuf.writeUInt32BE(code, 0);
  const body = gzipSync(Buffer.from(message, "utf8"));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, codeBuf, size, body]);
}

describe("encodeFullClientRequest", () => {
  it("frames a gzipped JSON config with sequence 1", () => {
    const frame = encodeFullClientRequest(CONFIG);
    expect(frame[0]).toBe((0b0001 << 4) | 0b0001);
    expect(frame[1]).toBe((0b0001 << 4) | 0b0001); // FULL_CLIENT_REQUEST | POS_SEQUENCE
    expect(frame[2]).toBe((0b0001 << 4) | 0b0001); // JSON | GZIP
    expect(frame.readInt32BE(4)).toBe(1); // sequence
    const size = frame.readUInt32BE(8);
    const body = frame.subarray(12, 12 + size);
    expect(JSON.parse(gunzipSync(body).toString("utf8"))).toEqual(CONFIG);
  });
});

describe("encodeAudioRequest", () => {
  it("frames a gzipped audio chunk with a positive sequence", () => {
    const audio = Buffer.from([1, 2, 3, 4]);
    const frame = encodeAudioRequest(audio, 5, false);
    expect(frame[1]).toBe((0b0010 << 4) | 0b0001); // AUDIO_ONLY | POS_SEQUENCE
    expect(frame.readInt32BE(4)).toBe(5);
    const size = frame.readUInt32BE(8);
    expect(Buffer.from(gunzipSync(frame.subarray(12, 12 + size)))).toEqual(audio);
  });

  it("marks the last packet with a negated sequence and the end flag", () => {
    const frame = encodeAudioRequest(Buffer.alloc(0), 9, true);
    expect(frame[1]).toBe((0b0010 << 4) | 0b0011); // AUDIO_ONLY | NEG_WITH_SEQUENCE
    expect(frame.readInt32BE(4)).toBe(-9);
  });
});

describe("parseServerMessage", () => {
  it("parses a full server response into the result payload", () => {
    const payload = { result: { text: "hi", utterances: [{ text: "hi", definite: true }] } };
    const message = parseServerMessage(buildServerResponse(payload, true));
    expect(message).toEqual({ type: "response", isLast: true, payload });
  });

  it("parses a server error response into a code and message", () => {
    const message = parseServerMessage(buildServerError(45000001, "bad request"));
    expect(message).toEqual({ type: "error", code: 45000001, message: "bad request" });
  });
});
