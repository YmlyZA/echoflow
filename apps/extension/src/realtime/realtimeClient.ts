import {
  isServerEvent,
  type AudioFormatMetadata,
  type AudioFrameMetadata,
  type ClientCapabilities,
  type ClientMessage,
  type ServerEvent,
  type SubtitleMode
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

export type ConnectionStatus = "reconnecting" | "connected";

export interface RealtimeClientOptions {
  url: string;
  apiKey: string;
  sessionId: string;
  tabTitle: string;
  tabUrl: string;
  targetLanguage: string;
  sourceLanguage: string;
  mode: SubtitleMode;
  audioFormat: AudioFormatMetadata;
  clientCapabilities?: ClientCapabilities;
  maxConnectionAttempts?: number;
  retryDelayMs?: number;
  maxReconnectAttempts?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  WebSocketCtor?: BrowserWebSocketConstructor;
  onEvent?: (event: ServerEvent) => void;
  onError?: (error: RealtimeClientError) => void;
  onStatus?: (status: ConnectionStatus) => void;
}

export interface RealtimeClientError {
  code: string;
  message: string;
}

const DEFAULT_MAX_CONNECTION_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 500;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 8000;
const DEFAULT_CLIENT_CAPABILITIES: ClientCapabilities = {
  binaryAudioFrames: true,
  partialSubtitles: true,
  finalSubtitles: true,
  languageEvents: true,
  errorEvents: true
};

export class RealtimeClient {
  private socket: BrowserWebSocket | undefined;
  private stopped = false;
  private epoch = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: RealtimeClientOptions) {}

  async connect(): Promise<void> {
    const maxAttempts =
      this.options.maxConnectionAttempts ?? DEFAULT_MAX_CONNECTION_ATTEMPTS;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (this.stopped) {
        return;
      }

      try {
        await this.openSocket();
        return;
      } catch (error) {
        if (this.stopped) {
          // The stop closed our in-flight socket; that rejection is expected,
          // not a connection failure — exit quietly without onError.
          return;
        }

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
    const socket = this.socket;
    if (!socket || socket.readyState !== socket.OPEN) {
      return;
    }

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
    this.stopped = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const socket = this.socket;
    if (!socket || socket.readyState !== socket.OPEN) {
      socket?.close();
      return;
    }

    const message: ClientMessage = {
      type: "stop",
      sessionId: this.options.sessionId,
      reason
    };

    socket.send(JSON.stringify(message));
    socket.close();
  }

  private openSocket(): Promise<void> {
    const WebSocketCtor =
      this.options.WebSocketCtor ??
      (globalThis.WebSocket as unknown as BrowserWebSocketConstructor);

    return new Promise((resolve, reject) => {
      let opened = false;
      const socket = new WebSocketCtor(
        buildAuthenticatedWebSocketUrl(this.options.url, this.options.apiKey)
      );
      this.socket = socket;

      socket.onopen = () => {
        if (this.stopped) {
          // Opened after stop(): close it and reject so connect() exits without
          // ever sending "start" — this is what prevented the un-reclaimable
          // backend session.
          socket.close();
          reject(new Error("Realtime connection stopped before opening"));
          return;
        }

        opened = true;
        this.epoch += 1;
        // The retry budget is per stable connection: a successful open clears it
        // so a later, unrelated drop gets a fresh set of attempts. A backend that
        // accepts then immediately drops would therefore reconnect indefinitely;
        // that pathological case is out of scope for the localhost MVP.
        this.reconnectAttempts = 0;
        socket.send(JSON.stringify(this.createStartMessage()));
        if (this.epoch > 1) {
          this.options.onStatus?.("connected");
        }
        resolve();
      };

      socket.onmessage = (event) => {
        this.handleServerMessage(event.data);
      };

      socket.onerror = () => {
        if (!opened) {
          reject(new Error("Realtime connection failed"));
        }
      };

      socket.onclose = () => {
        if (!opened) {
          reject(new Error("Realtime connection closed before opening"));
          return;
        }

        this.handleUnexpectedClose();
      };
    });
  }

  private handleUnexpectedClose(): void {
    if (this.stopped) {
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }

    const maxAttempts =
      this.options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    if (this.reconnectAttempts >= maxAttempts) {
      this.options.onError?.({
        code: "connection_lost",
        message: "Realtime connection lost"
      });
      return;
    }

    const base =
      this.options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
    const cap =
      this.options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    const delayMs = Math.min(base * 2 ** this.reconnectAttempts, cap);
    this.reconnectAttempts += 1;
    this.options.onStatus?.("reconnecting");

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopped) {
        return;
      }
      this.openSocket().catch(() => {
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private createStartMessage(): ClientMessage {
    return {
      type: "start",
      mode: this.options.mode,
      sessionId: this.options.sessionId,
      tabTitle: this.options.tabTitle,
      tabUrl: this.options.tabUrl,
      targetLanguage: this.options.targetLanguage,
      sourceLanguage: this.options.sourceLanguage,
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
      this.options.onEvent?.(withEpochSegmentId(event, this.epoch));
    } catch (error) {
      this.options.onError?.(
        toClientError(error, "invalid_server_message", "Invalid server message")
      );
    }
  }
}

export function withEpochSegmentId(
  event: ServerEvent,
  epoch: number
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
