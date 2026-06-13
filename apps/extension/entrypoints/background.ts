import { finalEventToSegment } from "../src/history/segmentMapping";
import {
  isRuntimeMessage,
  type RuntimeMessage,
  type SessionErrorMessage,
  type SessionStartedMessage,
  type ServerEventMessage,
  type StartSessionMessage,
  type StopSessionMessage
} from "../src/messaging/messages";
import { createHistoryStore } from "../src/history/historyStore";
import { loadSettings, validateSettings } from "../src/settings/settings";
import {
  createInitialSessionState,
  reduceSessionState
} from "../src/session/sessionState";

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const CONTENT_SCRIPT_PATH = "content-scripts/content.js";

const historyStore = createHistoryStore();
let sessionState = createInitialSessionState();
let detectedSourceLanguage = "unknown";

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.action.setTitle({ title: "EchoFlow" });
  });

  chrome.action.onClicked.addListener((tab) => {
    void handleActionClick(tab);
  });

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!isRuntimeMessage(message)) {
      return;
    }

    void handleRuntimeMessage(message);
  });
});

async function handleActionClick(tab: chrome.tabs.Tab): Promise<void> {
  if (sessionState.status === "connecting" || sessionState.status === "running") {
    await stopSession("action_click");
    return;
  }

  if (sessionState.status === "stopping") {
    return;
  }

  await startSession(tab);
}

async function startSession(tab: chrome.tabs.Tab): Promise<void> {
  if (typeof tab.id !== "number") {
    return;
  }

  const settings = await loadSettings();
  const validation = validateSettings(settings);

  if (!validation.valid) {
    await chrome.runtime.openOptionsPage();
    return;
  }

  let localSessionId: string | undefined;

  try {
    await injectRuntimeContentScript(tab.id);

    const localSession = await historyStore.createLocalSession({
      targetLanguage: settings.targetLanguage
    });
    localSessionId = localSession.id;
    detectedSourceLanguage = "unknown";

    sessionState = reduceSessionState(sessionState, {
      type: "START_CONNECTING",
      localSessionId: localSession.id,
      tabId: tab.id,
      streamId: "",
      settings
    });

    await ensureOffscreenDocument();

    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id
    });

    sessionState = reduceSessionState(sessionState, {
      type: "STREAM_READY",
      streamId,
    });

    await setBadge("...");

    await chrome.runtime.sendMessage({
      type: "START_SESSION",
      localSessionId,
      tabId: tab.id,
      streamId,
      settings
    } satisfies StartSessionMessage);
  } catch (error) {
    await handleSessionError({
      type: "SESSION_ERROR",
      localSessionId:
        localSessionId ??
        (sessionState.status === "idle" ? undefined : sessionState.localSessionId),
      code: "start_failed",
      message: error instanceof Error ? error.message : "Failed to start session"
    });
  }
}

async function stopSession(reason: string): Promise<void> {
  if (sessionState.status !== "connecting" && sessionState.status !== "running") {
    await clearBadge();
    sessionState = reduceSessionState(sessionState, { type: "STOP_COMPLETED" });
    return;
  }

  const localSessionId = sessionState.localSessionId;
  sessionState = reduceSessionState(sessionState, { type: "STOP_REQUESTED" });

  await chrome.runtime.sendMessage({
    type: "STOP_SESSION",
    localSessionId,
    reason
  } satisfies StopSessionMessage);

  await clearBadge();
  sessionState = reduceSessionState(sessionState, { type: "STOP_COMPLETED" });
}

async function handleRuntimeMessage(message: RuntimeMessage): Promise<void> {
  switch (message.type) {
    case "STOP_SESSION":
      await stopSession(message.reason ?? "content_request");
      return;
    case "SESSION_STARTED":
      await handleSessionStarted(message);
      return;
    case "SESSION_ERROR":
      await handleSessionError(message);
      return;
    case "SERVER_EVENT":
      await forwardServerEvent(message);
      return;
    case "OFFSCREEN_READY":
    case "START_SESSION":
      return;
  }
}

async function handleSessionStarted(
  message: SessionStartedMessage
): Promise<void> {
  if (
    sessionState.status !== "connecting" ||
    message.localSessionId !== sessionState.localSessionId
  ) {
    return;
  }

  sessionState = reduceSessionState(sessionState, {
    type: "SESSION_STARTED",
    remoteSessionId: message.remoteSessionId
  });

  await setBadge("ON");
}

async function handleSessionError(message: SessionErrorMessage): Promise<void> {
  if (sessionState.status !== "idle") {
    sessionState = reduceSessionState(sessionState, {
      type: "SESSION_ERROR",
      error: {
        code: message.code,
        message: message.message
      }
    });
  }

  const localSessionId =
    message.localSessionId ??
    (sessionState.status === "idle" ? undefined : sessionState.localSessionId);

  if (localSessionId) {
    await historyStore.recordSessionError(localSessionId, {
      code: message.code,
      message: message.message
    });
  }

  await clearBadge();
}

async function forwardServerEvent(message: ServerEventMessage): Promise<void> {
  if (
    sessionState.status === "idle" ||
    message.localSessionId !== sessionState.localSessionId
  ) {
    return;
  }

  if (message.event.type === "language") {
    detectedSourceLanguage = message.event.sourceLanguage;
    await historyStore.updateSessionLanguages(message.localSessionId, {
      sourceLanguage: message.event.sourceLanguage
    });
  }

  if (message.event.type === "final") {
    await historyStore.appendSegment(
      finalEventToSegment({
        localSessionId: message.localSessionId,
        event: message.event,
        sourceLanguage: detectedSourceLanguage,
        targetLanguage: sessionState.targetLanguage
      })
    );
  }

  await sendMessageToTab(sessionState.tabId, {
    type: "SERVER_EVENT",
    localSessionId: message.localSessionId,
    event: message.event
  });
}

async function injectRuntimeContentScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [CONTENT_SCRIPT_PATH]
  });
}

async function ensureOffscreenDocument(): Promise<void> {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl]
  });

  if (contexts.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ["USER_MEDIA"],
    justification: "Capture tab audio for realtime subtitles."
  });
}

async function sendMessageToTab(
  tabId: number,
  message: Extract<RuntimeMessage, { type: "SERVER_EVENT" }>
): Promise<void> {
  await chrome.tabs.sendMessage(tabId, message);
}

async function setBadge(text: string): Promise<void> {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
}

async function clearBadge(): Promise<void> {
  await chrome.action.setBadgeText({ text: "" });
}
