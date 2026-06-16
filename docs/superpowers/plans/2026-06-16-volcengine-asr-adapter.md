# Volcengine ASR Adapter (Plan B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real streaming `SpeechProvider` for Volcengine 大模型流式语音识别 (`sauc/bigmodel`), selectable via `ECHOFLOW_ASR_PROVIDER=volcengine`, behind an injectable transport so it is fully unit-testable without network or credentials.

**Architecture:** Four small backend units — a pure binary-protocol codec, a pure cumulative→incremental utterance reconciler, an injectable WebSocket transport seam (default impl wraps the `ws` client), and the `SpeechProvider` that wires them together. Plus config/env wiring, a new `onError` channel on the provider contract surfaced as the existing `error` `ServerEvent`, and docs. The extension already streams canonical 16 kHz/16-bit/mono PCM (Plan A), which is exactly what `bigmodel` expects, so no audio conversion is needed in the adapter.

**Tech Stack:** TypeScript (ESM, strict: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Node built-ins `node:zlib` (gzip) + `node:crypto` (randomUUID), the `ws` WebSocket client (already a backend dependency), Vitest.

**Reference:** `docs/superpowers/specs/2026-06-16-volcengine-asr-design.md` (Half B). Protocol verified against `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/backend/src/providers/volcengineAsrProtocol.ts` | Pure binary codec: encode client requests, parse server messages | Create |
| `apps/backend/src/providers/volcengineAsrProtocol.test.ts` | Byte-level codec tests | Create |
| `apps/backend/src/providers/utteranceReconciler.ts` | Pure cumulative→incremental `SegmentEvent` state machine | Create |
| `apps/backend/src/providers/utteranceReconciler.test.ts` | Reconciler tests | Create |
| `apps/backend/src/providers/volcengineAsrTransport.ts` | Injectable WS transport seam + default `ws` impl | Create |
| `apps/backend/src/providers/volcengineSpeechProvider.ts` | The `SpeechProvider` wiring codec + transport + reconciler | Create |
| `apps/backend/src/providers/volcengineSpeechProvider.test.ts` | Provider tests with a scripted fake transport | Create |
| `apps/backend/src/providers/types.ts` | Add optional `onError` to `SpeechProvider.open` opts | Modify |
| `apps/backend/src/providers/providerConfig.ts` | Add `VolcengineAsrConfig`, ASR defaults | Modify |
| `apps/backend/src/config.ts` | Populate `asr.volcengine` from env | Modify |
| `apps/backend/src/config.test.ts` | Cover the new ASR env wiring | Modify |
| `apps/backend/src/providers/providerFactory.ts` | Construct `VolcengineSpeechProvider` for `volcengine` | Modify |
| `apps/backend/src/providers/providerFactory.test.ts` | Cover volcengine ASR construction + missing-creds throw | Modify |
| `apps/backend/src/realtime/session.ts` | Wire provider `onError` → `error` `ServerEvent` + end session | Modify |
| `apps/backend/src/realtime/session.test.ts` | Cover provider-error surfacing | Modify |
| `.env.example`, `README.md`, `CLAUDE.md` | Document the new ASR env vars (distinct from translation key) | Modify |
| `scripts/volcengine-asr-smoke.ts` | Opt-in real smoke: stream a WAV/PCM file, print transcript | Create |

---

## Task 1: Binary protocol codec

**Files:**
- Create: `apps/backend/src/providers/volcengineAsrProtocol.ts`
- Create: `apps/backend/src/providers/volcengineAsrProtocol.test.ts`

Pure functions over `Buffer`; the only place that knows the 4-byte framing.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/providers/volcengineAsrProtocol.test.ts`:

```ts
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  encodeAudioRequest,
  encodeFullClientRequest,
  parseServerMessage,
  type VolcengineAsrRequestConfig,
} from "./volcengineAsrProtocol.js";

const CONFIG: VolcengineAsrRequestConfig = {
  user: { uid: "echoflow" },
  audio: { format: "pcm", sample_rate: 16000, bits: 16, channel: 1, codec: "raw" },
  request: { model_name: "bigmodel", enable_punc: true },
};

// Helpers that build server->client frames the same way the real server does,
// so parseServerMessage can be tested without a network.
function buildServerResponse(payload: unknown, isLast = false): Buffer {
  const header = Buffer.from([
    (0b0001 << 4) | 0b0001, // version | header size
    (0b1001 << 4) | (isLast ? 0b0010 : 0b0000), // FULL_SERVER_RESPONSE | flags
    (0b0001 << 4) | 0b0001, // JSON | GZIP
    0x00,
  ]);
  const body = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, size, body]);
}

function buildServerError(code: number, message: string): Buffer {
  const header = Buffer.from([
    (0b0001 << 4) | 0b0001,
    (0b1111 << 4) | 0b0000, // SERVER_ERROR_RESPONSE
    (0b0001 << 4) | 0b0001,
    0x00,
  ]);
  const codeBuf = Buffer.alloc(4);
  codeBuf.writeUInt32BE(code, 0);
  const body = gzipSync(Buffer.from(message, "utf8"));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, codeBuf, size, body]);
}

describe("encodeFullClientRequest", () => {
  it("frames a gzipped JSON config with sequence 1", () => {
    const frame = encodeFullClientRequest(CONFIG);
    expect(frame[0]).toBe((0b0001 << 4) | 0b0001);
    expect(frame[1]).toBe((0b0001 << 4) | 0b0001); // FULL_CLIENT_REQUEST | POS_SEQUENCE
    expect(frame[2]).toBe((0b0001 << 4) | 0b0001); // JSON | GZIP
    expect(frame.readInt32BE(4)).toBe(1); // sequence
    const size = frame.readUInt32BE(8);
    const body = frame.subarray(12, 12 + size);
    expect(JSON.parse(gunzipSync(body).toString("utf8"))).toEqual(CONFIG);
  });
});

