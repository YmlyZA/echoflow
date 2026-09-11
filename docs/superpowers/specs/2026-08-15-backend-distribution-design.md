# Backend Distribution and Honest Capabilities Design

> Captured 2026-08-15. First slice after `v0.1.0`. The product arcs (UX overhaul, video-anchored
> history SP1a–SP3, self-hosted sync SP4) are all complete; the binding constraint on the project
> is no longer features but **the install path**. Today a user must clone the repo, install pnpm,
> build a workspace, and hand-write an env file before the first subtitle appears. This slice
> replaces that with a published container image, and makes the backend tell the truth about its
> own configuration so a misconfigured install fails where the cause is, not three steps later.

## The problem, precisely

Two failures compound today:

1. **No runnable artifact.** `pnpm build` emits `apps/backend/dist/`, but that output has never
   been executed — `dev` runs through `tsx` and CI only builds. Running it fails immediately:
   Node resolves `@echoflow/protocol` to `packages/protocol/src/index.ts` (its `exports` target),
   strips the types successfully, and then dies on `ERR_MODULE_NOT_FOUND` for
   `packages/protocol/src/events.js` — the repo's `.js`-suffix import convention pointing at a
   file that only exists under `packages/protocol/dist/`. Type stripping does not rewrite
   specifiers. `tsc` type-checks; it does not verify runtime module resolution, so `pnpm build`
   has stayed green over a non-runnable artifact.
2. **Misconfiguration surfaces at the wrong moment.** `readProviderConfig` silently omits
   `config.asr.volcengine` when `ECHOFLOW_ASR_PROVIDER=volcengine` but the credentials are missing
   or misspelled. The backend boots, `/healthz` returns `{ok:true}`, and `/v1/capabilities`
   advertises `pipeline.available: true`. `providerFactory` throws — but it runs **per connection**,
   so the user learns about their typo only after clicking Start, as a capture error. Worse,
   `buildCapabilities` reports `pipeline.available: true` unconditionally, so a backend running the
   `fake` providers passes the onboarding wizard's Connect gate and the user then puzzles over
   deterministic placeholder subtitles.

The install path is the product bottleneck, and the diagnostic path is what makes a stumble on it
unrecoverable.

## Product decisions (settled with the user)

1. **Docker only, one channel.** The target user is comfortable with a terminal but should not have
   to clone and build. A multi-arch image on `ghcr.io` is the single supported distribution path.
   No npm package, no single-file binary, no desktop app this slice.
2. **The wizard is the extension's existing onboarding, not a new surface.** The backend exposes
   structured diagnostics through `/v1/capabilities`; the Connect step renders them. Zero new UI
   surfaces, and the diagnosis appears on the screen the user is actually looking at.
3. **`pipeline.available` stays `true` under `fake` providers.** The zero-credential deterministic
   demo is an advertised feature, not a broken state. Honesty is added as an explicit `demo`
   marker, not by reporting the demo path as unavailable.
4. **Reason codes are enumerated, never prose.** The backend emits codes; all wording lives in the
   extension. The backend does not acquire opinions about UI copy.
5. **Chrome Web Store submission stays out of scope.** Its friction is review process, not code.
6. **Protocol gets a dual entry point.** Fixing the artifact properly beats working around it in
   the Dockerfile — the compiled backend should be runnable everywhere, not only in a container.

## Architecture

```
   docker run --env-file .env -p 127.0.0.1:8787:8787 ghcr.io/ymlyza/echoflow-backend
                        │
                        ▼
   ┌────────────────────────────────────────────────┐
   │ container: ECHOFLOW_HOST=0.0.0.0               │
   │                                                │
   │  main.ts ─► createConfig() ─► assertConfigUsable()│ fail fast on real misconfig
   │     │              │                           │
   │     │              ▼                           │
   │     │        describeConfigHealth() ───────────┼──► stdout (boot self-check)
   │     │              │                           │
   │     ▼              ▼                           │
   │  createServer ──► buildCapabilities()          │
   └────────────────────────┬───────────────────────┘
                            │ GET /v1/capabilities
                            │   modes.pipeline.demo / .blockers
                            ▼
   ┌────────────────────────────────────────────────┐
   │ extension onboarding, Connect step             │
   │   summarizeCapabilities() → tone + demo        │
   │   describeBlocker(code)   → actionable line    │
   └────────────────────────────────────────────────┘
```

`describeConfigHealth` and `buildCapabilities` consume the same predicates, so the terminal and the
browser can never disagree about whether a credential is present.

