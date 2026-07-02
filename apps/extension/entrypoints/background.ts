import {
  isRuntimeMessage,
  type ConnectionStatusMessage,
  type RuntimeMessage,
  type SessionErrorMessage,
  type SessionStartedMessage,
  type ServerEventMessage,
  type StartFromPopupMessage,
  type StartSessionMessage,
  type StopSessionMessage
} from "../src/messaging/messages";
import { createHistoryStore } from "../src/history/historyStore";
import { finalEventToSegment } from "../src/history/segmentMapping";
import { validateSettings } from "../src/settings/settings";
import {
  createInitialSessionState,
  reduceSessionState,
  type SessionState
} from "../src/session/sessionState";
import { loadPersistedState, persistState } from "../src/session/sessionStore";
import { createSerialQueue } from "../src/messaging/serialQueue";
import { isMessageForActiveSession } from "../src/session/activeSession";

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const CONTENT_SCRIPT_PATH = "content-scripts/content.js";

const historyStore = createHistoryStore();
let sessionState: SessionState = createInitialSessionState();
let detectedSourceLanguage = "unknown";
let stateLoaded: Promise<void> | undefined;

function ensureStateLoaded(): Promise<void> {
  stateLoaded ??= loadPersistedState().then((persisted) => {
    sessionState = persisted.sessionState;
    detectedSourceLanguage = persisted.detectedSourceLanguage;
  });
  return stateLoaded;
}

async function commitSessionState(next: SessionState): Promise<void> {
  sessionState = next;
  await persistState({ sessionState, detectedSourceLanguage });
}

async function commitDetectedSourceLanguage(language: string): Promise<void> {
  detectedSourceLanguage = language;
  await persistState({ sessionState, detectedSourceLanguage });
}

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener((details) => {
    chrome.action.setTitle({ title: "EchoFlow" });
    if (details.reason === "install") {
      void chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
    }
  });

  const enqueueMessage = createSerialQueue((error) => {
    console.error("EchoFlow background message handler failed", error);
  });

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!isRuntimeMessage(message)) {
      return;
    }

    enqueueMessage(() => handleRuntimeMessage(message));
  });
});

async function startSession(message: StartFromPopupMessage): Promise<void> {
  const { tabId, streamId, settings } = message;
  const validation = validateSettings(settings);

  if (!validation.valid) {
    // The popup gates Start on validity; this is a defensive no-op.
    return;
  }

  let localSessionId: string | undefined;

  try {
    await injectRuntimeContentScript(tabId);

    const localSession = await historyStore.createLocalSession({
      targetLanguage: settings.targetLanguage
    });
    localSessionId = localSession.id;
    await commitDetectedSourceLanguage("unknown");

    await commitSessionState(
      reduceSessionState(sessionState, {
        type: "START_CONNECTING",
        localSessionId: localSession.id,
        tabId,
        streamId,
        settings
      })
    );

    await ensureOffscreenDocument();

    await commitSessionState(
      reduceSessionState(sessionState, {
        type: "STREAM_READY",
        streamId
      })
    );

    await setBadge("...");

    await chrome.runtime.sendMessage({
      type: "START_SESSION",
      localSessionId,
      tabId,
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
    await commitSessionState(
      reduceSessionState(sessionState, { type: "STOP_COMPLETED" })
    );
    return;
  }

  const localSessionId = sessionState.localSessionId;
  await commitSessionState(
    reduceSessionState(sessionState, { type: "STOP_REQUESTED" })
  );

  await chrome.runtime.sendMessage({
    type: "STOP_SESSION",
    localSessionId,
    reason
  } satisfies StopSessionMessage);

  await clearBadge();
  await commitSessionState(
    reduceSessionState(sessionState, { type: "STOP_COMPLETED" })
  );
}

async function handleRuntimeMessage(message: RuntimeMessage): Promise<void> {
  await ensureStateLoaded();

  switch (message.type) {
    case "START_FROM_POPUP":
      await startSession(message);
      return;
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
    case "CONNECTION_STATUS":
      await forwardConnectionStatus(message);
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

  await commitSessionState(
    reduceSessionState(sessionState, {
      type: "SESSION_STARTED",
      remoteSessionId: message.remoteSessionId
    })
  );

  await setBadge("ON");
}

async function handleSessionError(message: SessionErrorMessage): Promise<void> {
  // A late error from a session that has since been replaced must not corrupt
  // the current session's state/badge/UI — record its own history and return.
  if (
    message.localSessionId &&
    sessionState.status !== "idle" &&
    !isMessageForActiveSession(sessionState, message.localSessionId)
  ) {
    await historyStore.recordSessionError(message.localSessionId, {
      code: message.code,
      message: message.message
    });
    return;
  }

  if (sessionState.status !== "idle") {
    await commitSessionState(
      reduceSessionState(sessionState, {
        type: "SESSION_ERROR",
        error: { code: message.code, message: message.message }
      })
    );
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

  if (sessionState.status !== "idle") {
    await sendMessageToTab(sessionState.tabId, message);
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
    await commitDetectedSourceLanguage(message.event.sourceLanguage);
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
    mode: sessionState.mode,
    event: message.event
  });
}

async function forwardConnectionStatus(
  message: ConnectionStatusMessage
): Promise<void> {
  if (
    sessionState.status === "idle" ||
    message.localSessionId !== sessionState.localSessionId
  ) {
    return;
  }

  await setBadge(message.status === "reconnecting" ? "..." : "ON");
  await sendMessageToTab(sessionState.tabId, message);
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

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["USER_MEDIA"],
      justification: "Capture tab audio for realtime subtitles."
    });
  } catch (error) {
    // Serialization (the background message queue) makes concurrent creation
    // unreachable, but if the document already exists the goal is met — Chrome
    // rejects a second createDocument with this specific message.
    const alreadyExists =
      error instanceof Error &&
      error.message.includes("Only a single offscreen document");
    if (!alreadyExists) {
      throw error;
    }
  }
}

async function sendMessageToTab(
  tabId: number,
  message: Extract<
    RuntimeMessage,
    { type: "SERVER_EVENT" | "CONNECTION_STATUS" | "SESSION_ERROR" }
  >
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
