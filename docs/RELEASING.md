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
