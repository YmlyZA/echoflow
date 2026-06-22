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

// Ground-truth hex vectors from astProtocol.test.ts
// SourceSubtitleResponse(651), text "hi"
const SOURCE_HEX = "119420000000028B0000000000000004220268 69".replace(/\s/g, "");
// TranslationSubtitleEnd(655), text "你好"
const TRANSLATION_END_HEX =
  "11942000000002 8F00000000000000082206E4BDA0E5A5BD".replace(/\s/g, "");

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
      sourceLanguage: "auto",
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