describe("encodeAudioRequest", () => {
  it("frames a gzipped audio chunk with a positive sequence", () => {
    const audio = Buffer.from([1, 2, 3, 4]);
    const frame = encodeAudioRequest(audio, 5, false);
    expect(frame[1]).toBe((0b0010 << 4) | 0b0001); // AUDIO_ONLY | POS_SEQUENCE
    expect(frame.readInt32BE(4)).toBe(5);
    const size = frame.readUInt32BE(8);
    expect(Buffer.from(gunzipSync(frame.subarray(12, 12 + size)))).toEqual(audio);
  });

  it("marks the last packet with a negated sequence and the end flag", () => {
    const frame = encodeAudioRequest(Buffer.alloc(0), 9, true);
    expect(frame[1]).toBe((0b0010 << 4) | 0b0011); // AUDIO_ONLY | NEG_WITH_SEQUENCE
    expect(frame.readInt32BE(4)).toBe(-9);
  });
});

describe("parseServerMessage", () => {
  it("parses a full server response into the result payload", () => {
    const payload = { result: { text: "hi", utterances: [{ text: "hi", definite: true }] } };
    const message = parseServerMessage(buildServerResponse(payload, true));
    expect(message).toEqual({ type: "response", isLast: true, payload });
  });

  it("parses a server error response into a code and message", () => {
    const message = parseServerMessage(buildServerError(45000001, "bad request"));
    expect(message).toEqual({ type: "error", code: 45000001, message: "bad request" });
  });
});

```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/backend test volcengineAsrProtocol`
Expected: FAIL — module `./volcengineAsrProtocol.js` not found.

- [ ] **Step 3: Implement the codec**

Create `apps/backend/src/providers/volcengineAsrProtocol.ts`:

```ts
import { gunzipSync, gzipSync } from "node:zlib";

const PROTOCOL_VERSION = 0b0001;
const HEADER_SIZE = 0b0001;

const FULL_CLIENT_REQUEST = 0b0001;
const AUDIO_ONLY_REQUEST = 0b0010;
const SERVER_ERROR_RESPONSE = 0b1111;

const POS_SEQUENCE = 0b0001;
const NEG_WITH_SEQUENCE = 0b0011;

const JSON_SERIALIZATION = 0b0001;
const GZIP = 0b0001;

const FLAG_HAS_SEQUENCE = 0b0001;
const FLAG_LAST_PACKET = 0b0010;

export type VolcengineAsrRequestConfig = {
  user: { uid: string };
  audio: {
    format: string;
    sample_rate: number;
    bits: number;
    channel: number;
    codec: string;
  };
  request: { model_name: string; enable_punc: boolean };
};

export type VolcengineUtterance = {
  text?: string;
  definite?: boolean;
  start_time?: number;
  end_time?: number;
};

export type VolcengineAsrResult = {
  result?: {
    text?: string;
    language?: string;
    utterances?: VolcengineUtterance[];
  };
};

export type VolcengineServerMessage =
  | { type: "response"; isLast: boolean; payload: VolcengineAsrResult }
  | { type: "error"; code: number; message: string };

function buildHeader(messageType: number, flags: number): Buffer {
  return Buffer.from([
    (PROTOCOL_VERSION << 4) | HEADER_SIZE,
    (messageType << 4) | flags,
    (JSON_SERIALIZATION << 4) | GZIP,
    0x00,
  ]);
}

function framePayload(header: Buffer, sequence: number, payload: Buffer): Buffer {
  const sequenceBytes = Buffer.alloc(4);
  sequenceBytes.writeInt32BE(sequence, 0);
  const sizeBytes = Buffer.alloc(4);
  sizeBytes.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, sequenceBytes, sizeBytes, payload]);
}

export function encodeFullClientRequest(config: VolcengineAsrRequestConfig): Buffer {
  const header = buildHeader(FULL_CLIENT_REQUEST, POS_SEQUENCE);
  const payload = gzipSync(Buffer.from(JSON.stringify(config), "utf8"));
  return framePayload(header, 1, payload);
}

export function encodeAudioRequest(
  audio: Buffer,
  sequence: number,
  isLast: boolean,
): Buffer {
  const flags = isLast ? NEG_WITH_SEQUENCE : POS_SEQUENCE;
  const header = buildHeader(AUDIO_ONLY_REQUEST, flags);
  const payload = gzipSync(audio);
  return framePayload(header, isLast ? -sequence : sequence, payload);
}

export function parseServerMessage(data: Buffer): VolcengineServerMessage {
  const headerSize = data[0]! & 0x0f;
  const messageType = data[1]! >> 4;
  const flags = data[1]! & 0x0f;
  const compression = data[2]! & 0x0f;

  let offset = headerSize * 4;
  const isLast = (flags & FLAG_LAST_PACKET) !== 0;
  if ((flags & FLAG_HAS_SEQUENCE) !== 0) {
    offset += 4; // skip the sequence prefix
  }

  if (messageType === SERVER_ERROR_RESPONSE) {
    const code = data.readUInt32BE(offset);
    offset += 4;
    const size = data.readUInt32BE(offset);
    offset += 4;
    const body = decode(data.subarray(offset, offset + size), compression);
    return { type: "error", code, message: body.toString("utf8") };
  }

  const size = data.readUInt32BE(offset);
  offset += 4;
  const body = decode(data.subarray(offset, offset + size), compression);
  return {
    type: "response",
    isLast,
    payload: JSON.parse(body.toString("utf8")) as VolcengineAsrResult,
  };
}

function decode(body: Buffer, compression: number): Buffer {
  return compression === GZIP ? gunzipSync(body) : body;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/backend test volcengineAsrProtocol`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/providers/volcengineAsrProtocol.ts apps/backend/src/providers/volcengineAsrProtocol.test.ts
