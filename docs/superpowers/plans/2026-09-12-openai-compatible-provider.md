# OpenAI-Compatible Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `openai` provider lane for both pipeline legs — streaming ASR over the OpenAI Realtime transcription API (with a 16→24 kHz resampler and an item-keyed reconciler) and line translation over Chat Completions — behind configurable per-leg base URLs so the same adapters serve OpenAI, Speaches, Groq, OpenRouter and friends.

**Architecture:** Backend-only. Two new adapters that mirror the Volcengine ones in shape (injectable transport / fetch seam, `withReconnect`, `createDrainGate`, lifecycle guards), plus three small pure modules they depend on (PCM resampler, Realtime protocol encode/decode, transcript reconciler). Config → health → factory wiring reuses the existing blocker codes; no protocol change; no extension change.

**Tech Stack:** TypeScript, pnpm 10 workspace, Node 22, Fastify 5, `ws`, Vitest 3.

**Spec:** `docs/superpowers/specs/2026-09-12-openai-compatible-provider-design.md`

## Global Constraints

- Zero new npm dependencies. `ws` is already a backend dependency; base64 and resampling are hand-rolled.
- Backend source imports use explicit `.js` extensions.
- `exactOptionalPropertyTypes` is on. Never assign `undefined` to an optional property; spread conditionally (`...(x !== undefined ? { x } : {})`).
- All commits DCO-signed: `git commit -s`. (Recent history is missing sign-offs; from this slice on, do not skip it.) End the body with the Claude co-author trailer used in this repo.
- One adapter per commit at most; every task ends with `pnpm --filter @echoflow/backend typecheck && pnpm --filter @echoflow/backend test` green.
- Baseline entering this slice: protocol 55 / backend 190 / extension 269 tests; `pnpm typecheck`, `pnpm test`, `pnpm build` clean on `main` at `1b7178d`.
- Do not touch `packages/protocol` or `apps/extension`. If you think you need to, stop and re-read the spec's Non-goals.

## Facts this plan relies on

Verified in the repo:

1. `SpeechProvider.open` returns `{ pushFrame, end, close }`; the session calls `end()` on client `stop`, then `close()`. `pipelineSubtitleSource` translates each `final` and treats a thrown `translate()` as non-fatal (`translation_failed`).
2. `withReconnect(connect, opts)` (`providers/reconnectingTransport.ts`) calls `opts.initialize(transport)` on every fresh socket, buffers nothing during a gap (`send` is dropped while `reconnecting`), and routes non-retryable failures to `opts.onError`. `defaultClassify` retries on any raw socket error and close codes 1005/1006/1011/1012/1013.
3. `createDrainGate` (`providers/drainGate.ts`): `arm()` → `wait()` resolves on the next `onFinal()` or after `timeoutMs` (default 1500); `cancel()` settles immediately.
4. `configHealth.ts` derives `UNIMPLEMENTED_PROVIDER_NAMES` by filtering the name lists against an explicit set of implemented names (`fake`, `volcengine`) — adding `openai` there is what stops it being reported as unimplemented.
5. `readProviderConfig()` in `config.ts` drops the whole vendor object when a required credential is missing; `describeConfigHealth` keys `ready`/`missing` on that absence.
6. Canonical audio in is 16 kHz / Int16LE / mono in ~100 ms frames (3200 bytes).

Verified from OpenAI docs (September 2026) — see the spec's "Verified API facts". Unverified items (utterance `audio_*_ms` fields, `failed` payload, delta timing, session duration cap, detected-language reporting) are resolved by **Task 0** before the reconciler is written.

---

### Task 0: Capture a real Realtime transcription session

Produces the fixture every later ASR test uses and resolves the spec's unconfirmed fields. Needs an `OPENAI_API_KEY`; the maintainer runs it, the worker writes the script.

**Files:**
- Create: `apps/backend/scripts/openai-realtime-probe.ts`
- Create: `apps/backend/src/providers/__fixtures__/openai-realtime-events.jsonl` (output of the probe, committed)
- Create: `apps/backend/src/providers/__fixtures__/README.md`

- [ ] **Step 1: Write the probe**

`scripts/openai-realtime-probe.ts` (run with `pnpm --filter @echoflow/backend exec tsx scripts/openai-realtime-probe.ts <wav-file>`):

