// Colors are tuned for >=4.5:1 contrast on the dark overlay backgrounds
// (DARK_THEME.bg #0c0e13 and .surface #11141b). Teal is last so it rarely
// collides with the accent-colored translation line for small speaker counts.
export const SPEAKER_PALETTE = [
  "#8ab4f8", // blue
  "#f6b26b", // orange
  "#7fe0a0", // green
  "#f28b82", // salmon
  "#c9a0ff", // purple
  "#67d7c2", // teal
] as const;

/** First-seen order → 1-based display number. Stable within a session. */
export function assignSpeakerNumbers(orderedIds: readonly string[]): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const id of orderedIds) {
    if (!numbers.has(id)) {
      numbers.set(id, numbers.size + 1);
    }
  }
  return numbers;
}

/** Palette color for a 1-based display number; cycles past the palette length. */
export function speakerColor(displayNumber: number): string {
  const size = SPEAKER_PALETTE.length;
  const index = (((displayNumber - 1) % size) + size) % size;
  return SPEAKER_PALETTE[index];
}
