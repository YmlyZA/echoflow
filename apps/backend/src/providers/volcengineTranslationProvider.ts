import { randomUUID } from "node:crypto";
import type {
  TranslationInput,
  TranslationProvider,
} from "./types.js";
import type { VolcengineTranslationConfig } from "./providerConfig.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

type VolcengineTranslationResponse = {
  code?: number;
  message?: string;
  data?: {
    translation_list?: Array<{
      translation?: string;
      detected_source_language?: string;
    }>;
  };
};

export class VolcengineTranslationProvider implements TranslationProvider {
  constructor(
    private readonly config: VolcengineTranslationConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async translate(input: TranslationInput): Promise<string> {
    if (input.text.trim() === "") {
      return "";
    }

    const response = await this.fetchImpl(this.config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": this.config.apiKey,
        "X-Api-Request-Id": randomUUID(),
        "X-Api-Resource-Id": this.config.resourceId,
      },
      body: JSON.stringify(buildRequestBody(input)),
    });

    if (!response.ok) {
      throw new Error(`Volcengine translation failed: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as VolcengineTranslationResponse;
    if (payload.code !== 20_000_000) {
      throw new Error(
        `Volcengine translation failed: ${payload.code ?? "unknown"} ${
          payload.message ?? "unknown error"
        }`,
      );
    }

    const translation = payload.data?.translation_list?.[0]?.translation;
    if (typeof translation !== "string") {
      throw new Error("Volcengine translation failed: missing translation text");
    }

    return translation;
  }

  close(): void {
    // Stateless HTTP provider.
  }
}

// The abstraction layer speaks a provider-neutral (BCP-47) language code set;
// Volcengine MT uses ISO 639-1 / BCP-47 with its own spelling for Chinese. Map
// only the codes that differ here, in the adapter — other providers bring their
// own mapping. Unknown codes pass through unchanged.
const VOLCENGINE_LANGUAGE_CODE_OVERRIDES: Record<string, string> = {
  "zh-CN": "zh",
  "zh-TW": "zh-Hant",
};

export function toVolcengineLanguageCode(code: string): string {
  return VOLCENGINE_LANGUAGE_CODE_OVERRIDES[code] ?? code;
}

function buildRequestBody(input: TranslationInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (input.sourceLanguage.trim() !== "" && input.sourceLanguage !== "auto") {
    body.source_language = toVolcengineLanguageCode(input.sourceLanguage);
  }

  body.target_language = toVolcengineLanguageCode(input.targetLanguage);
  body.text_list = [input.text];

  return body;
}
