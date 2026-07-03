# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

EchoFlow is a Chrome Manifest V3 extension (MVP) that captures active-tab audio, streams it to a local backend over WebSocket, and renders bilingual subtitles in the page. The backend ships with deterministic **fake** speech/translation providers, a `volcengine` streaming ASR adapter (大模型流式语音识别 / sauc bigmodel), and a Volcengine translation adapter; `aliyun`/`tencent` ASR still fail fast. See `README.md` for end-user setup and Chrome loading steps.

## Workspaces

pnpm monorepo (`pnpm@10`, Node ESM throughout). Three packages:

- `packages/protocol` (`@echoflow/protocol`) — the **wire contract** between extension and backend. Defines `ServerEvent` (server→client: `language`/`partial`/`final`/`error`) and `ClientMessage` (client→server: `start`/`audio_frame`/`stop`), each paired with a runtime type guard (`isServerEvent`, `isClientMessage`). Both other packages import this; it has no runtime deps. Source is consumed directly (`main`/`types` point at `src/index.ts`), so backend/extension see protocol changes without a rebuild.
- `apps/backend` (`@echoflow/backend`) — Fastify + `@fastify/websocket` server. One WS route `/v1/realtime`, auth via `x-api-key` header or `?apiKey=` query.
- `apps/extension` (`@echoflow/extension`) — WXT + React 19 MV3 extension.

## Commands

Run from repo root (each fans out with `pnpm -r`):

```bash
pnpm build      # tsc build all packages
pnpm test       # vitest run, all packages
pnpm typecheck  # tsc --noEmit
pnpm lint       # NOTE: lint == tsc --noEmit (no ESLint configured)
```

Per-package (use the workspace filter):

```bash
pnpm --filter @echoflow/backend dev          # tsx watch backend on :8787
pnpm --filter @echoflow/extension dev        # WXT dev server
pnpm --filter @echoflow/extension build      # output: apps/extension/.output/chrome-mv3
```

Single test file / pattern (the `test` script is `vitest run`, so append a path or name filter):

```bash
pnpm --filter @echoflow/backend test config            # files matching "config"
pnpm --filter @echoflow/backend test -- -t "rejects"   # by test name
```

End-to-end:

```bash
bash scripts/dev-smoke.sh                         # full headless smoke (backend + extension)
pnpm --filter @echoflow/extension test:e2e        # Playwright extension smoke
```

The smoke/e2e flow cannot synthesize a real toolbar click, so it validates the deterministic path but records the `activeTab`/`tabCapture` grant as a known limitation.

## Architecture

### Backend request flow
`server.ts` registers a health check (`GET /healthz` → `{ ok: true }`; note: **not** `/health`, which 404s) and the WS route `/v1/realtime`, and, per connection, constructs a `RealtimeSession` (`realtime/session.ts`) with speech + translation providers from `providerFactory.ts`. The session distinguishes JSON control frames from binary audio frames by inspecting `isBinary` + a `looksLikeJson` check; control frames are validated against `isClientMessage` (malformed → `invalid_client_message` error event). The session opens a stream via `speechProvider.open({ onSegment, onError })` and pushes incoming audio frames into it (`pushFrame`); `language`/`partial` segment events are sent immediately, while each `final` is pushed onto a bounded FIFO queue and translated by a single-flight worker (`drainTranslations`) that emits **every** translated `final` in order (the queue caps at 64, dropping the oldest with a `history_truncated` event only under a stalled translator). Emitting every final keeps **history complete**; the extension's subtitle reducer keeps the on-screen current line **monotonic** (a late, slow-translated older final is recorded to history by the background but does not replace a newer displayed line — see `subtitles/compareSegmentId.ts`). This split (complete history, clean single line) supersedes the earlier latest-wins drop. The Volcengine adapter requests `result_type:"single"` + `show_utterances` + `vad_segment_duration` so SeedASR VAD-segments speech server-side, and its reconciler surfaces **finalized sentences only** (one `final` per confirmed `definite`) for a bounded movie-style current line. Providers are split (`createSpeechProvider` / `createTranslationProvider`) because streaming ASR and text translation use different APIs/credentials; `fake` ASR is deterministic; `volcengine` ASR streams audio to 大模型流式语音识别 (`sauc/bigmodel`) over a WebSocket and throws without `VOLCENGINE_ASR_APP_KEY`/`VOLCENGINE_ASR_ACCESS_KEY` (distinct from the translation key); `aliyun`/`tencent` ASR still throw; and `volcengine` translation throws without `VOLCENGINE_API_KEY`. Config precedence lives in `config.ts` (explicit input → `ECHOFLOW_*` env → `PORT` fallback → defaults).

