import type { SubtitleMode } from "@echoflow/protocol";
import { assignSpeakerNumbers, speakerColor } from "../src/subtitles/speakerDisplay";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useReducer, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  isInternalSender,
  isRuntimeMessage,
  type StopSessionMessage,
  type VideoTimeSampleMessage
} from "../src/messaging/messages";
import { SubtitleOverlay } from "../src/overlay/SubtitleOverlay";
import { deriveOverlayStatus } from "../src/overlay/overlayStatus";
import { DEFAULT_SUBTITLE_FONT_SIZE } from "../src/settings/settings";
import { isStopForCurrentSession } from "../src/subtitles/overlaySession";
import {
  createInitialSubtitleState,
  reduceSubtitleEvent,
  type TransientSubtitleError
} from "../src/subtitles/reducer";

function EchoFlowMount({ onSessionEnded }: { onSessionEnded: () => void }) {
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
  const [sessionError, setSessionError] = useState<TransientSubtitleError | null>(
    null
  );
  const currentSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    function handleRuntimeMessage(
      message: unknown,
      sender: chrome.runtime.MessageSender
    ) {
      if (!isInternalSender(sender, chrome.runtime.id)) {
        return;
      }
      if (!isRuntimeMessage(message)) {
        return;
      }

      if (message.type === "SERVER_EVENT") {
        currentSessionIdRef.current = message.localSessionId;
        setHasSignal(true);
        setMode(message.mode);
        setSessionError(null);
        dispatchSubtitleEvent(message.event);
        return;
      }

      if (message.type === "CONNECTION_STATUS") {
        currentSessionIdRef.current = message.localSessionId;
        setConnectionStatus(message.status);
        return;
      }

      if (message.type === "SESSION_ERROR") {
        if (message.localSessionId !== undefined) {
          currentSessionIdRef.current = message.localSessionId;
        }
        setConnectionStatus(null);
        setSessionError({ code: message.code, message: message.message });
        return;
      }

      if (message.type === "SESSION_STOPPED") {
        if (isStopForCurrentSession(currentSessionIdRef.current, message.localSessionId)) {
          onSessionEnded();
        }
      }
    }

    chrome.runtime.onMessage.addListener(handleRuntimeMessage);

    return () => {
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
    };
  }, []);

  useEffect(() => {
    const THROTTLE_MS = 250;
    let lastSentAt = 0;

    function sample(force: boolean): void {
      const video = document.querySelector("video");
      if (video === null || Number.isNaN(video.currentTime)) {
        return;
      }
      const wallClockMs = Date.now();
      if (!force && wallClockMs - lastSentAt < THROTTLE_MS) {
        return;
      }
      lastSentAt = wallClockMs;
      void chrome.runtime.sendMessage({
        type: "VIDEO_TIME_SAMPLE",
        wallClockMs,
        videoSec: video.currentTime,
      } satisfies VideoTimeSampleMessage);
    }

    const onTimeUpdate = (): void => sample(false);
    const onDiscontinuity = (): void => sample(true);

    // Listen at the document level (capture) so a <video> inserted after mount is
    // still covered without re-binding.
    document.addEventListener("timeupdate", onTimeUpdate, true);
    document.addEventListener("seeked", onDiscontinuity, true);
    document.addEventListener("play", onDiscontinuity, true);
    document.addEventListener("pause", onDiscontinuity, true);

    return () => {
      document.removeEventListener("timeupdate", onTimeUpdate, true);
      document.removeEventListener("seeked", onDiscontinuity, true);
      document.removeEventListener("play", onDiscontinuity, true);
      document.removeEventListener("pause", onDiscontinuity, true);
    };
  }, []);

  function handleStop() {
    void chrome.runtime.sendMessage({
      type: "STOP_SESSION",
      localSessionId: currentSessionIdRef.current ?? undefined,
      reason: "overlay_stop"
    } satisfies StopSessionMessage);
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
    hasError: subtitleState.transientError !== null || sessionError !== null,
    hasSignal,
    providerReconnecting: subtitleState.providerConnection === "reconnecting"
  });

  let speaker: { number: number; color: string } | null = null;
  if (subtitleState.seenSpeakerIds.length >= 2 && subtitleState.currentSegment?.speakerId) {
    const number = assignSpeakerNumbers(subtitleState.seenSpeakerIds).get(
      subtitleState.currentSegment.speakerId
    );
    if (number) {
      speaker = { number, color: speakerColor(number) };
    }
  }

  return (
    <SubtitleOverlay
      segment={subtitleState.currentSegment}
      transientError={subtitleState.transientError ?? sessionError}
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
      speaker={speaker}
    />
  );
}

type EchoFlowWindow = Window & { __echoflowRoot?: Root };

export default defineContentScript({
  registration: "runtime",
  main() {
    const echoWindow = window as EchoFlowWindow;
    echoWindow.__echoflowRoot?.unmount();
    document.getElementById("echoflow-root")?.remove();

    const host = document.createElement("div");
    host.id = "echoflow-root";
    const shadowRoot = host.attachShadow({ mode: "open" });
    document.documentElement.append(host);

    const root = createRoot(shadowRoot);
    echoWindow.__echoflowRoot = root;

    function teardown() {
      root.unmount();
      host.remove();
      if (echoWindow.__echoflowRoot === root) {
        echoWindow.__echoflowRoot = undefined;
      }
    }

    root.render(<EchoFlowMount onSessionEnded={teardown} />);
  }
});
