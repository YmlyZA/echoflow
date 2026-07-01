# Automated E2E Design (Direction D)

> Captured 2026-07-01. Direction D "Automated e2e". Two deliverables: a CI-gating in-process
> backend WS flow test, and un-skipping the existing extension smoke by moving its WebSocket
> client out of the sandboxed service worker into Node.

## Goal

Real end-to-end validation of the fake-provider path runs automatically:
- the backend WS request path is CI-covered in-process — the happy-path flow already is, and
  this slice adds the missing `stop` → clean-close coverage;
- the **extension smoke** is un-skipped so it exercises the real loaded extension
  (background → reducer → shadow-DOM overlay → IndexedDB history) against a running backend,
  runnable locally.

## Background — why the smoke was skipped

`apps/extension/e2e/extension-smoke.spec.ts` is `test.skip`'d for two documented blockers:
1. The popup Start gesture (`chrome.tabCapture.getMediaStreamId`) needs a real user gesture —
   already worked around by dispatching `START_FROM_POPUP` directly on the runtime message bus.
2. `bridgeFakeBackendEvents` opens a `WebSocket` from inside `serviceWorker.evaluate()`, but a
   headless Chromium extension service worker cannot establish that outbound TCP connection to
   `127.0.0.1` — the backend never sees the connection and the test times out. The same call
   **succeeds from Node.js** (proven: `expectBackendReady` fetches `/healthz` from Node fine).

Blocker #2 is the only true blocker; it is removed by relocating the socket to Node.

## Deliverable 1 — backend WS `stop` → clean-close coverage (CI-gating)

**Finding (planning-time):** the backend happy-path WS flow is **already** covered in
`apps/backend/src/server.test.ts` — three tests drive `start → audio → language/partial/final`
via `createServer({ apiKey })` + `server.injectWS(...)` and assert the exact
`[zh-CN] hello from echoflow` sequence (header-auth, query-string-auth, and binary-frame
variants), plus auth-rejection and malformed-message tests. Writing another full flow test
would be redundant. The **one untested control-message seam is `stop`** — no test drives the
`stop → session teardown → socket close` path, which is exactly the path the drain-final work
touches.

**File:** `apps/backend/src/server.test.ts` (add one test to the existing
`describe("backend realtime websocket", …)` block; reuse its `createServer`/`injectWS`/
`sendAudioFrame`/`collectServerEvents`/`openSockets` harness).

Test: drive `start` + audio frames to a `final` (as the existing flow test does), register a
`close` listener on the injected socket, then send `{ type: "stop" }` and assert the socket
closes cleanly (the `close` event fires with a normal code; no `error`). This exercises the
`RealtimeSession` stop path (`stream.end()` → `close()` → `socket.close()`) end-to-end on the
fake path.

Runs in `pnpm test` → the `check` CI job gates it. Together with the pre-existing flow tests,
the backend request path (WS auth, `ClientMessage` parsing, `RealtimeSession` incl. teardown,
fake providers, `ServerEvent` protocol) is CI-covered with zero orchestration.

**Not covered (documented):** interpret/AST mode (needs Volcengine credentials → cannot run on
fakes), and reconnect/drain-gate behavior (the fake provider never drops and flushes `end()`
synchronously; those remain mock-unit-tested in the adapter suites).

## Deliverable 2 — un-skip the extension smoke (Node-side WS bridge)

**File:** `apps/extension/e2e/extension-smoke.spec.ts` (modify).

1. Remove the `test.skip(true, …)` first line.
2. Rewrite `bridgeFakeBackendEvents(serviceWorker, localSessionId)` so the **WebSocket lives in
   Node** (the Playwright process), not in `serviceWorker.evaluate()`:
   - Node opens `new WebSocket(<ws url with apiKey>)` (Node 22 global `WebSocket` — no new dep).
   - On open, Node sends the same `start` frame + the audio-frame pump (JSON control frame +
     binary PCM) it sends today.
   - On each incoming message, Node parses the `ServerEvent` and injects it into the extension:
     `await serviceWorker.evaluate(({ localSessionId, event }) =>
     chrome.runtime.onMessage.dispatch({ type: "SERVER_EVENT", localSessionId, event }),
     { localSessionId, event })` — the same dispatch mechanism the test already uses for
     `START_FROM_POPUP`.
   - Resolve when a `final` event has been injected (and close the socket); reject on socket
     error / a bounded timeout.
   - Binary frames: Node `WebSocket.send(ArrayBuffer)` for the PCM; the fake backend ignores the
     bytes.
3. Keep every real-extension assertion unchanged: `expectOverlayText(page, "hello from echoflow")`
   and `"[zh-CN] hello from echoflow"` (shadow-DOM text), and the persisted `final` history
   segment via `readHistorySegments`.
4. Update the `test.describe` header comment: blocker #2 is resolved (socket moved to Node);
   blocker #1's `START_FROM_POPUP` gesture workaround remains (the real `tabCapture` gesture +
   offscreen audio pipeline are still not exercised headlessly).

**Stays a local smoke:** run via `pnpm --filter @echoflow/extension test:e2e` or
`bash scripts/dev-smoke.sh` (both boot a backend first). It is NOT added to the required `check`
CI job — a persistent-extension browser context + backend boot is heavy and flake-prone in CI,
and the backend flow test already gives CI real-path coverage.

**Accepted limitation (unchanged):** Node substitutes for the offscreen document's WS client, so
the capture gesture and the `getUserMedia → AudioWorklet → PCM → RealtimeClient` audio pipeline
are still not covered by this smoke.

## Testing / validation

- Deliverable 1: the new `stop`→close test green under `pnpm --filter @echoflow/backend test`
  (and thus `pnpm test` / CI), alongside the pre-existing flow tests.
- Deliverable 2: with a backend running, `pnpm --filter @echoflow/extension test:e2e` actually
  runs (no longer skipped) and passes headlessly. If a residual headless issue surfaces, it is
  diagnosed rather than re-skipped; the `START_FROM_POPUP` workaround stays.
- No unit-level test for the Playwright spec itself (it *is* the test); the backend flow test is
  the unit-suite/CI contribution.

## Non-goals (YAGNI)

- No new CI workflow/job — the backend flow test rides the existing `pnpm test`.
- No attempt at the real `tabCapture` gesture / headed-only offscreen pipeline coverage.
- No interpret/AST e2e (credential-gated).

## Rollout

1. Land on `feat/automated-e2e` via PR (CI `check` gates the merge; the new backend flow test
   runs there).
2. Locally verify the un-skipped extension smoke passes against a running backend.
3. Update `docs/superpowers/backlog.md`: the "Automated e2e" line reflects what now runs in CI
   (backend flow) vs. what stays a local smoke (extension) and deferred (gesture/offscreen).
