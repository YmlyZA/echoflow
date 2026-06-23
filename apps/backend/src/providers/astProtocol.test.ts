import { describe, expect, it } from "vitest";
import * as C from "./astConstants.js";
import {
  encodeAudioRequest,
  encodeFinishSession,
  encodeStartSession,
  parseAstMessage,
} from "./astProtocol.js";

// --- tiny, codec-independent protobuf helpers for building/reading vectors ---

function varint(value: number): Buffer {
  const out: number[] = [];
  let n = value >>> 0;
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}
const tag = (field: number, wire: number): Buffer => varint((field << 3) | wire);
const vField = (field: number, v: number): Buffer => Buffer.concat([tag(field, 0), varint(v)]);
const sField = (field: number, s: string): Buffer => {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([tag(field, 2), varint(b.length), b]);
};
const mField = (field: number, body: Buffer): Buffer =>
  Buffer.concat([tag(field, 2), varint(body.length), body]);

type Decoded = Map<number, { wire: number; value: Buffer | number }>;
function readFields(buf: Buffer): Decoded {
  const m: Decoded = new Map();
  let o = 0;
  while (o < buf.length) {
    let shift = 0;
    let t = 0;
    for (;;) {
      const x = buf[o++] ?? 0;
      t |= (x & 0x7f) << shift;
      if ((x & 0x80) === 0) break;
      shift += 7;
    }
    const field = t >> 3;
    const wire = t & 7;
    if (wire === 0) {
      let s = 0;
      let v = 0;
      for (;;) {
        const x = buf[o++] ?? 0;
        v |= (x & 0x7f) << s;
        if ((x & 0x80) === 0) break;
        s += 7;
      }
      m.set(field, { wire, value: v >>> 0 });
    } else if (wire === 2) {
      let s = 0;
      let len = 0;
      for (;;) {
        const x = buf[o++] ?? 0;
        len |= (x & 0x7f) << s;
        if ((x & 0x80) === 0) break;
        s += 7;
      }
      m.set(field, { wire, value: buf.subarray(o, o + len) });
      o += len;
    } else {
      break;
    }
  }
  return m;
}
const sub = (d: Decoded, field: number): Decoded =>
  readFields(d.get(field)?.value as Buffer);
const str = (d: Decoded, field: number): string =>
  (d.get(field)?.value as Buffer).toString("utf8");
const num = (d: Decoded, field: number): number => d.get(field)?.value as number;

describe("astProtocol — encode (bare TranslateRequest protobuf)", () => {
  it("encodes StartSession with request_meta, event=100, ReqParams, source_audio", () => {
    const frame = encodeStartSession({
      sessionId: "sess-1",
      resourceId: "volc.service_type.10053",
      sourceLanguage: "en",
      targetLanguage: "zh",
      audio: { format: "pcm", rate: 16000, bits: 16, channel: 1 },
    });
    const f = readFields(frame);
    // no 4-byte envelope: byte 0 must be a protobuf tag (field 1, wire 2 → 0x0a)
    expect(frame[0]).toBe((C.AST_REQ_FIELD_REQUEST_META << 3) | 2);
    expect(num(f, C.AST_REQ_FIELD_EVENT)).toBe(C.AST_EVENT_START_SESSION);

    const meta = sub(f, C.AST_REQ_FIELD_REQUEST_META);
    expect(str(meta, C.AST_REQMETA_FIELD_SESSION_ID)).toBe("sess-1");
    expect(str(meta, C.AST_REQMETA_FIELD_RESOURCE_ID)).toBe("volc.service_type.10053");

    const req = sub(f, C.AST_REQ_FIELD_REQUEST);
    expect(str(req, C.AST_REQPARAMS_FIELD_MODE)).toBe("s2t");
    expect(str(req, C.AST_REQPARAMS_FIELD_SOURCE_LANGUAGE)).toBe("en"); // explicit, required
    expect(str(req, C.AST_REQPARAMS_FIELD_TARGET_LANGUAGE)).toBe("zh");

    const audio = sub(f, C.AST_REQ_FIELD_SOURCE_AUDIO);
    expect(str(audio, C.AST_AUDIO_FIELD_FORMAT)).toBe("pcm");
    expect(num(audio, C.AST_AUDIO_FIELD_RATE)).toBe(16000);
    expect(num(audio, C.AST_AUDIO_FIELD_BITS)).toBe(16);
    expect(num(audio, C.AST_AUDIO_FIELD_CHANNEL)).toBe(1);
  });

  it("encodes an AudioRequest with event=200 and raw PCM in Audio.binary_data(14)", () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    const frame = encodeAudioRequest(pcm, "sess-1");
    const f = readFields(frame);
    expect(num(f, C.AST_REQ_FIELD_EVENT)).toBe(C.AST_EVENT_TASK_REQUEST);
    expect(str(sub(f, C.AST_REQ_FIELD_REQUEST_META), C.AST_REQMETA_FIELD_SESSION_ID)).toBe(
      "sess-1",
    );
    const audio = sub(f, C.AST_REQ_FIELD_SOURCE_AUDIO);
    expect(audio.get(C.AST_AUDIO_FIELD_BINARY_DATA)?.value).toEqual(pcm);
  });

  it("encodes FinishSession with event=102 and the session id", () => {
    const frame = encodeFinishSession("sess-9");
    const f = readFields(frame);
    expect(num(f, C.AST_REQ_FIELD_EVENT)).toBe(C.AST_EVENT_FINISH_SESSION);
    expect(str(sub(f, C.AST_REQ_FIELD_REQUEST_META), C.AST_REQMETA_FIELD_SESSION_ID)).toBe(
      "sess-9",
    );
  });
});

