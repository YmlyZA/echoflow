# Packaging & Release Design (Direction B)

> Captured 2026-07-01. Direction B / "Packaging / distribution" from `docs/superpowers/backlog.md`.
> Turns the extension from "clone and build" into a downloadable, versioned artifact.

## Goal

Pushing a `vX.Y.Z` git tag triggers a GitHub Actions workflow that builds, zips, and
publishes a GitHub Release with `echoflow-X.Y.Z-chrome.zip` attached. A non-developer
downloads the zip, Load-unpacks it in Chrome, and — following a documented backend
quickstart — gets end-to-end bilingual subtitles on the deterministic fake providers
without cloning or building the extension.

## Non-goals (YAGNI)

- **Chrome Web Store submission** — still deferred (localhost/self-host model). This design
  produces the artifact that a future submission would reuse, nothing more.
- **Firefox / AMO** — Chrome MV3 only. No sources zip, no `browser_specific_settings`.
- **`.crx` packaging / signing** — the Release ships an unpacked zip (Load unpacked), not a
  signed `.crx`.
- **Bundling a backend artifact** — the backend is still run from source. We document how,
  but do not package or version it here.

## Distribution reality (why the docs matter)

The extension is inert without a local backend at `http://127.0.0.1:8787`. A prebuilt zip
therefore removes only the *extension* build step; the user still runs the backend. The
fake speech/translation providers require **no credentials**, so a non-developer can reach a
working end-to-end demo with just `pnpm install` + one `dev` command. Real ASR/translation
still needs Volcengine credentials in the backend `.env` (never in the extension). The docs
state this plainly rather than implying the zip is a standalone app.

## Architecture

Four pieces, smallest-blast-radius first:

### 1. `deriveVersion(tag)` — the one unit of real logic

A pure helper that converts a git tag into the manifest version fields and release flags.
This is the only part with branching logic, so it is isolated and unit-tested; everything
else is configuration or a shell workflow.

**Location:** `apps/extension/src/release/deriveVersion.ts` (+ colocated
`deriveVersion.test.ts`).

**Signature:**

```ts
export interface DerivedVersion {
  /** Chrome-manifest-legal version: 1–4 dot-separated integers. e.g. "0.1.0" */
  version: string;
  /** Human-facing full version incl. any prerelease suffix. e.g. "0.1.0-beta.2" */
  versionName: string;
  /** True when the tag carried a prerelease suffix (`-…`). */
  prerelease: boolean;
}

export function deriveVersion(tag: string): DerivedVersion;
```

**Behavior:**

| Input tag        | version | versionName    | prerelease |
|------------------|---------|----------------|------------|
| `v0.1.0`         | `0.1.0` | `0.1.0`        | `false`    |
| `v1.2.3`         | `1.2.3` | `1.2.3`        | `false`    |
| `v0.1.0-beta.2`  | `0.1.0` | `0.1.0-beta.2` | `true`     |
| `v2.0.0-rc.1`    | `2.0.0` | `2.0.0-rc.1`   | `true`     |

- Accepts an optional leading `v` (present or absent).
- `version` is the leading `MAJOR.MINOR.PATCH` (all integers); any `-suffix` is stripped for
  Chrome legality and reflected only in `versionName`.
- Rejects a malformed tag — missing/short numeric core, non-integer segments, empty — by
  throwing an `Error` with a message naming the offending tag, so the workflow fails loudly
  rather than publishing a mis-versioned build. Rejection cases to cover in tests: `v1`,
  `v1.2`, `1.2.3.4.5`, `vx.y.z`, `` (empty), `v1.2.-beta`.

Chrome's version format allows 1–4 dot-separated integers each 0–65535; requiring exactly
`MAJOR.MINOR.PATCH` (3 segments) is a deliberate, stricter house rule for predictable tags.

### 2. Dynamic manifest version (`wxt.config.ts`)

The manifest version stops being a hardcoded literal and reads build-time env, falling back
to a dev default:

```ts
manifest: {
  // …
  version: process.env.EF_VERSION ?? "0.0.0",
  ...(process.env.EF_VERSION_NAME ? { version_name: process.env.EF_VERSION_NAME } : {}),
}
```

