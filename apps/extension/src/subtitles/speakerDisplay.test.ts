import { describe, expect, it } from "vitest";
import { assignSpeakerNumbers, speakerColor, SPEAKER_PALETTE } from "./speakerDisplay";
import { contrastRatio, meetsAA } from "../ui/contrast";
import { DARK_THEME } from "../ui/theme";

describe("assignSpeakerNumbers", () => {
  it("numbers speakers in first-seen order", () => {
    const m = assignSpeakerNumbers(["spk-a", "spk-b", "spk-a", "spk-c"]);
    expect([m.get("spk-a"), m.get("spk-b"), m.get("spk-c")]).toEqual([1, 2, 3]);
  });

  it("keeps a returning speaker's number stable", () => {
    const m = assignSpeakerNumbers(["spk-b", "spk-a", "spk-b"]);
    expect(m.get("spk-b")).toBe(1);
    expect(m.get("spk-a")).toBe(2);
  });

  it("returns an empty map for no ids", () => {
    expect(assignSpeakerNumbers([]).size).toBe(0);
  });
});

describe("speakerColor", () => {
  it("maps 1-based numbers into the palette and cycles past its length", () => {
    expect(speakerColor(1)).toBe(SPEAKER_PALETTE[0]);
    expect(speakerColor(SPEAKER_PALETTE.length)).toBe(SPEAKER_PALETTE[SPEAKER_PALETTE.length - 1]);
    expect(speakerColor(SPEAKER_PALETTE.length + 1)).toBe(SPEAKER_PALETTE[0]);
  });
});

describe("SPEAKER_PALETTE", () => {
  it("every color meets AA on both dark overlay backgrounds", () => {
    for (const color of SPEAKER_PALETTE) {
      expect(meetsAA(contrastRatio(color, DARK_THEME.bg))).toBe(true);
      expect(meetsAA(contrastRatio(color, DARK_THEME.surface))).toBe(true);
    }
  });
});
