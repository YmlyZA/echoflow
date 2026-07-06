import { describe, expect, it } from "vitest";
import { createSubtitleTimeline } from "./subtitleTimeline";
import type { SubtitleDisplaySegment } from "./reducer";

function seg(id: string): SubtitleDisplaySegment {
  return { segmentId: id, sourceText: id, translatedText: id, status: "final" };
}

describe("createSubtitleTimeline", () => {
  it("returns the segment covering a position", () => {
    const t = createSubtitleTimeline();
    t.add({ videoStartSec: 0, videoEndSec: 2, segment: seg("a") });
    t.add({ videoStartSec: 3, videoEndSec: 5, segment: seg("b") });
    expect(t.segmentAt(4)?.segment.segmentId).toBe("b");
    expect(t.segmentAt(1)?.segment.segmentId).toBe("a");
  });

  it("holds the last segment briefly past its end, then clears", () => {
    const t = createSubtitleTimeline();
    t.add({ videoStartSec: 0, videoEndSec: 2, segment: seg("a") });
    expect(t.segmentAt(2.5, 1)?.segment.segmentId).toBe("a"); // within hold
    expect(t.segmentAt(4, 1)).toBeUndefined(); // beyond end+hold (long gap)
  });

  it("returns undefined before any entry", () => {
    const t = createSubtitleTimeline();
    t.add({ videoStartSec: 10, videoEndSec: 12, segment: seg("a") });
    expect(t.segmentAt(5)).toBeUndefined();
  });

  it("picks the latest entry starting before the position regardless of insert order", () => {
    const t = createSubtitleTimeline();
    t.add({ videoStartSec: 6, videoEndSec: 8, segment: seg("late") });
    t.add({ videoStartSec: 0, videoEndSec: 2, segment: seg("early") });
    expect(t.segmentAt(7)?.segment.segmentId).toBe("late");
  });

  it("tracks the max video end and resets", () => {
    const t = createSubtitleTimeline();
    expect(t.maxVideoEndSec()).toBeUndefined();
    t.add({ videoStartSec: 0, videoEndSec: 2, segment: seg("a") });
    t.add({ videoStartSec: 3, videoEndSec: 9, segment: seg("b") });
    expect(t.maxVideoEndSec()).toBe(9);
    t.reset();
    expect(t.maxVideoEndSec()).toBeUndefined();
  });
});