- Dev builds (`pnpm dev`, `pnpm build` with no env) → `0.0.0`, no `version_name`.
- The release workflow exports `EF_VERSION` / `EF_VERSION_NAME` from `deriveVersion`.
- Add `zip: { name: "echoflow" }` to the WXT config so the artifact filename is
  deterministically `echoflow-<version>-chrome.zip` regardless of the scoped package name.
- Add a `"zip": "wxt zip"` script to `apps/extension/package.json`.

### 3. Release workflow (`.github/workflows/release.yml`)

```yaml
name: Release

on:
  push:
    tags: ["v*"]

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write            # create the Release
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile

      # Derive version fields from the tag via the tested helper, export to env.
      - name: Derive version
        id: ver
        run: node apps/extension/scripts/print-version.mjs "${GITHUB_REF_NAME}" >> "$GITHUB_OUTPUT"

      # Never publish a broken build.
      - run: pnpm typecheck
      - run: pnpm test

      - name: Build + zip extension
        env:
          EF_VERSION: ${{ steps.ver.outputs.version }}
          EF_VERSION_NAME: ${{ steps.ver.outputs.versionName }}
        run: pnpm --filter @echoflow/extension zip

      - name: Publish Release
        uses: softprops/action-gh-release@v2
        with:
          files: apps/extension/.output/echoflow-${{ steps.ver.outputs.version }}-chrome.zip
          prerelease: ${{ steps.ver.outputs.prerelease }}
          generate_release_notes: true
```

`apps/extension/scripts/print-version.mjs` is a ~5-line shim: import `deriveVersion`, call it
on `process.argv[2]`, print `version=…`, `versionName=…`, `prerelease=…` lines for
`$GITHUB_OUTPUT`. It imports the same tested helper so the workflow and the unit tests share
one implementation. (WXT `zip` output path is `.output/`; confirm the exact filename WXT
emits during implementation and align the `files:` glob — fall back to
`apps/extension/.output/*-chrome.zip` if WXT's naming differs from the `zip.name` config.)

### 4. Documentation

- **README — "Install (prebuilt)"**: download `echoflow-X.Y.Z-chrome.zip` from the latest
  Release → unzip → `chrome://extensions` → Developer mode → Load unpacked → select the
  unzipped folder. Note it is an unpacked build (not a signed `.crx`), consistent with the
  self-host model. Keep the existing "build from source" path for developers.
- **README — "Run the backend" quickstart**: `pnpm install` → copy `.env.example` to `.env`
  → `pnpm --filter @echoflow/backend dev`; fake providers work with no credentials. One
  honest line: real ASR/translation needs Volcengine credentials in `.env` (extension never
  holds secrets).
- **`docs/RELEASING.md`** — maintainer checklist: decide the version, `git tag vX.Y.Z` +
  `git push origin vX.Y.Z`, what the workflow does, how to verify the artifact downloads and
  loads, and how prerelease tags (`vX.Y.Z-…`) are marked.

## Testing

- **Unit:** `deriveVersion` covers each row of the behavior table plus every rejection case.
  Runs inside the existing `pnpm test` (and therefore the `check` CI job).
- **Workflow:** validated the way `ci.yml` was — push a throwaway prerelease tag
  (e.g. `v0.0.1-test.1`), confirm the Release is created, marked prerelease, and carries
  `echoflow-0.0.1-chrome.zip`; download + Load unpack once to confirm the manifest version
  reads `0.0.1` with `version_name` `0.0.1-test.1`. Then delete the throwaway tag and its
  Release.
- No test renders CSS or the manifest; the manifest wiring is covered by the throwaway-tag
  validation, not a unit test.

## Rollout

1. Land `deriveVersion` + config + workflow + docs on `feat/packaging-release` via PR
   (branch protection requires the `check` job to pass).
2. After merge, cut the throwaway validation tag, verify, clean it up.
3. Cut the first real tag (`v0.1.0`) when ready — separate, deliberate step, not part of this
   PR.
4. Mark "Packaging / distribution" shipped in `docs/superpowers/backlog.md`.
