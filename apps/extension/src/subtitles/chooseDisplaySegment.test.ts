import { describe, expect, it } from "vitest";
import { chooseDisplaySegment } from "./chooseDisplaySegment";
import type { SubtitleDisplaySegment } from "./reducer";

const live: SubtitleDisplaySegment = { segmentId: "live", sourceText: "l", translatedText: "l", status: "final" };
const replay: SubtitleDisplaySegment = { segmentId: "replay", sourceText: "r", translatedText: "r", status: "final" };

describe("chooseDisplaySegment", () => {
  it("shows the live segment when there is no video time", () => {
    expect(chooseDisplaySegment({ currentTimeSec: null, liveEdgeSec: 10, liveSegment: live, replaySegment: replay })).toBe(live);
  });

  it("with no live final yet, shows the cached line if present, else the live line", () => {
    expect(chooseDisplaySegment({ currentTimeSec: 30, liveEdgeSec: null, liveSegment: live, replaySegment: replay })).toBe(replay);
    expect(chooseDisplaySegment({ currentTimeSec: 30, liveEdgeSec: null, liveSegment: live, replaySegment: null })).toBe(live);
  });

  it("shows the live segment within the asymmetric band of the live edge", () => {
    expect(chooseDisplaySegment({ currentTimeSec: 98, liveEdgeSec: 100, liveSegment: live, replaySegment: replay })).toBe(live); // small trail
    expect(chooseDisplaySegment({ currentTimeSec: 120, liveEdgeSec: 100, liveSegment: live, replaySegment: replay })).toBe(live); // modest lead, within 30
  });

  it("keeps showing the live segment when a long in-progress sentence makes the playhead lead the live edge by ~6s (regression: fails under the old symmetric 4s band)", () => {
    expect(chooseDisplaySegment({ currentTimeSec: 106, liveEdgeSec: 100, liveSegment: live, replaySegment: replay })).toBe(live);
  });

  it("shows the replay segment when scrubbed back out of the band", () => {
    expect(chooseDisplaySegment({ currentTimeSec: 30, liveEdgeSec: 100, liveSegment: live, replaySegment: replay })).toBe(replay);
  });

  it("shows the replay segment when scrubbed forward into cached territory past the band", () => {
    expect(chooseDisplaySegment({ currentTimeSec: 500, liveEdgeSec: 100, liveSegment: live, replaySegment: replay })).toBe(replay);
  });

  it("shows nothing when scrubbed into a gap", () => {
    expect(chooseDisplaySegment({ currentTimeSec: 30, liveEdgeSec: 100, liveSegment: live, replaySegment: null })).toBe(null);
  });
});
