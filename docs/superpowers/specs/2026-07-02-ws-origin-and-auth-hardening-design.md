# WebSocket Origin & Auth Hardening Design (Audit Slice E)

> Captured 2026-07-02. Fourth slice of the repo-audit remediation. Closes the CSWSH / quota-abuse
> vector on the local backend and hardens the credential comparison and the extension's runtime bus.

## Goal

A malicious web page the user has open cannot connect to the local backend and burn their
Volcengine quota; credential checks don't leak timing; and the extension's internal message bus
only accepts messages from the extension itself.

## Findings addressed

| # | Severity | Defect | File |
|---|----------|--------|------|
| 3 | medium | the WS handshake has no `Origin` check, so any web page can `new WebSocket("ws://127.0.0.1:8787/v1/realtime?apiKey=dev-key")` and drive the backend (WS handshakes bypass CORS); the default key is the README's `dev-key` | `src/server.ts` |
| — | low | API key compared with `!==` (not constant-time) | `src/server.ts` |
| — | low | extension runtime `onMessage` listeners don't validate the sender, so (in principle) another extension/page could inject control messages | `entrypoints/background.ts`, `entrypoints/offscreen/main.ts`, `entrypoints/content.tsx` |

## Design

### 1. Origin allowlist on the WebSocket handshake (#3)

A browser always sends an `Origin` header on a WS handshake; a non-browser client (the Playwright
Node bridge, curl, tests) sends none. The MV3 offscreen document that owns the real client sends
`Origin: chrome-extension://<id>`. So the policy, in a new testable helper `isAllowedOrigin(origin)`:

- `undefined` (no Origin) → **allow** (non-browser client).
- starts with `chrome-extension://` → **allow** (the extension; the id is per-install and unpacked
  ids are random, so we can't pin one id — allowing any extension origin is the pragmatic bar).
- anything else (an `http(s)://` web origin) → **reject**.

Wire it into the `/v1/realtime` `preValidation` **before** the key check: a disallowed Origin gets
`403` regardless of key, so a web page that somehow knows the key still cannot connect. This is not
configurable (YAGNI — the self-host model is localhost + the extension).

A malicious *extension* could still present a `chrome-extension://` origin, but that requires the
user to have installed a hostile extension — a far higher bar than "open a web page", and out of
scope for this fix.

### 2. Constant-time key comparison

Replace the `!==` key checks (both `/v1/realtime` and `/v1/capabilities`) with a
`timingSafeKeyMatch(provided, expected)` helper: return false for `undefined`, false on length
mismatch, else `crypto.timingSafeEqual` on the two buffers. Auth passes if the header **or** the
query key matches. (The length check leaks length only — acceptable and standard.)

**Default key unchanged:** the backend still defaults to `dev-key` (the README documents it and the
self-host onboarding depends on it). The Origin allowlist is the actual CSWSH defense; a user who
wants real protection sets `ECHOFLOW_API_KEY`. Changing the default to a random printed key is a
UX/docs change deferred for a product decision.

### 3. Extension runtime-message sender validation

The three `chrome.runtime.onMessage` listeners (background, offscreen, content) gain a sender guard:
ignore any message whose `sender.id !== chrome.runtime.id`. Internal messages (via
`chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`) always carry the extension's own id, so
this is transparent to normal operation and rejects any cross-extension/page injection. Defense in
depth — `externally_connectable` is not declared, so this path is already hard to reach, but the
guard makes the invariant explicit.

## Testing

- **`wsAuth.test.ts`** (new): `isAllowedOrigin` — undefined → true, `chrome-extension://abc` → true,
  `https://evil.example` / `http://localhost:3000` → false. `timingSafeKeyMatch` — exact match →
  true; wrong value / different length / `undefined` → false.
- **`server.test.ts`** (extend): a WS handshake with `origin: "https://evil.example"` + the valid
  key is rejected (`403`); `origin: "chrome-extension://abc"` + valid key connects; the existing
  no-Origin tests still connect; the existing wrong/missing-key `401` tests still pass (timing-safe
  path). One `/v1/capabilities` test confirms the timing-safe path still authenticates.
- Extension sender validation is entrypoint code (no unit test); verified by typecheck + the guard
  being a no-op for same-extension messages (the existing smoke/e2e still passes).

## Non-goals

- Randomizing the default API key (docs/UX decision — deferred).
- CORS headers on `/v1/capabilities` (cross-origin reads are already blocked by the same-origin
  policy; the endpoint returns no `Access-Control-Allow-Origin`).
- Rate limiting / auth on `/healthz` (intentionally public liveness check).
- Any wire-protocol or reconnect change.

## Rollout

1. Land on `fix/ws-origin-and-auth-hardening` via PR (CI `check` gates the merge).
2. Manual confirmation post-merge: from a random web page's devtools,
   `new WebSocket("ws://127.0.0.1:8787/v1/realtime?apiKey=dev-key")` now fails the handshake (403);
   the extension still connects normally.
3. Update `docs/superpowers/backlog.md` to mark Slice E of the audit remediation shipped.
