import { makeFinalSegment, type SubtitleSegment } from "@echoflow/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createHistoryStore,
  createInMemoryHistoryPersistence,
  type AppendableSubtitleSegment
} from "./historyStore";

describe("history store", () => {
  let store: ReturnType<typeof createHistoryStore>;

  beforeEach(() => {
    store = createHistoryStore(createInMemoryHistoryPersistence());
  });

  it("creates a local session", async () => {
    const session = await store.createLocalSession({
      startedAt: 1_700_000_000_000,
      sourceLanguage: "en",
      targetLanguage: "zh-CN"
    });

    expect(session).toMatchObject({
      id: expect.stringMatching(/^local-/),
      startedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      syncStatus: "local-only"
    });
    expect(session.remoteSessionId).toBeUndefined();
  });

  it("appends only final segments", async () => {
    const session = await store.createLocalSession({ now: () => 10 });
    const finalSegment = makeSegment({
      sessionId: session.id,
      segmentId: "s1",
      sourceText: "hello",
      translatedText: "你好"
    });
    const partialSegment: AppendableSubtitleSegment = {
      ...makeSegment({
        sessionId: session.id,
        segmentId: "s2",
        sourceText: "draft",
        translatedText: "草稿"
      }),
      status: "partial"
    };

    await store.appendSegment(partialSegment);
    await store.appendSegment(finalSegment);

    await expect(store.getSessionSegments(session.id)).resolves.toEqual([
      finalSegment
    ]);
  });

  it("persists video identity on a created session", async () => {
    const session = await store.createLocalSession({
      now: () => 100,
      randomSuffix: () => "s",
      videoUrl: "https://example.com/watch/123",
      videoTitle: "Example Video",
    });
    const fetched = await store.getSession(session.id);
    expect(fetched?.videoUrl).toBe("https://example.com/watch/123");
    expect(fetched?.videoTitle).toBe("Example Video");
  });

  it("generates distinct ids for calls in the same millisecond", async () => {
    const a = await store.createLocalSession({ now: () => 42 });
    const b = await store.createLocalSession({ now: () => 42 });

    expect(a.id).not.toBe(b.id);
    expect(a.startedAt).toBe(42);
    expect(b.startedAt).toBe(42);
    expect(a.id.startsWith("local-42-")).toBe(true);
  });

  it("records errors in session metadata", async () => {
    const session = await store.createLocalSession({ now: () => 20 });

    await store.recordSessionError(session.id, {
      code: "network_unavailable",
      message: "Realtime connection closed",
      occurredAt: 25
    });

    await expect(store.getSession(session.id)).resolves.toMatchObject({
      id: session.id,
      error: {
        code: "network_unavailable",
        message: "Realtime connection closed",
        occurredAt: 25
      },
      syncStatus: "failed",
      updatedAt: 25
    });
  });

  it("exports a session as text", async () => {
    const session = await store.createLocalSession({
      now: () => 30,
      randomSuffix: () => "s",
      sourceLanguage: "en",
      targetLanguage: "zh-CN"
    });
    await store.appendSegment(
      makeSegment({
        sessionId: session.id,
        segmentId: "s1",
        sourceText: "hello",
        translatedText: "你好",
        startTimeMs: 0,
        endTimeMs: 900
      })
    );
    await store.appendSegment(
      makeSegment({
        sessionId: session.id,
        segmentId: "s2",
        sourceText: "goodbye",
        translatedText: "再见",
        startTimeMs: 1_000,
        endTimeMs: 1_800
      })
    );

    await expect(store.exportSessionAsText(session.id)).resolves.toBe(
      [
        "EchoFlow transcript",
        "Session: local-30-s",
        "Languages: en -> zh-CN",
        "",
        "[00:00.000 - 00:00.900]",
        "hello",
        "你好",
        "",
        "[00:01.000 - 00:01.800]",
        "goodbye",
        "再见"
      ].join("\n")
    );
  });

  it("exports a session as JSON", async () => {
    const session = await store.createLocalSession({
      now: () => 40,
      sourceLanguage: "en",
      targetLanguage: "ja"
    });
    const segment = makeSegment({
      sessionId: session.id,
      segmentId: "s1",
      sourceText: "hello",
      translatedText: "こんにちは"
    });
    await store.appendSegment(segment);

    await expect(store.exportSessionAsJson(session.id)).resolves.toBe(
      JSON.stringify(
        {
          session,
          segments: [segment]
        },
        null,
        2
      )
    );
  });

  it("prefixes text export with Speaker N only when the session has 2+ speakers", async () => {
    const session = await store.createLocalSession({ now: () => 50 });
    await store.appendSegment(
      makeSegment({
        sessionId: session.id,
        segmentId: "s1",
        sourceText: "hi",
        translatedText: "你好",
        speakerId: "spk-a"
      })
    );
    await store.appendSegment(
      makeSegment({
        sessionId: session.id,
        segmentId: "s2",
        sourceText: "bye",
        translatedText: "再见",
        speakerId: "spk-b"
      })
    );

    const text = await store.exportSessionAsText(session.id);
    expect(text).toContain("Speaker 1: hi");
    expect(text).toContain("Speaker 2: bye");

    const json = JSON.parse(await store.exportSessionAsJson(session.id));
    expect(json.segments[1]).toMatchObject({ speakerId: "spk-b", speakerNumber: 2 });
  });
});

function makeSegment(
  overrides: Partial<SubtitleSegment> &
    Pick<SubtitleSegment, "sessionId" | "segmentId" | "sourceText" | "translatedText">
): SubtitleSegment {
  return makeFinalSegment({
    startTimeMs: 0,
    endTimeMs: 1_000,
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    ...overrides
  });
}

describe("updateSessionLanguages", () => {
  it("persists the detected source language and bumps updatedAt", async () => {
    const store = createHistoryStore(createInMemoryHistoryPersistence());
    const session = await store.createLocalSession({
      startedAt: 1000,
      targetLanguage: "zh-CN",
    });

    await store.updateSessionLanguages(session.id, {
      sourceLanguage: "en",
      updatedAt: 2000,
    });

    const updated = await store.getSession(session.id);
    expect(updated?.sourceLanguage).toBe("en");
    expect(updated?.updatedAt).toBe(2000);
  });
});
