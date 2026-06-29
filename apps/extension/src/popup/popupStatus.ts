import type { SubtitleMode } from "@echoflow/protocol";
import type { SessionState } from "../session/sessionState";
import { modeLabel } from "../overlay/overlayStatus";

export type PopupTone = "idle" | "connecting" | "live" | "error";

export interface PopupPill {
  tone: PopupTone;
  label: string;
}

export function popupPill(
  status: SessionState["status"],
  mode: SubtitleMode
): PopupPill {
  switch (status) {
    case "running":
      return { tone: "live", label: `${modeLabel(mode)} · LIVE` };
    case "connecting":
      return { tone: "connecting", label: "连接中…" };
    case "stopping":
      return { tone: "connecting", label: "停止中…" };
    case "error":
      return { tone: "error", label: "连接错误" };
    case "idle":
      return { tone: "idle", label: "Idle" };
  }
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${pad(minutes)}:${pad(seconds)}`;
}
