import { describe, expect, it } from "vitest";
import { isSyncPushRequest, isSyncPullResponse } from "./sync.js";

const session = {
  id: "local-1751800000000-abc",
  updatedAtMs: 1751800001000,
  payload: { startedAt: 1751800000000, videoKey: "youtube:dQw4w9WgXcQ" },
};

const segment = {
  sessionId: "local-1751800000000-abc",
  segmentId: "e0:seg-1",
  payload: { sourceText: "hello", translatedText: "你好" },
};

describe("isSyncPushRequest", () => {
  it("accepts a valid push request", () => {
    expect(isSyncPushRequest({ sessions: [session], segments: [segment] })).toBe(true);
  });

  it("accepts empty arrays", () => {
    expect(isSyncPushRequest({ sessions: [], segments: [] })).toBe(true);
  });

  it("rejects non-objects and missing arrays", () => {
    expect(isSyncPushRequest(null)).toBe(false);
    expect(isSyncPushRequest("push")).toBe(false);
    expect(isSyncPushRequest({ sessions: [session] })).toBe(false);
    expect(isSyncPushRequest({ segments: [segment] })).toBe(false);
  });

  it("rejects a session with a non-finite updatedAtMs or missing payload", () => {
    expect(
      isSyncPushRequest({
        sessions: [{ ...session, updatedAtMs: Number.NaN }],
        segments: [],
      }),
    ).toBe(false);
    expect(
      isSyncPushRequest({
        sessions: [{ id: "x", updatedAtMs: 1 }],
        segments: [],
      }),
    ).toBe(false);
    expect(
      isSyncPushRequest({
        sessions: [{ ...session, payload: "not-an-object" }],
        segments: [],
      }),
    ).toBe(false);
  });

  it("rejects a segment missing sessionId or segmentId", () => {
    expect(
      isSyncPushRequest({ sessions: [], segments: [{ segmentId: "a", payload: {} }] }),
    ).toBe(false);
    expect(
      isSyncPushRequest({ sessions: [], segments: [{ sessionId: "a", payload: {} }] }),
    ).toBe(false);
  });
});

describe("isSyncPullResponse", () => {
  it("accepts a valid pull response", () => {
    expect(
      isSyncPullResponse({
        sessions: [session],
        segments: [segment],
        nextCursor: 42,
        hasMore: false,
      }),
    ).toBe(true);
  });

  it("accepts an empty pull response", () => {
    expect(
      isSyncPullResponse({ sessions: [], segments: [], nextCursor: 0, hasMore: false }),
    ).toBe(true);
  });

  it("rejects missing or non-numeric cursor and non-boolean hasMore", () => {
    expect(
      isSyncPullResponse({ sessions: [], segments: [], hasMore: false }),
    ).toBe(false);
    expect(
      isSyncPullResponse({ sessions: [], segments: [], nextCursor: "42", hasMore: false }),
    ).toBe(false);
    expect(
      isSyncPullResponse({ sessions: [], segments: [], nextCursor: 1, hasMore: "no" }),
    ).toBe(false);
  });

  it("rejects invalid records inside the arrays", () => {
    expect(
      isSyncPullResponse({
        sessions: [{ id: 5, updatedAtMs: 1, payload: {} }],
        segments: [],
        nextCursor: 1,
        hasMore: false,
      }),
    ).toBe(false);
  });
});
