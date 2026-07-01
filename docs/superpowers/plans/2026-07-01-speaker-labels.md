# Speaker Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add color-coded **Speaker N** labels to bilingual subtitles end-to-end on the deterministic fake provider — overlay chip + persisted in history + export — via one optional `speakerId` threaded through the existing pipeline.

**Architecture:** Optional `speakerId?: string` rides on `SegmentEvent` → `ServerEvent` (`partial`/`final`) → subtitle reducer → overlay, and on `SubtitleSegment` → history → export/panel. A single pure helper (`assignSpeakerNumbers`) maps opaque ids → stable display numbers, shared by overlay, panel, and export. Real Volcengine speaker decode is a deliberate follow-up (the field is already optional).

**Tech Stack:** TypeScript, Vitest, React 19 (renderToStaticMarkup for component tests), WXT, Fastify backend.

## Global Constraints

- `speakerId` is **optional everywhere**; untouched paths (interpret source, real adapters) keep compiling and emit without it.
- **Never assign a possibly-`undefined` value to an optional `speakerId?` property.** The repo's tsconfig sets `exactOptionalPropertyTypes: true` and `noUncheckedIndexedAccess: true`, so `speakerId: someString | undefined` fails to typecheck against `speakerId?: string`, AND `speakerId: undefined` would trip `isServerEvent`'s `hasOwn → must be string` rule. When constructing ANY object with `speakerId` (wire events, reducer state, history segments) from a possibly-undefined source, use a conditional spread: `...(id !== undefined ? { speakerId: id } : {})`. Run `typecheck`, not just tests, before considering a task done.
- **Reveal rule:** speaker labels appear only once **≥2 distinct speakers** are seen in the session (single-speaker sessions look exactly as today). Applies to the overlay chip AND the text-export prefix.
- **`speakerColor` palette must be ≥4.5:1** on both `DARK_THEME.bg` (`#0c0e13`) and `DARK_THEME.surface` (`#11141b`), verified with `src/ui/contrast.ts`.
- **Color is an overlay-only affordance.** The light-themed options panel and export identify speakers by the **number** (no palette color there).
- **DRY:** overlay, options panel, and both export paths derive "Speaker N" from the same `assignSpeakerNumbers` (first-seen order).
- Contract change (`packages/protocol`): update the runtime guard AND its `.test.ts` in the same task.
- Extension component tests use `renderToStaticMarkup` (node env); assert on class/text, never literal apostrophes (they escape to `&#x27;`), never `dangerouslySetInnerHTML`.
- Colocated `*.test.ts(x)` under `src/`, run by `vitest run src` (the CI `check` job). Entrypoints (`content.tsx`, `options/main.tsx`) are covered by e2e/manual, not unit tests.

---

### Task 1: Protocol contract — `speakerId` on events + segment

**Files:**
- Modify: `packages/protocol/src/events.ts`
- Test: `packages/protocol/src/events.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PartialSubtitleEvent.speakerId?: string`, `FinalSubtitleEvent.speakerId?: string`, `SubtitleSegment.speakerId?: string`; `isServerEvent` validates `speakerId` on `partial`/`final`. Tasks 2, 4, 6 depend on these.

- [ ] **Step 1: Write the failing guard tests**

Add to `packages/protocol/src/events.test.ts` (inside the existing `describe` for `isServerEvent`):

```ts
it("accepts partial and final events carrying a string speakerId", () => {
  expect(
    isServerEvent({ type: "partial", segmentId: "s1", sourceText: "hi", speakerId: "spk-a" })
  ).toBe(true);
  expect(
    isServerEvent({
      type: "final", segmentId: "s1", sourceText: "hi", translatedText: "你好",
      startTimeMs: 0, endTimeMs: 1, speakerId: "spk-a"
    })
  ).toBe(true);
});

it("accepts final events with no speakerId (field is optional)", () => {
  expect(
    isServerEvent({
      type: "final", segmentId: "s1", sourceText: "hi", translatedText: "你好",
      startTimeMs: 0, endTimeMs: 1
    })
  ).toBe(true);
});

it("rejects events whose speakerId is present but not a string", () => {
  expect(
    isServerEvent({ type: "partial", segmentId: "s1", sourceText: "hi", speakerId: 3 })
  ).toBe(false);
  expect(
    isServerEvent({
      type: "final", segmentId: "s1", sourceText: "hi", translatedText: "你好",
      startTimeMs: 0, endTimeMs: 1, speakerId: 3
    })
  ).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @echoflow/protocol test -- events`
