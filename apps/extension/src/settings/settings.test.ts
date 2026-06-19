import { describe, expect, it } from "vitest";
import {
  buildRealtimeWebSocketUrl,
  getDefaultTargetLanguage,
  loadSettings,
  resolveSettings,
  saveSettings,
  validateSettings
} from "./settings";

describe("settings validation", () => {
  it("marks settings invalid when the server URL is missing", () => {
    const result = validateSettings({
      serverUrl: "",
      apiKey: "secret",
      targetLanguage: "en",
      subtitleFontSize: 24,
      mode: "pipeline"
    });

    expect(result.valid).toBe(false);
    expect(result.errors.serverUrl).toBe("Server URL is required");
  });

  it("marks settings invalid when the API key is missing", () => {
    const result = validateSettings({
      serverUrl: "https://api.example.com",
      apiKey: "",
      targetLanguage: "en",
      subtitleFontSize: 24,
      mode: "pipeline"
    });

    expect(result.valid).toBe(false);
    expect(result.errors.apiKey).toBe("API key is required");
  });
});

describe("target language defaults", () => {
  it("maps the browser language to a default target language", () => {
    expect(getDefaultTargetLanguage("en-US")).toBe("en");
    expect(getDefaultTargetLanguage("zh-Hans-CN")).toBe("zh-CN");
    expect(getDefaultTargetLanguage("ja-JP")).toBe("ja");
  });

  it("keeps a manual target language instead of the browser default", () => {
    const settings = resolveSettings(
      {
        serverUrl: "https://api.example.com",
        apiKey: "secret",
        targetLanguage: "es",
        subtitleFontSize: 24
      },
      "en-US"
    );

    expect(settings.targetLanguage).toBe("es");
  });
});

function createMemoryStorage() {
  const saved = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return saved.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      saved.set(key, value);
    }
  };
}

describe("settings storage", () => {
  it("trims settings before saving through the storage adapter", async () => {
    const storage = createMemoryStorage();

    const result = await saveSettings(
      {
        serverUrl: " https://api.example.com ",
        apiKey: " secret ",
        targetLanguage: " zh-CN ",
        subtitleFontSize: 24,
        mode: "pipeline"
      },
      storage
    );

    expect(result.valid).toBe(true);
    expect(await storage.get("echoflow.settings")).toEqual({
      serverUrl: "https://api.example.com",
      apiKey: "secret",
      targetLanguage: "zh-CN",
      subtitleFontSize: 24,
      mode: "pipeline"
    });
  });

  it("defaults mode to pipeline and round-trips a stored mode", async () => {
    const storage = createMemoryStorage();
    await saveSettings(
      { serverUrl: "http://127.0.0.1:8787", apiKey: "k", targetLanguage: "zh-CN", subtitleFontSize: 24, mode: "interpret" },
      storage,
    );
    const loaded = await loadSettings(storage, "en-US");
    expect(loaded.mode).toBe("interpret");
  });

  it("resolves mode to pipeline when unset", () => {
    expect(resolveSettings(undefined, "en-US").mode).toBe("pipeline");
  });
});

describe("realtime websocket URL", () => {
  it("derives the websocket endpoint from http and https service URLs", () => {
    expect(buildRealtimeWebSocketUrl("https://api.example.com")).toBe(
      "wss://api.example.com/v1/realtime"
    );
    expect(buildRealtimeWebSocketUrl("http://localhost:8787/api")).toBe(
      "ws://localhost:8787/api/v1/realtime"
    );
  });
});
