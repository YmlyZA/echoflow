# Contributing to EchoFlow

Thanks for considering a contribution!

## Licensing of contributions

EchoFlow uses per-package licenses (see the root `LICENSE` overview): the
protocol and extension are MIT, the backend is AGPL-3.0-only. By
contributing, you agree your contribution is licensed under the license of
the package it touches.

## Developer Certificate of Origin (DCO)

All commits must be signed off, certifying the
[Developer Certificate of Origin](https://developercertificate.org/):

```bash
git commit -s -m "feat: your change"
```

This adds a `Signed-off-by: Your Name <you@example.com>` trailer asserting
you have the right to submit the work under the project's licenses. PRs with
unsigned commits will be asked to rebase with sign-offs.

## Development

```bash
pnpm install
pnpm build      # tsc build all packages
pnpm test       # vitest, all packages
pnpm typecheck  # tsc --noEmit
```

See `CLAUDE.md` for architecture notes and per-package commands, and
`README.md` for end-user setup.

## Conventions

- Protocol changes are contract changes: update the matching runtime type
  guard and its `.test.ts` in the same change.
- Provider secrets live only in backend env files — never in the extension,
  never in committed files. `.env.example` carries structure, no real values.
- Tests are colocated `*.test.ts(x)`; PRs must pass the `check` CI gate.
