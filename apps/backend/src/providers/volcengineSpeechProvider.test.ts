import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { SegmentEvent } from "./types.js";
import { VolcengineSpeechProvider } from "./volcengineSpeechProvider.js";
import type {
  VolcengineAsrTransportCallbacks,
  VolcengineAsrTransportFactory,
} from "./volcengineAsrTransport.js";

const CONFIG = {
  appKey: "app",
  accessKey: "secret",
  resourceId: "volc.bigasr.sauc.duration",
  endpoint: "wss://example.test/asr",
};

function createFakeTransport() {
  const sent: Buffer[] = [];
  let callbacks: VolcengineAsrTransportCallbacks | undefined;
  const factory: VolcengineAsrTransportFactory = (_options, cbs) => {
    callbacks = cbs;
    return {
      send: (data: Buffer) => sent.push(data),
      close: () => {},
    };
  };
  return {
    factory,
    sent,
    emit: (message: Buffer) => callbacks?.onMessage(message),
    fail: (error: Error) => callbacks?.onError(error),
  };
}

function serverResponse(payload: unknown): Buffer {
  const header = Buffer.from([
    (0b0001 << 4) | 0b0001,
    (0b1001 << 4) | 0b0000,
    (0b0001 << 4) | 0b0001,
    0x00,
  ]);
  const body = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, size, body]);
}

function serverError(code: number, message: string): Buffer {
  const header = Buffer.from([
    (0b0001 << 4) | 0b0001,
    (0b1111 << 4) | 0b0000,
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

describe("VolcengineSpeechProvider", () => {
  it("sends a full client request on open", () => {
    const transport = createFakeTransport();
    const provider = new VolcengineSpeechProvider(CONFIG, transport.factory);
    provider.open({ onSegment: () => {} });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]![1]).toBe((0b0001 << 4) | 0b0001); // FULL_CLIENT_REQUEST
  });

  it("sends an audio-only request per frame", () => {
    const transport = createFakeTransport();
    const provider = new VolcengineSpeechProvider(CONFIG, transport.factory);
    const stream = provider.open({ onSegment: () => {} });
    stream.pushFrame({ data: Buffer.from([1, 2]), sequenceNumber: 0, timestampMs: 0 });
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]![1]).toBe((0b0010 << 4) | 0b0001); // AUDIO_ONLY | POS_SEQUENCE
  });

  it("emits a one-time language event then reconciled segments", () => {
    const transport = createFakeTransport();
    const provider = new VolcengineSpeechProvider(CONFIG, transport.factory);
    const events: SegmentEvent[] = [];
    provider.open({ onSegment: (event) => events.push(event) });

    transport.emit(
      serverResponse({ result: { utterances: [{ text: "hello", definite: false }] } }),
    );
    transport.emit(
      serverResponse({
        result: { utterances: [{ text: "hello", definite: true, start_time: 0, end_time: 500 }] },
      }),
    );

    expect(events).toEqual([
      { kind: "language", sourceLanguage: "auto" },
      { kind: "partial", segmentId: "seg-1", text: "hello", startTimeMs: 0 },
      { kind: "final", segmentId: "seg-1", text: "hello", startTimeMs: 0, endTimeMs: 500 },
    ]);
  });

  it("routes a server error response to onError", () => {
    const transport = createFakeTransport();
    const provider = new VolcengineSpeechProvider(CONFIG, transport.factory);
    const errors: Error[] = [];
    provider.open({ onSegment: () => {}, onError: (error) => errors.push(error) });

    transport.emit(serverError(45000001, "bad request"));

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("45000001");
  });

  it("sends a negated last packet on end", async () => {
    const transport = createFakeTransport();
    const provider = new VolcengineSpeechProvider(CONFIG, transport.factory);
    const stream = provider.open({ onSegment: () => {} });
    await stream.end();
    const last = transport.sent[transport.sent.length - 1]!;
    expect(last[1]).toBe((0b0010 << 4) | 0b0011); // AUDIO_ONLY | NEG_WITH_SEQUENCE
    expect(last.readInt32BE(4)).toBeLessThan(0);
  });

  it("ignores frames and messages after close", () => {
    const transport = createFakeTransport();
    const provider = new VolcengineSpeechProvider(CONFIG, transport.factory);
    const events: SegmentEvent[] = [];
    const stream = provider.open({ onSegment: (event) => events.push(event) });
    const sentAfterOpen = transport.sent.length; // the full client request

    void stream.close();
    stream.pushFrame({ data: Buffer.from([1, 2]), sequenceNumber: 0, timestampMs: 0 });
    transport.emit(
      serverResponse({ result: { utterances: [{ text: "late", definite: true }] } }),
    );

    expect(transport.sent).toHaveLength(sentAfterOpen); // pushFrame after close sent nothing
    expect(events).toEqual([]); // late server message produced no events
  });
});
