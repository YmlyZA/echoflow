import {
  isServerEvent,
  type AudioFormatMetadata,
  type AudioFrameMetadata,
  type ClientCapabilities,
  type ClientMessage,
  type ServerEvent
} from "@echoflow/protocol";

export interface BrowserWebSocket {
  readonly OPEN: number;
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string | Blob | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

export type BrowserWebSocketConstructor = new (url: string) => BrowserWebSocket;

export interface RealtimeClientOptions {
  url: string;
  apiKey: string;
  sessionId: string;
  tabTitle: string;
  tabUrl: string;
  targetLanguage: string;
  audioFormat: AudioFormatMetadata;
  clientCapabilities?: ClientCapabilities;
  maxConnectionAttempts?: number;
  retryDelayMs?: number;
  WebSocketCtor?: BrowserWebSocketConstructor;
  onEvent?: (event: ServerEvent) => void;
  onError?: (error: RealtimeClientError) => void;
}

export interface RealtimeClientError {
  code: string;
  message: string;
}

const DEFAULT_MAX_CONNECTION_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_CLIENT_CAPABILITIES: ClientCapabilities = {
  binaryAudioFrames: true,
  partialSubtitles: true,
  finalSubtitles: true,
  languageEvents: true,
  errorEvents: true
};

export class RealtimeClient {
  private socket: BrowserWebSocket | undefined;

  constructor(private readonly options: RealtimeClientOptions) {}

  async connect(): Promise<void> {
    const maxAttempts =
      this.options.maxConnectionAttempts ?? DEFAULT_MAX_CONNECTION_ATTEMPTS;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.openSocket();
        return;
      } catch (error) {
        if (attempt >= maxAttempts) {
          const clientError = toClientError(
            error,
            "connection_failed",
            "Realtime connection failed"
          );
          this.options.onError?.(clientError);
          throw new Error(clientError.message);
        }

        await delay(this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
      }
    }
  }

  sendAudioFrame(
    data: Blob | ArrayBuffer,
    frame: Omit<AudioFrameMetadata, "byteLength"> & { byteLength?: number }
  ): void {
    const socket = this.requireOpenSocket();
    const byteLength = frame.byteLength ?? getByteLength(data);
    const message: ClientMessage = {
      type: "audio_frame",
      sessionId: this.options.sessionId,
      frame: {
        ...frame,
        byteLength
      }
    };

    socket.send(JSON.stringify(message));
    socket.send(data);
  }

  stop(reason = "client_stop"): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      this.socket?.close();
      return;
    }

    const message: ClientMessage = {
      type: "stop",
      sessionId: this.options.sessionId,
      reason
    };

    this.socket.send(JSON.stringify(message));
    this.socket.close();
  }

  private openSocket(): Promise<void> {
    const WebSocketCtor =
      this.options.WebSocketCtor ??
      (globalThis.WebSocket as unknown as BrowserWebSocketConstructor);

    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocketCtor(
        buildAuthenticatedWebSocketUrl(this.options.url, this.options.apiKey)
      );
      this.socket = socket;

      socket.onopen = () => {
        settled = true;
        socket.send(JSON.stringify(this.createStartMessage()));
        resolve();
      };

      socket.onmessage = (event) => {
        this.handleServerMessage(event.data);
      };

      socket.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error("Realtime connection failed"));
        }
      };

      socket.onclose = () => {
        if (!settled) {
          settled = true;
          reject(new Error("Realtime connection closed before opening"));
        }
      };
    });
  }

  private createStartMessage(): ClientMessage {
    return {
      type: "start",
      sessionId: this.options.sessionId,
      tabTitle: this.options.tabTitle,
      tabUrl: this.options.tabUrl,
      targetLanguage: this.options.targetLanguage,
      audioFormat: this.options.audioFormat,
      clientCapabilities:
        this.options.clientCapabilities ?? DEFAULT_CLIENT_CAPABILITIES
    };
  }

  private handleServerMessage(data: unknown): void {
    try {
      if (typeof data !== "string") {
        throw new RealtimeProtocolError("Invalid server message");
      }

      const event = parseServerEventMessage(data);
      this.options.onEvent?.(event);
    } catch (error) {
      this.options.onError?.(
        toClientError(error, "invalid_server_message", "Invalid server message")
      );
    }
  }

  private requireOpenSocket(): BrowserWebSocket {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error("Realtime connection is not open");
    }

    return this.socket;
  }
}

export function withEpochSegmentId(
  event: ServerEvent,
  epoch: number,
): ServerEvent {
  if (event.type === "partial" || event.type === "final") {
    return { ...event, segmentId: `e${epoch}:${event.segmentId}` };
  }

  return event;
}

export function parseServerEventMessage(data: string): ServerEvent {
  let parsed: unknown;

  try {
    parsed = JSON.parse(data);
  } catch {
    throw new RealtimeProtocolError("Invalid server message");
  }

  if (!isServerEvent(parsed)) {
    throw new RealtimeProtocolError("Invalid server message");
  }

  return parsed;
}

export function buildAuthenticatedWebSocketUrl(
  url: string,
  apiKey: string
): string {
  const websocketUrl = new URL(url);
  websocketUrl.searchParams.set("apiKey", apiKey);

  return websocketUrl.toString();
}

function getByteLength(data: Blob | ArrayBuffer): number {
  return data instanceof Blob ? data.size : data.byteLength;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toClientError(
  error: unknown,
  code: string,
  fallbackMessage: string
): RealtimeClientError {
  return {
    code,
    message: error instanceof Error ? error.message : fallbackMessage
  };
}

class RealtimeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RealtimeProtocolError";
  }
}
