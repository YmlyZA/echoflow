import type { SubtitleMode } from "@echoflow/protocol";

export type OverlayLifecycle = "connecting" | "live" | "reconnecting" | "error";

export interface OverlayStatusInput {
  connectionStatus: "reconnecting" | "connected" | null;
  hasError: boolean;
  hasSignal: boolean;
  providerReconnecting: boolean;
}

export function deriveOverlayStatus(input: OverlayStatusInput): OverlayLifecycle {
  if (input.hasError) {
    return "error";
  }
  if (input.connectionStatus === "reconnecting" || input.providerReconnecting) {
    return "reconnecting";
  }
  if (input.hasSignal || input.connectionStatus === "connected") {
    return "live";
  }
  return "connecting";
}

export function modeLabel(mode: SubtitleMode): string {
  return mode === "interpret" ? "实时" : "一致";
}
