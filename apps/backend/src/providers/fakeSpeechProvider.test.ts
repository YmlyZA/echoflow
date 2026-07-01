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
      { kind: "partial", segmentId: "seg-1", text: "hello", startTimeMs: 0, speakerId: "spk-a" },
      { kind: "partial", segmentId: "seg-1", text: "hello from", startTimeMs: 0, speakerId: "spk-a" },
      {
        kind: "final",
        segmentId: "seg-1",
        text: "hello from echoflow",
        startTimeMs: 0,
        endTimeMs: 500,
        speakerId: "spk-a",
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
      speakerId: "spk-a",
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
        speakerId: "spk-a",
      },
      {
        kind: "final",
        segmentId: "seg-2",
        text: "this is the second segment",
        startTimeMs: 750,
        endTimeMs: 1750,
        speakerId: "spk-b",
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

  it("labels segments with cycling speaker ids (spk-a, spk-b, spk-a)", () => {
    const events: SegmentEvent[] = [];
    const provider = new FakeSpeechProvider();
    const stream = provider.open({ onSegment: (e) => events.push(e) });
    // Drive enough frames to finalize all three script segments.
    for (let i = 0; i < 30; i++) {
      stream.pushFrame({ data: Buffer.alloc(0), sequenceNumber: i, timestampMs: i * 100 });
    }
    const finals = events.filter(
      (e): e is Extract<SegmentEvent, { kind: "final" }> => e.kind === "final"
    );
    expect(finals.map((f) => f.speakerId)).toEqual(["spk-a", "spk-b", "spk-a"]);
  });
});
