import {
  type ClientMessage,
  type ErrorEvent,
  type ServerEvent,
  isClientMessage,
} from "@echoflow/protocol";
import type { WebSocket } from "ws";
import type { SpeechProvider } from "../providers/fakeSpeechProvider.js";
import type { TranslationProvider } from "../providers/fakeTranslationProvider.js";

export type RealtimeSessionOptions = {
  socket: WebSocket;
  speechProvider: SpeechProvider;
  translationProvider: TranslationProvider;
  defaultTargetLanguage: string;
};

export class RealtimeSession {
  private languageEmitted = false;
  private targetLanguage: string;
  private closed = false;

  constructor(private readonly options: RealtimeSessionOptions) {
    this.targetLanguage = options.defaultTargetLanguage;
  }

  start(): void {
    this.options.socket.on("message", (data) => {
      void this.handleFrame(data).catch((error: unknown) => {
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
      this.options.speechProvider.close(),
      this.options.translationProvider.close(),
    ]);
  }

  private async handleFrame(data: WebSocket.RawData): Promise<void> {
    if (this.closed) {
      return;
    }

    if (typeof data === "string" || Buffer.isBuffer(data)) {
      const message = parseClientMessage(data);
      if (message !== undefined) {
        await this.handleClientMessage(message);
        return;
      }
    }

    await this.processAudioFrame(data);
  }

  private async handleClientMessage(message: ClientMessage): Promise<void> {
    switch (message.type) {
      case "start":
        this.targetLanguage = message.targetLanguage ?? this.targetLanguage;
        await this.processAudioFrame(message);
        return;
      case "audio_frame":
        await this.processAudioFrame(message);
        return;
      case "stop":
        await this.close();
        this.options.socket.close();
        return;
    }
  }

  private async processAudioFrame(frame: unknown): Promise<void> {
    const speech = await this.options.speechProvider.recognize(frame);

    if (!this.languageEmitted) {
      this.send({
        type: "language",
        sourceLanguage: speech.sourceLanguage,
        targetLanguage: this.targetLanguage,
      });
      this.languageEmitted = true;
    }

    const partialTranslation = await this.options.translationProvider.translate({
      text: speech.partialText,
      sourceLanguage: speech.sourceLanguage,
      targetLanguage: this.targetLanguage,
    });
    this.send({
      type: "partial",
      segmentId: speech.segmentId,
      sourceText: speech.partialText,
      translatedText: partialTranslation,
    });

    const finalTranslation = await this.options.translationProvider.translate({
      text: speech.finalText,
      sourceLanguage: speech.sourceLanguage,
      targetLanguage: this.targetLanguage,
    });
    this.send({
      type: "final",
      segmentId: speech.segmentId,
      sourceText: speech.finalText,
      translatedText: finalTranslation,
    });
  }

  private sendError(code: string, message: string): void {
    this.send({ type: "error", code, message });
  }

  private send(event: ServerEvent): void {
    if (this.closed || this.options.socket.readyState !== this.options.socket.OPEN) {
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
