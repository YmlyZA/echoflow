import {
  isRuntimeMessage,
  type ConnectionStatusMessage,
  type ServerEventMessage,
  type SessionErrorMessage,
  type SessionStartedMessage,
  type StartSessionMessage
} from "../../src/messaging/messages";
import { OffscreenAudioPipeline } from "../../src/audio/audioPipeline";
import { RealtimeClient } from "../../src/realtime/realtimeClient";
import { CANONICAL_PCM_AUDIO_FORMAT } from "@echoflow/protocol";
import { buildRealtimeWebSocketUrl } from "../../src/settings/settings";
import { createSerialQueue } from "../../src/messaging/serialQueue";

chrome.runtime.sendMessage({ type: "OFFSCREEN_READY" });

let activeSession: {
  localSessionId: string;
  pipeline: OffscreenAudioPipeline;
} | undefined;

const enqueueMessage = createSerialQueue((error) => {
  console.error("EchoFlow offscreen message handler failed", error);
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isRuntimeMessage(message)) {
    return;
  }

  if (message.type === "START_SESSION") {
    enqueueMessage(() => startSession(message));
    return;
  }

  if (message.type === "STOP_SESSION") {
    if (
      message.localSessionId &&
      activeSession &&
      message.localSessionId !== activeSession.localSessionId
    ) {
      return;
    }

    enqueueMessage(() => stopActiveSession(message.reason ?? "stop_session"));
    return;
  }
});

async function startSession(message: StartSessionMessage): Promise<void> {
  await stopActiveSession("replaced_by_new_session");

  let pipeline: OffscreenAudioPipeline | undefined;
  try {
    const tab = await getTabMetadata(message.tabId);
    const client = new RealtimeClient({
      url: buildRealtimeWebSocketUrl(message.settings.serverUrl),
      apiKey: message.settings.apiKey,
      sessionId: message.localSessionId,
      tabTitle: tab.title,
      tabUrl: tab.url,
      targetLanguage: message.settings.targetLanguage,
      sourceLanguage: message.settings.sourceLanguage,
      mode: message.settings.mode,
      audioFormat: CANONICAL_PCM_AUDIO_FORMAT,
      onEvent: (event) => {
        void chrome.runtime.sendMessage({
          type: "SERVER_EVENT",
          localSessionId: message.localSessionId,
          mode: message.settings.mode,
          event
        } satisfies ServerEventMessage);
      },
      onError: (error) => {
        void chrome.runtime.sendMessage({
          type: "SESSION_ERROR",
          localSessionId: message.localSessionId,
          code: error.code,
          message: error.message
        } satisfies SessionErrorMessage);

        if (error.code === "connection_lost") {
          void stopActiveSession("connection_lost");
        }
      },
      onStatus: (status) => {
        void chrome.runtime.sendMessage({
          type: "CONNECTION_STATUS",
          localSessionId: message.localSessionId,
          status
        } satisfies ConnectionStatusMessage);
      }
    });
    pipeline = new OffscreenAudioPipeline({
      streamId: message.streamId,
      client,
      workletModuleUrl: chrome.runtime.getURL("pcm-encoder.worklet.js")
    });

    activeSession = {
      localSessionId: message.localSessionId,
      pipeline
    };

    await client.connect();
    await pipeline.start();

    await chrome.runtime.sendMessage({
      type: "SESSION_STARTED",
      localSessionId: message.localSessionId
    } satisfies SessionStartedMessage);
  } catch (error) {
    if (activeSession?.localSessionId === message.localSessionId) {
      // This invocation still owns the active session — full teardown.
      await stopActiveSession("start_failed");
    } else if (pipeline) {
      // A newer session replaced us mid-await; only clean up what we created,
      // leaving the current activeSession intact.
      await pipeline.stop("start_failed_superseded");
    }

    await chrome.runtime.sendMessage({
      type: "SESSION_ERROR",
      localSessionId: message.localSessionId,
      code: "offscreen_start_failed",
      message:
        error instanceof Error ? error.message : "Failed to start offscreen session"
    } satisfies SessionErrorMessage);
  }
}

async function stopActiveSession(reason: string): Promise<void> {
  const session = activeSession;
  activeSession = undefined;

  if (!session) {
    return;
  }

  await session.pipeline.stop(reason);
}

async function getTabMetadata(tabId: number): Promise<{
  title: string;
  url: string;
}> {
  try {
    const tab = await chrome.tabs.get(tabId);

    return {
      title: tab.title ?? "",
      url: tab.url ?? ""
    };
  } catch {
    return {
      title: "",
      url: ""
    };
  }
}
