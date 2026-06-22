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
