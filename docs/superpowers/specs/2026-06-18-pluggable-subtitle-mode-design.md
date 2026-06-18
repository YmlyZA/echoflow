# Pluggable Subtitle-Mode Architecture (Cycle 1) — Design

**Date:** 2026-06-18
**Status:** Approved (design); pending implementation plan

## Goal

Make the subtitle engine a **per-session, client-selected, entitlement-gated
mode**, so the same backend can serve a free "consistency" mode and a paid
"real-time" mode that the user toggles (and we remember). **Cycle 1** builds the
architecture + the toggle end-to-end with the existing engine as the free
`pipeline` mode; the paid `interpret` mode (Doubao 同声传译) is selectable but
gated/erroring until **Cycle 2** implements it.

## Why (product + diagnosis)

- Product direction: a free service (Mode A) upgradable to a paid service
  (Mode B). Users default to A and toggle to B; the choice is remembered.
- Latency diagnosis (measured 2026-06-18): Mode A's "finalized-only" subtitles
  lag ~10s on continuous speech **by design** — it waits for each whole sentence
  to finish + be confirmed (~3–4s ASR confirmation). The audio pipeline (≈0ms
  drift) and translation (~0.5–1s) are not bottlenecks. True low latency requires
  a streaming speech-translation model that emits *before* a sentence ends — a
  fundamentally different engine, hence a distinct **mode**, not a tuning knob.

So mode is a swappable capability: `pipeline` (ASR + translation, accurate, laggy,
32 languages) vs `interpret` (豆包同传 streaming S2TT, ~2–3s, zh↔en, paid).

## Architecture

```
extension (mode toggle, remembered) ──start{mode}──▶ RealtimeSession (thin)
                                                        │ createSubtitleSource(mode, targetLanguage)
                                                        ▼
                                            ┌─────────── SubtitleSource ───────────┐
                                            │ PipelineSubtitleSource (pipeline/free)│  ← Cycle 1
                                            │ InterpretationSubtitleSource (paid)   │  ← Cycle 2 (gated)
                                            └───────────────────────────────────────┘
                                                        │ onEvent(ServerEvent)
                                                        ▼  socket.send  (wire unchanged)
                                            extension overlay/reducer (unchanged)
```

### Section 1 — The `SubtitleSource` seam + a thin session

A `SubtitleSource` turns audio into **wire-ready** subtitle events (source *and*
translated text already inside):

```ts
export type SubtitleMode = "pipeline" | "interpret";

export interface SubtitleSourceStream {
  pushFrame(frame: AudioFrame): void;
  end(): Promise<void>;
  close(): Promise<void>;
}

export interface SubtitleSource {
  open(opts: {
    onEvent: (event: ServerEvent) => void; // language | partial | final
    onError?: (error: Error) => void;
  }): SubtitleSourceStream;
}
```

`RealtimeSession` becomes a thin forwarder — it no longer knows about speech vs
translation:
- On `start`: `const source = this.options.createSubtitleSource(message.mode ?? "pipeline", this.targetLanguage)`; open it with `onEvent → this.send(event)` and `onError → sendError + close`. If `createSubtitleSource` throws `ModeUnavailableError`, send a `mode_unavailable` error event (do not crash the connection).
- On `audio_frame` + binary: `stream.pushFrame(...)` (unchanged framing).
- On `stop`: `await stream.end()` then `close()`.

`RealtimeSessionOptions` changes from `{ speechProvider, translationProvider }` to
`{ createSubtitleSource: (mode: SubtitleMode, targetLanguage: string) => SubtitleSource }`
(injectable → tests pass a stub factory; `server.ts` passes the real one).

### Section 2 — `PipelineSubtitleSource` (Mode A, free tier) + factory/entitlement

`PipelineSubtitleSource` wraps the existing `SpeechProvider` + `TranslationProvider`
and **contains the logic relocated verbatim from today's session**: open the speech
stream; forward `language`/`partial` events immediately; run the single-flight,
**latest-wins** translation of `final`s (emit a translated `final` only if its
segment is still the latest). It emits `ServerEvent`s via `onEvent`. The fake and
Volcengine ASR + translation providers are unchanged — they are simply wrapped.

The factory + entitlement gate live in one place:

```ts
createSubtitleSource(mode, targetLanguage): SubtitleSource
  // "pipeline"  → new PipelineSubtitleSource(speechProvider, translationProvider, targetLanguage)
  // "interpret" → isInterpretAvailable(config)
  //                 ? buildInterpretationSource(...)   // Cycle 2
  //                 : throw new ModeUnavailableError("interpret")
```

`ModeUnavailableError` carries the mode name; the session maps it to an `error`
`ServerEvent` with code `mode_unavailable`. In Cycle 1, `isInterpretAvailable`
always returns false (interpret is not built / not configured), so selecting it
yields a clean "requires upgrade / not available" error. Entitlement is currently
"is the interpret engine configured?"; real auth/billing is future work, but the
gate is the single seam where it will attach.

### Section 3 — Protocol `start.mode` + extension toggle (remembered)

- `@echoflow/protocol`: `StartSessionMessage` gains `mode?: SubtitleMode`
  (default `"pipeline"`). Update `isStartSessionMessage` to validate it
  (optional; if present must be `"pipeline"` or `"interpret"`) and add a guard
  test. This is a contract change.
- Extension settings (`src/settings/settings.ts`) gain `mode: SubtitleMode`
  (default `"pipeline"`), validated + persisted like `targetLanguage`.
- Options page: a **toggle** (e.g. "字幕模式: 一致 (免费) / 实时 (付费)") bound to
  the setting, so the last choice is remembered.
- The offscreen `RealtimeClient` includes `mode` from settings in the `start`
  message. (`buildRealtimeWebSocketUrl`/auth unchanged.)
- Cycle 1 behavior when a user picks `interpret`: the backend returns
  `mode_unavailable`, the overlay shows the existing error banner with an
  "升级/暂未开放" message. The whole toggle UX therefore ships now on the free tier.

The wire `ServerEvent` shape is unchanged, so the overlay/reducer need no changes
beyond reading the new setting.

### Section 4 — Error handling

- `mode_unavailable`: selecting an unavailable/un-entitled mode → `error`
  `ServerEvent` (code `mode_unavailable`, message naming the mode) → overlay shows
  it; the connection stays alive (the user can toggle back and re-trigger).
- Source `onError` (engine failure mid-session) → existing `error` event + session
  end (unchanged behavior, now routed through the source seam).

## Scope / decomposition

- **Cycle 1 (this spec):** the `SubtitleSource` seam, `PipelineSubtitleSource`
  (Mode A relocated), thin session, factory + entitlement gate, protocol
  `start.mode`, extension `mode` setting + options toggle. `interpret` is gated
  (errors). Net behavior of the free path is identical to today; the refactor is
  structural + the toggle is added.
- **Cycle 2 (separate spec):** `InterpretationSubtitleSource` — Doubao 同声传译
  (Seed LiveInterpret 2.0) streaming S2TT — behind the entitlement gate, plus its
  config/credentials. The exact 同传 WebSocket protocol is researched and specced
  there.

## Testing

- **`PipelineSubtitleSource`** unit tests (the relocated session-logic tests):
  partials/`language` emitted without waiting on a slow translator; latest-wins
  drops a stale final; a final emits with its translation when still latest.
- **Thin `RealtimeSession`** tests via an injected stub `createSubtitleSource`:
  events from the source are forwarded to the socket; a factory that throws
  `ModeUnavailableError` produces a `mode_unavailable` error event and keeps the
  connection open; `start` passes the requested `mode` (and default) to the
  factory; `stop` ends/closes the source.
- **Factory** tests: `pipeline` builds a `PipelineSubtitleSource`; `interpret`
  throws `ModeUnavailableError` in Cycle 1.
- **Protocol** guard test: `start` accepts a valid `mode`, rejects an invalid one.
- **Extension**: settings round-trip/validation for `mode`; the `start` message
  carries the configured mode.
- Full `pnpm test`/build/typecheck/lint green; the existing server/e2e fake-path
  behavior is unchanged (default `pipeline`).

## Out of scope (future)

- The `interpret` engine itself (Cycle 2).
- Real authentication / billing for the paid tier (the gate is the attach point).
- A popup quick-toggle (options-page setting suffices for Cycle 1).
- Per-mode UI affordances beyond the toggle + the existing error banner.