git commit -m "feat(backend): add Volcengine ASR binary protocol codec"
```

---

## Task 2: Cumulative→incremental utterance reconciler

**Files:**
- Create: `apps/backend/src/providers/utteranceReconciler.ts`
- Create: `apps/backend/src/providers/utteranceReconciler.test.ts`

Volcengine re-sends the whole utterances array each packet. This pure state machine turns that into incremental `partial`/`final` `SegmentEvent`s.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/providers/utteranceReconciler.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { UtteranceReconciler } from "./utteranceReconciler.js";

describe("UtteranceReconciler", () => {
  it("emits a partial for a non-definite utterance", () => {
    const reconciler = new UtteranceReconciler();
    expect(reconciler.reconcile([{ text: "hello", start_time: 100 }])).toEqual([
      { kind: "partial", segmentId: "seg-1", text: "hello", startTimeMs: 100 },
    ]);
  });

  it("does not re-emit an unchanged partial", () => {
    const reconciler = new UtteranceReconciler();
    reconciler.reconcile([{ text: "hello" }]);
    expect(reconciler.reconcile([{ text: "hello" }])).toEqual([]);
  });

  it("emits a new partial when the text grows", () => {
    const reconciler = new UtteranceReconciler();
    reconciler.reconcile([{ text: "hello" }]);
    expect(reconciler.reconcile([{ text: "hello world" }])).toEqual([
      { kind: "partial", segmentId: "seg-1", text: "hello world", startTimeMs: 0 },
    ]);
  });

  it("emits exactly one final when an utterance becomes definite", () => {
    const reconciler = new UtteranceReconciler();
    reconciler.reconcile([{ text: "hello world" }]);
    expect(
      reconciler.reconcile([
        { text: "hello world", definite: true, start_time: 100, end_time: 900 },
      ]),
    ).toEqual([
      {
        kind: "final",
        segmentId: "seg-1",
        text: "hello world",
        startTimeMs: 100,
        endTimeMs: 900,
      },
    ]);
  });

  it("never re-emits a finalized utterance", () => {
    const reconciler = new UtteranceReconciler();
    reconciler.reconcile([{ text: "hi", definite: true }]);
    expect(reconciler.reconcile([{ text: "hi", definite: true }])).toEqual([]);
  });

  it("tracks multiple utterances independently by index", () => {
    const reconciler = new UtteranceReconciler();
    const events = reconciler.reconcile([
      { text: "first", definite: true, start_time: 0, end_time: 500 },
      { text: "second", definite: false, start_time: 500 },
    ]);
    expect(events).toEqual([
      { kind: "final", segmentId: "seg-1", text: "first", startTimeMs: 0, endTimeMs: 500 },
      { kind: "partial", segmentId: "seg-2", text: "second", startTimeMs: 500 },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/backend test utteranceReconciler`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the reconciler**

Create `apps/backend/src/providers/utteranceReconciler.ts`:

```ts
import type { SegmentEvent } from "./types.js";
import type { VolcengineUtterance } from "./volcengineAsrProtocol.js";

export class UtteranceReconciler {
  private readonly finalized = new Set<number>();
  private readonly lastPartialText = new Map<number, string>();

  reconcile(utterances: VolcengineUtterance[]): SegmentEvent[] {
    const events: SegmentEvent[] = [];

    utterances.forEach((utterance, index) => {
      if (this.finalized.has(index)) {
        return;
      }

      const segmentId = `seg-${index + 1}`;
      const text = utterance.text ?? "";
      const startTimeMs = utterance.start_time ?? 0;

      if (utterance.definite === true) {
        this.finalized.add(index);
        this.lastPartialText.delete(index);
        events.push({
          kind: "final",
          segmentId,
          text,
          startTimeMs,
          endTimeMs: utterance.end_time ?? startTimeMs,
        });
        return;
      }

      if (this.lastPartialText.get(index) === text) {
        return;
      }
      this.lastPartialText.set(index, text);
      events.push({ kind: "partial", segmentId, text, startTimeMs });
    });

    return events;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/backend test utteranceReconciler`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/providers/utteranceReconciler.ts apps/backend/src/providers/utteranceReconciler.test.ts
git commit -m "feat(backend): add cumulative-to-incremental utterance reconciler"
```

---

## Task 3: Add `onError` to the SpeechProvider contract

**Files:**
- Modify: `apps/backend/src/providers/types.ts:24-26`

The streaming `open` opts only carry `onSegment`. Add an optional `onError` so asynchronous failures (arriving over the Volcengine WS after `open` returns) have a path. Optional → the fake provider is unaffected.

- [ ] **Step 1: Update the type**

In `apps/backend/src/providers/types.ts`, replace the `SpeechProvider` type:

```ts
export type SpeechProvider = {
  open(opts: {
    onSegment: (event: SegmentEvent) => void;
    onError?: (error: Error) => void;
  }): SpeechRecognitionStream;
};
```

- [ ] **Step 2: Verify the package still typechecks**

Run: `pnpm --filter @echoflow/backend typecheck`
Expected: PASS (adding an optional callback is backward compatible; existing callers pass only `onSegment`).

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/providers/types.ts
git commit -m "feat(backend): add optional onError to SpeechProvider.open"
```

---

## Task 4: Injectable WebSocket transport

**Files:**
- Create: `apps/backend/src/providers/volcengineAsrTransport.ts`

The transport is I/O — verified through the speech provider's fake transport (Task 6) and the opt-in smoke (Task 11), not a dedicated unit test. It defines the seam interface and the default `ws`-client implementation. It buffers sends issued before the socket opens (the provider sends the full client request immediately).

- [ ] **Step 1: Create the transport**

Create `apps/backend/src/providers/volcengineAsrTransport.ts`:

```ts
import { WebSocket } from "ws";

export type VolcengineAsrConnectOptions = {
  endpoint: string;
  headers: Record<string, string>;
};

export type VolcengineAsrTransportCallbacks = {
  onMessage: (data: Buffer) => void;
  onError: (error: Error) => void;
  onClose: (code: number, reason: string) => void;
};

export interface VolcengineAsrTransport {
  send(data: Buffer): void;
  close(): void;
}

export type VolcengineAsrTransportFactory = (
  options: VolcengineAsrConnectOptions,
  callbacks: VolcengineAsrTransportCallbacks,
) => VolcengineAsrTransport;

export const connectVolcengineAsrTransport: VolcengineAsrTransportFactory = (
  options,
  callbacks,
) => {
  const socket = new WebSocket(options.endpoint, { headers: options.headers });
  socket.binaryType = "nodebuffer";

  let open = false;
  const queue: Buffer[] = [];

  socket.on("open", () => {
    open = true;
    for (const buffered of queue) {
      socket.send(buffered);
    }
    queue.length = 0;
  });
  socket.on("message", (data: Buffer) => {
    callbacks.onMessage(data);
  });
  socket.on("error", (error: Error) => {
    callbacks.onError(error);
  });
  socket.on("close", (code: number, reason: Buffer) => {
    callbacks.onClose(code, reason.toString("utf8"));
  });

  return {
    send(data: Buffer): void {
      if (open && socket.readyState === socket.OPEN) {
        socket.send(data);
      } else {
        queue.push(data);
      }
    },
    close(): void {
      socket.close();
    },
  };
};
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm --filter @echoflow/backend typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/providers/volcengineAsrTransport.ts
git commit -m "feat(backend): add injectable Volcengine ASR WebSocket transport"
```

---

## Task 5: Add the Volcengine ASR config type

**Files:**
- Modify: `apps/backend/src/providers/providerConfig.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/backend/src/providers/providerConfig.ts` consumers later; first add a focused test. Create `apps/backend/src/providers/providerConfig.test.ts` ONLY IF it does not already exist; if it exists, add the case to it. Use this test:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOLCENGINE_ASR_ENDPOINT,
  DEFAULT_VOLCENGINE_ASR_RESOURCE_ID,
} from "./providerConfig.js";