## Component 1 — Backend: production entry point and truthful boot

**`apps/backend/src/main.ts` (new).** The production entry point. Unlike `dev.ts` it does not load
the repo-root `.env` — containers get their environment from `--env-file` / `-e`. Both entry points
delegate to a shared `startServer()` helper so the graceful-shutdown block (currently unique to
`dev.ts`) exists once rather than being copy-pasted into a second entry point where it would rot.

**Host binding.** `BackendConfig` gains `host: string`, sourced from `ECHOFLOW_HOST`, **defaulting
to `127.0.0.1`**. Only the Dockerfile sets `0.0.0.0`, and that address is the container's
interface, not a host exposure. Documentation consistently uses `-p 127.0.0.1:8787:8787` rather
than a bare `-p 8787:8787`, which would publish the backend and its API key to the local network.
The existing "does not listen on external interfaces" property is preserved by default and given up
only by an explicit, documented act.

**Boot self-check.** A pure `describeConfigHealth(config): ConfigHealth` returns a structured
report — per capability: provider name, whether credentials are present, whether it is running in
demo mode. Both entry points print it after `listen`. Being pure makes it unit-testable and lets
Component 2 reuse the same predicates.

**Fail fast on genuine misconfiguration.** A pure `assertConfigUsable(config)` raises when a
provider is explicitly selected but its credentials are absent (`provider=volcengine` with no
keys); both entry points call it before `listen`, so the process exits non-zero at boot with a
message naming the missing variables instead of deferring to `providerFactory`'s per-connection
throw. This is a **behavior change**: the same error, moved to where the cause is.
A container then exits loudly rather than pretending to be healthy. The `fake` default path is a
valid configuration, not an error, and is unaffected.

## Component 2 — Protocol: honest capabilities

`ModeCapabilities` gains two optional fields, following the additive path `sync.available`
established:

- `demo?: boolean` — the mode is served by `fake` providers. `available` stays `true`.
- `blockers?: readonly string[]` — reason codes, e.g. `asr_credentials_missing`,
  `translation_credentials_missing`, `interpret_credentials_missing`,
  `asr_provider_unimplemented` (the reserved `aliyun`/`tencent` names).

A `CapabilityBlockerCode` union type is exported for authoring discipline on the backend side, but
**`isCapabilitiesDescriptor` validates the wire field as `string[]`, not against a whitelist.**
A newer backend emitting a code an older extension does not recognize must cost the user one
missing hint line — never a failed descriptor validation, which would degrade "one unknown hint"
into "backend unusable". The extension maps known codes and falls back to a generic line.

Per repo convention, the runtime type guard and its `.test.ts` change in the same commit as the
type.

## Component 3 — Protocol: dual entry point

The root cause of the non-runnable artifact. `packages/protocol/package.json` currently points
`main`/`types`/`exports` at `src/index.ts`, which CLAUDE.md documents as deliberate: consumers see
protocol changes without a rebuild. That holds for bundlers and breaks under plain Node.

Correction (found in review after implementation): it does **not** hold for `tsx` for free. `tsx`
is a Node loader, not a bundler — it sets no extra export conditions, so once `exports` gains a
`default` that points at `dist/`, a plain `tsx src/dev.ts` resolves the compiled output exactly
like `node` does. Every `tsx` entry point that imports workspace source therefore has to pass
`--conditions=echoflow-source` explicitly (`apps/backend`'s `dev` script, and the two opt-in
`scripts/volcengine-*-smoke.ts` invocations). Without it `pnpm dev` dies with
`ERR_MODULE_NOT_FOUND` on a clean checkout, and with a stale `dist/` present it silently runs
against compiled guards that `tsc` — which does see the condition, via `customConditions` — no
longer agrees with.

Constraint that shapes the fix: there are **no vitest config files in the repo** (tests run on
default resolution), and `ci.yml` ordering is `typecheck → test → build` — test runs *before*
build. So simply pointing `exports` default at `dist/index.js` breaks `pnpm test` on a clean
checkout, where `dist/` does not exist yet.

