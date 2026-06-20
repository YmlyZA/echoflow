import { describe, expect, it } from "vitest";
import { InterpretReconciler } from "./interpretReconciler.js";

describe("InterpretReconciler", () => {
  it("emits a live partial for a source response", () => {
    const r = new InterpretReconciler();
    expect(r.reconcile({ kind: "source", text: "hello", final: false })).toEqual([
      { kind: "partial", segmentId: "ast-0", text: "hello", startTimeMs: 0 },
    ]);
  });

  it("updates the same segment's partial as the source revises", () => {
    const r = new InterpretReconciler();
    r.reconcile({ kind: "source", text: "hel", final: false });
    expect(r.reconcile({ kind: "source", text: "hello there", final: false })).toEqual([
      { kind: "partial", segmentId: "ast-0", text: "hello there", startTimeMs: 0 },
    ]);
  });

  it("emits a final pairing buffered source + translation on translation end", () => {
    const r = new InterpretReconciler();
    r.reconcile({ kind: "source", text: "hello there", final: false });
    r.reconcile({ kind: "translation", text: "你好", final: false });
    expect(r.reconcile({ kind: "translation", text: "你好啊", final: true })).toEqual([
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
    r.reconcile({ kind: "source", text: "one", final: false });
    r.reconcile({ kind: "translation", text: "一", final: true });
    expect(r.reconcile({ kind: "source", text: "two", final: false })).toEqual([
      { kind: "partial", segmentId: "ast-1", text: "two", startTimeMs: 0 },
    ]);
  });

  it("ignores usage and non-final source-end without emitting", () => {
    const r = new InterpretReconciler();
    r.reconcile({ kind: "source", text: "hi", final: false });
    expect(r.reconcile({ kind: "usage" })).toEqual([]);
    expect(r.reconcile({ kind: "source", text: "hi", final: true })).toEqual([]);
  });
});
