import type { ServerEvent, SubtitleMode } from "@echoflow/protocol";
import type { AudioFrame } from "../providers/types.js";

export type { SubtitleMode };

export interface SubtitleSourceStream {
  pushFrame(frame: AudioFrame): void;
  end(): Promise<void>;
  close(): Promise<void>;
}

export interface SubtitleSource {
  open(opts: {
    onEvent: (event: ServerEvent) => void;
    onError?: (error: Error) => void;
  }): SubtitleSourceStream;
}

export type SubtitleSourceFactory = (
  mode: SubtitleMode,
  targetLanguage: string,
) => SubtitleSource;

export class ModeUnavailableError extends Error {
  constructor(public readonly mode: string) {
    super(`Subtitle mode "${mode}" is not available`);
    this.name = "ModeUnavailableError";
  }
}
