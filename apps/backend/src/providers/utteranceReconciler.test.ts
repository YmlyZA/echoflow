import { describe, expect, it } from "vitest";
import { UtteranceReconciler } from "./utteranceReconciler.js";

describe("UtteranceReconciler (finalized sentences only)", () => {
  it("ignores non-definite (partial) utterances", () => {
    const r = new UtteranceReconciler();
    expect(r.reconcile([{ text: "hello world", definite: false }])).toEqual([]);
  });

  it("emits one final per confirmed definite sentence", () => {
    const r = new UtteranceReconciler();
    expect(
      r.reconcile([{ text: "hello world", definite: true, start_time: 0, end_time: 800 }]),
    ).toEqual([
      { kind: "final", segmentId: "seg-1", text: "hello world", startTimeMs: 0, endTimeMs: 800 },
    ]);
  });

  it("dedupes a re-sent definite sentence", () => {
    const r = new UtteranceReconciler();
    r.reconcile([{ text: "hi", definite: true, end_time: 500 }]);
    expect(r.reconcile([{ text: "hi", definite: true, end_time: 500 }])).toEqual([]);
  });

  it("advances a monotonic ordinal per new sentence", () => {
    const r = new UtteranceReconciler();
    r.reconcile([{ text: "first", definite: true, start_time: 0, end_time: 500 }]);
    expect(
      r.reconcile([{ text: "second", definite: true, start_time: 600, end_time: 1100 }]),
    ).toEqual([
      { kind: "final", segmentId: "seg-2", text: "second", startTimeMs: 600, endTimeMs: 1100 },
    ]);
  });

  it("finalizes the confirmed sentence and ignores a trailing partial in the same frame", () => {
    const r = new UtteranceReconciler();
    expect(
      r.reconcile([
        { text: "first sentence.", definite: true, start_time: 0, end_time: 900 },
        { text: "the next one is still", definite: false, start_time: 1000 },
      ]),
    ).toEqual([
      { kind: "final", segmentId: "seg-1", text: "first sentence.", startTimeMs: 0, endTimeMs: 900 },
    ]);
  });

  it("emits multiple finals when a frame confirms several sentences in order", () => {
    const r = new UtteranceReconciler();
    expect(
      r.reconcile([
        { text: "one", definite: true, start_time: 0, end_time: 300 },
        { text: "two", definite: true, start_time: 300, end_time: 600 },
      ]),
    ).toEqual([
      { kind: "final", segmentId: "seg-1", text: "one", startTimeMs: 0, endTimeMs: 300 },
      { kind: "final", segmentId: "seg-2", text: "two", startTimeMs: 300, endTimeMs: 600 },
    ]);
  });

  it("returns nothing for an empty frame or an empty-text definite", () => {
    const r = new UtteranceReconciler();
    expect(r.reconcile([])).toEqual([]);
    expect(r.reconcile([{ definite: true }])).toEqual([]);
  });

  it("falls back endTime to startTime when end_time is missing", () => {
    const r = new UtteranceReconciler();
    expect(r.reconcile([{ text: "x", definite: true, start_time: 200 }])).toEqual([
      { kind: "final", segmentId: "seg-1", text: "x", startTimeMs: 200, endTimeMs: 200 },
    ]);
  });
});
