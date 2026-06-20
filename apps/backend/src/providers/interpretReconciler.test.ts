import { describe, expect, it } from "vitest";
import { InterpretReconciler } from "./interpretReconciler.js";

describe("InterpretReconciler", () => {
  it("emits a live partial for a source response", () => {
    const r = new InterpretReconciler();
    expect(
      r.reconcile({ kind: "source", text: "hello", final: false, startTime: 0, endTime: 0 }),
    ).toEqual([{ kind: "partial", segmentId: "ast-0", text: "hello", startTimeMs: 0 }]);
  });

  it("updates the same segment's partial as the source revises", () => {
    const r = new InterpretReconciler();
    r.reconcile({ kind: "source", text: "hel", final: false, startTime: 0, endTime: 0 });
    expect(
      r.reconcile({ kind: "source", text: "hello there", final: false, startTime: 0, endTime: 0 }),
    ).toEqual([{ kind: "partial", segmentId: "ast-0", text: "hello there", startTimeMs: 0 }]);
  });

  it("emits a final pairing buffered source + translation on translation end", () => {
    const r = new InterpretReconciler();
    r.reconcile({ kind: "source", text: "hello there", final: false, startTime: 0, endTime: 0 });
    r.reconcile({
      kind: "translation",
      text: "你好",
      final: false,
      startTime: 0,
      endTime: 0,
    });
    expect(
      r.reconcile({ kind: "translation", text: "你好啊", final: true, startTime: 0, endTime: 0 }),
    ).toEqual([
      {
        kind: "final",
        segmentId: "ast-0",
        text: "hello there",
        translatedText: "你好啊",
        startTimeMs: 0,
        endTimeMs: 0,
      },
    ]);
  });

  it("advances the ordinal for the next utterance after a final", () => {
    const r = new InterpretReconciler();
    r.reconcile({ kind: "source", text: "one", final: false, startTime: 0, endTime: 0 });
    r.reconcile({ kind: "translation", text: "一", final: true, startTime: 0, endTime: 0 });
    expect(
      r.reconcile({ kind: "source", text: "two", final: false, startTime: 0, endTime: 0 }),
    ).toEqual([{ kind: "partial", segmentId: "ast-1", text: "two", startTimeMs: 0 }]);
  });

  it("ignores usage and non-final source-end without emitting", () => {
    const r = new InterpretReconciler();
    r.reconcile({ kind: "source", text: "hi", final: false, startTime: 0, endTime: 0 });
    expect(r.reconcile({ kind: "usage" })).toEqual([]);
    expect(
      r.reconcile({ kind: "source", text: "hi", final: true, startTime: 0, endTime: 0 }),
    ).toEqual([]);
  });

  it("threads source audio timestamps into the final event", () => {
    const r = new InterpretReconciler();
    r.reconcile({ kind: "source", text: "hello", final: false, startTime: 1000, endTime: 2000 });
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

  it("captures startTime from first source event and endTime from last, resets after final", () => {
    const r = new InterpretReconciler();
    // First utterance: multiple source events extending end time
    r.reconcile({ kind: "source", text: "he", final: false, startTime: 500, endTime: 1000 });
    r.reconcile({ kind: "source", text: "hello", final: false, startTime: 500, endTime: 1500 });
    r.reconcile({ kind: "source", text: "hello", final: true, startTime: 500, endTime: 1800 });
    r.reconcile({
      kind: "translation",
      text: "你好",
      final: true,
      startTime: 500,
      endTime: 1800,
    });
    // Second utterance should have its own times and ordinal ast-1
    expect(
      r.reconcile({ kind: "source", text: "world", final: false, startTime: 3000, endTime: 4000 }),
    ).toEqual([{ kind: "partial", segmentId: "ast-1", text: "world", startTimeMs: 3000 }]);
  });
});
