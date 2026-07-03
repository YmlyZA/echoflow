import { describe, expect, it } from "vitest";
import type { ServerEvent } from "@echoflow/protocol";
import type {
  AstConnectOptions,
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
  options: () => AstConnectOptions | undefined;
  closes: () => number;
} {
  let cbs: AstTransportCallbacks | undefined;
  let opts: AstConnectOptions | undefined;
  const sent: Buffer[] = [];
  let closes = 0;
  const factory: AstTransportFactory = (options, callbacks) => {
    opts = options;
    cbs = callbacks;
    const transport: AstTransport = {
      send: (d) => sent.push(d),
      close: () => {
        closes += 1;
      },
    };
    return transport;
  };
  return {
    factory,
    emit: (data) => cbs?.onMessage(data),
    fail: (error) => cbs?.onError(error),
    sent,
    options: () => opts,
    closes: () => closes,
  };
}

const CONFIG = {
  apiKey: "ak",
  resourceId: "volc.service_type.10053",
  endpoint: "wss://x",
};

// Bare TranslateResponse protobuf vectors (no frame envelope).
// SourceSubtitleResponse: event(2)=651 [10 8b05], text(4)="hi" [22 02 6869]
const SOURCE_HEX = "108b0522026869";
// TranslationSubtitleEnd: event(2)=655 [10 8f05], text(4)="你好" [22 06 e4bda0e5a5bd]
const TRANSLATION_END_HEX = "108f052206e4bda0e5a5bd";

