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
} {
  let cbs: AstTransportCallbacks | undefined;
  let opts: AstConnectOptions | undefined;
  const sent: Buffer[] = [];
  const factory: AstTransportFactory = (options, callbacks) => {
    opts = options;
    cbs = callbacks;
    const transport: AstTransport = { send: (d) => sent.push(d), close: () => {} };
    return transport;
  };
  return {
    factory,
    emit: (data) => cbs?.onMessage(data),
    fail: (error) => cbs?.onError(error),
    sent,
    options: () => opts,
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
    const source = new InterpretationSubtitleSource(CONFIG, "zh-CN", t.factory);
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
    const source = new InterpretationSubtitleSource(CONFIG, "zh-CN", t.factory);
    source.open({ onEvent: (e) => events.push(e) });
    t.emit(Buffer.from(SOURCE_HEX, "hex"));
    expect(events).toContainEqual({
      type: "language",
      sourceLanguage: "en", // counterpart of zh target (auto-detect unsupported by AST)
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
    const source = new InterpretationSubtitleSource(CONFIG, "zh-CN", t.factory);
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

  it("routes a transport error to onError", () => {
    const t = stubTransport();
    let errored: Error | undefined;
    const source = new InterpretationSubtitleSource(CONFIG, "zh-CN", t.factory);
    source.open({ onEvent: () => {}, onError: (e) => (errored = e) });
    t.fail(new Error("boom"));
    expect(errored?.message).toBe("boom");
  });
});