- Reads a 16 kHz mono 16-bit WAV (skip the 44-byte header; the repo has none checked in — the maintainer records 20–30 s of English speech with Audacity/`sox`).
- Opens `wss://api.openai.com/v1/realtime?intent=transcription` with `Authorization: Bearer $OPENAI_API_KEY` and **no** `OpenAI-Beta` header.
- Sends `session.update` `{ session: { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "gpt-live-transcribe" }, turn_detection: { type: "server_vad", silence_duration_ms: 600 } } } } }`. If the server rejects `format`, retry with `{ type: "audio/pcm" }` only and note which shape worked.
- Resamples 16→24 k with naive linear interpolation inline (Task 3 will replace this with the tested module; the probe is throwaway).
- Streams 100 ms frames at real-time pace (`setTimeout` 100 ms between appends), then `input_audio_buffer.commit`, waits 5 s, closes.
- Writes **every** server event as one JSON line `{ "t": <ms since first append>, "pushedMs": <audio ms pushed so far>, "event": <raw> }` to the path given as the second argument.

- [ ] **Step 2: Run it (maintainer) and commit the log**

```bash
OPENAI_API_KEY=... pnpm --filter @echoflow/backend exec tsx scripts/openai-realtime-probe.ts sample.wav apps/backend/src/providers/__fixtures__/openai-realtime-events.jsonl
```

Before committing, scrub the log: remove `session.created` / `session.updated` bodies except `session.type`, `audio.input.format`, `turn_detection` (they may echo account-level fields).

- [ ] **Step 3: Record the answers in the fixture README**

`__fixtures__/README.md` states, from the log: (a) whether `speech_started` / `speech_stopped` carry `audio_start_ms` / `audio_end_ms`; (b) whether deltas arrived before `speech_stopped`; (c) the exact `…transcription.failed` shape if one occurred (if not, say so); (d) whether any event reports a detected language; (e) which `format` shape the server accepted; (f) the first-final latency observed. **Task 5's reconciler and Task 4's encoder follow this README, not the spec's guesses.**

---

### Task 1: Provider config and env parsing

**Files:**
- Modify: `apps/backend/src/providers/providerConfig.ts`
- Modify: `apps/backend/src/config.ts`
- Modify: `apps/backend/src/config.test.ts`

**Interfaces:**
- Produces: `OpenAiAsrConfig`, `OpenAiTranslationConfig`, `"openai"` in both name lists, `DEFAULT_OPENAI_*` constants, `resolveOpenAiLeg` helper. Consumed by Tasks 2, 6, 7.

- [ ] **Step 1: Types and defaults in `providerConfig.ts`**

```ts
export const ASR_PROVIDER_NAMES = ["fake", "volcengine", "openai", "aliyun", "tencent"] as const;
export const TRANSLATION_PROVIDER_NAMES = ["fake", "volcengine", "openai", "aliyun", "tencent"] as const;

export type OpenAiAsrConfig = {
  apiKey: string;
  /** No trailing slash, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  model: string;
  silenceMs: number;
  prompt?: string;
  /** ISO 639-1 hints; absent = auto */
  languages?: readonly string[];
};

export type OpenAiTranslationConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type AsrProviderConfig = {
  provider: AsrProviderName;
  volcengine?: VolcengineAsrConfig;
  openai?: OpenAiAsrConfig;
};
export type TranslationProviderConfig = {
  provider: TranslationProviderName;
  volcengine?: VolcengineTranslationConfig;
  openai?: OpenAiTranslationConfig;
};

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_ASR_MODEL = "gpt-live-transcribe";
export const DEFAULT_OPENAI_ASR_SILENCE_MS = 600;
export const DEFAULT_OPENAI_TRANSLATION_MODEL = "gpt-5-nano";
```

- [ ] **Step 2: Failing tests in `config.test.ts`**

Add the eight `OPENAI_*` names to `ORIGINAL_ENV` and the restore list, then:

