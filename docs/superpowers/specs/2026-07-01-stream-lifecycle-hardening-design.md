# Provider-Stream Lifecycle Hardening Design (Direction D)

> Captured 2026-07-01. Direction D "parked Cycle-2 minors": interpret in-flight-after-`end()`
> and double-`close()` were untested (and subtly incorrect). This closes both, symmetrically
> across the interpret AST and pipeline ASR adapters.

## Goal

A provider stream behaves correctly under sloppy lifecycle calls: audio pushed after (or
during) `end()` is not sent to Volcengine after the finish/last frame, `end()` is single-shot,
and `close()` is idempotent. No happy-path behavior changes.

## Problem (current behavior)

Both `InterpretationSubtitleSource` and `VolcengineSpeechProvider` return a stream shaped:

```ts
pushFrame(f) { if (closed) return; transport.send(audio); }
async end()  { if (closed) return; transport.send(finish/lastFrame); drain.arm(); await drain.wait(); closed = true; }
async close(){ closed = true; transport.close(); }
```

- **in-flight-after-`end()`:** `closed` flips to `true` only *after* `await drain.wait()` (up to
  ~1500ms). During that drain window `pushFrame`'s `if (closed)` guard is still false, so audio
  frames arriving mid-drain are forwarded to the transport **after** `FinishSession` / the
  `isLast` frame — protocol-incorrect. A second `end()` during the window also re-sends the
  finish frame and re-arms the drain. (The session can push audio concurrently during the
  stop path because each WS frame is handled on its own async task.)
- **double-`close()`:** no idempotency guard — a second `close()` calls `transport.close()`
  again. Likely a WS no-op in practice, but unguarded and untested.

## Fix

Add two flags to each adapter's returned stream closure (no shared helper — it's three lines
per adapter and the closures already hold `closed`):

1. **`ending`** — set `true` at the START of `end()`, before `await drain.wait()`.
   - `pushFrame`: no-op when `closed || ending` (stops post-finish audio during the drain).
   - `end()`: no-op when `closed || ending` (single-shot; a repeat call during the drain does
     nothing).
2. **`disposed`** — `close()` no-ops after the first call: `if (disposed) return; disposed =
   true; closed = true; transport.close();`. `close()` after `end()` still closes the transport
   (since `end()` never calls `transport.close()`).

Applied to **both** adapters (identical shape → identical guards). The fake speech provider is
untouched (its `end()`/`close()` already flip a single `closed` flag synchronously and it has
no transport/drain).

### Interaction with existing behavior

- `drain.arm()` still runs before `await drain.wait()`; the trailing final still drains — the
  `ending` guard only blocks *outbound audio* and *re-entry*, not the inbound message handling
  that feeds `drain.onFinal()`.
- The reconnect wrapper is unaffected: `close()` still reaches `withReconnect.close()`
  (`closedByUser = true` + `transport.close()`) exactly once.
- Happy path (push* → end → close, each once) is byte-for-byte unchanged.

## Testing

Per adapter, using the existing mock-transport harness (`stubSpeech`/inline `sockets[]` mock;
injectable `setTimer` so the drain window is controllable):

- **Audio after `end()` is dropped:** call `end()`; assert no further `transport.send` beyond
  the finish/last frame. Also assert a `pushFrame` issued *during* the drain window (before the
  injected drain timer fires) sends nothing.
- **`end()` is single-shot:** call `end()` twice; assert the finish/last frame is sent exactly
  once.
- **`close()` is idempotent:** call `close()` twice; assert `transport.close()` runs once.
- **`close()` after `end()` still closes:** assert `transport.close()` is called.

No new integration/e2e tests; these are adapter-unit tests alongside the existing suites.

## Non-goals

- The e2e un-skip / automated-e2e blocker (headless SW→backend WS) — stays deferred.
- Any change to reconnect/drain semantics, the protocol, or the extension.

## Rollout

1. Land on `feat/stream-lifecycle-hardening` via PR (CI `check` gates the merge).
2. Mark the parked Cycle-2 minors resolved in `docs/superpowers/backlog.md`.
