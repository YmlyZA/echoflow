import type { ServerEvent } from "@echoflow/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RealtimeClient,
  parseServerEventMessage,
  withEpochSegmentId,
  type BrowserWebSocket
} from "./realtimeClient";

describe("RealtimeClient", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  it("sends session start metadata after the websocket opens", async () => {
    const client = createClient({ sourceLanguage: "en" });
    const connected = client.connect();

    FakeWebSocket.instances[0].open();
    await connected;

    expect(JSON.parse(FakeWebSocket.instances[0].sentText[0])).toEqual({
      type: "start",
      sessionId: "local-1",
      tabTitle: "Example",
      tabUrl: "https://example.com/watch",
      targetLanguage: "zh-CN",
      sourceLanguage: "en",
      mode: "pipeline",
      audioFormat: {
        mimeType: "audio/webm",
        sampleRateHz: 48000,
        channelCount: 2
      },
      clientCapabilities: {
        binaryAudioFrames: true,
        partialSubtitles: true,
        finalSubtitles: true,
        languageEvents: true,
        errorEvents: true
      }
    });
  });

  it("carries a non-default mode in the start message", async () => {
    const client = createClient({ mode: "interpret" });
    const connected = client.connect();

    FakeWebSocket.instances[0].open();
    await connected;

    expect(JSON.parse(FakeWebSocket.instances[0].sentText[0])).toMatchObject({
      type: "start",
      mode: "interpret"
    });
  });

  it("opens the websocket with an api key query parameter for browser-compatible auth", async () => {
    const client = createClient();
    const connected = client.connect();

    FakeWebSocket.instances[0].open();
    await connected;

    expect(FakeWebSocket.instances[0].url).toBe(
      "wss://api.example.com/v1/realtime?apiKey=secret-key"
    );
  });

  it("does not duplicate the api key in the start message body", async () => {
    const client = createClient();
    const connected = client.connect();

    FakeWebSocket.instances[0].open();
    await connected;

    expect(JSON.parse(FakeWebSocket.instances[0].sentText[0])).not.toHaveProperty(
      "apiKey"
    );
  });

  it("sends audio frame metadata and bytes", async () => {
    const client = createConnectedClient();
    const frame = new Blob(["audio"], { type: "audio/webm" });

    client.sendAudioFrame(frame, {
      sequenceNumber: 7,
      timestampMs: 1200,
      durationMs: 250
    });

    expect(JSON.parse(FakeWebSocket.instances[0].sentText[1])).toEqual({
      type: "audio_frame",
      sessionId: "local-1",
      frame: {
        sequenceNumber: 7,
        timestampMs: 1200,
        durationMs: 250,
        byteLength: frame.size
      }
    });
    expect(FakeWebSocket.instances[0].sentBinary[0]).toBe(frame);
  });

  it("parses server events", () => {
    const event = parseServerEventMessage(
      JSON.stringify({
        type: "partial",
        segmentId: "seg-1",
        sourceText: "hello",
        translatedText: "ni hao"
      })
    );

    expect(event).toEqual({
      type: "partial",
      segmentId: "seg-1",
      sourceText: "hello",
      translatedText: "ni hao"
    });
  });

  it("emits an error on invalid server messages", () => {
    const onError = vi.fn();
    createConnectedClient({ onError });

    FakeWebSocket.instances[0].message(JSON.stringify({ type: "unknown" }));

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "invalid_server_message",
        message: "Invalid server message"
      })
    );
  });

  it("retries limited connection failures", async () => {
    const client = createClient({ maxConnectionAttempts: 3, retryDelayMs: 0 });
    const connected = client.connect();

    FakeWebSocket.instances[0].error();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    FakeWebSocket.instances[1].error();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3));
    FakeWebSocket.instances[2].open();
    await connected;

    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(JSON.parse(FakeWebSocket.instances[2].sentText[0])).toMatchObject({
      type: "start",
      sessionId: "local-1"
    });
  });
});

function createConnectedClient(
  overrides: Partial<ConstructorParameters<typeof RealtimeClient>[0]> = {}
): RealtimeClient {
  const client = createClient(overrides);
  const connected = client.connect();
  FakeWebSocket.instances[0].open();
  void connected;
  return client;
}

