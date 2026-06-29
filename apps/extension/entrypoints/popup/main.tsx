import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  CapabilitiesDescriptor,
  ModeCapabilities,
  SubtitleMode
} from "@echoflow/protocol";
import {
  PopupApp,
  type PopupHandlers,
  type PopupView
} from "../../src/popup/PopupApp";
import { popupPill } from "../../src/popup/popupStatus";
import { recentSessions } from "../../src/popup/recentSessions";
import { evaluateStartGate } from "../../src/popup/canStart";
import {
  counterpartSource,
  loadSettings,
  saveSettings,
  validateSettings,
  type ExtensionSettings
} from "../../src/settings/settings";
import { fetchCapabilities } from "../../src/settings/capabilitiesClient";
import {
  coercePair,
  targetOptions
} from "../../src/settings/languageSelection";
import {
  loadPersistedState,
  SESSION_STATE_STORAGE_KEY
} from "../../src/session/sessionStore";
import type { SessionState } from "../../src/session/sessionState";
import type {
  StartFromPopupMessage,
  StopSessionMessage
} from "../../src/messaging/messages";
import { createHistoryStore } from "../../src/history/historyStore";
import type { HistorySessionRecord } from "../../src/history/historyStore";

const historyStore = createHistoryStore();
const RECENT_LIMIT = 3;

function PopupRoot() {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [sessionState, setSessionState] = useState<SessionState>({ status: "idle" });
  const [capabilities, setCapabilities] = useState<CapabilitiesDescriptor | null>(null);
  const [recent, setRecent] = useState<HistorySessionRecord[]>([]);
  const [activeTab, setActiveTab] = useState<chrome.tabs.Tab | null>(null);

  // Load settings, persisted session state, history, and the active tab on open.
  useEffect(() => {
    void loadSettings().then(setSettings);
    void loadPersistedState().then((p) => setSessionState(p.sessionState));
    void historyStore.listSessions().then((s) => setRecent(recentSessions(s, RECENT_LIMIT)));
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => setActiveTab(tabs[0] ?? null));
  }, []);

  // Reflect live lifecycle changes while the popup is open.
  useEffect(() => {
    function onChanged(
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) {
      if (area !== "session" || !changes[SESSION_STATE_STORAGE_KEY]) {
        return;
      }
      const next = changes[SESSION_STATE_STORAGE_KEY].newValue as
        | { sessionState: SessionState }
        | undefined;
      if (next) {
        setSessionState(next.sessionState);
      }
    }
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  // Fetch capabilities once connection details are known (mirrors Options).
  useEffect(() => {
    if (!settings?.serverUrl || !settings.apiKey) {
      return;
    }
    void fetchCapabilities(settings.serverUrl, settings.apiKey).then(setCapabilities);
  }, [settings?.serverUrl, settings?.apiKey]);

  const modeCaps: ModeCapabilities | null = useMemo(
    () => (settings && capabilities ? capabilities.modes[settings.mode] : null),
    [settings, capabilities]
  );

  const running =
    sessionState.status === "running" || sessionState.status === "connecting";

  const persist = useCallback(async (next: ExtensionSettings) => {
    setSettings(next);
    await saveSettings(next);
  }, []);

  const onModeChange = useCallback(
    (mode: SubtitleMode) => {
      if (!settings) return;
      const caps = capabilities?.modes[mode] ?? null;
      if (!caps) {
        void persist({ ...settings, mode });
        return;
      }
      const pair = coercePair(caps, settings.sourceLanguage, settings.targetLanguage);
      void persist({
        ...settings,
        mode,
        sourceLanguage: pair.source,
        targetLanguage: pair.target
      });
    },
    [settings, capabilities, persist]
  );

  const onTargetChange = useCallback(
    (code: string) => {
      if (!settings) return;
      if (!modeCaps) {
        void persist({
          ...settings,
          targetLanguage: code,
          sourceLanguage: counterpartSource(code)
        });
        return;
      }
      // The popup exposes only the target; derive the source from it, then
      // snap the pair to what the mode's capabilities actually allow.
      const pair = coercePair(modeCaps, counterpartSource(code), code);
      void persist({
        ...settings,
        sourceLanguage: pair.source,
        targetLanguage: pair.target
      });
    },
    [settings, modeCaps, persist]
  );

  const onStart = useCallback(async () => {
    if (!settings || !activeTab || typeof activeTab.id !== "number") {
      return;
    }
    if (!validateSettings(settings).valid) {
      await chrome.runtime.openOptionsPage();
      return;
    }
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: activeTab.id
    });
    await chrome.runtime.sendMessage({
      type: "START_FROM_POPUP",
      tabId: activeTab.id,
      streamId,
      settings
    } satisfies StartFromPopupMessage);
    window.close();
  }, [settings, activeTab]);

  const onStop = useCallback(async () => {
    await chrome.runtime.sendMessage({
      type: "STOP_SESSION",
      reason: "popup_stop"
    } satisfies StopSessionMessage);
    window.close();
  }, []);

  const onOpenOptions = useCallback(() => {
    void chrome.runtime.openOptionsPage();
    window.close();
  }, []);

  if (!settings) {
    return null;
  }

  const gate = evaluateStartGate({
    settingsValid: validateSettings(settings).valid,
    hasActiveTab: typeof activeTab?.id === "number"
  });

  const view: PopupView = {
    pill: popupPill(sessionState.status, settings.mode),
    status: sessionState.status,
    running,
    tabTitle: activeTab?.title ?? null,
    elapsedMs:
      running && "startedAt" in sessionState
        ? Date.now() - (sessionState as { startedAt?: number }).startedAt!
        : null,
    mode: settings.mode,
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
    targetOptions: modeCaps ? targetOptions(modeCaps, settings.sourceLanguage) : [],
    recent,
    startReason: gate.reason,
    errorMessage:
      sessionState.status === "error" ? sessionState.error.message : null
  };

  const handlers: PopupHandlers = {
    onStart: () => void onStart(),
    onStop: () => void onStop(),
    onModeChange,
    onTargetChange,
    onOpenOptions
  };

  return <PopupApp view={view} handlers={handlers} />;
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<PopupRoot />);
}
