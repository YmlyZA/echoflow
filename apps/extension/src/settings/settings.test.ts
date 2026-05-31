import { describe, expect, it } from "vitest";
import {
  getDefaultTargetLanguage,
  resolveSettings,
  validateSettings
} from "./settings";

describe("settings validation", () => {
  it("marks settings invalid when the server URL is missing", () => {
    const result = validateSettings({
      serverUrl: "",
      apiKey: "secret",
      targetLanguage: "en",
      subtitleFontSize: 24
    });

    expect(result.valid).toBe(false);
    expect(result.errors.serverUrl).toBe("Server URL is required");
  });

  it("marks settings invalid when the API key is missing", () => {
    const result = validateSettings({
      serverUrl: "https://api.example.com",
      apiKey: "",
      targetLanguage: "en",
      subtitleFontSize: 24
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
