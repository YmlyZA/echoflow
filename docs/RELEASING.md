# Releasing EchoFlow

Releases are **tag-driven**. The version lives in the git tag, not in any
committed file — `.github/workflows/release.yml` builds two artifacts when you
push a `vX.Y.Z` tag: the extension zip, attached to a GitHub Release, and a
multi-arch backend container image, pushed to ghcr.io.

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

4. Watch the run: `gh run watch` (or the Actions tab). The `release` job:
   - derives the version from the tag (`scripts/print-version.ts`),
   - runs `pnpm typecheck` and `pnpm test` (a red build never publishes),
   - builds and `wxt zip`s the extension,
   - creates the Release with `echoflow-<version>-chrome.zip` attached and
     auto-generated notes.

   A second `image` job then reuses that same derived version to build and
   push the backend container image (`linux/amd64` + `linux/arm64`) to
   `ghcr.io/ymlyza/echoflow-backend`, tagged with the version and, for
   non-prerelease tags only, also `latest`.

## Verify

- The Release lists `echoflow-<version>-chrome.zip`.
- Download it, unzip, Load unpacked, and confirm `chrome://extensions` shows
  the expected version (prerelease tags show the full string as the version
  name, e.g. `0.2.0-beta.1`).
- `ghcr.io/ymlyza/echoflow-backend` has a new version tag (and `latest`, for
  non-prerelease tags).

## Notes

- The Chrome manifest `version` must be plain integers; WXT strips any
  prerelease suffix into `version_name` automatically — a `v0.2.0-beta.1` tag
  yields manifest `version 0.2.0` + `version_name 0.2.0-beta.1`.
- A malformed tag fails the "Derive version" step loudly rather than
  publishing a mis-versioned build.
- Chrome MV3 only; no Firefox/AMO artifact, no `.crx` signing.
- **First publish only:** a newly-created ghcr.io package defaults to
  private. Visit the package settings on GitHub and change its visibility to
  public once, manually — otherwise `docker run ghcr.io/ymlyza/echoflow-backend`
  prompts for credentials instead of pulling.
