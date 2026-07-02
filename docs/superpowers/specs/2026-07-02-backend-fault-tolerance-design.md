# Backend Fault Tolerance Design (Audit Slice C)

> Captured 2026-07-02. Third slice of the repo-audit remediation. Four independent backend fixes
> that keep a realtime session alive and correct under transient provider failures and reconnects.

## Goal

A backend realtime session survives the routine faults it currently dies or misbehaves on:
- a single transient translation failure no longer kills the whole session;
- a Volcengine ASR reconnect re-establishes a valid, correctly-sequenced stream;
- the utterance reconciler no longer swallows a genuinely repeated sentence;
- a fatal provider-stream error closes the client WebSocket instead of leaving it half-open.

No happy-path behavior changes; each fix targets a specific failure path currently untested.

## Findings addressed

| # | Severity | Defect | File |
|---|----------|--------|------|
| 1 | high | one transient translation HTTP failure routes to the session-level fatal `onError` → the whole session is closed; the ASR side has full reconnect but translation has zero tolerance | `src/realtime/pipelineSubtitleSource.ts` |
| 10 | medium | on ASR reconnect the config frame is re-sent (seq 1) but the audio `sequence` counter keeps its cross-connection value, so the reconnected stream's frames are mis-sequenced (and dropped-during-reconnect frames still advance it) | `src/providers/volcengineSpeechProvider.ts` |
| 11 | medium | `UtteranceReconciler` dedupes `definite` sentences by text equality against the last final, so a speaker repeating a sentence verbatim has the repeat silently dropped | `src/providers/utteranceReconciler.ts` |
| 12 | medium | a fatal provider-stream `onError` calls `session.close()` (which never closes the socket), leaving the client WebSocket OPEN while audio keeps flowing into a dead session | `src/realtime/session.ts` |

**Deferred (not in this slice):** #9 (latest-wins drops a translated final from history). It is a real gap but carries a render-vs-history product tradeoff — the deliberate "bounded movie-style current line" UX documented in CLAUDE.md — so it needs a product decision rather than an autonomous change. Tracked for a follow-up.

## Design

### 1. Translation failure is non-fatal (#1)

In `pipelineSubtitleSource.ts` `drainTranslations`, the `catch` currently calls the session-fatal
`opts.onError`. Replace that: on a translation failure, if the segment is still the latest, emit the
`final` with the **source text and an empty `translatedText`** (so the line is shown and history is
complete) plus a **non-fatal `error` event** (`type: "error"`, `code: "translation_failed"`) via
`opts.onEvent` — then `continue`. Never call `opts.onError` for a translation failure. The session
stays alive; the ASR stream is untouched. (Genuinely fatal errors still reach `onError` from the
speech provider's own `onError`, unchanged.)

The latest-wins skip on the *success* path is unchanged (that is finding #9, deferred).

### 2. Reset ASR audio sequence on every (re)connect (#10)

In `volcengineSpeechProvider.ts`, the `sequence` counter is an `open()`-closure variable that
persists across reconnects. Reset it inside the `initialize` callback — which `withReconnect`
invokes on every connection (initial and each reconnect) — so each connection starts its audio
numbering fresh after the seq-1 config frame:

```ts
initialize: (t) => { sequence = 1; t.send(configFrame); }
```

The first `pushFrame` on any connection then sends audio sequence 2 (config = 1, audio = 2, 3, …),
matching the wire contract, regardless of how far the counter advanced (including frames dropped
during the reconnect window) on the prior connection.

### 3. Reconciler dedupes by utterance boundary, not text (#11)

In `UtteranceReconciler`, replace the `text === lastFinalText` dedup with a monotonic **start-time**
guard: track `lastEmittedStartTime` and emit a `definite` utterance only when its `start_time` is
strictly greater. SeedASR re-sends a confirmed sentence with the same boundary (`start_time`), so
those are still deduped; a genuinely repeated sentence is a later VAD segment with a later
`start_time`, so it now surfaces. This preserves every existing reconciler test (the re-send test's
utterances share a boundary; sequential sentences have increasing start times) and fixes the
verbatim-repeat drop.

### 4. Fatal provider error closes the socket (#12)

In `session.ts`, the runtime provider-stream `onError` (inside `source.open({ onError })`) currently
does `sendError(...) + void this.close()`, and `close()` never touches the socket. Make that path
also close the client WebSocket after teardown, so the client stops streaming into a dead session:

```ts
onError: (error) => {
  this.sendError("provider_error", error.message);
  void this.close().then(() => this.options.socket.close());
},
```

`close()` is idempotent (guarded by `this.closed`) and `socket.close()` is a WS no-op if already
closing, so this is safe alongside the stop path. **The factory-error paths
(`mode_unavailable` / `mode_language_unsupported` / factory `provider_error`) are intentionally left
open — existing tests pin `readyState === OPEN` there** — because no stream was opened and the client
may correct its settings; only a mid-session stream failure is terminal.

## Testing

- **`pipelineSubtitleSource.test.ts`** (extend): a translating provider that throws → the pipeline
  emits a `final` with the source text + empty `translatedText` and a non-fatal `translation_failed`
  `error` event, and `onError` is NOT called (session survives). The existing latest-wins and
  drain-on-end tests remain green.
- **`volcengineSpeechProvider.test.ts`** (extend): after a retryable drop + reconnect, the first
  audio frame on the new connection encodes sequence 2 — asserted by comparing the sent buffer to
  `encodeAudioRequest(<same audio>, 2, false)` — even though the counter advanced on the prior
  connection. Reuse the file's fake-connect/`setTimer` harness.
- **`utteranceReconciler.test.ts`** (extend): the same text spoken again at a later `start_time`
  (real repeat) emits a second final; the existing re-send/ordinal/multi-sentence tests stay green.
- **`session.test.ts`** (extend): a runtime provider-stream `onError` closes the socket
  (`readyState === 3`); the factory-error tests still assert the socket stays open.

## Non-goals

- #9 latest-wins history drop (deferred — product decision).
- Translation retry/backoff (skip-with-source-text is sufficient for the MVP; not adding a retry loop).
- Any change to the wire protocol, the reconnect/drain machinery, or the extension.

## Rollout

1. Land on `fix/backend-fault-tolerance` via PR (CI `check` gates the merge).
2. Manual confirmation post-merge against a real Volcengine drop: induce a translation 500 → the
   session keeps running with source-only lines; kill/restore ASR connectivity → reconnect resumes.
3. Update `docs/superpowers/backlog.md` to mark Slice C of the audit remediation shipped.