```ts
it("reads the openai asr leg from the shared key and base url", () => {
  process.env.ECHOFLOW_ASR_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "sk-shared";
  expect(createConfig().providers.asr).toEqual({
    provider: "openai",
    openai: { apiKey: "sk-shared", baseUrl: "https://api.openai.com/v1", model: "gpt-live-transcribe", silenceMs: 600 },
  });
});

it("lets the asr leg override key, base url, model, silence, prompt and languages", () => {
  process.env.ECHOFLOW_ASR_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "sk-shared";
  process.env.OPENAI_ASR_API_KEY = "sk-asr";
  process.env.OPENAI_ASR_BASE_URL = "http://127.0.0.1:8000/v1/";
  process.env.OPENAI_ASR_MODEL = "Systran/faster-whisper-small";
  process.env.OPENAI_ASR_SILENCE_MS = "800";
  process.env.OPENAI_ASR_PROMPT = "EchoFlow, Volcengine";
  process.env.OPENAI_ASR_LANGUAGES = "en, zh";
  expect(createConfig().providers.asr.openai).toEqual({
    apiKey: "sk-asr", baseUrl: "http://127.0.0.1:8000/v1", model: "Systran/faster-whisper-small",
    silenceMs: 800, prompt: "EchoFlow, Volcengine", languages: ["en", "zh"],
  });
});

it("drops the openai asr leg when no key resolves", () => {
  process.env.ECHOFLOW_ASR_PROVIDER = "openai";
  delete process.env.OPENAI_API_KEY; delete process.env.OPENAI_ASR_API_KEY;
  expect(createConfig().providers.asr).toEqual({ provider: "openai" });
});

it("reads the openai translation leg with its own overrides", () => {
  process.env.ECHOFLOW_TRANSLATION_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "sk-shared";
  process.env.OPENAI_TRANSLATION_BASE_URL = "https://api.groq.com/openai/v1";
  process.env.OPENAI_TRANSLATION_MODEL = "llama-3.3-70b-versatile";
  expect(createConfig().providers.translation.openai).toEqual({
    apiKey: "sk-shared", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile",
  });
});

it("rejects a non-integer OPENAI_ASR_SILENCE_MS", () => {
  process.env.ECHOFLOW_ASR_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "sk";
  process.env.OPENAI_ASR_SILENCE_MS = "soon";
  expect(() => createConfig()).toThrow("Invalid OPENAI_ASR_SILENCE_MS value: soon");
});
```

Run: `pnpm --filter @echoflow/backend test config` → the new tests fail on `provider: "openai"` being rejected.

- [ ] **Step 3: Parse in `config.ts`**

Add a `readOpenAiLeg(prefix: "OPENAI_ASR" | "OPENAI_TRANSLATION")` that resolves `apiKey = env[`${prefix}_API_KEY`] ?? env.OPENAI_API_KEY`, `baseUrl = stripTrailingSlash(env[`${prefix}_BASE_URL`] ?? env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL)` and returns `undefined` when `apiKey` is empty. In `readProviderConfig`:

```ts
if (asrProvider === "openai") {
  const leg = readOpenAiLeg("OPENAI_ASR");
  if (leg !== undefined) {
    const prompt = readNonEmpty(process.env.OPENAI_ASR_PROMPT);
    const languages = readCsv(process.env.OPENAI_ASR_LANGUAGES);
    config.asr.openai = {
      ...leg,
      model: process.env.OPENAI_ASR_MODEL ?? DEFAULT_OPENAI_ASR_MODEL,
      silenceMs: readPositiveInt(process.env.OPENAI_ASR_SILENCE_MS, "OPENAI_ASR_SILENCE_MS", DEFAULT_OPENAI_ASR_SILENCE_MS),
      ...(prompt !== undefined ? { prompt } : {}),
      ...(languages !== undefined ? { languages } : {}),
    };
  }
}
if (translationProvider === "openai") {
  const leg = readOpenAiLeg("OPENAI_TRANSLATION");
  if (leg !== undefined) {
    config.translation.openai = { ...leg, model: process.env.OPENAI_TRANSLATION_MODEL ?? DEFAULT_OPENAI_TRANSLATION_MODEL };
  }
}
```

