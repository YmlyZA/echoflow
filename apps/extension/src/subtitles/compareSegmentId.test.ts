import { describe, expect, it } from "vitest";
import { compareSegmentId } from "./compareSegmentId";

describe("compareSegmentId", () => {
  it("orders by ordinal within an epoch", () => {
    expect(compareSegmentId("e1:seg-1", "e1:seg-2")).toBeLessThan(0);
    expect(compareSegmentId("e1:seg-3", "e1:seg-2")).toBeGreaterThan(0);
    expect(compareSegmentId("e1:seg-2", "e1:seg-2")).toBe(0);
  });

  it("orders a later epoch as newer regardless of ordinal", () => {
    expect(compareSegmentId("e1:seg-50", "e2:seg-1")).toBeLessThan(0);
    expect(compareSegmentId("e2:seg-1", "e1:seg-50")).toBeGreaterThan(0);
  });

  it("treats an unparseable id as lowest precedence, never throwing", () => {
    expect(compareSegmentId("garbage", "e1:seg-1")).toBeLessThan(0);
    expect(compareSegmentId("garbage", "also-garbage")).toBe(0);
  });
});
