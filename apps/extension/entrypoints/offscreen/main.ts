import {
  isRuntimeMessage,
  type SessionStartedMessage
} from "../../src/messaging/messages";

chrome.runtime.sendMessage({ type: "OFFSCREEN_READY" });

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isRuntimeMessage(message)) {
    return;
  }

  if (message.type === "START_SESSION") {
    void chrome.runtime.sendMessage({
      type: "SESSION_STARTED",
      localSessionId: message.localSessionId
    } satisfies SessionStartedMessage);
    return;
  }

  if (message.type === "STOP_SESSION") {
    return;
  }
});