describe("InterpretationSubtitleSource", () => {
  it("connects with new-console auth headers (X-Api-Key + X-Api-Resource-Id)", () => {
    const t = stubTransport();
    const source = new InterpretationSubtitleSource(CONFIG, "en", "zh-CN", t.factory);
    source.open({ onEvent: () => {} });
    const headers = t.options()?.headers ?? {};
    expect(headers["X-Api-Key"]).toBe("ak");
    expect(headers["X-Api-Resource-Id"]).toBe("volc.service_type.10053");
    // old-console headers must not be sent
    expect(headers["X-Api-App-Key"]).toBeUndefined();
    expect(headers["X-Api-Access-Key"]).toBeUndefined();
  });

  it("emits a language event and forwards a partial for a source frame", () => {
    const t = stubTransport();
    const events: ServerEvent[] = [];
    const source = new InterpretationSubtitleSource(CONFIG, "en", "zh-CN", t.factory);
    source.open({ onEvent: (e) => events.push(e) });
    t.emit(Buffer.from(SOURCE_HEX, "hex"));
    expect(events).toContainEqual({
      type: "language",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
    expect(events).toContainEqual({
      type: "partial",
      segmentId: "ast-0",
      sourceText: "hi",
    });
  });

  it("emits a final with translation on a translation-end frame", () => {
    const t = stubTransport();
    const events: ServerEvent[] = [];
    const source = new InterpretationSubtitleSource(CONFIG, "en", "zh-CN", t.factory);
    source.open({ onEvent: (e) => events.push(e) });
    t.emit(Buffer.from(SOURCE_HEX, "hex"));
    t.emit(Buffer.from(TRANSLATION_END_HEX, "hex"));
    const finalEvents = events.filter((e) => e.type === "final");
    expect(finalEvents.length).toBeGreaterThan(0);
    const finalEvent = finalEvents[0];
    expect(finalEvent).toMatchObject({
      type: "final",
      sourceText: "hi",
      translatedText: "你好",
    });
  });

  it("routes an AST protocol error to onError directly (bypasses reconnect)", () => {
    const t = stubTransport();
    let errored: Error | undefined;
    const source = new InterpretationSubtitleSource(CONFIG, "en", "zh-CN", t.factory);
    source.open({ onEvent: () => {}, onError: (e) => (errored = e) });
    // Bare protobuf: ResponseMeta { StatusCode=11303, Message="boom" }
    // Field 1 wire 2 (0x0a), len 9, field 3 wire 0 (0x18) varint(11303)=[0xa7,0x58],
    // field 4 wire 2 (0x22), len 4, "boom"=[0x62,0x6f,0x6f,0x6d]
    t.emit(Buffer.from("0a0918a7582204626f6f6d", "hex"));
    expect(errored?.message).toBe("AST error 11303: boom");
  });

  it("re-sends StartSession and emits a status event on a retryable drop", () => {
    const sockets: Array<{ cb: any; sent: Buffer[] }> = [];
    const connect = (_opts: any, cb: any) => {
      const s = { cb, sent: [] as Buffer[] };
      sockets.push(s);
      return { send: (d: Buffer) => s.sent.push(d), close: () => {} };
    };
    const events: ServerEvent[] = [];
    let fireTimer: () => void = () => {};
    const source = new InterpretationSubtitleSource(
      CONFIG, "en", "zh-CN", connect, { setTimer: (fn) => { fireTimer = fn; } }
    );
    source.open({ onEvent: (e) => events.push(e) });
    expect(sockets[0]!.sent).toHaveLength(1);       // initial StartSession
    sockets[0]!.cb.onClose(1006, "abnormal");
    fireTimer();
    expect(sockets[1]!.sent).toHaveLength(1);        // StartSession re-sent
    expect(events).toContainEqual({ type: "status", state: "reconnecting" });
  });

  it("stops sending audio during the drain window and after end()", async () => {
    const t = stubTransport();
    let fireDrain: () => void = () => {};
    const source = new InterpretationSubtitleSource(CONFIG, "en", "zh-CN", t.factory, {
      setTimer: (fn) => {
        fireDrain = fn;
      },
    });
    const stream = source.open({ onEvent: () => {} });
    const afterOpen = t.sent.length; // StartSession

    const endPromise = stream.end(); // sends FinishSession, arms drain, awaits
    expect(t.sent.length).toBe(afterOpen + 1); // only FinishSession

    stream.pushFrame({ data: Buffer.from([1]), sequenceNumber: 1, timestampMs: 0 }); // during drain
    expect(t.sent.length).toBe(afterOpen + 1); // dropped

    fireDrain();
    await endPromise;

    stream.pushFrame({ data: Buffer.from([2]), sequenceNumber: 2, timestampMs: 0 }); // after end
    expect(t.sent.length).toBe(afterOpen + 1); // still dropped
  });

  it("close() unblocks a pending end() drain instead of waiting out the timeout", async () => {
    const t = stubTransport();
    const source = new InterpretationSubtitleSource(CONFIG, "en", "zh-CN", t.factory, {
      // Drain timeout never fires; only close()'s cancel can settle the drain,
      // so a hang here would mean the fix is missing.
      setTimer: () => {},
    });
    const stream = source.open({ onEvent: () => {} });

    const endPromise = stream.end(); // sends FinishSession, arms drain, awaits (no trailing final)
    await stream.close(); // disposes the transport -> cancels the drain

    await expect(endPromise).resolves.toBeUndefined();
  });

  it("end() is single-shot (FinishSession sent once)", async () => {
    const t = stubTransport();
    const source = new InterpretationSubtitleSource(CONFIG, "en", "zh-CN", t.factory, {
      setTimer: (fn) => fn(),
    });
    const stream = source.open({ onEvent: () => {} });
    const afterOpen = t.sent.length;
    await stream.end();
    await stream.end();
    expect(t.sent.length).toBe(afterOpen + 1);
  });

  it("close() is idempotent", async () => {
    const t = stubTransport();
    const source = new InterpretationSubtitleSource(CONFIG, "en", "zh-CN", t.factory, {
      setTimer: (fn) => fn(),
    });
    const stream = source.open({ onEvent: () => {} });
    await stream.close();
    await stream.close();
    expect(t.closes()).toBe(1);
  });

  it("close() after end() still closes the transport once", async () => {
    const t = stubTransport();
    const source = new InterpretationSubtitleSource(CONFIG, "en", "zh-CN", t.factory, {
      setTimer: (fn) => fn(),
    });
    const stream = source.open({ onEvent: () => {} });
    await stream.end();
    await stream.close();
    expect(t.closes()).toBe(1);
  });
});
