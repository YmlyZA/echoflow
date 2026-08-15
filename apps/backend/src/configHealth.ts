import type { BackendConfig } from "./config.js";
import { isInterpretAvailable } from "./providers/providerConfig.js";

export type CapabilityHealth = {
  name: "asr" | "translation" | "interpret";
  provider: string;
  /** Usable as configured. A fake provider is ready — it is a valid demo, not an error. */
  ready: boolean;
  /** Served by a deterministic fake rather than a real provider. */
  demo: boolean;
  /**
   * Environment variables that would make this capability real. The config layer
   * drops the whole credential object when any part is missing, so this names
   * every variable of the set rather than the one that is actually absent.
   */
  missing: readonly string[];
};

const ASR_CREDENTIAL_VARS = [
  "VOLCENGINE_ASR_APP_KEY",
  "VOLCENGINE_ASR_ACCESS_KEY",
] as const;
const TRANSLATION_CREDENTIAL_VARS = ["VOLCENGINE_API_KEY"] as const;
const INTERPRET_CREDENTIAL_VARS = ["VOLCENGINE_AST_API_KEY"] as const;

export function describeConfigHealth(
  config: BackendConfig,
): readonly CapabilityHealth[] {
  const { asr, translation } = config.providers;

  return [
    {
      name: "asr",
      provider: asr.provider,
      ready: asr.provider === "fake" || asr.volcengine !== undefined,
      demo: asr.provider === "fake",
      missing:
        asr.provider === "volcengine" && asr.volcengine === undefined
          ? [...ASR_CREDENTIAL_VARS]
          : [],
    },
    {
      name: "translation",
      provider: translation.provider,
      ready: translation.provider === "fake" || translation.volcengine !== undefined,
      demo: translation.provider === "fake",
      missing:
        translation.provider === "volcengine" && translation.volcengine === undefined
          ? [...TRANSLATION_CREDENTIAL_VARS]
          : [],
    },
    {
      name: "interpret",
      provider: "volcengine",
      ready: isInterpretAvailable(config.providers),
      demo: false,
      missing: isInterpretAvailable(config.providers)
        ? []
        : [...INTERPRET_CREDENTIAL_VARS],
    },
  ];
}

export function formatConfigHealth(health: readonly CapabilityHealth[]): string {
  const lines = health.map((capability) => {
    if (capability.demo) {
      return `  ${capability.name}: ${capability.provider} (demo — deterministic placeholder output)`;
    }
    if (capability.ready) {
      return `  ${capability.name}: ${capability.provider} (configured)`;
    }
    return `  ${capability.name}: unavailable — set ${capability.missing.join(", ")}`;
  });
  return ["EchoFlow configuration:", ...lines].join("\n");
}

/**
 * Throws when a provider was explicitly selected but its credentials are absent.
 * providerFactory already throws for this case, but only when a session opens —
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
    .map((capability) => `${capability.name} requires ${capability.missing.join(" and ")}`)
    .join("; ");
  throw new Error(`Backend configuration is incomplete: ${detail}`);
}
