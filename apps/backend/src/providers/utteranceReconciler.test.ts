import { describe, expect, it } from "vitest";
import { UtteranceReconciler } from "./utteranceReconciler.js";

describe("UtteranceReconciler", () => {
  it("emits a partial for a non-definite utterance", () => {
    const reconciler = new UtteranceReconciler();
    expect(reconciler.reconcile([{ text: "hello", start_time: 100 }])).toEqual([
      { kind: "partial", segmentId: "seg-1", text: "hello", startTimeMs: 100 },
    ]);
  });

  it("does not re-emit an unchanged partial", () => {
    const reconciler = new UtteranceReconciler();
    reconciler.reconcile([{ text: "hello" }]);
    expect(reconciler.reconcile([{ text: "hello" }])).toEqual([]);
  });

  it("emits a new partial when the text grows", () => {
    const reconciler = new UtteranceReconciler();
    reconciler.reconcile([{ text: "hello" }]);
    expect(reconciler.reconcile([{ text: "hello world" }])).toEqual([
      { kind: "partial", segmentId: "seg-1", text: "hello world", startTimeMs: 0 },
    ]);
  });

  it("emits exactly one final when an utterance becomes definite", () => {
    const reconciler = new UtteranceReconciler();
    reconciler.reconcile([{ text: "hello world" }]);
    expect(
      reconciler.reconcile([
        { text: "hello world", definite: true, start_time: 100, end_time: 900 },
      ]),
    ).toEqual([
      {
        kind: "final",
        segmentId: "seg-1",
        text: "hello world",
        startTimeMs: 100,
        endTimeMs: 900,
      },
    ]);
  });

  it("never re-emits a finalized utterance", () => {
    const reconciler = new UtteranceReconciler();
    reconciler.reconcile([{ text: "hi", definite: true }]);
    expect(reconciler.reconcile([{ text: "hi", definite: true }])).toEqual([]);
  });

  it("tracks multiple utterances independently by index", () => {
    const reconciler = new UtteranceReconciler();
    const events = reconciler.reconcile([
      { text: "first", definite: true, start_time: 0, end_time: 500 },
      { text: "second", definite: false, start_time: 500 },
    ]);
    expect(events).toEqual([
      { kind: "final", segmentId: "seg-1", text: "first", startTimeMs: 0, endTimeMs: 500 },
      { kind: "partial", segmentId: "seg-2", text: "second", startTimeMs: 500 },
    ]);
  });
});
