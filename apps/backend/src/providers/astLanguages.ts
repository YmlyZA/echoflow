import { validTarget, type LanguageOption } from "@echoflow/protocol";

// AST S2T supported languages (20). zh/en are the pivot anchors.
// Dialects (粤语/上海话, source-only) are deferred to P2 pending wire-code verification.
export const AST_LANGUAGES: LanguageOption[] = [
  { code: "zh", label: "中文", pivot: true },
  { code: "en", label: "English", pivot: true },
  { code: "ja", label: "日本語", pivot: false },
  { code: "ko", label: "한국어", pivot: false },
  { code: "es", label: "Español", pivot: false },
  { code: "pt", label: "Português", pivot: false },
  { code: "de", label: "Deutsch", pivot: false },
  { code: "fr", label: "Français", pivot: false },
  { code: "ru", label: "Русский", pivot: false },
  { code: "it", label: "Italiano", pivot: false },
  { code: "ar", label: "العربية", pivot: false },
  { code: "tr", label: "Türkçe", pivot: false },
  { code: "id", label: "Bahasa Indonesia", pivot: false },
  { code: "ms", label: "Bahasa Melayu", pivot: false },
  { code: "vi", label: "Tiếng Việt", pivot: false },
  { code: "th", label: "ไทย", pivot: false },
  { code: "nl", label: "Nederlands", pivot: false },
  { code: "ro", label: "Română", pivot: false },
  { code: "pl", label: "Polski", pivot: false },
  { code: "cs", label: "Čeština", pivot: false },
];

const AST_BY_CODE = new Map(AST_LANGUAGES.map((l) => [l.code, l]));

export function isSupportedAstPair(sourceAst: string, targetAst: string): boolean {
  const s = AST_BY_CODE.get(sourceAst);
  const t = AST_BY_CODE.get(targetAst);
  return s !== undefined && t !== undefined && validTarget(s, t);
}

export const INTERPRET_SUPPORTED_TARGETS = ["zh-CN", "zh-TW", "en"] as const;

export function isSupportedInterpretTarget(target: string): boolean {
  return (INTERPRET_SUPPORTED_TARGETS as readonly string[]).includes(target);
}

export function toAstLanguageCode(code: string): string {
  if (code === "zh-CN" || code === "zh-TW") {
    return "zh";
  }
  return code;
}

/**
 * AST requires an explicit source language (auto-detect is unsupported by
 * model:default). Interpret targets are constrained to the zh/en pair, so the
 * source is the counterpart: target zh → source en, target en → source zh.
 */
export function counterpartAstLanguage(targetAstCode: string): string {
  return targetAstCode === "zh" ? "en" : "zh";
}