### Extension: three execution contexts + two message layers
The extension spans three contexts that talk over `chrome.runtime` messages typed by `RuntimeMessage` in `src/messaging/messages.ts`. **Keep this distinct from the wire `ServerEvent`/`ClientMessage` protocol** — `messages.ts` is the *internal* extension bus; a `ServerEvent` rides inside a `SERVER_EVENT` runtime message as a payload.

- `entrypoints/background.ts` — service-worker orchestrator. Owns session lifecycle. On action click: validates settings (opens options page if invalid), creates a *local* history session, reduces `sessionState`, ensures the offscreen doc, gets a `tabCapture` stream id, then sends `START_SESSION`. Records `final` segments to history and forwards `SERVER_EVENT`s to the content script. Toggles the toolbar badge.
- `entrypoints/offscreen/main.ts` — offscreen document (`reasons: ["USER_MEDIA"]`). The only place that can run `getUserMedia` in MV3. Owns the `RealtimeClient` (WS to backend) and `OffscreenAudioPipeline`. The pipeline captures via an `AudioWorklet` (`public/pcm-encoder.worklet.js`) and streams provider-neutral 16 kHz/16-bit/mono PCM (`CANONICAL_PCM_AUDIO_FORMAT`) — not webm — so any real ASR adapter can consume the bytes. Translates backend `ServerEvent`s into `SERVER_EVENT` runtime messages.
- `entrypoints/content.tsx` — **runtime-injected** content script (`registration: "runtime"`, not declared in the manifest; injected on demand via `chrome.scripting.executeScript`). Mounts a React overlay into a **shadow root** for style isolation. Receives `SERVER_EVENT` runtime messages and dispatches them **directly** into the subtitle reducer (no page-observable `window` bridge). It also samples the page `<video>`'s `currentTime` and sends `VIDEO_TIME_SAMPLE`; the background correlates each final's spoken wall-clock (`captureStartedAtMs + startTimeMs`, `captureStartedAtMs` arriving on `SESSION_STARTED`) against a `videoTimeIndex` and stores `videoStartSec`/`videoEndSec` on the history segment — client-side only, the wire `SubtitleSegment` is unchanged.

### Two "session" concepts, two reducers
Do not conflate them:
- **Local session** — a browser-side history record (Dexie/IndexedDB via `src/history/`), id generated by `historyStore.createLocalSession`. `localSessionId` tags every runtime message so stale messages from a replaced session are ignored.
- **Remote session** — the backend WS connection.
- `src/session/sessionState.ts` reduces the background **lifecycle** (`idle`/`connecting`/`running`/`stopping`).
- `src/subtitles/reducer.ts` reduces **rendering** state (current segment + transient error) in the content script.

Both reducers are pure and unit-tested; prefer extending the reducer + its test over adding ad-hoc state.

## Conventions

- **Protocol changes are contract changes.** When editing `packages/protocol`, update the matching runtime type guard *and* its `.test.ts` in the same change — every boundary (backend frame parsing, extension event handling) trusts these guards rather than re-validating.
- Settings/credentials: provider secrets live only in backend env files. Never put them in the extension. The extension stores only `serverUrl`/`apiKey`/`targetLanguage`/`subtitleFontSize` (`src/settings/settings.ts`); `buildRealtimeWebSocketUrl` derives the WS URL from `serverUrl`.
- Tests are colocated `*.test.ts(x)` run by Vitest; the extension's `test` script targets `src` only (entrypoints are covered by e2e).
- `host_permissions` are restricted to localhost; the backend is expected at `http://127.0.0.1:8787`.
