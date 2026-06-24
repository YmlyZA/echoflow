import {
  validTarget,
  type LanguageOption,
  type ModeCapabilities,
} from "@echoflow/protocol";

export type LanguagePair = { source: string; target: string };

export function sourceOptions(caps: ModeCapabilities): LanguageOption[] {
  return caps.autoDetect ? [] : caps.languages;
}

export function targetOptions(
  caps: ModeCapabilities,
  sourceCode: string,
): LanguageOption[] {
  if (caps.autoDetect) {
    return caps.languages.filter((l) => l.sourceOnly !== true);
  }
  const source = caps.languages.find((l) => l.code === sourceCode);
  if (source === undefined) {
    return [];
  }
  return caps.languages.filter((target) => validTarget(source, target));
}

/** Prefer `wanted`, then `fallback`, then the first option; "" if none. */
function pickCode(options: LanguageOption[], wanted: string, fallback: string): string {
  if (options.some((o) => o.code === wanted)) return wanted;
  if (options.some((o) => o.code === fallback)) return fallback;
  return options[0]?.code ?? "";
}

export function coercePair(
  caps: ModeCapabilities,
  source: string,
  target: string,
): LanguagePair {
  const fallback = caps.defaultPair ?? { source: "", target: "" };

  if (caps.autoDetect) {
    const targets = targetOptions(caps, source);
    return { source: "auto", target: pickCode(targets, target, fallback.target) };
  }

  const resolvedSource = pickCode(sourceOptions(caps), source, fallback.source);
  const targets = targetOptions(caps, resolvedSource);
  return { source: resolvedSource, target: pickCode(targets, target, fallback.target) };
}

export function filterLanguages(
  options: LanguageOption[],
  query: string,
): LanguageOption[] {
  const q = query.trim().toLowerCase();
  if (q === "") {
    return options;
  }
  return options.filter(
    (o) => o.code.toLowerCase().includes(q) || o.label.toLowerCase().includes(q),
  );
}
