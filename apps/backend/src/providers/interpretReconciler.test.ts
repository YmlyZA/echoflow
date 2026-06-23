import { describe, expect, it } from "vitest";
import { InterpretReconciler } from "./interpretReconciler.js";

// Wire semantics confirmed against the live AST endpoint:
//  - 651 source / 654 translation (non-final) are DELTA fragments, timestamps 0.
//  - 652 source-end / 655 translation-end (final) carry the CUMULATIVE line and
//    the real start/end timestamps.

describe("InterpretReconciler", () => {
  it("emits a live partial for a source response", () => {
    const r = new InterpretReconciler();
    expect(
      r.reconcile({ kind: "source", text: "Hello", final: false, startTime: 0, endTime: 0 }),
    ).toEqual([{ kind: "partial", segmentId: "ast-0", text: "Hello", startTimeMs: 0 }]);
  });

  it("accumulates non-final source deltas into the current line", () => {
    const r = new InterpretReconciler();
    r.reconcile({ kind: "source", text: "Hello", final: false, startTime: 0, endTime: 0 });
    expect(
      r.reconcile({ kind: "source", text: ". ", final: false, startTime: 0, endTime: 0 }),
    ).toEqual([{ kind: "partial", segmentId: "ast-0", text: "Hello. ", startTimeMs: 0 }]);
  });

  it("pairs the cumulative source-end line with the translation-end on emit", () => {
    const r = new InterpretReconciler();
    r.reconcile({ kind: "source", text: "Hello", final: false, startTime: 0, endTime: 0 });
    r.reconcile({ kind: "source", text: ". ", final: false, startTime: 0, endTime: 0 });
    // source-end (652): cumulative line + real timestamps; no emit yet
    expect(
      r.reconcile({ kind: "source", text: "Hello. ", final: true, startTime: 20, endTime: 340 }),
    ).toEqual([]);
    // translation deltas (654) are buffered
    expect(
      r.reconcile({ kind: "translation", text: "你", final: false, startTime: 0, endTime: 0 }),
    ).toEqual([]);
    // translation-end (655): cumulative translation → final, paired
    expect(
      r.reconcile({ kind: "translation", text: "你好。", final: true, startTime: 20, endTime: 340 }),
    ).toEqual([
      {
        kind: "final",
        segmentId: "ast-0",
        text: "Hello. ",
        translatedText: "你好。",
        startTimeMs: 20,
        endTimeMs: 340,
      },
    ]);
  });

  it("takes timestamps from the final frames, not the zero-valued deltas", () => {
    const r = new InterpretReconciler();
    // delta frames report 0/0 on the wire
    r.reconcile({ kind: "source", text: "hello", final: false, startTime: 0, endTime: 0 });
    // source-end carries the real bounds
    r.reconcile({ kind: "source", text: "hello", final: true, startTime: 1000, endTime: 2000 });
    expect(
      r.reconcile({
        kind: "translation",
        text: "你好",
        final: true,
        startTime: 1000,
        endTime: 2000,
      }),
    ).toEqual([
      {
        kind: "final",
        segmentId: "ast-0",
        text: "hello",
        translatedText: "你好",
        startTimeMs: 1000,
        endTimeMs: 2000,
      },
    ]);
  });

  it("falls back to translation-end timestamps when no source-end was seen", () => {
    const r = new InterpretReconciler();
    r.reconcile({ kind: "source", text: "hi", final: false, startTime: 0, endTime: 0 });
    expect(
      r.reconcile({ kind: "translation", text: "你好", final: true, startTime: 70, endTime: 120 }),
    ).toEqual([
      {
        kind: "final",
        segmentId: "ast-0",
        text: "hi",
        translatedText: "你好",
        startTimeMs: 70,
        endTimeMs: 120,
      },
    ]);
  });

  it("ignores usage and source-end without emitting", () => {
    const r = new InterpretReconciler();
    r.reconcile({ kind: "source", text: "hi", final: false, startTime: 0, endTime: 0 });
    expect(r.reconcile({ kind: "usage" })).toEqual([]);
    expect(
      r.reconcile({ kind: "source", text: "hi", final: true, startTime: 10, endTime: 50 }),
    ).toEqual([]);
  });

  it("resets state after a final so the next segment starts clean (ast-1)", () => {
    const r = new InterpretReconciler();
    r.reconcile({ kind: "source", text: "one", final: false, startTime: 0, endTime: 0 });
    r.reconcile({ kind: "source", text: "one", final: true, startTime: 500, endTime: 1800 });
    r.reconcile({ kind: "translation", text: "一", final: true, startTime: 500, endTime: 1800 });
    expect(
      r.reconcile({ kind: "source", text: "two", final: false, startTime: 0, endTime: 0 }),
    ).toEqual([{ kind: "partial", segmentId: "ast-1", text: "two", startTimeMs: 0 }]);
  });
});