function createClient(
  overrides: Partial<ConstructorParameters<typeof RealtimeClient>[0]> = {}
): RealtimeClient {
  return new RealtimeClient({
    url: "wss://api.example.com/v1/realtime",
    apiKey: "secret-key",
    sessionId: "local-1",
    tabTitle: "Example",
    tabUrl: "https://example.com/watch",
    targetLanguage: "zh-CN",
    mode: "pipeline",
    audioFormat: {
      mimeType: "audio/webm",
      sampleRateHz: 48000,
      channelCount: 2
    },
    WebSocketCtor: FakeWebSocket,
    ...overrides
  });
}

class FakeWebSocket implements BrowserWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly OPEN = 1;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sentText: string[] = [];
  sentBinary: Blob[] = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string | Blob): void {
    if (typeof data === "string") {
      this.sentText.push(data);
    } else {
      this.sentBinary.push(data);
    }
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = this.OPEN;
    this.onopen?.(new Event("open"));
  }

  message(event: ServerEvent | string): void {
    const data = typeof event === "string" ? event : JSON.stringify(event);
    this.onmessage?.({ data } as MessageEvent);
  }

  error(): void {
    this.onerror?.(new Event("error"));
  }

  remoteClose(): void {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
}

describe("RealtimeClient reconnect", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  it("does not signal connected on the initial connection", async () => {
    const onStatus = vi.fn();
    const client = createClient({ onStatus });
    const connected = client.connect();
    FakeWebSocket.instances[0].open();
    await connected;

    expect(onStatus).not.toHaveBeenCalled();
  });

  it("reconnects with backoff and re-sends the handshake after an unexpected close", async () => {
    vi.useFakeTimers();
    try {
      const onStatus = vi.fn();
      const client = createClient({ onStatus, reconnectBaseDelayMs: 500 });
      const connected = client.connect();
      FakeWebSocket.instances[0].open();
      await connected;

      FakeWebSocket.instances[0].remoteClose();
      expect(onStatus).toHaveBeenCalledWith("reconnecting");
      expect(FakeWebSocket.instances).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(500);
      expect(FakeWebSocket.instances).toHaveLength(2);

      FakeWebSocket.instances[1].open();
      expect(onStatus).toHaveBeenCalledWith("connected");
      expect(JSON.parse(FakeWebSocket.instances[1].sentText[0])).toMatchObject({
        type: "start",
        sessionId: "local-1",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after maxReconnectAttempts and reports connection_lost", async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const onStatus = vi.fn();
      const client = createClient({
        onError,
        onStatus,
        maxReconnectAttempts: 2,
        reconnectBaseDelayMs: 100,
        reconnectMaxDelayMs: 1000,
      });
      const connected = client.connect();
      FakeWebSocket.instances[0].open();
      await connected;

      FakeWebSocket.instances[0].remoteClose();
      await vi.advanceTimersByTimeAsync(100);
      expect(onError).not.toHaveBeenCalled();
      FakeWebSocket.instances[1].error();
      await vi.advanceTimersByTimeAsync(200);
      FakeWebSocket.instances[2].error();
      await vi.advanceTimersByTimeAsync(0);

      expect(onStatus).toHaveBeenCalledWith("reconnecting");
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "connection_lost" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reconnect after an intentional stop", async () => {
    const client = createConnectedClient();

    client.stop();
    FakeWebSocket.instances[0].remoteClose();

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("drops audio frames while disconnected instead of throwing", () => {
    const client = createClient();

    expect(() =>
      client.sendAudioFrame(new Blob(["x"], { type: "audio/webm" }), {
        sequenceNumber: 0,
        timestampMs: 0,
      }),
    ).not.toThrow();
  });
});

describe("withEpochSegmentId", () => {
  it("prefixes partial and final segment ids with the epoch", () => {
    expect(
      withEpochSegmentId(
        { type: "partial", segmentId: "seg-1", sourceText: "a" },
        2,
      ),
    ).toEqual({ type: "partial", segmentId: "e2:seg-1", sourceText: "a" });

    expect(
      withEpochSegmentId(
        {
          type: "final",
          segmentId: "seg-1",
          sourceText: "a",
          translatedText: "b",
          startTimeMs: 0,
          endTimeMs: 1,
        },
        1,
      ),
    ).toEqual({
      type: "final",
      segmentId: "e1:seg-1",
      sourceText: "a",
      translatedText: "b",
      startTimeMs: 0,
      endTimeMs: 1,
    });
  });

  it("passes language and error events through unchanged", () => {
    const language = {
      type: "language",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    } as const;
    expect(withEpochSegmentId(language, 3)).toBe(language);
  });
});
