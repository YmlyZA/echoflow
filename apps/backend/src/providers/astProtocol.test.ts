import { describe, expect, it } from "vitest";
import {
  encodeAudioRequest,
  encodeFinishSession,
  encodeStartSession,
  parseAstMessage,
} from "./astProtocol.js";

describe("astProtocol", () => {
  // ---- encode tests ----

  it("encodes a StartSession frame with the correct bigmodel header bytes", () => {
    const frame = encodeStartSession({
      sessionId: "11111111-1111-1111-1111-111111111111",
      sourceLanguageDetect: true,
      targetLanguage: "zh",
      audio: { format: "pcm", rate: 16000, bits: 16, channel: 1 },
    });
    // byte 0: (version<<4)|headerSize = 0x11
    expect(frame[0]).toBe(0x11);
    // byte 1: FULL_CLIENT(0b0001)<<4 | WITH_EVENT(0b0100) = 0x14
    expect(frame[1]).toBe(0x14);
    // byte 2: PROTOBUF(0b0010)<<4 | NONE(0) = 0x20
    expect(frame[2]).toBe(0x20);
    // frame must be longer than just the header
    expect(frame.length).toBeGreaterThan(4);
    // event int32 at offset 4 must be 100 (StartSession)
    expect(frame.readInt32BE(4)).toBe(100);
    // sessionId round-trips: sidLen at offset 8, then the UUID bytes
    const sidLen = frame.readUInt32BE(8);
    expect(sidLen).toBe(36);
    const sid = frame.subarray(12, 12 + sidLen).toString("utf8");
    expect(sid).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("encodes an AudioRequest frame with raw PCM header and event 200", () => {
    const sid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const audio = Buffer.from([1, 2, 3]);
    const frame = encodeAudioRequest(audio, sid);
    // byte 1: AUDIO_ONLY(0b0010)<<4 | WITH_EVENT(0b0100) = 0x24
    expect(frame[1]).toBe(0x24);
    // byte 2: RAW(0)<<4 | NONE(0) = 0x00
    expect(frame[2]).toBe(0x00);
    // event at offset 4 = 200 (TaskRequest)
    expect(frame.readInt32BE(4)).toBe(200);
    // sessionId is present
    const sidLen = frame.readUInt32BE(8);
    expect(sidLen).toBe(36);
    // raw audio bytes appear in the payload
    const payloadStart = 12 + sidLen + 4; // after header+event+sidLen+sid+payloadLen
    expect(frame.subarray(payloadStart, payloadStart + 3)).toEqual(audio);
  });

  it("encodes a FinishSession frame with event 102", () => {
    const sid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const frame = encodeFinishSession(sid);
    expect(frame[0]).toBe(0x11);
    expect(frame[1]).toBe(0x14);
    expect(frame[2]).toBe(0x20);
    expect(frame.readInt32BE(4)).toBe(102);
    const sidLen = frame.readUInt32BE(8);
    expect(sidLen).toBe(36);
  });

  // ---- decode tests (ground-truth hex vectors) ----

  it("decodes SourceSubtitleResponse(651) with text 'hi' as non-final source event", () => {
    // Hand-computed vector: event=651, sidLen=0, payload=field4("hi")
    const hex = "119420000000028B0000000000000004220268 69".replace(/\s/g, "");
    const sample = Buffer.from(hex, "hex");
    expect(parseAstMessage(sample)).toEqual({
      kind: "source",
      text: "hi",
      final: false,
      startTime: 0,
      endTime: 0,
    });
  });

  it("decodes TranslationSubtitleEnd(655) with text '你好' as final translation event", () => {
    // Hand-computed vector: event=655, sidLen=0, payload=field4("你好")
    const hex = "11942000000002 8F00000000000000082206E4BDA0E5A5BD".replace(/\s/g, "");
    const sample = Buffer.from(hex, "hex");
    expect(parseAstMessage(sample)).toEqual({
      kind: "translation",
      text: "你好",
      final: true,
      startTime: 0,
      endTime: 0,
    });
  });

  it("decodes SourceSubtitleResponse(651) 'hi' with start_time=1000, end_time=2500", () => {
    // Hand-computed: event=651, sidLen=0, payload=field4("hi")+field5(1000)+field6(2500)
    // field4("hi"): 22 02 68 69
    // field5(varint 1000=0xE807): 28 E8 07
    // field6(varint 2500=0xC413): 30 C4 13
    // payload = 0A bytes: 22 02 68 69 28 E8 07 30 C4 13
    const hex = "119420000000028B000000000000000A2202686928E80730C413";
    const sample = Buffer.from(hex, "hex");
    expect(parseAstMessage(sample)).toEqual({
      kind: "source",
      text: "hi",
      final: false,
      startTime: 1000,
      endTime: 2500,
    });
  });

  it("decodes TranslationSubtitleEnd(655) '你好' with start_time=1000, end_time=2500", () => {
    // Hand-computed: event=655, sidLen=0, payload=field4("你好")+field5(1000)+field6(2500)
    // field4("你好"): 22 06 E4 BD A0 E5 A5 BD
    // field5(varint 1000=0xE807): 28 E8 07
    // field6(varint 2500=0xC413): 30 C4 13
    // payload = 0E bytes: 22 06 E4 BD A0 E5 A5 BD 28 E8 07 30 C4 13
    const hex = "119420000000028F000000000000000E2206E4BDA0E5A5BD28E80730C413";
    const sample = Buffer.from(hex, "hex");
    expect(parseAstMessage(sample)).toEqual({
      kind: "translation",
      text: "你好",
      final: true,
      startTime: 1000,
      endTime: 2500,
    });
  });

  it("decodes SessionFailed(153) with code 11303 and message 'busy'", () => {
    // Hand-computed vector: event=153, sidLen=0, nested response_meta{StatusCode=11303, Message="busy"}
    const hex = "1194200000000099000000000000000B0A0918A75822046275 7379".replace(/\s/g, "");
    const sample = Buffer.from(hex, "hex");
    expect(parseAstMessage(sample)).toEqual({
      kind: "error",
      code: 11303,
      message: "busy",
    });
  });

  it("decodes a frame with a non-zero sessionId, proving the payload offset is dynamic", () => {
    // Hand-computed vector: event=651, sidLen=36 (UUID), payload=field4("hi").
    // A parser that hardcoded the payload offset at 12 (instead of 12 + sidLen)
    // would read the session id as the payload and fail this case.
    const hex =
      "11942000 0000028B 00000024 " + // header, event=651, sidLen=36
      "3131313131313131 2D 31313131 2D 31313131 2D 31313131 2D 313131313131313131313131 " + // "11111111-1111-1111-1111-111111111111"
      "00000004 22026869"; // payloadLen=4, field4("hi")
    const sample = Buffer.from(hex.replace(/\s/g, ""), "hex");
    expect(parseAstMessage(sample)).toEqual({
      kind: "source",
      text: "hi",
      final: false,
      startTime: 0,
      endTime: 0,
    });
  });
});
