import type { SubtitleMode } from "@echoflow/protocol";

export type OverlayLifecycle =
  | "connecting"
  | "live"
  | "reconnecting"
  | "degraded"
  | "error";

export interface OverlayStatusInput {
  connectionStatus: "reconnecting" | "connected" | null;
  hasError: boolean;
  /** A non-fatal, self-clearing hiccup (e.g. one line lost its translation). */
  hasDegradedError?: boolean;
  hasSignal: boolean;
  providerReconnecting: boolean;
}

/**
 * Backend `error` codes that do not mean the connection is broken: the session
 * keeps running and the next subtitle event clears them. Everything else is
 * rendered as a connection error.
 */
const DEGRADED_ERROR_CODES: ReadonlySet<string> = new Set([
  "translation_failed",
  "history_truncated"
]);

export function isDegradedErrorCode(code: string): boolean {
  return DEGRADED_ERROR_CODES.has(code);
}

export function degradedErrorLabel(code: string): string {
  switch (code) {
    case "translation_failed":
      return "翻译失败";
    case "history_truncated":
      return "历史已截断";
    default:
      return "部分异常";
  }
}

export function deriveOverlayStatus(input: OverlayStatusInput): OverlayLifecycle {
  if (input.hasError) {
    return "error";
  }
  if (input.connectionStatus === "reconnecting" || input.providerReconnecting) {
    return "reconnecting";
  }
  if (input.hasDegradedError) {
    return "degraded";
  }
  if (input.hasSignal || input.connectionStatus === "connected") {
    return "live";
  }
  return "connecting";
}

export function modeLabel(mode: SubtitleMode): string {
  return mode === "interpret" ? "实时" : "一致";
}
