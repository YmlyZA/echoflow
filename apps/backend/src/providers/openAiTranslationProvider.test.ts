import { describe, expect, it, vi } from "vitest";
import {
  type FetchLike,
  OpenAiTranslationProvider,
  describeLanguage,
  stripWrappingQuotes,
} from "./openAiTranslationProvider.js";

const CONFIG = { apiKey: "sk-test", baseUrl: "https://api.groq.com/openai/v1", model: "gpt-5-nano" };

function completion(content: string | null, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
}

describe("OpenAiTranslationProvider", () => {
  it("posts a chat completion to the leg's base url and returns the trimmed content", async () => {
    const fetch = vi.fn<FetchLike>(async () => completion("  你好，世界\n"));
    const provider = new OpenAiTranslationProvider(CONFIG, fetch);

    await expect(
      provider.translate({ text: "hello world", sourceLanguage: "en", targetLanguage: "zh-CN" }),
    ).resolves.toBe("你好，世界");

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer sk-test",
    });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: "gpt-5-nano", temperature: 0 });
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("Target language: Simplified Chinese (zh-CN)");
    expect(body.messages[0].content).toContain("Source language: English (en)");
    expect(body.messages[1]).toEqual({ role: "user", content: "hello world" });
  });

  it("asks the model to detect the source language for auto", async () => {
    const fetch = vi.fn<FetchLike>(async () => completion("Hola"));
    await new OpenAiTranslationProvider(CONFIG, fetch).translate({
      text: "hello",
      sourceLanguage: "auto",
      targetLanguage: "es",
    });
    const body = JSON.parse(fetch.mock.calls[0]![1].body as string);
    expect(body.messages[0].content).toContain("Source language: detect automatically");
  });

  it("strips one matched pair of wrapping quotes", async () => {
    const fetch = vi.fn<FetchLike>(async () => completion("“你好”"));
    await expect(
      new OpenAiTranslationProvider(CONFIG, fetch).translate({ text: "hi", sourceLanguage: "en", targetLanguage: "zh-CN" }),
    ).resolves.toBe("你好");
  });

  it("returns an empty string for blank input without calling the API", async () => {
    const fetch = vi.fn<FetchLike>();
    await expect(
      new OpenAiTranslationProvider(CONFIG, fetch).translate({ text: "   ", sourceLanguage: "en", targetLanguage: "zh-CN" }),
    ).resolves.toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws with the status on a non-2xx response", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response("slow down", { status: 429 }));
    await expect(
      new OpenAiTranslationProvider(CONFIG, fetch).translate({ text: "hi", sourceLanguage: "en", targetLanguage: "zh-CN" }),
    ).rejects.toThrow("OpenAI translation failed: HTTP 429");
  });

  it("throws when the body has no choices", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response("{}", { status: 200 }));
    await expect(
      new OpenAiTranslationProvider(CONFIG, fetch).translate({ text: "hi", sourceLanguage: "en", targetLanguage: "zh-CN" }),
    ).rejects.toThrow("OpenAI translation failed: missing translation text");
  });

  it("throws when the content is empty and surfaces an embedded error message", async () => {
    const fetch = vi.fn<FetchLike>(
      async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }], error: { message: "model overloaded" } }), { status: 200 }),
    );
    await expect(
      new OpenAiTranslationProvider(CONFIG, fetch).translate({ text: "hi", sourceLanguage: "en", targetLanguage: "zh-CN" }),
    ).rejects.toThrow("OpenAI translation failed: model overloaded");
  });
});

describe("describeLanguage", () => {
  it("names known codes and passes unknown ones through", () => {
    expect(describeLanguage("zh-TW")).toBe("Traditional Chinese (zh-TW)");
    expect(describeLanguage("pt-BR")).toBe("pt-BR");
  });
});

describe("stripWrappingQuotes", () => {
  it("strips straight, curly and CJK corner quotes but not mismatched or inner ones", () => {
    expect(stripWrappingQuotes('"hi"')).toBe("hi");
    expect(stripWrappingQuotes("「こんにちは」")).toBe("こんにちは");
    expect(stripWrappingQuotes('"hi')).toBe('"hi');
    expect(stripWrappingQuotes('say "hi" now')).toBe('say "hi" now');
    expect(stripWrappingQuotes('"')).toBe('"');
  });
});
