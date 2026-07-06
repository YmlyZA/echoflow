import { describe, expect, it } from "vitest";
import { videoIdentity } from "./videoIdentity";

describe("videoIdentity", () => {
  it("canonicalizes YouTube watch/short/embed/shorts URLs to the same key", () => {
    const key = "youtube:dQw4w9WgXcQ";
    expect(videoIdentity("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s")).toBe(key);
    expect(videoIdentity("https://youtu.be/dQw4w9WgXcQ?si=abc")).toBe(key);
    expect(videoIdentity("https://youtu.be/dQw4w9WgXcQ/")).toBe(key); // trailing slash
    expect(videoIdentity("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe(key);
    expect(videoIdentity("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(key);
    expect(videoIdentity("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(key);
  });

  it("strips volatile params and the hash for a generic video page", () => {
    const a = videoIdentity("https://example.com/course/lesson-5?t=120&utm_source=news#notes");
    const b = videoIdentity("https://example.com/course/lesson-5");
    expect(a).toBe(b);
  });

  it("keeps a meaningful query param that identifies the video", () => {
    const a = videoIdentity("https://vid.example.com/player?id=abc123&t=30");
    const b = videoIdentity("https://vid.example.com/player?id=abc123");
    expect(a).toBe(b);
    expect(a).not.toBe(videoIdentity("https://vid.example.com/player?id=different"));
  });

  it("returns the raw string for an unparseable url", () => {
    expect(videoIdentity("not a url")).toBe("not a url");
  });
});
