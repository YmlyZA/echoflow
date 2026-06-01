import type { TranslationInput, TranslationProvider } from "./types.js";

const FAKE_TRANSLATIONS = new Map<string, string>([
  ["hello from fake speech", "你好，来自模拟语音"],
  ["hello from fake speech provider", "你好，来自模拟语音提供器"],
]);

export class FakeTranslationProvider implements TranslationProvider {
  async translate(input: TranslationInput): Promise<string> {
    return FAKE_TRANSLATIONS.get(input.text) ?? `[${input.targetLanguage}] ${input.text}`;
  }

  close(): void {
    // No resources to release for the deterministic fake provider.
  }
}
