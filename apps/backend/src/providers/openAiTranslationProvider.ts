import type { OpenAiTranslationConfig } from "./providerConfig.js";
import type { TranslationInput, TranslationProvider } from "./types.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
};

/**
 * Line translation over `POST {baseUrl}/chat/completions` — the surface every
 * OpenAI-compatible service clones (OpenAI, Groq, OpenRouter, DeepSeek, Ollama,
 * vLLM). Non-streaming: a subtitle line is short and the pipeline translates
 * one final at a time.
 */
export class OpenAiTranslationProvider implements TranslationProvider {
  constructor(
    private readonly config: OpenAiTranslationConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async translate(input: TranslationInput): Promise<string> {
    if (input.text.trim() === "") {
      return "";
    }

    const response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(buildRequestBody(this.config.model, input)),
    });

    if (!response.ok) {
      throw new Error(`OpenAI translation failed: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error(
        `OpenAI translation failed: ${payload.error?.message ?? "missing translation text"}`,
      );
    }

    return stripWrappingQuotes(content.trim());
  }

  close(): void {
    // Stateless HTTP provider.
  }
}

// The pipeline speaks BCP-47; an LLM wants a name it will not misread. Codes
// outside this table pass through as-is — a model still understands "ja-JP".
const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  es: "Spanish",
  fr: "French",
  de: "German",
};

export function describeLanguage(code: string): string {
  const name = LANGUAGE_NAMES[code];
  return name === undefined ? code : `${name} (${code})`;
}

export function buildRequestBody(
  model: string,
  input: TranslationInput,
): Record<string, unknown> {
  const source =
    input.sourceLanguage.trim() === "" || input.sourceLanguage === "auto"
      ? "detect automatically"
      : describeLanguage(input.sourceLanguage);
  return {
    model,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You translate subtitle lines. Reply with the translation only: no quotes, no notes, no romanization, no explanation. " +
          `Target language: ${describeLanguage(input.targetLanguage)}. Source language: ${source}.`,
      },
      { role: "user", content: input.text },
    ],
  };
}

const QUOTE_PAIRS: ReadonlyArray<[string, string]> = [
  ['"', '"'],
  ["“", "”"],
  ["「", "」"],
  ["『", "』"],
];

/** Small models like to quote their answer; strip one matched outer pair. */
export function stripWrappingQuotes(text: string): string {
  for (const [open, close] of QUOTE_PAIRS) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
      return text.slice(open.length, text.length - close.length).trim();
    }
  }
  return text;
}