Expected: FAIL — the `speakerId: 3` cases return `true` (guard doesn't check the field yet).

- [ ] **Step 3: Add the field to the types**

In `packages/protocol/src/events.ts`, add `speakerId?: string;` as the last property of `PartialSubtitleEvent`, `FinalSubtitleEvent`, and `SubtitleSegment`. Example for `FinalSubtitleEvent`:

```ts
export type FinalSubtitleEvent = {
  type: "final";
  segmentId: string;
  sourceText: string;
  translatedText: string;
  startTimeMs: number;
  endTimeMs: number;
  speakerId?: string;
};
```

- [ ] **Step 4: Validate it in the guard**

In `isServerEvent`, extend the `"partial"` and `"final"` cases with a speaker check (append with `&&`). For `"partial"`:

```ts
case "partial":
  return (
    typeof value.segmentId === "string" &&
    typeof value.sourceText === "string" &&
    (!hasOwn(value, "translatedText") ||
      typeof value.translatedText === "string") &&
    (!hasOwn(value, "speakerId") || typeof value.speakerId === "string")
  );
```

For `"final"`, append the same `(!hasOwn(value, "speakerId") || typeof value.speakerId === "string")` clause to the existing return expression.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @echoflow/protocol test -- events`
Expected: PASS (all new + existing guard tests green).

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/events.ts packages/protocol/src/events.test.ts
git commit -m "feat(protocol): optional speakerId on partial/final events + segment"
```

---

### Task 2: Backend — fake multi-speaker provider + pipeline threading

**Files:**
- Modify: `apps/backend/src/providers/types.ts`
- Modify: `apps/backend/src/providers/fakeSpeechProvider.ts`
- Modify: `apps/backend/src/realtime/pipelineSubtitleSource.ts`
- Test: `apps/backend/src/providers/fakeSpeechProvider.test.ts`
- Test: `apps/backend/src/realtime/pipelineSubtitleSource.test.ts`

**Interfaces:**
- Consumes: protocol `ServerEvent` `partial`/`final` now carry `speakerId?` (Task 1).
- Produces: `SegmentEvent` `partial`/`final` gain `speakerId?: string`; the fake provider emits ≥2 distinct speakers; the pipeline source forwards `speakerId` onto emitted `partial`/`final` `ServerEvent`s.

- [ ] **Step 1: Add `speakerId` to `SegmentEvent`**

In `apps/backend/src/providers/types.ts`, add `speakerId?: string` to the `partial` and `final` variants:

```ts
export type SegmentEvent =
  | { kind: "language"; sourceLanguage: string }
  | { kind: "partial"; segmentId: string; text: string; startTimeMs: number; speakerId?: string }
  | {
      kind: "final";
      segmentId: string;
      text: string;
      startTimeMs: number;
      endTimeMs: number;
      speakerId?: string;
    };
```

- [ ] **Step 2: Write the failing fake-provider test**

Add to `apps/backend/src/providers/fakeSpeechProvider.test.ts`:

```ts
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
```

(If the test file lacks a `SegmentEvent` import, add `import type { SegmentEvent } from "./types.js";`.)

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @echoflow/backend test -- fakeSpeechProvider`
Expected: FAIL — `speakerId` is `undefined` on the finals.

- [ ] **Step 4: Emit speakers from the fake provider**

In `apps/backend/src/providers/fakeSpeechProvider.ts`, add a speaker table beside `SCRIPT`:

```ts
const SPEAKERS = ["spk-a", "spk-b", "spk-a"];
```

Then add `speakerId: SPEAKERS[segmentIndex]` to each of the three `onSegment` emissions that carry a `segmentId` — the `partial` emit and the `final` emit inside `pushFrame`, and the `final` emit inside `end()`. Example for the `pushFrame` final:

```ts
opts.onSegment({
  kind: "final",
  segmentId,
  text: words.join(" "),
  startTimeMs: segmentStartMs,
  endTimeMs: frame.timestampMs,
  speakerId: SPEAKERS[segmentIndex],
});
```

(`SPEAKERS` is indexed by the same `segmentIndex` the code already uses; all three script segments have an entry.)

- [ ] **Step 5: Run the fake-provider test to verify it passes**

Run: `pnpm --filter @echoflow/backend test -- fakeSpeechProvider`
Expected: PASS.

- [ ] **Step 6: Write the failing pipeline test**

Add to `apps/backend/src/realtime/pipelineSubtitleSource.test.ts` a case asserting the speaker survives to the emitted `final`. Use the file's existing helpers — `stubSpeech()` and `buildSource(translation, provider)` (which internally calls `source.open` and returns the collected `events` array) — and the file's `vi.waitFor` idiom to await the async translation drain, exactly like the existing "emits a translated final" test:

```ts
it("forwards speakerId from the segment onto the emitted final", async () => {
  const speech = stubSpeech();
  const events = buildSource(
    { translate: async () => "你好", close: () => {} },
    speech.provider,
  );
  speech.emit({ kind: "language", sourceLanguage: "en" });
  speech.emit({
    kind: "final", segmentId: "s1", text: "hi", startTimeMs: 0, endTimeMs: 1, speakerId: "spk-b",
  });
  await vi.waitFor(() =>
    expect(events).toContainEqual(
      expect.objectContaining({ type: "final", segmentId: "s1", speakerId: "spk-b" }),
    ),
  );
});
```

(`stubSpeech`, `buildSource`, and `vi` are already imported/defined in the file — no new imports needed.)

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --filter @echoflow/backend test -- pipelineSubtitleSource`
Expected: FAIL — emitted `final` has no `speakerId`.

- [ ] **Step 8: Thread `speakerId` through the pipeline source**

In `apps/backend/src/realtime/pipelineSubtitleSource.ts`:

1. Extend the `pendingFinal` type to include the speaker:

```ts
let pendingFinal:
  | { segmentId: string; sourceText: string; startTimeMs: number; endTimeMs: number; speakerId?: string }
  | undefined;
```

2. In the `final`-emit inside `drainTranslations`, add the speaker via conditional spread (never emit `undefined`):

```ts
opts.onEvent({
  type: "final",
  segmentId: job.segmentId,
  sourceText: job.sourceText,
  translatedText,
  startTimeMs: job.startTimeMs,
  endTimeMs: job.endTimeMs,
  ...(job.speakerId !== undefined ? { speakerId: job.speakerId } : {}),
});
```

3. In `onSegment`, carry the speaker into `pendingFinal` and onto the `partial` emit:

```ts
if (event.kind === "partial") {
  tail = tail.then(() => {
    opts.onEvent({
      type: "partial",
      segmentId: event.segmentId,
      sourceText: event.text,
      ...(event.speakerId !== undefined ? { speakerId: event.speakerId } : {}),
    });
  });
  return;
}
pendingFinal = {
  segmentId: event.segmentId,
  sourceText: event.text,
  startTimeMs: event.startTimeMs,
  endTimeMs: event.endTimeMs,
  ...(event.speakerId !== undefined ? { speakerId: event.speakerId } : {}),
};
```

- [ ] **Step 9: Run the pipeline test to verify it passes**

Run: `pnpm --filter @echoflow/backend test -- pipelineSubtitleSource`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/backend/src/providers/types.ts apps/backend/src/providers/fakeSpeechProvider.ts apps/backend/src/realtime/pipelineSubtitleSource.ts apps/backend/src/providers/fakeSpeechProvider.test.ts apps/backend/src/realtime/pipelineSubtitleSource.test.ts
git commit -m "feat(backend): fake multi-speaker provider + pipeline speakerId threading"
```

---

### Task 3: Extension — speaker display helper (numbers + palette)

**Files:**
- Create: `apps/extension/src/subtitles/speakerDisplay.ts`
- Test: `apps/extension/src/subtitles/speakerDisplay.test.ts`

**Interfaces:**
- Consumes: `contrastRatio`, `meetsAA` from `../ui/contrast`; `DARK_THEME` from `../ui/theme`.
- Produces: `SPEAKER_PALETTE: readonly string[]`, `assignSpeakerNumbers(orderedIds: readonly string[]): Map<string, number>`, `speakerColor(displayNumber: number): string`. Tasks 5 and 6 consume `assignSpeakerNumbers`; Task 5 consumes `speakerColor`.

- [ ] **Step 1: Write the failing tests**

Create `apps/extension/src/subtitles/speakerDisplay.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- speakerDisplay`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the helper**

Create `apps/extension/src/subtitles/speakerDisplay.ts`:

```ts
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
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @echoflow/extension test -- speakerDisplay`
Expected: PASS (including the AA contrast assertions).

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/subtitles/speakerDisplay.ts apps/extension/src/subtitles/speakerDisplay.test.ts
git commit -m "feat(extension): speaker display numbering + AA-verified palette"
```

---

### Task 4: Extension — reducer tracks speaker + reveal state

**Files:**
- Modify: `apps/extension/src/subtitles/reducer.ts`
- Test: `apps/extension/src/subtitles/reducer.test.ts`

**Interfaces:**
- Consumes: protocol events with `speakerId?` (Task 1).
- Produces: `SubtitleDisplaySegment.speakerId?: string`; `SubtitleState.seenSpeakerIds: readonly string[]` (first-seen order, deduped). Task 5 consumes both.

- [ ] **Step 1: Write the failing tests**

Add to `apps/extension/src/subtitles/reducer.test.ts`:

```ts
it("copies speakerId onto the current segment and tracks first-seen order", () => {
  let state = createInitialSubtitleState();
  state = reduceSubtitleEvent(state, {
    type: "final", segmentId: "s1", sourceText: "hi", translatedText: "你好",
    startTimeMs: 0, endTimeMs: 1, speakerId: "spk-a"
  });
  expect(state.currentSegment?.speakerId).toBe("spk-a");
  expect(state.seenSpeakerIds).toEqual(["spk-a"]);

  state = reduceSubtitleEvent(state, {
    type: "final", segmentId: "s2", sourceText: "bye", translatedText: "再见",
    startTimeMs: 1, endTimeMs: 2, speakerId: "spk-b"
  });
  expect(state.seenSpeakerIds).toEqual(["spk-a", "spk-b"]);

  // A returning speaker is not re-added.
  state = reduceSubtitleEvent(state, {
    type: "final", segmentId: "s3", sourceText: "hi again", translatedText: "又见",
    startTimeMs: 2, endTimeMs: 3, speakerId: "spk-a"
  });
  expect(state.seenSpeakerIds).toEqual(["spk-a", "spk-b"]);
});

it("leaves seenSpeakerIds empty when events carry no speaker", () => {
  let state = createInitialSubtitleState();
  state = reduceSubtitleEvent(state, {
    type: "final", segmentId: "s1", sourceText: "hi", translatedText: "你好",
    startTimeMs: 0, endTimeMs: 1
  });
  expect(state.seenSpeakerIds).toEqual([]);
  expect(state.currentSegment?.speakerId).toBeUndefined();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- subtitles/reducer`
Expected: FAIL — `seenSpeakerIds` undefined / `speakerId` not copied.

- [ ] **Step 3: Extend the state and reducer**

In `apps/extension/src/subtitles/reducer.ts`:

1. Add `speakerId?: string;` to `SubtitleDisplaySegment`.
2. Add `seenSpeakerIds: readonly string[];` to `SubtitleState`.
3. In `createInitialSubtitleState`, add `seenSpeakerIds: []`.
4. Add a tracking helper at the bottom of the file:

```ts
function trackSpeaker(
  seen: readonly string[],
  speakerId: string | undefined
): readonly string[] {
  if (speakerId === undefined || seen.includes(speakerId)) {
    return seen;
  }
  return [...seen, speakerId];
}
```

5. In the `"final"` case, add the speaker to `currentSegment` via a **conditional spread** (required by `exactOptionalPropertyTypes` — a bare `speakerId: event.speakerId` is `string | undefined` and won't typecheck against `speakerId?: string`), and track it on the state:

```ts
currentSegment: {
  segmentId: event.segmentId,
  sourceText: event.sourceText,
  translatedText: event.translatedText,
  status: "final",
  ...(event.speakerId !== undefined ? { speakerId: event.speakerId } : {})
},
// …existing finalizedSegmentIds…
seenSpeakerIds: trackSpeaker(state.seenSpeakerIds, event.speakerId),
```

6. In `reducePartialEvent`, add the same conditional-spread `...(event.speakerId !== undefined ? { speakerId: event.speakerId } : {})` to the returned `currentSegment`, and return `seenSpeakerIds: trackSpeaker(state.seenSpeakerIds, event.speakerId)`. (Keep the early-return-on-finalized branch unchanged. `trackSpeaker`'s param is typed `string | undefined`, so passing `event.speakerId` directly there is fine.)

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @echoflow/extension test -- subtitles/reducer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/subtitles/reducer.ts apps/extension/src/subtitles/reducer.test.ts
git commit -m "feat(extension): reducer tracks speakerId + first-seen speaker order"
```

---

### Task 5: Extension — overlay speaker chip

**Files:**
- Modify: `apps/extension/src/overlay/SubtitleOverlay.tsx`
- Modify: `apps/extension/entrypoints/content.tsx`
- Test: `apps/extension/src/overlay/SubtitleOverlay.test.tsx`

**Interfaces:**
- Consumes: `assignSpeakerNumbers` + `speakerColor` (Task 3); `SubtitleState.seenSpeakerIds` + `SubtitleDisplaySegment.speakerId` (Task 4).
- Produces: `SubtitleOverlayProps.speaker?: { number: number; color: string } | null`; content.tsx computes and passes it.

- [ ] **Step 1: Write the failing overlay tests**

Add to `apps/extension/src/overlay/SubtitleOverlay.test.tsx` (follow the file's existing render helper / prop pattern):

```ts
it("renders a speaker chip when a resolved speaker is provided", () => {
  const html = renderToStaticMarkup(
    <SubtitleOverlay
      segment={{ segmentId: "s1", sourceText: "hi", translatedText: "你好", status: "final", speakerId: "spk-b" }}
      fontSize={16}
      lifecycle="live"
      mode="pipeline"
      speaker={{ number: 2, color: "#f6b26b" }}
    />
  );
  expect(html).toContain("echoflow-speaker");
  expect(html).toContain("Speaker 2");
});

it("renders no speaker chip when speaker is null", () => {
  const html = renderToStaticMarkup(
    <SubtitleOverlay
      segment={{ segmentId: "s1", sourceText: "hi", translatedText: "你好", status: "final" }}
      fontSize={16}
      lifecycle="live"
      mode="pipeline"
      speaker={null}
    />
  );
  expect(html).not.toContain("echoflow-speaker");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- SubtitleOverlay`
Expected: FAIL — `speaker` prop / chip not rendered.

- [ ] **Step 3: Add the prop and chip to the overlay**

In `apps/extension/src/overlay/SubtitleOverlay.tsx`:

1. Add to `SubtitleOverlayProps`:

```ts
  speaker?: { number: number; color: string } | null;
```

2. Destructure `speaker = null` in the component signature (alongside the other props).
3. Render the chip immediately **before** the `<div className="echoflow-lines">` block:

```tsx
{speaker ? (
  <span className="echoflow-speaker" style={{ color: speaker.color }}>
    <span className="echoflow-speaker-dot" style={{ background: speaker.color }} />
    Speaker {speaker.number}
  </span>
) : null}
```

4. Add CSS inside `SubtitleOverlayStyles` (near `.echoflow-lines`):

```css
.echoflow-speaker {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
}
.echoflow-speaker-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
```

- [ ] **Step 4: Run the overlay tests to verify they pass**

Run: `pnpm --filter @echoflow/extension test -- SubtitleOverlay`
Expected: PASS.

- [ ] **Step 5: Compute and pass the speaker prop from content.tsx**

In `apps/extension/entrypoints/content.tsx`:

1. Add the import:

```ts
import { assignSpeakerNumbers, speakerColor } from "../src/subtitles/speakerDisplay";
```

2. Just before the `return (`/`<SubtitleOverlay` render (after `lifecycle` is derived), compute:

```tsx
let speaker: { number: number; color: string } | null = null;
if (subtitleState.seenSpeakerIds.length >= 2 && subtitleState.currentSegment?.speakerId) {
  const number = assignSpeakerNumbers(subtitleState.seenSpeakerIds).get(
    subtitleState.currentSegment.speakerId
  );
  if (number) {
    speaker = { number, color: speakerColor(number) };
  }
}
```

3. Pass `speaker={speaker}` as a prop on `<SubtitleOverlay …>`.

- [ ] **Step 6: Typecheck the extension**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/extension/src/overlay/SubtitleOverlay.tsx apps/extension/entrypoints/content.tsx apps/extension/src/overlay/SubtitleOverlay.test.tsx
git commit -m "feat(extension): overlay speaker chip (revealed on 2+ speakers)"
```

---

### Task 6: History + export + options panel

**Files:**
- Modify: `apps/extension/src/history/segmentMapping.ts`
- Modify: `apps/extension/src/history/historyStore.ts`
- Modify: `apps/extension/entrypoints/options/main.tsx`
- Test: `apps/extension/src/history/segmentMapping.test.ts`
- Test: `apps/extension/src/history/historyStore.test.ts`

**Interfaces:**
- Consumes: `SubtitleSegment.speakerId?` (Task 1); `assignSpeakerNumbers` (Task 3).
- Produces: persisted `speakerId` in history; multi-speaker-gated `Speaker N:` prefix in text export; `speakerNumber` in JSON export; a `Speaker N` tag in the options history panel.

- [ ] **Step 1: Write the failing mapping + export tests**

Add to `apps/extension/src/history/segmentMapping.test.ts`:

```ts
it("carries speakerId onto the stored segment when present", () => {
  const segment = finalEventToSegment({
    localSessionId: "local-1",
    event: {
      type: "final", segmentId: "s1", sourceText: "hi", translatedText: "你好",
      startTimeMs: 0, endTimeMs: 1, speakerId: "spk-a"
    },
    sourceLanguage: "en",
    targetLanguage: "zh-CN"
  });
  expect(segment.speakerId).toBe("spk-a");
});

it("omits speakerId when the event has none", () => {
  const segment = finalEventToSegment({
    localSessionId: "local-1",
    event: {
      type: "final", segmentId: "s1", sourceText: "hi", translatedText: "你好",
      startTimeMs: 0, endTimeMs: 1
    },
    sourceLanguage: "en",
    targetLanguage: "zh-CN"
  });
  expect(segment.speakerId).toBeUndefined();
});
```

Add to `apps/extension/src/history/historyStore.test.ts` a multi-speaker export case. The file already imports `makeFinalSegment` from `@echoflow/protocol` and sets up `createHistoryStore(createInMemoryHistoryPersistence())`; `createLocalSession()` takes an optional input and returns a session with an `id`. Use `session.id` as the segments' `sessionId` (the export assertions don't depend on the session's languages):

```ts
it("prefixes text export with Speaker N only when the session has 2+ speakers", async () => {
  const store = createHistoryStore(createInMemoryHistoryPersistence());
  const session = await store.createLocalSession();
  await store.appendSegment(makeFinalSegment({
    sessionId: session.id, segmentId: "s1", startTimeMs: 0, endTimeMs: 1,
    sourceLanguage: "en", targetLanguage: "zh-CN", sourceText: "hi", translatedText: "你好", speakerId: "spk-a"
  }));
  await store.appendSegment(makeFinalSegment({
    sessionId: session.id, segmentId: "s2", startTimeMs: 1, endTimeMs: 2,
    sourceLanguage: "en", targetLanguage: "zh-CN", sourceText: "bye", translatedText: "再见", speakerId: "spk-b"
  }));
  const text = await store.exportSessionAsText(session.id);
  expect(text).toContain("Speaker 1: hi");
  expect(text).toContain("Speaker 2: bye");

  const json = JSON.parse(await store.exportSessionAsJson(session.id));
  expect(json.segments[1]).toMatchObject({ speakerId: "spk-b", speakerNumber: 2 });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @echoflow/extension test -- "history/segmentMapping" "history/historyStore"`
Expected: FAIL — no speakerId carried; no prefix / speakerNumber.

- [ ] **Step 3: Carry speakerId in the mapping**

In `apps/extension/src/history/segmentMapping.ts`, add the speaker via conditional spread inside `makeFinalSegment(...)`:

```ts
  return makeFinalSegment({
    sessionId: args.localSessionId,
    segmentId: args.event.segmentId,
    startTimeMs: args.event.startTimeMs,
    endTimeMs: args.event.endTimeMs,
    sourceLanguage: args.sourceLanguage,
    targetLanguage: args.targetLanguage,
    sourceText: args.event.sourceText,
    translatedText: args.event.translatedText,
    ...(args.event.speakerId !== undefined ? { speakerId: args.event.speakerId } : {})
  });
```

- [ ] **Step 4: Add speaker numbering to the exports**

In `apps/extension/src/history/historyStore.ts`, add the import at the top:

```ts
import { assignSpeakerNumbers } from "../subtitles/speakerDisplay";
```

In `formatSessionText`, before the `segments.forEach`, derive numbers, then prefix source lines when multi-speaker:

```ts
  const speakerNumbers = assignSpeakerNumbers(
    segments.map((s) => s.speakerId).filter((id): id is string => id !== undefined)
  );
  const multiSpeaker = speakerNumbers.size >= 2;
```

and replace the `lines.push(..., segment.sourceText, segment.translatedText)` call with:

```ts
    const prefix =
      multiSpeaker && segment.speakerId
        ? `Speaker ${speakerNumbers.get(segment.speakerId)}: `
        : "";
    lines.push(
      `[${formatTimestamp(segment.startTimeMs)} - ${formatTimestamp(segment.endTimeMs)}]`,
      `${prefix}${segment.sourceText}`,
      segment.translatedText
    );
```

In `exportSessionAsJson`, enrich segments with the derived number:

```ts
    async exportSessionAsJson(sessionId) {
      const { session, segments } = await loadSessionExportData(persistence, sessionId);
      const speakerNumbers = assignSpeakerNumbers(
        segments.map((s) => s.speakerId).filter((id): id is string => id !== undefined)
      );
      const enriched = segments.map((s) =>
        s.speakerId !== undefined
          ? { ...s, speakerNumber: speakerNumbers.get(s.speakerId) }
          : s
      );
      return JSON.stringify({ session, segments: enriched }, null, 2);
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @echoflow/extension test -- "history/segmentMapping" "history/historyStore"`
Expected: PASS.

- [ ] **Step 6: Add the speaker tag to the options history panel**

In `apps/extension/entrypoints/options/main.tsx`:

1. Add the import:

```ts
import { assignSpeakerNumbers } from "../../src/subtitles/speakerDisplay";
```

2. Where `segments` state is available (near the component that renders `.ef-segments`), derive numbering with `useMemo` (the file already imports React hooks):

```ts
  const speakerNumbers = useMemo(
    () =>
      assignSpeakerNumbers(
        segments.map((s) => s.speakerId).filter((id): id is string => id !== undefined)
      ),
    [segments]
  );
  const multiSpeaker = speakerNumbers.size >= 2;
```

3. Inside the `segments.map(...)` `<article>`, add the tag after `.ef-segment-time`:

```tsx
{multiSpeaker && segment.speakerId ? (
  <span className="ef-segment-speaker">Speaker {speakerNumbers.get(segment.speakerId)}</span>
) : null}
```

4. Add CSS beside the other `.ef-segment-*` rules (light-theme accent, AA on the white panel):

```css
.ef-segment-speaker { font-size: 12px; font-weight: 700; color: var(--ef-accent); }
```

- [ ] **Step 7: Typecheck the extension**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/extension/src/history/segmentMapping.ts apps/extension/src/history/historyStore.ts apps/extension/entrypoints/options/main.tsx apps/extension/src/history/segmentMapping.test.ts apps/extension/src/history/historyStore.test.ts
git commit -m "feat(extension): persist speakerId + Speaker N in export and history panel"
```

---

## Self-Review

**Spec coverage:**
- Contract (`speakerId` on partial/final/segment + guard + tests) → Task 1. ✅
- Backend fake multi-speaker + pipeline threading → Task 2. ✅
- `assignSpeakerNumbers` + `speakerColor` + AA palette → Task 3. ✅
- Reducer `speakerId` + `seenSpeakerIds` + reveal → Task 4. ✅
- Overlay chip (revealed on 2+ speakers) → Task 5. ✅
- History persist + export (text prefix gated, JSON number) + options panel → Task 6. ✅
- Deferred (interpret path, real Volcengine decode, per-speaker settings) → not implemented, per spec non-goals. ✅

**Placeholder scan:** No TBD/TODO. The test-harness "reuse the file's existing pattern" notes (Tasks 2, 6) are instructions to match a concrete existing setup, each with the full assertion body given — not vague stubs.

**Type consistency:** `speakerId?: string` identical across `SegmentEvent`, `PartialSubtitleEvent`/`FinalSubtitleEvent`, `SubtitleSegment`, `SubtitleDisplaySegment`. `assignSpeakerNumbers(readonly string[]) → Map<string, number>` used identically in content.tsx (Task 5), `formatSessionText`/`exportSessionAsJson` (Task 6), options panel (Task 6). `speaker?: { number: number; color: string } | null` prop matches content.tsx's computed shape. Conditional-spread (never emit `speakerId: undefined`) applied in every producer (Tasks 2, 6). Reveal threshold `>= 2` identical in reducer-derived overlay gate (Task 5) and text export (Task 6).