The mechanism is therefore a **custom export condition**: a condition such as `echoflow-source`
resolves to `src/index.ts`, while `default` resolves to `dist/index.js`. Bundler and test consumers
(WXT, and the three packages' vitest setups) declare that condition explicitly; plain Node, which
sets no such condition, gets the compiled output. The documented no-rebuild developer experience
survives, and the compiled backend becomes runnable.

Cost, stated plainly: this requires creating vitest config files for the three packages and adding
`resolve.conditions` to the WXT config. This is the single most uncertain part of the slice and
must be verified against all three consumers during implementation. **Fallback if the three
consumers cannot be made to agree:** drop the custom condition and instead guarantee build ordering
so `dist/` always exists before tests run. That trades away the no-rebuild convenience but is
mechanically simple.

## Component 4 — Extension: rendering the diagnosis

- `describeBlocker(code): string` — a pure code → actionable-sentence map with a generic fallback
  for unknown codes. **No apostrophes in any user-facing string** (`renderToStaticMarkup` escapes
  `'` to `&#x27;`, and component tests asserting a literal apostrophe fail).
- `ConnectionSummary` gains `demo: boolean` rather than a fourth `tone` value. Tone drives the
  colour ladder; demo drives copy and badging. Keeping them as separate dimensions lets the UI
  combine them freely.
- The Connect step renders the blocker list beneath the existing summary.
- `canAdvance` is unchanged. Demo mode resolves to `tone: "partial"`, and the existing gate is
  `tone !== "none"`, so demo users still advance — blocking them would destroy the
  zero-credential first-run experience that decision 3 protects.

`summarizeCapabilities` has exactly one call site (`entrypoints/onboarding/main.tsx`), so the blast
radius is small.

## Component 5 — Distribution

**Dockerfile (multi-stage).** Builder: `pnpm install --frozen-lockfile` then `pnpm build`
(protocol before backend). Runtime: `node:22-alpine` — the same major CI tests on, deliberately not
a newer runtime nothing has been verified against. `node:sqlite` loads unflagged on Node 22
(verified locally on v22.23.2; it prints an ExperimentalWarning), so the history-sync feature needs
no special flags. The image carries the backend `dist/`, the protocol `dist/`, and production
dependencies only; runs as a non-root user; sets `ECHOFLOW_HOST=0.0.0.0`; and declares a
`HEALTHCHECK` against `/healthz`.

Note: `apps/backend/tsconfig.json` has `include: ["src/**/*.ts"]`, so `dist/` currently contains
compiled `*.test.js` files. These are excluded from the runtime image.

**CI.** `release.yml` gains a job that builds `linux/amd64,linux/arm64` via
`docker/build-push-action` and pushes to `ghcr.io`, tagged `vX.Y.Z` plus `latest`. It is driven by
the same tag push as the extension zip and derives its version from the same tested `deriveVersion`
helper: one tag, two artifacts, one version truth.

**New CI gate.** `ci.yml` gains a step that starts the compiled backend and curls `/healthz`. This
is the gap that let the non-runnable artifact hide for the project's whole life: a passing `tsc` is
not evidence that the output runs.

**Documentation.** README is restructured to lead with the Docker path (`docker run` plus an env
file) and demotes the from-source path to a development section. `.env.example` is aligned with
what the container actually consumes.

## Testing strategy

Pure functions, covered by ordinary colocated unit tests:

- `describeConfigHealth` — each provider/credential combination.
- `buildCapabilities` — `demo` and `blockers` branches, including that `available` stays `true`
  under `fake`.
- `isCapabilitiesDescriptor` — new optional fields accepted when absent, rejected when malformed,
  and **an unrecognized blocker code does not fail validation**.
- `describeBlocker` — known codes and the unknown-code fallback.
- `summarizeCapabilities` — the `demo` dimension against each tone.

Boot fail-fast is covered in the existing `createConfig` / `createServer` test style. The
built-artifact smoke lives in CI as a real process start, not in vitest — an in-process test cannot
catch a module-resolution failure that only manifests under plain Node, which is precisely the
class of bug this slice exists to close.

Two process-start questions belong in CI for the same reason, and neither is expressible as a unit
test:

- Does `node apps/backend/dist/main.js` serve `/healthz`? (the built artifact)
- **Does `pnpm dev` still work with `packages/protocol/dist` deleted?** (the clean-checkout
  developer path — the case the `echoflow-source` condition exists to preserve, and the one that
  regressed silently because a stale `dist/` masks it locally)

## Out of scope

- Chrome Web Store submission (decision 5).
- npm-published backend, single-file binary, desktop/tray app (decision 1).
- Remote/LAN deployment. The extension's `host_permissions` are hard-scoped to
  `127.0.0.1`/`localhost`, and the privacy claim in the README depends on that scoping. Container
  port mapping keeps the extension's view at `127.0.0.1`, so this slice does not touch either.
- Any change to the realtime capture path.