describe("Volcengine ASR defaults", () => {
  it("targets the bidirectional bigmodel endpoint and duration resource", () => {
    expect(DEFAULT_VOLCENGINE_ASR_ENDPOINT).toBe(
      "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
    );
    expect(DEFAULT_VOLCENGINE_ASR_RESOURCE_ID).toBe("volc.bigasr.sauc.duration");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @echoflow/backend test providerConfig`
Expected: FAIL — the two constants are not exported.

- [ ] **Step 3: Add the type and constants**

In `apps/backend/src/providers/providerConfig.ts`, add the `VolcengineAsrConfig` type (next to `VolcengineTranslationConfig`), extend `AsrProviderConfig`, and add the defaults. Concretely:

Replace the existing `AsrProviderConfig` type:

```ts
export type VolcengineAsrConfig = {
  appKey: string;
  accessKey: string;
  resourceId: string;
  endpoint: string;
};

export type AsrProviderConfig = {
  provider: AsrProviderName;
  volcengine?: VolcengineAsrConfig;
};
```

And add these constants near `DEFAULT_VOLCENGINE_TRANSLATION_ENDPOINT`:

```ts
export const DEFAULT_VOLCENGINE_ASR_ENDPOINT =
  "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";
export const DEFAULT_VOLCENGINE_ASR_RESOURCE_ID = "volc.bigasr.sauc.duration";
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `pnpm --filter @echoflow/backend test providerConfig`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/providers/providerConfig.ts apps/backend/src/providers/providerConfig.test.ts
git commit -m "feat(backend): add Volcengine ASR provider config type"
```

---

## Task 6: The Volcengine SpeechProvider

**Files:**
- Create: `apps/backend/src/providers/volcengineSpeechProvider.ts`
- Create: `apps/backend/src/providers/volcengineSpeechProvider.test.ts`

Wires codec + transport + reconciler. Injectable transport factory → tested with a scripted fake (no network/creds).

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/providers/volcengineSpeechProvider.test.ts`:

```ts
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { SegmentEvent } from "./types.js";
import { VolcengineSpeechProvider } from "./volcengineSpeechProvider.js";
import type {
  VolcengineAsrTransportCallbacks,
  VolcengineAsrTransportFactory,
} from "./volcengineAsrTransport.js";

const CONFIG = {
  appKey: "app",
  accessKey: "secret",
  resourceId: "volc.bigasr.sauc.duration",
  endpoint: "wss://example.test/asr",
};

function createFakeTransport() {
  const sent: Buffer[] = [];
  let callbacks: VolcengineAsrTransportCallbacks | undefined;
  const factory: VolcengineAsrTransportFactory = (_options, cbs) => {
    callbacks = cbs;
    return {
      send: (data: Buffer) => sent.push(data),
      close: () => {},
    };
  };
  return {
    factory,
    sent,
    emit: (message: Buffer) => callbacks?.onMessage(message),
    fail: (error: Error) => callbacks?.onError(error),
  };
}

function serverResponse(payload: unknown): Buffer {
  const header = Buffer.from([
    (0b0001 << 4) | 0b0001,
    (0b1001 << 4) | 0b0000,
    (0b0001 << 4) | 0b0001,
    0x00,
  ]);
  const body = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, size, body]);
}

function serverError(code: number, message: string): Buffer {
  const header = Buffer.from([
    (0b0001 << 4) | 0b0001,
    (0b1111 << 4) | 0b0000,
    (0b0001 << 4) | 0b0001,
    0x00,
  ]);
  const codeBuf = Buffer.alloc(4);
  codeBuf.writeUInt32BE(code, 0);
  const body = gzipSync(Buffer.from(message, "utf8"));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, codeBuf, size, body]);
}

describe("VolcengineSpeechProvider", () => {
  it("sends a full client request on open", () => {
    const transport = createFakeTransport();
    const provider = new VolcengineSpeechProvider(CONFIG, transport.factory);
    provider.open({ onSegment: () => {} });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]![1]).toBe((0b0001 << 4) | 0b0001); // FULL_CLIENT_REQUEST
  });

  it("sends an audio-only request per frame", () => {
    const transport = createFakeTransport();
    const provider = new VolcengineSpeechProvider(CONFIG, transport.factory);
    const stream = provider.open({ onSegment: () => {} });
    stream.pushFrame({ data: Buffer.from([1, 2]), sequenceNumber: 0, timestampMs: 0 });
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]![1]).toBe((0b0010 << 4) | 0b0001); // AUDIO_ONLY | POS_SEQUENCE
  });

  it("emits a one-time language event then reconciled segments", () => {
    const transport = createFakeTransport();
    const provider = new VolcengineSpeechProvider(CONFIG, transport.factory);
    const events: SegmentEvent[] = [];
    provider.open({ onSegment: (event) => events.push(event) });

    transport.emit(
      serverResponse({ result: { utterances: [{ text: "hello", definite: false }] } }),
    );
    transport.emit(
      serverResponse({
        result: { utterances: [{ text: "hello", definite: true, start_time: 0, end_time: 500 }] },
      }),
    );

    expect(events).toEqual([
      { kind: "language", sourceLanguage: "auto" },
      { kind: "partial", segmentId: "seg-1", text: "hello", startTimeMs: 0 },
      { kind: "final", segmentId: "seg-1", text: "hello", startTimeMs: 0, endTimeMs: 500 },
    ]);
  });

  it("routes a server error response to onError", () => {
    const transport = createFakeTransport();
    const provider = new VolcengineSpeechProvider(CONFIG, transport.factory);
    const errors: Error[] = [];
    provider.open({ onSegment: () => {}, onError: (error) => errors.push(error) });

    transport.emit(serverError(45000001, "bad request"));

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("45000001");
  });

  it("sends a negated last packet on end", async () => {
    const transport = createFakeTransport();
    const provider = new VolcengineSpeechProvider(CONFIG, transport.factory);
    const stream = provider.open({ onSegment: () => {} });
    await stream.end();
    const last = transport.sent[transport.sent.length - 1]!;
    expect(last[1]).toBe((0b0010 << 4) | 0b0011); // AUDIO_ONLY | NEG_WITH_SEQUENCE
    expect(last.readInt32BE(4)).toBeLessThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/backend test volcengineSpeechProvider`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the provider**

Create `apps/backend/src/providers/volcengineSpeechProvider.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { VolcengineAsrConfig } from "./providerConfig.js";
import type {
  AudioFrame,
  SegmentEvent,
  SpeechProvider,
  SpeechRecognitionStream,
} from "./types.js";
import { UtteranceReconciler } from "./utteranceReconciler.js";
import {
  encodeAudioRequest,
  encodeFullClientRequest,
  parseServerMessage,
  type VolcengineAsrRequestConfig,
  type VolcengineServerMessage,
} from "./volcengineAsrProtocol.js";
import {
  connectVolcengineAsrTransport,
  type VolcengineAsrTransportFactory,
} from "./volcengineAsrTransport.js";

export class VolcengineSpeechProvider implements SpeechProvider {
  constructor(
    private readonly config: VolcengineAsrConfig,
    private readonly connect: VolcengineAsrTransportFactory = connectVolcengineAsrTransport,
  ) {}

  open(opts: {
    onSegment: (event: SegmentEvent) => void;
    onError?: (error: Error) => void;
  }): SpeechRecognitionStream {
    const reconciler = new UtteranceReconciler();
    const requestId = randomUUID();
    let languageEmitted = false;
    let sequence = 1;
    let closed = false;

    const transport = this.connect(
      {
        endpoint: this.config.endpoint,
        headers: {
          "X-Api-App-Key": this.config.appKey,
          "X-Api-Access-Key": this.config.accessKey,
          "X-Api-Resource-Id": this.config.resourceId,
          "X-Api-Request-Id": requestId,
        },
      },
      {
        onMessage: (data) => {
          if (closed) {
            return;
          }
          let message: VolcengineServerMessage;
          try {
            message = parseServerMessage(data);
          } catch (error) {
            opts.onError?.(toError(error));
            return;
          }
          if (message.type === "error") {
            opts.onError?.(
              new Error(`Volcengine ASR error ${message.code}: ${message.message}`),
            );
            return;
          }
          if (!languageEmitted) {
            languageEmitted = true;
            opts.onSegment({
              kind: "language",
              sourceLanguage: message.payload.result?.language ?? "auto",
            });
          }
          for (const event of reconciler.reconcile(
            message.payload.result?.utterances ?? [],
          )) {
            opts.onSegment(event);
          }
        },
        onError: (error) => {
          if (!closed) {
            opts.onError?.(error);
          }
        },
        onClose: () => {
          // The session drains via end(); nothing to do on a normal close.
        },
      },
    );

    transport.send(encodeFullClientRequest(buildRequestConfig(requestId)));

    return {
      pushFrame(frame: AudioFrame): void {
        if (closed) {
          return;
        }
        sequence += 1;
        const audio = Buffer.isBuffer(frame.data)
          ? frame.data
          : Buffer.from(frame.data);
        transport.send(encodeAudioRequest(audio, sequence, false));
      },
      async end(): Promise<void> {
        if (closed) {
          return;
        }
        sequence += 1;
        transport.send(encodeAudioRequest(Buffer.alloc(0), sequence, true));
        closed = true;
      },
      async close(): Promise<void> {
        closed = true;
        transport.close();
      },
    };
  }
}

function buildRequestConfig(uid: string): VolcengineAsrRequestConfig {
  return {
    user: { uid },
    audio: { format: "pcm", sample_rate: 16000, bits: 16, channel: 1, codec: "raw" },
    request: { model_name: "bigmodel", enable_punc: true },
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Volcengine ASR parse failed");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/backend test volcengineSpeechProvider`
Expected: PASS (all five cases).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/providers/volcengineSpeechProvider.ts apps/backend/src/providers/volcengineSpeechProvider.test.ts
git commit -m "feat(backend): add Volcengine streaming SpeechProvider"
```

---

## Task 7: Populate ASR config from env

**Files:**
- Modify: `apps/backend/src/config.ts` (the `readProviderConfig` function, lines 46-74)
- Modify: `apps/backend/src/config.test.ts`

- [ ] **Step 1: Write the failing test**

In `apps/backend/src/config.test.ts`, add a test that sets the ASR env vars and asserts they flow into `config.providers.asr.volcengine`. Read the existing file first to match its env-reset pattern; add this case:

```ts
it("reads Volcengine ASR credentials into the asr provider config", () => {
  process.env.ECHOFLOW_ASR_PROVIDER = "volcengine";
  process.env.VOLCENGINE_ASR_APP_KEY = "app-123";
  process.env.VOLCENGINE_ASR_ACCESS_KEY = "secret-456";

  const config = createConfig();

  expect(config.providers.asr).toEqual({
    provider: "volcengine",
    volcengine: {
      appKey: "app-123",
      accessKey: "secret-456",
      resourceId: "volc.bigasr.sauc.duration",
      endpoint: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
    },
  });
});
```

(Ensure `createConfig` is imported — the existing test file imports it. If the test file resets `process.env` in `beforeEach`/`afterEach`, the new `VOLCENGINE_ASR_*` keys must be cleared there too; add them to the existing reset list.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @echoflow/backend test config`
Expected: FAIL — `asr.volcengine` is undefined.

- [ ] **Step 3: Populate the config**

In `apps/backend/src/config.ts`, add the import and the env population. Update the import from `./providers/providerConfig.js` to also bring in the ASR defaults:

```ts
import {
  DEFAULT_PROVIDER_CONFIG,
  DEFAULT_VOLCENGINE_ASR_ENDPOINT,
  DEFAULT_VOLCENGINE_ASR_RESOURCE_ID,
  DEFAULT_VOLCENGINE_TRANSLATION_ENDPOINT,
  DEFAULT_VOLCENGINE_TRANSLATION_RESOURCE_ID,
  type ProviderConfig,
  parseAsrProviderName,
  parseTranslationProviderName,
} from "./providers/providerConfig.js";
```

Then in `readProviderConfig`, after the `config` object is created and before the `volcengine` translation block, add the ASR block:

```ts
  if (
    asrProvider === "volcengine" &&
    process.env.VOLCENGINE_ASR_APP_KEY &&
    process.env.VOLCENGINE_ASR_ACCESS_KEY
  ) {
    config.asr.volcengine = {
      appKey: process.env.VOLCENGINE_ASR_APP_KEY,
      accessKey: process.env.VOLCENGINE_ASR_ACCESS_KEY,
      resourceId:
        process.env.VOLCENGINE_ASR_RESOURCE_ID ?? DEFAULT_VOLCENGINE_ASR_RESOURCE_ID,
      endpoint:
        process.env.VOLCENGINE_ASR_ENDPOINT ?? DEFAULT_VOLCENGINE_ASR_ENDPOINT,
    };
  }
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `pnpm --filter @echoflow/backend test config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/config.ts apps/backend/src/config.test.ts
git commit -m "feat(backend): read Volcengine ASR credentials from env"
```

---

## Task 8: Wire the factory to construct the provider

**Files:**
- Modify: `apps/backend/src/providers/providerFactory.ts:10-18`
- Modify: `apps/backend/src/providers/providerFactory.test.ts`

- [ ] **Step 1: Write the failing test**

In `apps/backend/src/providers/providerFactory.test.ts`, add two cases (read the file first to match its imports/style):

```ts
it("constructs the Volcengine speech provider when configured with credentials", () => {
  const provider = createSpeechProvider({
    provider: "volcengine",
    volcengine: {
      appKey: "app",
      accessKey: "secret",
      resourceId: "volc.bigasr.sauc.duration",
      endpoint: "wss://example.test/asr",
    },
  });
  expect(provider).toBeInstanceOf(VolcengineSpeechProvider);
});

it("throws when Volcengine ASR is selected without credentials", () => {
  expect(() => createSpeechProvider({ provider: "volcengine" })).toThrow(
    /VOLCENGINE_ASR_APP_KEY/,
  );
});
```

Add the import at the top of the test file:

```ts
import { VolcengineSpeechProvider } from "./volcengineSpeechProvider.js";
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @echoflow/backend test providerFactory`
Expected: FAIL — `volcengine` currently throws "not implemented yet".

- [ ] **Step 3: Wire the factory**

In `apps/backend/src/providers/providerFactory.ts`, add the import and the construction branch. Add at the top:

```ts
import { VolcengineSpeechProvider } from "./volcengineSpeechProvider.js";
```

Replace `createSpeechProvider`:

```ts
export function createSpeechProvider(config: AsrProviderConfig): SpeechProvider {
  if (config.provider === "fake") {
    return new FakeSpeechProvider();
  }

  if (config.provider === "volcengine") {
    if (
      config.volcengine === undefined ||
      config.volcengine.appKey.trim() === "" ||
      config.volcengine.accessKey.trim() === ""
    ) {
      throw new Error(
        "VOLCENGINE_ASR_APP_KEY and VOLCENGINE_ASR_ACCESS_KEY are required when ECHOFLOW_ASR_PROVIDER=volcengine",
      );
    }

    return new VolcengineSpeechProvider(config.volcengine);
  }

  throw new Error(
    `ASR provider ${config.provider} is configured but not implemented yet; use fake or volcengine`,
  );
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `pnpm --filter @echoflow/backend test providerFactory`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/providers/providerFactory.ts apps/backend/src/providers/providerFactory.test.ts
git commit -m "feat(backend): construct Volcengine speech provider in factory"
```

---

## Task 9: Surface provider errors as an `error` ServerEvent

**Files:**
- Modify: `apps/backend/src/realtime/session.ts:100-109` (the `openStream` method)
- Modify: `apps/backend/src/realtime/session.test.ts`

- [ ] **Step 1: Write the failing test**

In `apps/backend/src/realtime/session.test.ts`, add a test using a stub speech provider that triggers `onError`. Read the file first to reuse its existing fake-socket helper (the test suite already constructs a `RealtimeSession` with a fake socket and providers). Add this case, adapting the socket/provider construction to the file's existing helpers:

```ts
it("forwards a speech-provider error as an error event", async () => {
  const sent: string[] = [];
  const socket = createFakeSocket(sent); // reuse the suite's existing helper
  const erroringSpeech: SpeechProvider = {
    open: (opts) => {
      // Surface an async provider failure right after the stream opens.
      queueMicrotask(() => opts.onError?.(new Error("connection lost")));
      return {
        pushFrame: () => {},
        end: async () => {},
        close: async () => {},
      };
    },
  };

  const session = new RealtimeSession({
    socket,
    speechProvider: erroringSpeech,
    translationProvider: createFakeTranslation(), // reuse the suite's helper
    defaultTargetLanguage: "zh-CN",
  });
  session.start();
  socket.emit("message", Buffer.from(JSON.stringify({ type: "start" })), false);

  await vi.waitFor(() => {
    expect(sent.map((raw) => JSON.parse(raw))).toContainEqual(
      expect.objectContaining({ type: "error", code: "provider_error", message: "connection lost" }),
    );
  });
});
```

If the existing test file does not expose `createFakeSocket`/`createFakeTranslation` helpers with these exact names, adapt the test to the helpers it does have (the goal: a session whose speech provider calls `onError`, asserting an `error` event with `code: "provider_error"` reaches the socket). Import `SpeechProvider` from `../providers/types.js` and `vi` from `vitest` if not already imported.

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @echoflow/backend test session`
Expected: FAIL — `openStream` does not pass `onError`, so no error event is sent.

- [ ] **Step 3: Wire onError in the session**

In `apps/backend/src/realtime/session.ts`, replace the `openStream` method:

```ts
  private openStream(): void {
    if (this.stream !== undefined) {
      return;
    }
    this.stream = this.options.speechProvider.open({
      onSegment: (event) => {
        this.enqueueSegment(event);
      },
      onError: (error) => {
        this.sendError("provider_error", error.message);
        void this.close();
      },
    });
  }
```

(`sendError` and `close` already exist on the session. `close()` is idempotent via its `closed` guard, and `sendError` sends before `close()` flips `closed`, so the error event is delivered.)

- [ ] **Step 4: Run it to confirm it passes**

Run: `pnpm --filter @echoflow/backend test session`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/realtime/session.ts apps/backend/src/realtime/session.test.ts
git commit -m "feat(backend): surface speech-provider errors as error events"
```

---

## Task 10: Document the new ASR env vars

**Files:**
- Modify: `.env.example`
- Modify: `README.md` (Provider Configuration section)
- Modify: `CLAUDE.md` (Backend request flow paragraph)

- [ ] **Step 1: Update `.env.example`**

In `.env.example`, change the ASR comment and add the ASR credential block. Replace the line `# - ASR real-time streaming adapters are not implemented yet; keep fake for local dev.` with:

```
# - ASR: fake (default) or volcengine (大模型流式语音识别 / sauc bigmodel).
```

And append, after the Volcengine translation block:

```
# Volcengine streaming ASR (大模型流式语音识别 / sauc bigmodel).
# Required when ECHOFLOW_ASR_PROVIDER=volcengine. These are DIFFERENT credentials
# from the translation VOLCENGINE_API_KEY (appid + access key, not a single key).
# ECHOFLOW_ASR_PROVIDER=volcengine
# VOLCENGINE_ASR_APP_KEY=
# VOLCENGINE_ASR_ACCESS_KEY=
# VOLCENGINE_ASR_RESOURCE_ID=volc.bigasr.sauc.duration
# VOLCENGINE_ASR_ENDPOINT=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel
```

- [ ] **Step 2: Update `README.md`**

In `README.md`, in the "ASR provider names" list, change the `fake` and reserved lines so `volcengine` is now implemented:

```
- `fake` - deterministic local provider.
- `volcengine` - 大模型流式语音识别 (sauc bigmodel) streaming ASR over WebSocket. Requires `VOLCENGINE_ASR_APP_KEY` + `VOLCENGINE_ASR_ACCESS_KEY` (appid + access key — distinct from the translation `VOLCENGINE_API_KEY`).
- `aliyun`, `tencent` - reserved provider options; selecting one fails fast until implemented.
```

And add a Volcengine ASR environment block after the translation one:

```bash
ECHOFLOW_ASR_PROVIDER=volcengine
VOLCENGINE_ASR_APP_KEY=your-appid
VOLCENGINE_ASR_ACCESS_KEY=your-access-key
VOLCENGINE_ASR_RESOURCE_ID=volc.bigasr.sauc.duration
VOLCENGINE_ASR_ENDPOINT=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel
```

- [ ] **Step 3: Update `CLAUDE.md`**

In `CLAUDE.md`, in the "Backend request flow" paragraph, replace the clause "non-`fake` ASR throws" with:

```
`fake` ASR is deterministic; `volcengine` ASR streams audio to 大模型流式语音识别 (`sauc/bigmodel`) over a WebSocket and throws without `VOLCENGINE_ASR_APP_KEY`/`VOLCENGINE_ASR_ACCESS_KEY` (distinct from the translation key); `aliyun`/`tencent` ASR still throw.
```

Also update the per-frame description: the line currently says `speechProvider.recognize`. Replace `speechProvider.recognize` with `speechProvider.open({ onSegment, onError })` and the streaming `pushFrame` model, so it reads accurately (the provider is streaming, not request-per-frame).

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md CLAUDE.md
git commit -m "docs: document Volcengine streaming ASR configuration"
```

---

## Task 11: Opt-in real ASR smoke script

**Files:**
- Create: `scripts/volcengine-asr-smoke.ts`

A standalone CLI (not a Vitest test, so it never runs in CI) that streams a 16 kHz/16-bit/mono PCM or WAV file through the real provider and prints the transcript. Lets the user validate real credentials without the browser. It reads creds from the same env vars and the audio path from `argv`.

- [ ] **Step 1: Create the script**

Create `scripts/volcengine-asr-smoke.ts`:

```ts
// Opt-in manual smoke for the real Volcengine streaming ASR adapter.
//
// Usage:
//   VOLCENGINE_ASR_APP_KEY=... VOLCENGINE_ASR_ACCESS_KEY=... \
//   pnpm --filter @echoflow/backend exec tsx ../../scripts/volcengine-asr-smoke.ts path/to/audio.pcm
//
// The audio file must be raw 16 kHz / 16-bit / mono little-endian PCM (or a WAV
// with that format — its 44-byte header is skipped). Prints partial/final
// transcript lines as they arrive.
import { readFileSync } from "node:fs";
import { VolcengineSpeechProvider } from "../apps/backend/src/providers/volcengineSpeechProvider.js";
import {
  DEFAULT_VOLCENGINE_ASR_ENDPOINT,
  DEFAULT_VOLCENGINE_ASR_RESOURCE_ID,
} from "../apps/backend/src/providers/providerConfig.js";

const audioPath = process.argv[2];
if (audioPath === undefined) {
  console.error("usage: tsx scripts/volcengine-asr-smoke.ts <audio.pcm|audio.wav>");
  process.exit(1);
}

const appKey = requireEnv("VOLCENGINE_ASR_APP_KEY");
const accessKey = requireEnv("VOLCENGINE_ASR_ACCESS_KEY");

const raw = readFileSync(audioPath);
// Skip a 44-byte WAV header if present.
const pcm = raw.subarray(0, 4).toString("ascii") === "RIFF" ? raw.subarray(44) : raw;

const provider = new VolcengineSpeechProvider({
  appKey,
  accessKey,
  resourceId: process.env.VOLCENGINE_ASR_RESOURCE_ID ?? DEFAULT_VOLCENGINE_ASR_RESOURCE_ID,
  endpoint: process.env.VOLCENGINE_ASR_ENDPOINT ?? DEFAULT_VOLCENGINE_ASR_ENDPOINT,
});

await new Promise<void>((resolve, reject) => {
  let finals = 0;
  const stream = provider.open({
    onSegment: (event) => {
      if (event.kind === "language") {
        console.log(`[language] ${event.sourceLanguage}`);
      } else if (event.kind === "partial") {
        console.log(`[partial:${event.segmentId}] ${event.text}`);
      } else {
        finals += 1;
        console.log(`[final:${event.segmentId}] ${event.text}`);
      }
    },
    onError: (error) => reject(error),
  });

  // ~100 ms frames: 16000 samples/s * 2 bytes * 0.1 s = 3200 bytes.
  const frameBytes = 3200;
  let sequence = 0;
  for (let offset = 0; offset < pcm.length; offset += frameBytes) {
    stream.pushFrame({
      data: pcm.subarray(offset, offset + frameBytes),
      sequenceNumber: sequence,
      timestampMs: sequence * 100,
    });
    sequence += 1;
  }

  void stream.end().then(() => {
    // Allow trailing finals to arrive before exiting.
    setTimeout(() => {
      console.log(`done: ${finals} final segment(s)`);
      void stream.close().then(resolve);
    }, 2000);
  });
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    console.error(`missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}
```

- [ ] **Step 2: Verify it typechecks (do not run it — it needs real credentials)**

Run: `pnpm --filter @echoflow/backend exec tsc --noEmit ../../scripts/volcengine-asr-smoke.ts 2>&1 | head -5 || true`

Because the script lives outside the backend tsconfig program, a direct `tsc` may report module-resolution noise; the authoritative check is that the workspace gates pass in Task 12. If `tsc` on the single file is noisy, rely on Task 12's full verification instead. Do NOT execute the script in CI (it opens a real network connection and needs credentials).

- [ ] **Step 3: Commit**

```bash
git add scripts/volcengine-asr-smoke.ts
git commit -m "feat(backend): add opt-in Volcengine ASR smoke script"
```

---

## Task 12: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole workspace test suite**

Run: `pnpm test`
Expected: all packages green, including the new `volcengineAsrProtocol`, `utteranceReconciler`, `volcengineSpeechProvider`, and updated `config`/`providerFactory`/`session` suites.

- [ ] **Step 2: Build, typecheck, lint**

Run: `pnpm build && pnpm typecheck && pnpm lint`
Expected: all succeed.

- [ ] **Step 3: Confirm the fake path is unaffected**

Run: `pnpm --filter @echoflow/backend test` and confirm `fakeSpeechProvider` + `server.test.ts` still pass (selecting `volcengine` is opt-in; default stays `fake`).

- [ ] **Step 4: Manual real check (record outcome; requires credentials)**

With real credentials, start the backend with the real ASR provider:

```bash
ECHOFLOW_ASR_PROVIDER=volcengine \
VOLCENGINE_ASR_APP_KEY=<appid> \
VOLCENGINE_ASR_ACCESS_KEY=<access-key> \
pnpm --filter @echoflow/backend dev
```

Then either run the smoke script against a 16 kHz mono PCM/WAV speech sample, or load the extension, play a video, and confirm real transcribed subtitles appear. Record the result. (If credentials are absent, note that the real check was skipped — CI and the rest of the plan remain hermetic.)

---

## Notes

- Provider switching is provider-level only (`model_name` is hardcoded `"bigmodel"`); no per-model env. No backend↔Volcengine auto-reconnect in this plan (a Volcengine failure surfaces as an `error` `ServerEvent` and ends the session) — both are deliberate, per the spec's "out of scope".
- The extension already sends canonical 16 kHz/16-bit/mono PCM (Plan A), which matches the `bigmodel` audio config exactly, so the adapter does no resampling.
