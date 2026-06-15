import { describe, expect, it } from "vitest";
import {
  createInMemorySessionStorage,
  loadPersistedState,
  persistState,
  type PersistedSessionState,
} from "./sessionStore";

describe("sessionStore", () => {
  it("round-trips a running session state", async () => {
    const storage = createInMemorySessionStorage();
    const running: PersistedSessionState = {
      sessionState: {
        status: "running",
        localSessionId: "local-1",
        tabId: 7,
        streamId: "stream-1",
        targetLanguage: "zh-CN",
      },
      detectedSourceLanguage: "en",
    };

    await persistState(running, storage);

    expect(await loadPersistedState(storage)).toEqual(running);
  });

  it("returns an idle default when nothing is stored", async () => {
    const storage = createInMemorySessionStorage();

    expect(await loadPersistedState(storage)).toEqual({
      sessionState: { status: "idle" },
      detectedSourceLanguage: "unknown",
    });
  });

  it("normalizes a persisted stopping state to idle on load", async () => {
    const storage = createInMemorySessionStorage();
    await persistState(
      {
        sessionState: {
          status: "stopping",
          localSessionId: "local-1",
          tabId: 7,
          streamId: "stream-1",
          targetLanguage: "zh-CN",
        },
        detectedSourceLanguage: "en",
      },
      storage,
    );

    const loaded = await loadPersistedState(storage);
    expect(loaded.sessionState).toEqual({ status: "idle" });
    expect(loaded.detectedSourceLanguage).toBe("en");
  });
});