Generalize the existing `readVadSegmentDurationMs` into `readPositiveInt(value, name, fallback)` and reuse it for `VOLCENGINE_ASR_VAD_MS` (behaviour unchanged, existing test still passes). `readCsv` splits on commas, trims, drops empties, returns `undefined` for an empty result.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @echoflow/backend typecheck && pnpm --filter @echoflow/backend test config providerConfig
git commit -s -am "feat(backend): openai provider config and env parsing"
```

---

### Task 2: Health, blockers, factory fail-fast

**Files:**
- Modify: `apps/backend/src/configHealth.ts`, `configHealth.test.ts`
- Modify: `apps/backend/src/providers/providerFactory.ts`, `providerFactory.test.ts`

- [ ] **Step 1: Failing tests**

`configHealth.test.ts`:

```ts
it("treats openai as implemented and names OPENAI_API_KEY when its leg is missing", () => {
  const health = describeConfigHealth(configWith({ asr: { provider: "openai" }, translation: { provider: "openai" } }));
  expect(health.find((c) => c.name === "asr")).toMatchObject({ ready: false, demo: false, unimplemented: false, missing: ["OPENAI_API_KEY"] });
  expect(health.find((c) => c.name === "translation")).toMatchObject({ ready: false, unimplemented: false, missing: ["OPENAI_API_KEY"] });
});
it("marks a credentialed openai leg ready", () => { /* asr.openai present → ready true, missing [] */ });
```

`providerFactory.test.ts`:

```ts
it("throws when openai ASR is selected without a key", () => {
  expect(() => createSpeechProvider({ provider: "openai" })).toThrow(/OPENAI_API_KEY/);
});
it("throws when openai translation is selected without a key", () => {
  expect(() => createTranslationProvider({ provider: "openai" })).toThrow("OPENAI_API_KEY is required when ECHOFLOW_TRANSLATION_PROVIDER=openai");
});
```

(The "constructs the provider" cases are added in Tasks 6/7 once the classes exist.)

- [ ] **Step 2: Implement**

`configHealth.ts`: `UNIMPLEMENTED_PROVIDER_NAMES` filter excludes `"openai"` too; `ready` for each leg becomes `provider === "fake" || volcengine !== undefined || openai !== undefined`; `missing` is `["OPENAI_API_KEY"]` when `provider === "openai" && openai === undefined`. Update `describeUnavailable` / `assertConfigUsable` wording from "use fake or volcengine" to "use fake, volcengine or openai" — and the two tests that assert that string.

`providerFactory.ts`: add the `openai` branches that throw the messages above; the constructors are wired in Tasks 6/7 (for now the branch after the guard can `throw new Error("openai adapter lands in a later task")` — replace it in Task 6/7, never ship it).

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @echoflow/backend typecheck && pnpm --filter @echoflow/backend test configHealth providerFactory
git commit -s -am "feat(backend): openai provider health, blockers and fail-fast"
```

---

### Task 3: PCM resampler

**Files:**
- Create: `apps/backend/src/providers/pcmResample.ts`, `pcmResample.test.ts`

- [ ] **Step 1: Failing tests**

```ts
it("produces 3 output samples for every 2 input samples across frame boundaries", () => {
  const r = createPcmResampler(16000, 24000);
  const total = [0, 1, 2, 3, 4].map(() => r.push(sine(1000, 16000, 1600)).length / 2).reduce((a, b) => a + b);
  expect(total).toBe(1600 * 5 * 3 / 2);
});
it("keeps a 1 kHz tone a 1 kHz tone", () => { /* zero-crossing count of output over 0.5 s ≈ 1000 ±2 */ });
it("is continuous across frames", () => { /* max abs diff between last sample of frame n and first of n+1 < 5% of amplitude */ });
it("passes through unchanged when rates match", () => { expect(createPcmResampler(16000, 16000).push(buf)).toEqual(buf); });
```

- [ ] **Step 2: Implement**

```ts
export interface PcmResampler { push(input: Buffer): Buffer; }

/** Int16LE mono linear-interpolation resampler that carries state across frames. */
export function createPcmResampler(fromHz: number, toHz: number): PcmResampler {
  if (fromHz === toHz) return { push: (b) => b };
  const step = fromHz / toHz;
  let prev = 0;          // last input sample of the previous frame
  let pos = 0;           // fractional read position relative to prev (0..1) at frame start
  let primed = false;
  return {
    push(input) {
      const n = input.length >> 1;
      if (n === 0) return Buffer.alloc(0);
      // Virtual input: [prev, s0, s1, ... s(n-1)]; index 0 is prev.
      const out: number[] = [];
      let p = primed ? pos : 1;   // first ever frame starts at s0
      while (p < n) {             // p in virtual index space, reads sample floor(p) and floor(p)+1
        const i = Math.floor(p);
        const frac = p - i;
        const a = i === 0 ? prev : input.readInt16LE((i - 1) * 2);
        const b = input.readInt16LE(i * 2);
        out.push(Math.round(a + (b - a) * frac));
        p += step;
      }
      prev = input.readInt16LE((n - 1) * 2);
      pos = p - n;                // carry the overshoot into the next frame
      primed = true;
      const buf = Buffer.alloc(out.length * 2);
      out.forEach((v, k) => buf.writeInt16LE(Math.max(-32768, Math.min(32767, v)), k * 2));
      return buf;
    },
  };
}
```

