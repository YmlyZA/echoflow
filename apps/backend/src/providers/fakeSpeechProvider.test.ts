import { describe, expect, it } from "vitest";
import { FakeSpeechProvider } from "./fakeSpeechProvider.js";
import type { AudioFrame, SegmentEvent } from "./types.js";

function frame(sequenceNumber: number, timestampMs: number): AudioFrame {
  return { data: Buffer.alloc(0), sequenceNumber, timestampMs };
}

describe("FakeSpeechProvider", () => {
  it("emits language once, progressive partials, then a final per segment", () => {
    const events: SegmentEvent[] = [];
    const stream = new FakeSpeechProvider().open({
      onSegment: (event) => events.push(event),
    });

    stream.pushFrame(frame(0, 0));
    stream.pushFrame(frame(1, 250));
    stream.pushFrame(frame(2, 500));

    expect(events).toEqual([
      { kind: "language", sourceLanguage: "en" },
      { kind: "partial", segmentId: "seg-1", text: "hello", startTimeMs: 0 },
      { kind: "partial", segmentId: "seg-1", text: "hello from", startTimeMs: 0 },
      {
        kind: "final",
        segmentId: "seg-1",
        text: "hello from echoflow",
        startTimeMs: 0,
        endTimeMs: 500,
      },
    ]);
  });

  it("flushes an in-progress segment as a final on end()", async () => {
    const events: SegmentEvent[] = [];
    const stream = new FakeSpeechProvider().open({
      onSegment: (event) => events.push(event),
    });

    stream.pushFrame(frame(0, 0));
    stream.pushFrame(frame(1, 250));
    await stream.end();

    expect(events.at(-1)).toEqual({
      kind: "final",
      segmentId: "seg-1",
      text: "hello from echoflow",
      startTimeMs: 0,
      endTimeMs: 250,
    });
  });
});
