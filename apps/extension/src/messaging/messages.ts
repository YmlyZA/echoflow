import type { ServerEvent, SubtitleMode } from "@echoflow/protocol";
import type { ExtensionSettings } from "../settings/settings";
import type { TimelineEntry } from "../subtitles/subtitleTimeline";

export type RuntimeMessage =
  | StartSessionMessage
  | StartFromPopupMessage
  | StopSessionMessage
  | SessionStartedMessage
  | SessionStoppedMessage
  | SessionErrorMessage
  | ServerEventMessage
  | OffscreenReadyMessage
  | ConnectionStatusMessage
  | VideoTimeSampleMessage
  | CachedTranscriptMessage;

export interface StartSessionMessage {
  type: "START_SESSION";
  localSessionId: string;
  tabId: number;
  streamId: string;
  settings: ExtensionSettings;
}

export interface StartFromPopupMessage {
  type: "START_FROM_POPUP";
  tabId: number;
  streamId: string;
  settings: ExtensionSettings;
}

export interface StopSessionMessage {
  type: "STOP_SESSION";
  localSessionId?: string;
  reason?: string;
}

export interface SessionStartedMessage {
  type: "SESSION_STARTED";
  localSessionId: string;
  remoteSessionId?: string;
  captureStartedAtMs?: number;
}

export interface SessionStoppedMessage {
  type: "SESSION_STOPPED";
  localSessionId: string;
}

export interface SessionErrorMessage {
  type: "SESSION_ERROR";
  localSessionId?: string;
  code: string;
  message: string;
}

export interface ServerEventMessage {
  type: "SERVER_EVENT";
  localSessionId: string;
  mode: SubtitleMode;
  event: ServerEvent;
  videoStartSec?: number;
  videoEndSec?: number;
}

export interface OffscreenReadyMessage {
  type: "OFFSCREEN_READY";
}

export interface ConnectionStatusMessage {
  type: "CONNECTION_STATUS";
  localSessionId: string;
  status: "reconnecting" | "connected";
}

export interface VideoTimeSampleMessage {
  type: "VIDEO_TIME_SAMPLE";
  wallClockMs: number;
  videoSec: number;
}

export interface CachedTranscriptMessage {
  type: "CACHED_TRANSCRIPT";
  localSessionId: string;
  entries: TimelineEntry[];
}

export function isRuntimeMessage(message: unknown): message is RuntimeMessage {
  if (!isRecord(message) || typeof message.type !== "string") {
    return false;
  }

  return [
    "START_SESSION",
    "START_FROM_POPUP",
    "STOP_SESSION",
    "SESSION_STARTED",
    "SESSION_STOPPED",
    "SESSION_ERROR",
    "SERVER_EVENT",
    "OFFSCREEN_READY",
    "CONNECTION_STATUS",
    "VIDEO_TIME_SAMPLE",
    "CACHED_TRANSCRIPT"
  ].includes(message.type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isInternalSender(
  sender: { id?: string },
  runtimeId: string
): boolean {
  return sender.id === runtimeId;
}
