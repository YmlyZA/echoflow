export interface DerivedVersion {
  /** Chrome-manifest-legal version: MAJOR.MINOR.PATCH integers. e.g. "0.1.0" */
  version: string;
  /** Full version including any prerelease suffix. e.g. "0.1.0-beta.2" */
  versionName: string;
  /** True when the tag carried a prerelease suffix (`-…`). */
  prerelease: boolean;
}

/**
 * Convert a git tag into the extension's version fields.
 *
 * Accepts `vMAJOR.MINOR.PATCH` (leading `v` optional) with an optional
 * `-prerelease` suffix. Throws on anything else so the release workflow fails
 * loudly instead of publishing a mis-versioned build.
 */
export function deriveVersion(tag: string): DerivedVersion {
  const raw = tag.startsWith("v") ? tag.slice(1) : tag;
  const dash = raw.indexOf("-");
  const core = dash === -1 ? raw : raw.slice(0, dash);
  const suffix = dash === -1 ? "" : raw.slice(dash + 1);

  const parts = core.split(".");
  const partsAreIntegers = parts.every((p) => /^(0|[1-9]\d*)$/.test(p));
  const suffixOk = dash === -1 || suffix.length > 0;

  if (parts.length !== 3 || !partsAreIntegers || !suffixOk) {
    throw new Error(
      `Invalid release tag ${JSON.stringify(tag)}: expected vMAJOR.MINOR.PATCH ` +
        `(e.g. v0.1.0) with an optional -prerelease suffix.`
    );
  }

  return { version: core, versionName: raw, prerelease: suffix.length > 0 };
}
