import {
  type ClientMessage,
  type ServerEvent,
  isClientMessage,
} from "@echoflow/protocol";
import type { WebSocket } from "ws";
import {
  ModeLanguageUnsupportedError,
  ModeUnavailableError,
  type SubtitleSourceFactory,
  type SubtitleSourceStream,
} from "./subtitleSource.js";

export type RealtimeSessionOptions = {
  socket: WebSocket;
  createSubtitleSource: SubtitleSourceFactory;
  defaultTargetLanguage: string;
};

// Opt-in session tracing (ECHOFLOW_LATENCY_DEBUG=1). Prints connection
// lifecycle + every outbound ServerEvent with a wall-clock stamp, so an
// interpret/pipeline session can be watched live without a debugger.
const SESSION_DEBUG = process.env.ECHOFLOW_LATENCY_DEBUG === "1";

function dlog(message: string): void {
  if (SESSION_DEBUG) {
    console.error(`[session ${new Date().toISOString().slice(11, 23)}] ${message}`);
  }
}

function summarizeEvent(event: ServerEvent): string {
  switch (event.type) {
    case "language":
      return `language  ${event.sourceLanguage} -> ${event.targetLanguage}`;
    case "partial":
      return `partial   [${event.segmentId}] "${event.sourceText}"`;
    case "final":
      return `final     [${event.segmentId}] "${event.sourceText}" -> "${event.translatedText}" [${event.startTimeMs}..${event.endTimeMs}ms]`;
    case "error":
      return `error     ${event.code}: ${event.message}`;
    default:
      return JSON.stringify(event);
  }
}

export class RealtimeSession {
  private targetLanguage: string;
  private sourceLanguage = "";
  private closed = false;
  private stream: SubtitleSourceStream | undefined;
  private pendingFrameMeta:
    | { sequenceNumber: number; timestampMs: number }
    | undefined;

  constructor(private readonly options: RealtimeSessionOptions) {
    this.targetLanguage = options.defaultTargetLanguage;
  }

  start(): void {
    dlog("connection opened");
    this.options.socket.on("message", (data, isBinary) => {
      void this.handleFrame(data, isBinary).catch((error: unknown) => {
        this.sendError(getErrorCode(error), getErrorMessage(error));
      });
    });
    this.options.socket.on("close", () => {
      void this.close();
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    dlog("connection closed");
    await this.stream?.close();
  }

  private async handleFrame(
    data: WebSocket.RawData,
    isBinary: boolean,
  ): Promise<void> {
    if (this.closed) {
      return;
    }
    if (!isBinary && (typeof data === "string" || Buffer.isBuffer(data))) {
      const message = parseClientMessage(data);
      if (message !== undefined) {
        await this.handleClientMessage(message);
        return;
      }
    }
    this.pushAudio(data);
  }

  private async handleClientMessage(message: ClientMessage): Promise<void> {
    switch (message.type) {
      case "start":
        this.targetLanguage = message.targetLanguage ?? this.targetLanguage;
        this.sourceLanguage = message.sourceLanguage ?? this.sourceLanguage;
        this.openSource(message.mode ?? "pipeline");
        return;
      case "audio_frame":
        this.pendingFrameMeta = {
          sequenceNumber: message.frame.sequenceNumber,
          timestampMs: message.frame.timestampMs,
        };
        return;
      case "stop":
        if (this.stream !== undefined) {
          await this.stream.end();
        }
        await this.close();
        this.options.socket.close();
        return;
    }
  }

  private openSource(mode: "pipeline" | "interpret"): void {
    if (this.stream !== undefined) {
      return;
    }
    dlog(`open      mode=${mode} target=${this.targetLanguage}`);
    let source;
    try {
      source = this.options.createSubtitleSource(mode, this.sourceLanguage, this.targetLanguage);
    } catch (error: unknown) {
      if (error instanceof ModeUnavailableError) {
        this.sendError("mode_unavailable", error.message);
        return;
      }
      if (error instanceof ModeLanguageUnsupportedError) {
        this.sendError("mode_language_unsupported", error.message);
        return;
      }
      this.sendError("provider_error", getErrorMessage(error));
      return;
    }
    this.stream = source.open({
      onEvent: (event) => {
        this.send(event);
      },
      onError: (error) => {
        this.sendError("provider_error", error.message);
        // A mid-session provider-stream failure is terminal: tear down and close
        // the client socket so it stops streaming audio into a dead session.
        // (Factory-open errors above intentionally leave the socket open.)
        void this.close().then(() => {
          this.options.socket.close();
        });
      },
    });
  }

  private pushAudio(data: WebSocket.RawData): void {
    if (this.stream === undefined) {
      return;
    }
    const meta = this.pendingFrameMeta ?? { sequenceNumber: 0, timestampMs: 0 };
    this.pendingFrameMeta = undefined;
    this.stream.pushFrame({
      // ws delivers binary messages as a single Buffer (no binaryType override).
      data: data as Buffer,
      sequenceNumber: meta.sequenceNumber,
      timestampMs: meta.timestampMs,
    });
  }

  private sendError(code: string, message: string): void {
    this.send({ type: "error", code, message });
  }

  private send(event: ServerEvent): void {
    if (
      this.closed ||
      this.options.socket.readyState !== this.options.socket.OPEN
    ) {
      return;
    }
    dlog(summarizeEvent(event));
    this.options.socket.send(JSON.stringify(event));
  }
}

function parseClientMessage(data: string | Buffer): ClientMessage | undefined {
  const text = data.toString();
  if (!looksLikeJson(text)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProtocolMessageError("Malformed client message");
  }
  if (!isClientMessage(parsed)) {
    throw new ProtocolMessageError("Malformed client message");
  }
  return parsed;
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function getErrorMessage(error: unknown): string {
  if (error instanceof ProtocolMessageError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Realtime session failed";
}

function getErrorCode(error: unknown): string {
  if (error instanceof ProtocolMessageError) {
    return "invalid_client_message";
  }
  return "provider_error";
}

class ProtocolMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolMessageError";
  }
}
