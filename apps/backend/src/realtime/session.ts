import {
  type ClientMessage,
  type ServerEvent,
  isClientMessage,
} from "@echoflow/protocol";
import type { WebSocket } from "ws";
import type {
  SegmentEvent,
  SpeechProvider,
  SpeechRecognitionStream,
  TranslationProvider,
} from "../providers/types.js";

export type RealtimeSessionOptions = {
  socket: WebSocket;
  speechProvider: SpeechProvider;
  translationProvider: TranslationProvider;
  defaultTargetLanguage: string;
};

export class RealtimeSession {
  private targetLanguage: string;
  private sourceLanguage = "unknown";
  private closed = false;
  private stream: SpeechRecognitionStream | undefined;
  private pendingFrameMeta:
    | { sequenceNumber: number; timestampMs: number }
    | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: RealtimeSessionOptions) {
    this.targetLanguage = options.defaultTargetLanguage;
  }

  start(): void {
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
    await Promise.all([
      this.stream?.close(),
      this.options.translationProvider.close(),
    ]);
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
        this.openStream();
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
        await this.tail;
        await this.close();
        this.options.socket.close();
        return;
    }
  }

  private openStream(): void {
    if (this.stream !== undefined) {
      return;
    }
    this.stream = this.options.speechProvider.open({
      onSegment: (event) => {
        this.enqueueSegment(event);
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
      // ws delivers binary messages as Buffer (no binaryType override is set), so the
      // RawData here is always a single Buffer, never ArrayBuffer or a Buffer[] fragment.
      data: data as Buffer,
      sequenceNumber: meta.sequenceNumber,
      timestampMs: meta.timestampMs,
    });
  }

  private enqueueSegment(event: SegmentEvent): void {
    this.tail = this.tail
      .then(() => this.dispatchSegment(event))
      .catch((error: unknown) => {
        this.sendError(getErrorCode(error), getErrorMessage(error));
      });
  }

  private async dispatchSegment(event: SegmentEvent): Promise<void> {
    switch (event.kind) {
      case "language":
        this.sourceLanguage = event.sourceLanguage;
        this.send({
          type: "language",
          sourceLanguage: event.sourceLanguage,
          targetLanguage: this.targetLanguage,
        });
        return;
      case "partial":
        this.send({
          type: "partial",
          segmentId: event.segmentId,
          sourceText: event.text,
        });
        return;
      case "final": {
        const translatedText = await this.options.translationProvider.translate({
          text: event.text,
          sourceLanguage: this.sourceLanguage,
          targetLanguage: this.targetLanguage,
        });
        this.send({
          type: "final",
          segmentId: event.segmentId,
          sourceText: event.text,
          translatedText,
          startTimeMs: event.startTimeMs,
          endTimeMs: event.endTimeMs,
        });
        return;
      }
    }
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
  return "Realtime provider failed";
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