describe("astProtocol — decode (bare TranslateResponse protobuf)", () => {
  it("decodes SourceSubtitleResponse(651) as a non-final source event", () => {
    const frame = Buffer.concat([
      vField(C.AST_RESP_FIELD_EVENT, C.AST_EVENT_SOURCE_RESPONSE),
      sField(C.AST_RESP_FIELD_TEXT, "hello"),
    ]);
    expect(parseAstMessage(frame)).toEqual({
      kind: "source",
      text: "hello",
      final: false,
      startTime: 0,
      endTime: 0,
    });
  });

  it("decodes TranslationSubtitleEnd(655) with timestamps as a final translation", () => {
    const frame = Buffer.concat([
      vField(C.AST_RESP_FIELD_EVENT, C.AST_EVENT_TRANSLATION_END),
      sField(C.AST_RESP_FIELD_TEXT, "你好"),
      vField(C.AST_RESP_FIELD_START_TIME, 1000),
      vField(C.AST_RESP_FIELD_END_TIME, 2500),
    ]);
    expect(parseAstMessage(frame)).toEqual({
      kind: "translation",
      text: "你好",
      final: true,
      startTime: 1000,
      endTime: 2500,
    });
  });

  it("surfaces an error from response_meta.StatusCode even when event is unset", () => {
    const meta = Buffer.concat([
      vField(C.AST_META_FIELD_STATUS_CODE, 11303),
      sField(C.AST_META_FIELD_MESSAGE, "busy"),
    ]);
    const frame = mField(C.AST_RESP_FIELD_RESPONSE_META, meta); // no event field
    expect(parseAstMessage(frame)).toEqual({ kind: "error", code: 11303, message: "busy" });
  });

  it("treats StatusCode SUCCESS(21000) as non-error and dispatches by event", () => {
    const meta = vField(C.AST_META_FIELD_STATUS_CODE, C.AST_STATUS_BACKEND_SUCCESS);
    const frame = Buffer.concat([
      mField(C.AST_RESP_FIELD_RESPONSE_META, meta),
      vField(C.AST_RESP_FIELD_EVENT, C.AST_EVENT_SOURCE_RESPONSE),
      sField(C.AST_RESP_FIELD_TEXT, "ok"),
    ]);
    expect(parseAstMessage(frame)).toEqual({
      kind: "source",
      text: "ok",
      final: false,
      startTime: 0,
      endTime: 0,
    });
  });

  it("maps UsageResponse(154) to a usage event and unknown events to other", () => {
    expect(parseAstMessage(vField(C.AST_RESP_FIELD_EVENT, C.AST_EVENT_USAGE))).toEqual({
      kind: "usage",
    });
    expect(
      parseAstMessage(vField(C.AST_RESP_FIELD_EVENT, C.AST_EVENT_SESSION_STARTED)),
    ).toEqual({ kind: "other" });
  });
});
