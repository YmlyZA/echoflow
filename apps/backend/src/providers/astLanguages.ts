export const INTERPRET_SUPPORTED_TARGETS = ["zh-CN", "zh-TW", "en"] as const;

export function isSupportedInterpretTarget(target: string): boolean {
  return (INTERPRET_SUPPORTED_TARGETS as readonly string[]).includes(target);
}

export function toAstLanguageCode(target: string): string {
  if (target === "zh-CN" || target === "zh-TW") {
    return "zh";
  }
  return "en";
}

/**
 * AST requires an explicit source language (auto-detect is unsupported by
 * model:default). Interpret targets are constrained to the zh/en pair, so the
 * source is the counterpart: target zh → source en, target en → source zh.
 */
export function counterpartAstLanguage(targetAstCode: string): string {
  return targetAstCode === "zh" ? "en" : "zh";
}
