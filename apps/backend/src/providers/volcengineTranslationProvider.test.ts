import { describe, expect, it, vi } from "vitest";
import {
  type FetchLike,
  toVolcengineLanguageCode,
  VolcengineTranslationProvider,
} from "./volcengineTranslationProvider.js";

describe("VolcengineTranslationProvider", () => {
  it("sends text to the Volcengine machine translation API and returns the first translation", async () => {
    const fetch = vi.fn<FetchLike>(async () => {
      return new Response(
        JSON.stringify({
          code: 20000000,
          message: "success",
          data: {
            translation_list: [
              {
                translation: "你好，世界",
                detected_source_language: "en",
              },
            ],
          },
        }),
        { status: 200 },
      );
    });
    const provider = new VolcengineTranslationProvider(
      {
        apiKey: "volc-key",
        endpoint: "https://openspeech.bytedance.com/api/v3/machine_translation/matx_translate",
        resourceId: "volc.speech.mt",
      },
      fetch,
    );

    await expect(
      provider.translate({
        text: "hello world",
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
      }),
    ).resolves.toBe("你好，世界");

    expect(fetch).toHaveBeenCalledWith(
      "https://openspeech.bytedance.com/api/v3/machine_translation/matx_translate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": "volc-key",
          "X-Api-Request-Id": expect.any(String),
          "X-Api-Resource-Id": "volc.speech.mt",
        },
        body: JSON.stringify({
          source_language: "en",
          target_language: "zh",
          text_list: ["hello world"],
        }),
      },
    );
  });

  it("omits source_language so Volcengine can auto-detect the source language", async () => {
    const fetch = vi.fn<FetchLike>(async () => {
      return new Response(
        JSON.stringify({
          code: 20000000,
          data: { translation_list: [{ translation: "你好" }] },
        }),
      );
    });
    const provider = new VolcengineTranslationProvider(
      {
        apiKey: "volc-key",
        endpoint: "https://example.test/mt",
        resourceId: "volc.speech.mt",
      },
      fetch,
    );

    await provider.translate({
      text: "hello",
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
    });

    const [, init] = fetch.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      target_language: "zh",
      text_list: ["hello"],
    });
  });

  it("surfaces provider errors with the Volcengine response code and message", async () => {
    const fetch = vi.fn<FetchLike>(async () => {
      return new Response(
        JSON.stringify({
          code: 40000000,
          message: "invalid api key",
        }),
        { status: 200 },
      );
    });
    const provider = new VolcengineTranslationProvider(
      {
        apiKey: "bad-key",
        endpoint: "https://example.test/mt",
        resourceId: "volc.speech.mt",
      },
      fetch,
    );

    await expect(
      provider.translate({
        text: "hello",
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
      }),
    ).rejects.toThrow("Volcengine translation failed: 40000000 invalid api key");
  });

  it("maps the canonical target language to Volcengine's code set", async () => {
    const fetch = vi.fn<FetchLike>(
      async () =>
        new Response(
          JSON.stringify({
            code: 20000000,
            data: { translation_list: [{ translation: "x" }] },
          }),
        ),
    );
    const provider = new VolcengineTranslationProvider(
      { apiKey: "k", endpoint: "https://example.test/mt", resourceId: "volc.speech.mt" },
      fetch,
    );

    await provider.translate({ text: "hi", sourceLanguage: "auto", targetLanguage: "zh-CN" });
    await provider.translate({ text: "hi", sourceLanguage: "auto", targetLanguage: "zh-TW" });
    await provider.translate({ text: "hi", sourceLanguage: "auto", targetLanguage: "en" });

    const targets = fetch.mock.calls.map(
      ([, init]) => JSON.parse(String(init?.body)).target_language,
    );
    expect(targets).toEqual(["zh", "zh-Hant", "en"]);
  });
});

describe("toVolcengineLanguageCode", () => {
  it("maps Chinese region codes to Volcengine codes and passes others through", () => {
    expect(toVolcengineLanguageCode("zh-CN")).toBe("zh");
    expect(toVolcengineLanguageCode("zh-TW")).toBe("zh-Hant");
    expect(toVolcengineLanguageCode("en")).toBe("en");
    expect(toVolcengineLanguageCode("ja")).toBe("ja");
  });
});
