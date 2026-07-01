# Packaging & Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pushing a `vX.Y.Z` git tag makes GitHub Actions build, `wxt zip`, and publish a GitHub Release with `echoflow-<version>-chrome.zip` attached, versioned from the tag.

**Architecture:** A pure, unit-tested `deriveVersion(tag)` helper turns the tag into `{ version, versionName, prerelease }`. `wxt.config.ts` reads `EF_VERSION_NAME` from the build environment into the manifest (WXT derives the Chrome-legal numeric `version` from it, stripping any prerelease suffix, and emits `version_name` only when it differs). A `scripts/print-version.ts` shim (run with `tsx`) bridges the tag to the workflow's env via the same tested helper. `.github/workflows/release.yml` wires it together; README + `docs/RELEASING.md` document install and cutting a release.

**Tech Stack:** WXT 0.20 (`wxt zip`), TypeScript, Vitest, tsx, GitHub Actions, `softprops/action-gh-release@v2`.

## Global Constraints

- **Tag is the version source of truth.** Nothing in a committed file carries the release version; the tag drives it. `wxt.config.ts` keeps a dev-only fallback of `0.0.0`.
- **Version tag format:** exactly `vMAJOR.MINOR.PATCH` (three integers), optional leading `v`, optional `-prerelease` suffix. A malformed tag must throw (fail the release loudly), never publish a mis-versioned build.
- **Chrome manifest `version` must be dot-separated integers only.** Prerelease suffixes live in `version_name`, never in `version`. (WXT enforces this via its own `simplifyVersion`; do not hand-roll a second stripper.)
- **Deterministic artifact name:** `echoflow-<version>-chrome.zip`, produced by `zip: { name: "echoflow" }` in the WXT config.
- **Chrome MV3 only.** No Firefox/AMO, no sources zip, no `.crx` signing, no backend artifact. (YAGNI — from the spec's non-goals.)
- **Never publish a broken build:** the release workflow runs `pnpm typecheck` + `pnpm test` before zipping.
- **Secrets stay in backend env files.** Docs must not put credentials in the extension; the backend quickstart uses fake providers (no creds) with an honest note that real ASR needs Volcengine creds in `.env`.
- Colocated `*.test.ts` under `src/`, run by Vitest (`vitest run src`), which is what the `check` CI job executes.

---

### Task 1: `deriveVersion` helper

Pure tag→version logic, the only branching logic in this feature. Unit-tested; everything downstream is config/workflow/docs.

**Files:**
- Create: `apps/extension/src/release/deriveVersion.ts`
- Test: `apps/extension/src/release/deriveVersion.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface DerivedVersion { version: string; versionName: string; prerelease: boolean }` and `function deriveVersion(tag: string): DerivedVersion`. Task 2's `print-version.ts` imports this.

- [ ] **Step 1: Write the failing test**

Create `apps/extension/src/release/deriveVersion.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveVersion } from "./deriveVersion";

describe("deriveVersion", () => {
  it("derives a plain release version", () => {
    expect(deriveVersion("v0.1.0")).toEqual({
      version: "0.1.0",
      versionName: "0.1.0",
      prerelease: false
    });
  });

  it("accepts a tag without the leading v", () => {
    expect(deriveVersion("1.2.3")).toEqual({
      version: "1.2.3",
      versionName: "1.2.3",
      prerelease: false
    });
  });

  it("keeps the suffix in versionName and marks prerelease", () => {
    expect(deriveVersion("v0.1.0-beta.2")).toEqual({
      version: "0.1.0",
      versionName: "0.1.0-beta.2",
      prerelease: true
    });
  });

  it("handles an rc suffix", () => {
    expect(deriveVersion("v2.0.0-rc.1")).toEqual({
      version: "2.0.0",
      versionName: "2.0.0-rc.1",
      prerelease: true
    });
  });

  it.each(["v1", "v1.2", "1.2.3.4.5", "vx.y.z", "", "v1.2.-beta", "v01.2.3"])(
    "rejects malformed tag %j",
    (tag) => {
      expect(() => deriveVersion(tag)).toThrow(/Invalid release tag/);
    }
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- deriveVersion`
Expected: FAIL — `deriveVersion` cannot be imported (module/function does not exist).

- [ ] **Step 3: Write the implementation**

Create `apps/extension/src/release/deriveVersion.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @echoflow/extension test -- deriveVersion`
Expected: PASS — all cases green (4 accept + 7 reject).

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/release/deriveVersion.ts apps/extension/src/release/deriveVersion.test.ts
git commit -m "feat(extension): deriveVersion helper for tag-driven release versions"
```

---

### Task 2: Build wiring — dynamic manifest version, deterministic zip name, tag→env shim

Make a build produce a correctly-versioned, deterministically-named zip, and add the shim the workflow uses to turn a tag into env vars.

**Files:**
- Modify: `apps/extension/wxt.config.ts`
- Modify: `apps/extension/package.json` (add `zip` script + `tsx` devDependency)
- Create: `apps/extension/scripts/print-version.ts`

**Interfaces:**
- Consumes: `deriveVersion` from `apps/extension/src/release/deriveVersion.ts` (Task 1).
- Produces (relied on by Task 3's workflow):
  - Env contract: a release build reads `process.env.EF_VERSION_NAME` (the full tag version, e.g. `0.1.0` or `0.1.0-beta.2`) into the manifest.
  - The `pnpm --filter @echoflow/extension zip` script emits `apps/extension/.output/echoflow-<version>-chrome.zip`.
  - `scripts/print-version.ts <tag>` prints three lines to stdout — `version=…`, `versionName=…`, `prerelease=…` — for appending to `$GITHUB_OUTPUT`; exits non-zero on a malformed tag.

- [ ] **Step 1: Add the `tsx` devDependency and the `zip` script**

In `apps/extension/package.json`, add to `scripts` (after `"build"`):

```json
    "zip": "wxt zip",
```

and add to `devDependencies` (keep alphabetical; version matches the backend's tsx):

```json
    "tsx": "^4.22.3",
```

Then install so the lockfile updates:

Run: `pnpm install`
Expected: completes; `apps/extension` now has `tsx` available.

- [ ] **Step 2: Wire the manifest version to the environment**

Replace the contents of `apps/extension/wxt.config.ts` with:

```ts
import { defineConfig } from "wxt";

// Release builds inject the full version (including any prerelease suffix) via
// EF_VERSION_NAME; the release workflow sets it from the git tag. WXT derives
// the Chrome-legal numeric `version` from version_name itself (stripping any
// -suffix) and only emits version_name when it differs. Dev/local builds fall
// back to a static 0.0.0.
const versionName = process.env.EF_VERSION_NAME;

export default defineConfig({
  manifestVersion: 3,
  modules: ["@wxt-dev/module-react"],
  zip: {
    // Deterministic artifact name regardless of the scoped package name:
    // echoflow-<version>-chrome.zip
    name: "echoflow"
  },
  manifest: {
    name: "EchoFlow",
    description: "Real-time bilingual subtitles for tab audio.",
    ...(versionName ? { version_name: versionName } : { version: "0.0.0" }),
    permissions: ["activeTab", "storage", "tabCapture", "offscreen", "scripting"],
    host_permissions: ["http://127.0.0.1/*", "http://localhost/*"],
    icons: {
      16: "/icon/16.png",
      32: "/icon/32.png",
      48: "/icon/48.png",
      128: "/icon/128.png"
    },
    action: {
      default_title: "EchoFlow",
      default_popup: "popup.html",
      default_icon: {
        16: "/icon/16.png",
        32: "/icon/32.png",
        48: "/icon/48.png",
        128: "/icon/128.png"
      }
    }
  }
});
```

- [ ] **Step 3: Create the tag→env shim**

Create `apps/extension/scripts/print-version.ts`:

```ts
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
```

- [ ] **Step 4: Verify the shim (accept + reject)**

Run: `pnpm --filter @echoflow/extension exec tsx scripts/print-version.ts v0.1.0-beta.2`
Expected stdout exactly:

```
version=0.1.0
versionName=0.1.0-beta.2
prerelease=true
```

Run: `pnpm --filter @echoflow/extension exec tsx scripts/print-version.ts nope; echo "exit=$?"`
Expected: prints an `Invalid release tag "nope"…` message to stderr and `exit=1`.

- [ ] **Step 5: Verify the release build produces a correctly-versioned manifest**

Run: `EF_VERSION_NAME=1.2.3-rc.1 pnpm --filter @echoflow/extension build`
Then: `node -e "const m=require('./apps/extension/.output/chrome-mv3/manifest.json'); console.log(m.version, '|', m.version_name)"`
Expected output: `1.2.3 | 1.2.3-rc.1` (WXT stripped the suffix for `version`, kept it in `version_name`).

Run (dev fallback): `pnpm --filter @echoflow/extension build`
Then: `node -e "const m=require('./apps/extension/.output/chrome-mv3/manifest.json'); console.log(m.version, '|', m.version_name)"`
Expected output: `0.0.0 | undefined`.

- [ ] **Step 6: Verify the zip name is deterministic**

Run: `EF_VERSION_NAME=1.2.3 pnpm --filter @echoflow/extension zip && ls apps/extension/.output/*.zip`
Expected: a file `apps/extension/.output/echoflow-1.2.3-chrome.zip` exists.
(If WXT emits a different filename, align `zip.name` / note the actual template — the workflow's upload glob in Task 3 is `echoflow-*-chrome.zip`, so any `echoflow-…-chrome.zip` is fine.)

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: PASS (the `version_name` key is valid in WXT's manifest type).

- [ ] **Step 8: Commit**

```bash
git add apps/extension/wxt.config.ts apps/extension/package.json apps/extension/scripts/print-version.ts pnpm-lock.yaml
git commit -m "feat(extension): tag-driven manifest version + deterministic zip name"
```

---

### Task 3: Release workflow

Tag push → build → zip → publish Release. Reviewable by inspection; end-to-end validation is a post-merge throwaway tag (see the controller's rollout note below, not part of this task's tests).

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: the `zip` script + `EF_VERSION_NAME` env contract + `scripts/print-version.ts` from Task 2; mirrors `.github/workflows/ci.yml`'s pnpm/Node setup.
- Produces: a GitHub Release per `v*` tag with the zip attached.

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags: ["v*"]

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write # create the GitHub Release
    steps:
      - uses: actions/checkout@v4

      # Install pnpm first so setup-node's pnpm cache can resolve the store.
      # Version comes from the "packageManager" field in package.json (pnpm@10).
      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      # Turn the tag into version fields via the same tested helper the build uses.
      - name: Derive version from tag
        id: ver
        run: pnpm --filter @echoflow/extension exec tsx scripts/print-version.ts "${GITHUB_REF_NAME}" >> "$GITHUB_OUTPUT"

      # Never publish a broken build.
      - run: pnpm typecheck
      - run: pnpm test

      - name: Build and zip the extension
        env:
          EF_VERSION_NAME: ${{ steps.ver.outputs.versionName }}
        run: pnpm --filter @echoflow/extension zip

      - name: Publish GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: apps/extension/.output/echoflow-*-chrome.zip
          prerelease: ${{ steps.ver.outputs.prerelease }}
          generate_release_notes: true
```

- [ ] **Step 2: Validate the YAML parses**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml')); print('yaml ok')"`
Expected: `yaml ok`.

- [ ] **Step 3: Sanity-check the shim path used by the workflow**

The workflow runs the shim with `--filter @echoflow/extension exec` (cwd = `apps/extension`), so the `scripts/print-version.ts` path is relative to the package. Confirm it resolves:

Run: `pnpm --filter @echoflow/extension exec tsx scripts/print-version.ts v9.9.9`
Expected stdout: `version=9.9.9` / `versionName=9.9.9` / `prerelease=false`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(extension): tag-driven release workflow (build, zip, publish)"
```

---

### Task 4: Documentation — prebuilt install, backend quickstart, releasing guide

Make the artifact usable and the release process repeatable.

**Files:**
- Modify: `README.md` (add "Install (prebuilt)" + "Run the backend" quickstart; keep the existing build-from-source path)
- Create: `docs/RELEASING.md`

**Interfaces:**
- Consumes: the Release artifact naming (`echoflow-X.Y.Z-chrome.zip`) and the tag workflow from Tasks 2–3.
- Produces: nothing consumed by code.

- [ ] **Step 1: Add the prebuilt-install section to the README**

In `README.md`, immediately **before** the existing `## Load the Extension in Chrome` heading, insert:

```markdown
## Install (prebuilt)

Non-developers can skip building the extension:

1. Open the project's [GitHub Releases](../../releases) and download the latest
   `echoflow-<version>-chrome.zip`.
2. Unzip it to a folder you'll keep (Chrome loads it from disk).
3. Go to `chrome://extensions`, enable **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped folder.

This is an unpacked build (not a signed `.crx`), matching EchoFlow's self-host
model. The extension still needs the local backend running — see
[Run the backend](#run-the-backend) below.

To build from source instead, follow the developer steps below.
```

- [ ] **Step 2: Add the backend quickstart to the README**

In `README.md`, add a `## Run the backend` section (place it after the install sections, before or near the existing setup steps — wherever backend startup is first needed). Content:

```markdown
## Run the backend

The extension talks to a local backend at `http://127.0.0.1:8787`. The bundled
**fake** speech/translation providers need no credentials, so you can reach a
working end-to-end demo in three commands:

```bash
pnpm install
cp apps/backend/.env.example apps/backend/.env   # defaults use the fake providers
pnpm --filter @echoflow/backend dev              # starts the backend on :8787
```

Then start subtitles from the EchoFlow toolbar popup on any tab playing audio.

For **real** speech recognition and translation, add Volcengine credentials to
`apps/backend/.env` (see `.env.example` for the keys). Credentials live only in
the backend env file — never in the extension.
```

(If `apps/backend/.env.example` is at a different path, use the actual path; verify with `ls apps/backend/.env.example` before writing the command.)

- [ ] **Step 3: Verify README links/paths are real**

Run: `ls apps/backend/.env.example && grep -n "Run the backend\|Install (prebuilt)" README.md`
Expected: the `.env.example` path exists and both new headings are present. If `.env.example` doesn't exist at that path, correct the quickstart command to the real path (do not invent one).

- [ ] **Step 4: Create the releasing guide**

Create `docs/RELEASING.md`:

```markdown
# Releasing EchoFlow

Releases are **tag-driven**. The version lives in the git tag, not in any
committed file — `.github/workflows/release.yml` builds, zips, and publishes a
GitHub Release when you push a `vX.Y.Z` tag.

## Cut a release

1. Make sure `main` is green (the `check` CI job passes) and up to date.
2. Choose the version. Tags are `vMAJOR.MINOR.PATCH`, with an optional
   prerelease suffix (`v0.2.0-beta.1`). Prerelease tags are published as
   GitHub **pre-releases** automatically.
3. Tag and push:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

4. Watch the run: `gh run watch` (or the Actions tab). The workflow:
   - derives the version from the tag (`scripts/print-version.ts`),
   - runs `pnpm typecheck` and `pnpm test` (a red build never publishes),
   - builds and `wxt zip`s the extension,
   - creates the Release with `echoflow-<version>-chrome.zip` attached and
     auto-generated notes.

## Verify

- The Release lists `echoflow-<version>-chrome.zip`.
- Download it, unzip, Load unpacked, and confirm `chrome://extensions` shows
  the expected version (prerelease tags show the full string as the version
  name, e.g. `0.2.0-beta.1`).

## Notes

- The Chrome manifest `version` must be plain integers; WXT strips any
  prerelease suffix into `version_name` automatically — a `v0.2.0-beta.1` tag
  yields manifest `version 0.2.0` + `version_name 0.2.0-beta.1`.
- A malformed tag fails the "Derive version" step loudly rather than
  publishing a mis-versioned build.
- Chrome MV3 only; no Firefox/AMO artifact, no `.crx` signing, no backend
  bundle (run the backend from source — see the README).
```

- [ ] **Step 5: Commit**

```bash
git add README.md docs/RELEASING.md
git commit -m "docs: prebuilt install, backend quickstart, and releasing guide"
```

---

## Self-Review

**Spec coverage:**
- `deriveVersion` (spec §1) → Task 1. ✅
- Dynamic manifest version + `zip.name` + `zip` script (spec §2) → Task 2. ✅ (Refinement vs. spec: the spec sketched injecting `EF_VERSION` into `version` and `EF_VERSION_NAME` into `version_name`; that produces an **invalid** Chrome `version` for prerelease tags. The plan instead sets only `version_name` and lets WXT's own `simplifyVersion` derive the numeric `version` — same intent, correct for prereleases, one env var. Flagged here so review treats it as intentional.)
- `print-version` shim (spec §3) → Task 2 (folded in — it's build scaffolding the workflow consumes). ✅
- Release workflow (spec §3) → Task 3. ✅
- README prebuilt-install + backend quickstart + `RELEASING.md` (spec §4) → Task 4. ✅
- Testing: unit tests for `deriveVersion`; throwaway-tag validation is a post-merge controller step (spec "Testing"/"Rollout"), not a task. ✅
- Backlog update (spec "Rollout" step 4) → done by the controller at finish, after merge.

**Placeholder scan:** No TBD/TODO. The two "if the path/filename differs" notes each carry a concrete fallback (wildcard glob; verify-then-correct with `ls`), not vague hand-waving.

**Type consistency:** `deriveVersion` returns `{ version, versionName, prerelease }` in Task 1; `print-version.ts` destructures exactly those in Task 2; the workflow reads `steps.ver.outputs.version|versionName|prerelease` in Task 3. Env var is `EF_VERSION_NAME` in both the config (Task 2) and the workflow (Task 3). Artifact glob `echoflow-*-chrome.zip` (Task 3) matches `zip.name: "echoflow"` (Task 2). Consistent.
