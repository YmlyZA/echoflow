import { gunzipSync, gzipSync } from "node:zlib";
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
  let closes = 0;
  let callbacks: VolcengineAsrTransportCallbacks | undefined;
  const factory: VolcengineAsrTransportFactory = (_options, cbs) => {
    callbacks = cbs;
    return {
      send: (data: Buffer) => sent.push(data),
      close: () => {
        closes += 1;
      },
    };
  };
  return {
    factory,
    sent,
    emit: (message: Buffer) => callbacks?.onMessage(message),
    fail: (error: Error) => callbacks?.onError(error),
    closes: () => closes,
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

  it("requests incremental VAD-segmented results in the full client request", () => {
    const transport = createFakeTransport();
    const provider = new VolcengineSpeechProvider(
      { ...CONFIG, vadSegmentDurationMs: 800 },
      transport.factory,
    );
    provider.open({ onSegment: () => {} });

    const frame = transport.sent[0]!;
    const size = frame.readUInt32BE(8);
    const config = JSON.parse(gunzipSync(frame.subarray(12, 12 + size)).toString("utf8"));
    expect(config.request).toEqual({
      model_name: "bigmodel",
      enable_punc: true,
      result_type: "single",
      show_utterances: true,
      vad_segment_duration: 800,
    });
  });

  it("re-sends the config frame and reports status on a retryable drop", () => {
    const sockets: Array<{ cb: any; sent: Buffer[] }> = [];
    const connect = (_opts: any, cb: any) => {
      const s = { cb, sent: [] as Buffer[] };
      sockets.push(s);
      return { send: (d: Buffer) => s.sent.push(d), close: () => {} };
    };
    const statuses: string[] = [];
    let fireTimer: () => void = () => {};
    const provider = new VolcengineSpeechProvider(CONFIG, connect, {
      setTimer: (fn) => { fireTimer = fn; }
    });
    provider.open({ onSegment: () => {}, onStatus: (s) => statuses.push(s) });
    expect(sockets[0]!.sent).toHaveLength(1);      // initial config frame
    sockets[0]!.cb.onClose(1006, "abnormal");
    expect(statuses).toEqual(["reconnecting"]);
    fireTimer();
    expect(sockets[1]!.sent).toHaveLength(1);      // config re-sent on reconnect
  });

  it("stops sending audio during the drain window and after end()", async () => {
    const transport = createFakeTransport();
    let fireDrain: () => void = () => {};
    const provider = new VolcengineSpeechProvider(CONFIG, transport.factory, {
      setTimer: (fn) => {
        fireDrain = fn;
      },
    });
    const stream = provider.open({ onSegment: () => {} });
    const afterOpen = transport.sent.length; // config frame(s)

    const endPromise = stream.end(); // sends the last frame, arms drain, awaits (timer captured)
    expect(transport.sent.length).toBe(afterOpen + 1); // only the isLast frame

    stream.pushFrame({ data: Buffer.from([1]), sequenceNumber: 1, timestampMs: 0 }); // during drain
    expect(transport.sent.length).toBe(afterOpen + 1); // dropped — no audio after end()

    fireDrain();
    await endPromise;

    stream.pushFrame({ data: Buffer.from([2]), sequenceNumber: 2, timestampMs: 0 }); // after end
    expect(transport.sent.length).toBe(afterOpen + 1); // still dropped
  });

  it("end() is single-shot (last frame sent once)", async () => {
    const transport = createFakeTransport();
    const provider = new VolcengineSpeechProvider(CONFIG, transport.factory, {
      setTimer: (fn) => fn(),
    });
    const stream = provider.open({ onSegment: () => {} });
    const afterOpen = transport.sent.length;
    await stream.end();
    await stream.end();
    expect(transport.sent.length).toBe(afterOpen + 1);
  });

  it("close() is idempotent", async () => {
    const transport = createFakeTransport();
    const provider = new VolcengineSpeechProvider(CONFIG, transport.factory, {
      setTimer: (fn) => fn(),
    });
    const stream = provider.open({ onSegment: () => {} });
    await stream.close();
    await stream.close();
    expect(transport.closes()).toBe(1);
  });

  it("close() after end() still closes the transport once", async () => {
    const transport = createFakeTransport();
    const provider = new VolcengineSpeechProvider(CONFIG, transport.factory, {
      setTimer: (fn) => fn(),
    });
    const stream = provider.open({ onSegment: () => {} });
    await stream.end();
    await stream.close();
    expect(transport.closes()).toBe(1);
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
