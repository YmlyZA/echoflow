import type { BackendConfig } from "./config.js";
import {
  ASR_PROVIDER_NAMES,
  TRANSLATION_PROVIDER_NAMES,
  isInterpretAvailable,
} from "./providers/providerConfig.js";

export type CapabilityHealth = {
  name: "asr" | "translation" | "interpret";
  provider: string;
  /** Usable as configured. A fake provider is ready — it is a valid demo, not an error. */
  ready: boolean;
  /** Served by a deterministic fake rather than a real provider. */
  demo: boolean;
  /**
   * True when `provider` is a recognized-but-not-yet-implemented choice (see
   * `UNIMPLEMENTED_PROVIDER_NAMES`) — e.g. `aliyun`/`tencent`. Distinct from a
   * real provider that is merely missing credentials: no environment variable
   * can fix this, only picking a different provider can.
   */
  unimplemented: boolean;
  /**
   * Environment variables that would make this capability real. The config layer
   * drops the whole credential object when any part is missing, so this names
   * every variable of the set rather than the one that is actually absent.
   * Empty for an unimplemented provider — no variable applies.
   */
  missing: readonly string[];
};

const IMPLEMENTED_PROVIDER_NAMES: ReadonlySet<string> = new Set([
  "fake",
  "volcengine",
  "openai",
]);
export const IMPLEMENTED_PROVIDER_LIST = "fake, volcengine or openai";

/**
 * Provider names the config layer recognizes but that have no adapter yet.
 * Derived from `providerConfig.ts`'s allowed-name lists so this can never
 * drift from what `parseAsrProviderName`/`parseTranslationProviderName`
 * accept. Exported so a later task's `/v1/capabilities` handler can reuse the
 * same "is this provider unimplemented" judgment instead of a second copy.
 */
export const UNIMPLEMENTED_PROVIDER_NAMES: readonly string[] = [
  ...new Set<string>([...ASR_PROVIDER_NAMES, ...TRANSLATION_PROVIDER_NAMES]),
].filter((name) => !IMPLEMENTED_PROVIDER_NAMES.has(name));

const ASR_CREDENTIAL_VARS = [
  "VOLCENGINE_ASR_APP_KEY",
  "VOLCENGINE_ASR_ACCESS_KEY",
] as const;
const TRANSLATION_CREDENTIAL_VARS = ["VOLCENGINE_API_KEY"] as const;
// The shared key is what a user should set first; the per-leg overrides are
// documented in .env.example, not in the fail-fast message.
const OPENAI_CREDENTIAL_VARS = ["OPENAI_API_KEY"] as const;

function missingAsrVars(asr: BackendConfig["providers"]["asr"]): readonly string[] {
  if (asr.provider === "volcengine" && asr.volcengine === undefined) {
    return [...ASR_CREDENTIAL_VARS];
  }
  if (asr.provider === "openai" && asr.openai === undefined) {
    return [...OPENAI_CREDENTIAL_VARS];
  }
  return [];
}

function missingTranslationVars(
  translation: BackendConfig["providers"]["translation"],
): readonly string[] {
  if (translation.provider === "volcengine" && translation.volcengine === undefined) {
    return [...TRANSLATION_CREDENTIAL_VARS];
  }
  if (translation.provider === "openai" && translation.openai === undefined) {
    return [...OPENAI_CREDENTIAL_VARS];
  }
  return [];
}
const INTERPRET_CREDENTIAL_VARS = ["VOLCENGINE_AST_API_KEY"] as const;

export function describeConfigHealth(
  config: BackendConfig,
): readonly CapabilityHealth[] {
  const { asr, translation } = config.providers;
  const asrUnimplemented = UNIMPLEMENTED_PROVIDER_NAMES.includes(asr.provider);
  const translationUnimplemented = UNIMPLEMENTED_PROVIDER_NAMES.includes(
    translation.provider,
  );

  return [
    {
      name: "asr",
      provider: asr.provider,
      ready:
        asr.provider === "fake" || asr.volcengine !== undefined || asr.openai !== undefined,
      demo: asr.provider === "fake",
      unimplemented: asrUnimplemented,
      missing: missingAsrVars(asr),
    },
    {
      name: "translation",
      provider: translation.provider,
      ready:
        translation.provider === "fake" ||
        translation.volcengine !== undefined ||
        translation.openai !== undefined,
      demo: translation.provider === "fake",
      unimplemented: translationUnimplemented,
      missing: missingTranslationVars(translation),
    },
    {
      name: "interpret",
      provider: "volcengine",
      ready: isInterpretAvailable(config.providers),
      demo: false,
      unimplemented: false,
      missing: isInterpretAvailable(config.providers)
        ? []
        : [...INTERPRET_CREDENTIAL_VARS],
    },
  ];
}

function describeUnavailable(capability: CapabilityHealth): string {
  if (capability.unimplemented) {
    return `${capability.provider} is not implemented yet; use ${IMPLEMENTED_PROVIDER_LIST}`;
  }
  return `unavailable — set ${capability.missing.join(", ")}`;
}

export function formatConfigHealth(health: readonly CapabilityHealth[]): string {
  const lines = health.map((capability) => {
    if (capability.demo) {
      return `  ${capability.name}: ${capability.provider} (demo — deterministic placeholder output)`;
    }
    if (capability.ready) {
      return `  ${capability.name}: ${capability.provider} (configured)`;
    }
    return `  ${capability.name}: ${describeUnavailable(capability)}`;
  });
  return ["EchoFlow configuration:", ...lines].join("\n");
}

/**
 * Throws when a provider was explicitly selected but its credentials are absent,
 * or when the selected provider name is recognized but has no adapter yet.
 * providerFactory already throws for both cases, but only when a session opens —
 * this moves the same failure to boot, where the cause is.
 *
 * `interpret` is never fatal: it is opt-in, and a backend without AST credentials
 * is a valid pipeline-only deployment.
 */
export function assertConfigUsable(health: readonly CapabilityHealth[]): void {
  const broken = health.filter(
    (capability) => capability.name !== "interpret" && !capability.ready,
  );
  if (broken.length === 0) {
    return;
  }
  const detail = broken
    .map((capability) =>
      capability.unimplemented
        ? `${capability.name} provider ${capability.provider} is not implemented yet; use ${IMPLEMENTED_PROVIDER_LIST}`
        : `${capability.name} requires ${capability.missing.join(" and ")}`,
    )
    .join("; ");
  throw new Error(`Backend configuration is incomplete: ${detail}`);
}
