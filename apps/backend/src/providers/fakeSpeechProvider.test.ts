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

  it("advances across segments with incrementing ids", () => {
    const events: SegmentEvent[] = [];
    const stream = new FakeSpeechProvider().open({
      onSegment: (event) => events.push(event),
    });

    for (let index = 0; index < 8; index += 1) {
      stream.pushFrame(frame(index, index * 250));
    }

    const finals = events.filter((event) => event.kind === "final");
    expect(finals).toEqual([
      {
        kind: "final",
        segmentId: "seg-1",
        text: "hello from echoflow",
        startTimeMs: 0,
        endTimeMs: 500,
      },
      {
        kind: "final",
        segmentId: "seg-2",
        text: "this is the second segment",
        startTimeMs: 750,
        endTimeMs: 1750,
      },
    ]);
  });

  it("stops emitting after close()", async () => {
    const events: SegmentEvent[] = [];
    const stream = new FakeSpeechProvider().open({
      onSegment: (event) => events.push(event),
    });

    await stream.close();
    stream.pushFrame(frame(0, 0));

    expect(events).toEqual([]);
  });
});