Tune the test tolerances to what the implementation actually produces rather than loosening the implementation; the 3:2 length invariant must hold exactly over many frames (±1 total).

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @echoflow/backend test pcmResample
git commit -s -am "feat(backend): stateful Int16 PCM linear resampler"
```

---

### Task 4: Realtime protocol encode/decode

**Files:**
- Create: `apps/backend/src/providers/openAiRealtimeProtocol.ts`, `openAiRealtimeProtocol.test.ts`

Follow the fixture README for the exact shapes (format object, field names). The types below are the expectation; adjust to what the log shows.

- [ ] **Step 1: Types and functions**

```ts
export type OpenAiRealtimeSessionOptions = { model: string; silenceMs: number; prompt?: string; languages?: readonly string[] };

export type OpenAiRealtimeServerEvent =
  | { type: "session.created" | "session.updated" }
  | { type: "input_audio_buffer.speech_started"; item_id?: string; audio_start_ms?: number }
  | { type: "input_audio_buffer.speech_stopped"; item_id?: string; audio_end_ms?: number }
  | { type: "input_audio_buffer.committed"; item_id: string }
  | { type: "conversation.item.input_audio_transcription.delta"; item_id: string; delta: string }
  | { type: "conversation.item.input_audio_transcription.completed"; item_id: string; transcript: string }
  | { type: "conversation.item.input_audio_transcription.failed"; item_id?: string; error?: { message?: string; code?: string } }
  | { type: "error"; error: { type?: string; code?: string; message: string } }
  | { type: string };  // anything else: ignored

export function encodeSessionUpdate(o: OpenAiRealtimeSessionOptions): Buffer;   // JSON of session.update per fixture README
export function encodeAudioAppend(pcm24k: Buffer): Buffer;                       // { type: "input_audio_buffer.append", audio: base64 }
export function encodeAudioCommit(): Buffer;
export function parseServerEvent(data: Buffer): OpenAiRealtimeServerEvent;       // throws on non-JSON / missing string `type`
export function isFatalRealtimeError(e: { type?: string; code?: string }): boolean; // invalid_request_error, invalid_api_key, authentication → true
```

- [ ] **Step 2: Tests**

`encodeSessionUpdate` includes `prompt`/`languages` only when given; `encodeAudioAppend` round-trips bytes through base64; `parseServerEvent` throws on `"nope"` and on `{}`; every fixture line's `event` parses without throwing (iterate the JSONL — this is the check that the union covers reality). `isFatalRealtimeError` truth table.

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @echoflow/backend test openAiRealtimeProtocol
git commit -s -am "feat(backend): openai realtime transcription protocol codec"
```

---

### Task 5: Transcript reconciler

**Files:**
- Create: `apps/backend/src/providers/openAiTranscriptReconciler.ts`, `openAiTranscriptReconciler.test.ts`

- [ ] **Step 1: Failing tests (fixture-driven)**

```ts
it("replays the captured session into monotonic finals with real timing", () => {
  const r = new OpenAiTranscriptReconciler();
  const events = readFixture().flatMap((line) => r.reconcile(line.event, line.pushedMs));
  const finals = events.filter((e) => e.kind === "final");
  expect(finals.length).toBeGreaterThan(0);
  expect(finals.map((f) => f.segmentId)).toEqual(finals.map((_, i) => `seg-${i + 1}`));
  for (const f of finals) { expect(f.endTimeMs).toBeGreaterThan(f.startTimeMs); expect(f.text.trim()).not.toBe(""); }
});
it("uses audio_start_ms/audio_end_ms when present and the audio clock when absent", ...);
it("emits partials from deltas for the current item", ...);
it("numbers overlapping items in completion order", ...);   // speech_started A, speech_started B, completed B, completed A → seg-1 = B, seg-2 = A
it("drops a blank transcript and a failed item without emitting a final", ...);
```

