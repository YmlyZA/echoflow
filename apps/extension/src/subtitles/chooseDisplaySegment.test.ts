import { describe, expect, it } from "vitest";
import { chooseDisplaySegment } from "./chooseDisplaySegment";
import type { SubtitleDisplaySegment } from "./reducer";

const live: SubtitleDisplaySegment = { segmentId: "live", sourceText: "l", translatedText: "l", status: "final" };
const replay: SubtitleDisplaySegment = { segmentId: "replay", sourceText: "r", translatedText: "r", status: "final" };

describe("chooseDisplaySegment", () => {
  it("shows the live segment when there is no video-time info yet", () => {
    expect(chooseDisplaySegment({ currentTimeSec: null, maxCapturedVideoSec: null, liveSegment: live, replaySegment: replay })).toBe(live);
    expect(chooseDisplaySegment({ currentTimeSec: 5, maxCapturedVideoSec: null, liveSegment: live, replaySegment: replay })).toBe(live);
  });

  it("shows the live segment at/near the live edge", () => {
    expect(chooseDisplaySegment({ currentTimeSec: 99, maxCapturedVideoSec: 100, liveSegment: live, replaySegment: replay })).toBe(live);
  });

  it("shows the replay segment when scrubbed back", () => {
    expect(chooseDisplaySegment({ currentTimeSec: 30, maxCapturedVideoSec: 100, liveSegment: live, replaySegment: replay })).toBe(replay);
  });

  it("shows nothing when scrubbed back into a gap", () => {
    expect(chooseDisplaySegment({ currentTimeSec: 30, maxCapturedVideoSec: 100, liveSegment: live, replaySegment: null })).toBe(null);
  });
});
