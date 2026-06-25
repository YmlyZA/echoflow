import { isServerEvent } from "@echoflow/protocol";
import type { SubtitleMode } from "@echoflow/protocol";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useReducer, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  isRuntimeMessage,
  type StopSessionMessage
} from "../src/messaging/messages";
import { SubtitleOverlay } from "../src/overlay/SubtitleOverlay";
import { deriveOverlayStatus } from "../src/overlay/overlayStatus";
import { DEFAULT_SUBTITLE_FONT_SIZE } from "../src/settings/settings";
import {
  createInitialSubtitleState,
  reduceSubtitleEvent
} from "../src/subtitles/reducer";

function EchoFlowMount() {
  const [subtitleState, dispatchSubtitleEvent] = useReducer(
    reduceSubtitleEvent,
    createInitialSubtitleState()
  );
  const [hidden, setHidden] = useState(false);
  const [fontSize, setFontSize] = useState(DEFAULT_SUBTITLE_FONT_SIZE);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null
  );
  const [connectionStatus, setConnectionStatus] = useState<
    "reconnecting" | "connected" | null
  >(null);
  const [hasSignal, setHasSignal] = useState(false);
  const [mode, setMode] = useState<SubtitleMode>("pipeline");

  useEffect(() => {
    function handleServerEvent(event: Event) {
      const detail = (event as CustomEvent<unknown>).detail;

      if (isServerEvent(detail)) {
        dispatchSubtitleEvent(detail);
      }
    }

    window.addEventListener("echoflow:server-event", handleServerEvent);

    return () => {
      window.removeEventListener("echoflow:server-event", handleServerEvent);
    };
  }, []);

  useEffect(() => {
    function handleRuntimeMessage(message: unknown) {
      if (!isRuntimeMessage(message)) {
        return;
      }

      if (message.type === "SERVER_EVENT") {
        setHasSignal(true);
        setMode(message.mode);
        window.dispatchEvent(
          new CustomEvent("echoflow:server-event", {
            detail: message.event
          })
        );
        return;
      }

      if (message.type === "CONNECTION_STATUS") {
        setConnectionStatus(message.status);
        return;
      }

      if (message.type === "SESSION_ERROR") {
        setConnectionStatus(null);
      }
    }

    function handleStopSubtitles() {
      void chrome.runtime.sendMessage({
        type: "STOP_SESSION",
        reason: "overlay_stop"
      } satisfies StopSessionMessage);
    }

    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
    window.addEventListener("echoflow:stop-subtitles", handleStopSubtitles);

    return () => {
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
      window.removeEventListener("echoflow:stop-subtitles", handleStopSubtitles);
    };
  }, []);

  function handleStop() {
    window.dispatchEvent(new CustomEvent("echoflow:stop-subtitles"));
  }

  function handleDecreaseFontSize() {
    setFontSize((currentFontSize) => Math.max(12, currentFontSize - 2));
  }

  function handleIncreaseFontSize() {
    setFontSize((currentFontSize) => Math.min(48, currentFontSize + 2));
  }

  function handleDragStart(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();

    const startClientX = event.clientX;
    const startClientY = event.clientY;
    const startPosition = position ?? {
      x: window.innerWidth / 2,
      y: 32
    };

    function handlePointerMove(pointerEvent: PointerEvent) {
      setPosition({
        x: startPosition.x + pointerEvent.clientX - startClientX,
        y: Math.max(
          8,
          startPosition.y + startClientY - pointerEvent.clientY
        )
      });
    }

    function handlePointerUp() {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  const lifecycle = deriveOverlayStatus({
    connectionStatus,
    hasError: subtitleState.transientError !== null,
    hasSignal
  });

  return (
    <SubtitleOverlay
      segment={subtitleState.currentSegment}
      transientError={subtitleState.transientError}
      lifecycle={lifecycle}
      mode={mode}
      fontSize={fontSize}
      hidden={hidden}
      position={position ?? undefined}
      onStop={handleStop}
      onHide={() => setHidden(true)}
      onShow={() => setHidden(false)}
      onDecreaseFontSize={handleDecreaseFontSize}
      onIncreaseFontSize={handleIncreaseFontSize}
      onDragStart={handleDragStart}
    />
  );
}

export default defineContentScript({
  registration: "runtime",
  main() {
    document.getElementById("echoflow-root")?.remove();

    const host = document.createElement("div");
    host.id = "echoflow-root";
    const shadowRoot = host.attachShadow({ mode: "open" });
    document.documentElement.append(host);

    createRoot(shadowRoot).render(<EchoFlowMount />);
  }
});