- [ ] **Step 2: Implement**

```ts
export class OpenAiTranscriptReconciler {
  private ordinal = 0;
  private open = new Map<string, { startTimeMs: number; endTimeMs?: number; text: string }>();
  private pendingStart: { startTimeMs: number } | null = null;   // speech_started without item_id

  reconcile(event: OpenAiRealtimeServerEvent, pushedMs: number): SegmentEvent[] { ... }
  reset(): void { this.open.clear(); this.pendingStart = null; }   // on reconnect; ordinal is kept
}
```

Rules:

- The ordinal (and so `segmentId = seg-<ordinal>`) is assigned at the **first** event for an item — `speech_started` when it carries an `item_id`, otherwise the first `delta`/`committed` naming the item. A `speech_started` without `item_id` is parked in `pendingStart` and bound to the next item that appears. Partials therefore carry the same id the final will use.
- `delta` appends to the item's text and emits `partial`.
- `speech_stopped` records `endTimeMs` (`audio_end_ms ?? pushedMs`); `speech_started` records `startTimeMs` (`audio_start_ms ?? pushedMs`).
- `completed` marks the item done. Finals are **flushed in ordinal order only**: if item 2 completes before item 1, its final is held until item 1 completes or fails, then both flush. `segmentId` stays monotonic on the wire, which the extension's `compareSegmentId` requires; the cost is one held final under overlap, rare with server VAD.
- A blank transcript or a `failed` item is removed without a final (and unblocks anything held behind it).

