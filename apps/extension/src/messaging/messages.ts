import type { ServerEvent } from "@echoflow/protocol";
import type { ExtensionSettings } from "../settings/settings";

export type RuntimeMessage =
  | StartSessionMessage
  | StopSessionMessage
  | SessionStartedMessage
  | SessionErrorMessage
  | ServerEventMessage
  | OffscreenReadyMessage;

export interface StartSessionMessage {
  type: "START_SESSION";
  localSessionId: string;
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
  event: ServerEvent;
}

export interface OffscreenReadyMessage {
  type: "OFFSCREEN_READY";
}

export function isRuntimeMessage(message: unknown): message is RuntimeMessage {
  if (!isRecord(message) || typeof message.type !== "string") {
    return false;
  }

  return [
    "START_SESSION",
    "STOP_SESSION",
    "SESSION_STARTED",
    "SESSION_ERROR",
    "SERVER_EVENT",
    "OFFSCREEN_READY"
  ].includes(message.type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
