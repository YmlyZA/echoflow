// Bridges a git tag to the release workflow's env via the same tested helper
// the extension build trusts. Run with tsx:
//   tsx scripts/print-version.ts "v0.1.0" >> "$GITHUB_OUTPUT"
import { deriveVersion } from "../src/release/deriveVersion";

const tag = process.argv[2];
if (!tag) {
  console.error("usage: print-version <tag>");
  process.exit(1);
}

try {
  const { version, versionName, prerelease } = deriveVersion(tag);
  process.stdout.write(
    `version=${version}\nversionName=${versionName}\nprerelease=${prerelease}\n`
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