The "overlapping items" test asserts exactly this: started A, started B, completed B, completed A → nothing emitted until A completes, then `seg-1` = A, `seg-2` = B.

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @echoflow/backend test openAiTranscriptReconciler
git commit -s -am "feat(backend): openai transcript reconciler"
```

---

### Task 6: Speech provider and transport

**Files:**
- Create: `apps/backend/src/providers/openAiRealtimeTransport.ts`
- Create: `apps/backend/src/providers/openAiSpeechProvider.ts`, `openAiSpeechProvider.test.ts`
- Modify: `apps/backend/src/providers/providerFactory.ts`, `providerFactory.test.ts`

- [ ] **Step 1: Transport**

Copy `volcengineAsrTransport.ts` verbatim, rename the types `OpenAiRealtime*`, and derive the URL in the provider: `baseUrl.replace(/^http/, "ws") + "/realtime?intent=transcription"`, headers `{ Authorization: "Bearer <key>" }`. Text frames arrive as `Buffer` with `binaryType = "nodebuffer"`, so `parseServerEvent` gets a Buffer either way.

- [ ] **Step 2: Failing provider tests** (fake transport as in `volcengineSpeechProvider.test.ts`, decoding JSON instead of gzip frames)

1. sends `session.update` on open with model/silence/prompt/languages from config;
2. each `pushFrame` of 3200 bytes at 16 k becomes one `input_audio_buffer.append` whose base64 decodes to 4800 bytes;
3. emits `language: "auto"` once, then reconciled segments from a replay of the fixture;
4. `error` event with `invalid_request_error` → `onError` and no reconnect; a transport error → `onStatus("reconnecting")`, `session.update` re-sent on the new socket, reconciler reset, ordinal continues;
5. `end()` sends `commit`, resolves on the next final; resolves on timeout when none arrives (injected timer);
6. no audio sent after `end()`; `end()` single-shot; `close()` idempotent and cancels an in-flight drain (mirror the eight Volcengine lifecycle tests one for one).

- [ ] **Step 3: Implement `OpenAiSpeechProvider`**

Same skeleton as `VolcengineSpeechProvider`. Differences: `createPcmResampler(16000, 24000)` per stream; `pushedMs += frame.length / 32` (16 k Int16 mono → 32 bytes per ms) **before** reconciling any event that arrives later; `classify` = `defaultClassify` for socket failures, and for `error` events route through `isFatalRealtimeError` (fatal → `opts.onError` and `transport.close()`; otherwise log and continue). `initialize` sends `session.update` and calls `reconciler.reset()`.

- [ ] **Step 4: Factory + commit**

Wire `new OpenAiSpeechProvider(config.openai)` in `createSpeechProvider`; add the "constructs the openai speech provider" factory test.

```bash
pnpm --filter @echoflow/backend typecheck && pnpm --filter @echoflow/backend test
git commit -s -am "feat(backend): openai realtime streaming ASR adapter"
```

---

### Task 7: Translation provider

**Files:**
- Create: `apps/backend/src/providers/openAiTranslationProvider.ts`, `openAiTranslationProvider.test.ts`
- Modify: `providerFactory.ts`, `providerFactory.test.ts`

- [ ] **Step 1: Failing tests** (stub `fetch` as in the Volcengine test)

- posts to `${baseUrl}/chat/completions` with `Authorization: Bearer`, `temperature: 0`, the system prompt naming "Simplified Chinese (zh-CN)" as target and "detect automatically" for `auto` source, user content = the line; returns trimmed `choices[0].message.content`;
- strips one surrounding pair of `"…"`, `“…”` or `「…」`;
- blank input → `""` with no fetch;
- HTTP 429 → throws with the status; `{}` body → throws "missing translation"; empty content → throws.

- [ ] **Step 2: Implement**

```ts
const LANGUAGE_NAMES: Record<string, string> = { en: "English", "zh-CN": "Simplified Chinese", "zh-TW": "Traditional Chinese", ja: "Japanese", ko: "Korean", es: "Spanish", fr: "French", de: "German" };
export function describeLanguage(code: string): string { const n = LANGUAGE_NAMES[code]; return n ? `${n} (${code})` : code; }
```

`translate` builds the body per the spec, `fetchImpl(`${baseUrl}/chat/completions`, {...})`, throws `OpenAI translation failed: HTTP <status>` / `: missing translation text`. `close()` no-op.

- [ ] **Step 3: Factory + commit**

```bash
pnpm --filter @echoflow/backend typecheck && pnpm --filter @echoflow/backend test
git commit -s -am "feat(backend): openai-compatible chat-completions translation adapter"
```

---

### Task 8: Docs and examples

**Files:**
- Modify: `.env.example`, `README.md`, `docs/providers.md`, `docs/superpowers/backlog.md`, `CLAUDE.md`

- [ ] **Step 1: `.env.example`** — an `# --- OpenAI-compatible (ASR + translation) ---` block with the variables from the spec's Configuration section, the Speaches + Groq split as the worked example, and the note that the ASR leg requires a server that speaks the Realtime transcription protocol (OpenAI, Speaches, vLLM) — not a REST-only Whisper server.
- [ ] **Step 2: README** — add `openai` to both provider lists and an "OpenAI-compatible environment" code block mirroring the Volcengine ones. Update the intro sentence and the provider-selection comment in `.env.example`.
- [ ] **Step 3: `docs/providers.md`** — one line under "Building a streaming ASR adapter" pointing at `openAiSpeechProvider.ts` as the JSON/text-frame reference (Volcengine is the binary-frame one), and at `pcmResample.ts` for vendors that need another rate.
- [ ] **Step 4: `CLAUDE.md` + backlog** — the Project paragraph mentions the `openai` lane; backlog "Provider strategy" bullet 2 flips to ✅ with the PR number.
- [ ] **Step 5: Commit** `git commit -s -am "docs: openai-compatible provider setup"`.

---

### Task 9: Whole-branch verification

- [ ] `pnpm typecheck && pnpm test && pnpm build` from the repo root; then `node apps/backend/dist/main.js` with `ECHOFLOW_ASR_PROVIDER=openai` and no key → exits non-zero naming `OPENAI_API_KEY`; with a key → boots and `/v1/capabilities` shows `pipeline.demo: false`, `blockers: []`.
- [ ] **Real session (maintainer):** extension → backend with `openai`/`openai` against OpenAI; note first-final latency, whether partials render mid-sentence, reconnect behaviour when the network is cut for ~5 s (`重连中…` then resume), Stop keeping the last line, and zh↔en translation quality of `gpt-5-nano` on ~20 lines. If Speaches is available, repeat the ASR leg against it.
- [ ] Put those notes in the PR body; open the PR `feat(backend): openai-compatible ASR and translation providers`.
