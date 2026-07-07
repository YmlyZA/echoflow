import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  CapabilitiesDescriptor,
  ModeCapabilities,
  SubtitleMode,
} from "@echoflow/protocol";
import type {
  HistorySegmentRecord,
  HistorySessionRecord,
} from "../../src/history/historyStore";
import { createHistoryStore } from "../../src/history/historyStore";
import {
  type ExtensionSettings,
  type SettingsValidationErrors,
  SUBTITLE_MODE_OPTIONS,
  loadSettings,
  saveSettings,
  validateSettings,
} from "../../src/settings/settings";
import { fetchCapabilities } from "../../src/settings/capabilitiesClient";
import {
  coercePair,
  sourceOptions,
  targetOptions,
} from "../../src/settings/languageSelection";
import { FONT_STACK, LIGHT_THEME, themeStyleSheet } from "../../src/ui/theme";
import { SegmentedControl } from "../../src/ui/SegmentedControl";
import { assignSpeakerNumbers } from "../../src/subtitles/speakerDisplay";
import { LanguagePicker } from "../../src/ui/LanguagePicker";
import { CONTROL_STYLES } from "../../src/ui/controlStyles";
import type { SyncNowMessage } from "../../src/messaging/messages";
import { deriveSyncStatusView } from "../../src/sync/syncStatusView";
import { SyncSection } from "../../src/sync/SyncSection";
import { SyncStatusBadge } from "../../src/sync/SyncStatusBadge";
import { LAST_SYNC_STORAGE_KEY } from "../../src/sync/syncStorageKeys";
import {
  loadPersistedState,
  SESSION_STATE_STORAGE_KEY,
  type PersistedSessionState
} from "../../src/session/sessionStore";

const historyStore = createHistoryStore();

const MIN_FONT = 12;
const MAX_FONT = 48;

type CapsState = "idle" | "loading" | "ok" | "error";

function OptionsApp() {
  const [settings, setSettings] = useState<ExtensionSettings>({
    serverUrl: "",
    apiKey: "",
    targetLanguage: "en",
    sourceLanguage: "zh",
    subtitleFontSize: 24,
    mode: "pipeline",
  });
  const [errors, setErrors] = useState<SettingsValidationErrors>({});
  const [savedState, setSavedState] = useState("");
  const [loadingError, setLoadingError] = useState("");
  const [capabilities, setCapabilities] = useState<CapabilitiesDescriptor | null>(null);
  const [capsState, setCapsState] = useState<CapsState>("idle");

  useEffect(() => {
    let mounted = true;
    void loadSettings()
      .then((loaded) => {
        if (!mounted) return;
        setSettings(loaded);
        setErrors(validateSettings(loaded).errors);
      })
      .catch((error: unknown) => {
        if (mounted) setLoadingError(getErrorMessage(error));
      });
    return () => {
      mounted = false;
    };
  }, []);

  // Fetch capabilities (debounced) whenever the connection details change.
  useEffect(() => {
    const serverUrl = settings.serverUrl.trim();
    const apiKey = settings.apiKey.trim();
    if (!serverUrl || !apiKey) {
      setCapabilities(null);
      setCapsState("idle");
      return;
    }
    let active = true;
    setCapsState("loading");
    const timer = setTimeout(() => {
      void fetchCapabilities(serverUrl, apiKey).then((caps) => {
        if (!active) return;
        setCapabilities(caps);
        setCapsState(caps ? "ok" : "error");
      });
    }, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [settings.serverUrl, settings.apiKey]);

  const validation = useMemo(() => validateSettings(settings), [settings]);
  const modeCaps: ModeCapabilities | null = capabilities
    ? capabilities.modes[settings.mode]
    : null;

  // Once capabilities for the current mode are known, snap the stored pair to a
  // valid one (only updates when it actually changes, so it converges).
  useEffect(() => {
    if (!modeCaps || !modeCaps.available) return;
    setSettings((current) => {
      const coerced = coercePair(modeCaps, current.sourceLanguage, current.targetLanguage);
      if (
        coerced.source === current.sourceLanguage &&
        coerced.target === current.targetLanguage
      ) {
        return current;
      }
      return { ...current, sourceLanguage: coerced.source, targetLanguage: coerced.target };
    });
  }, [modeCaps]);

  function update<K extends keyof ExtensionSettings>(key: K, value: ExtensionSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
    setSavedState("");
  }

  function onModeChange(mode: SubtitleMode) {
    setSettings((current) => {
      const caps = capabilities?.modes[mode];
      if (caps && caps.available) {
        const coerced = coercePair(caps, current.sourceLanguage, current.targetLanguage);
        return { ...current, mode, sourceLanguage: coerced.source, targetLanguage: coerced.target };
      }
      return { ...current, mode };
    });
    setSavedState("");
  }

  function onSourceChange(code: string) {
    setSettings((current) => {
      if (!modeCaps) return { ...current, sourceLanguage: code };
      const coerced = coercePair(modeCaps, code, current.targetLanguage);
      return { ...current, sourceLanguage: coerced.source, targetLanguage: coerced.target };
    });
    setSavedState("");
  }

  function adjustFont(delta: number) {
    setSettings((current) => ({
      ...current,
      subtitleFontSize: Math.min(MAX_FONT, Math.max(MIN_FONT, current.subtitleFontSize + delta)),
    }));
    setSavedState("");
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavedState("");
    try {
      const result = await saveSettings(settings);
      setErrors(result.errors);
      if (result.valid) {
        setSettings((current) => ({
          ...current,
          serverUrl: current.serverUrl.trim(),
          apiKey: current.apiKey.trim(),
          targetLanguage: current.targetLanguage.trim(),
        }));
        setSavedState("Settings saved");
      }
    } catch (error: unknown) {
      setLoadingError(getErrorMessage(error));
    }
  }

  return (
    <main className="ef-page">
      <style>{OPTIONS_CSS}</style>

      <header className="ef-header">
        <span className="ef-wordmark">EchoFlow</span>
        <StatusPill capsState={capsState} />
        <button
          type="button"
          className="ef-secondary"
          onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") })}
        >
          Run setup again
        </button>
      </header>

      {loadingError ? (
        <p role="alert" className="ef-banner ef-banner-error">
          {loadingError}
        </p>
      ) : null}

      <form className="ef-card" onSubmit={onSubmit}>
        <Section label="Subtitle mode">
          <SegmentedControl<SubtitleMode>
            value={settings.mode}
            options={SUBTITLE_MODE_OPTIONS}
            onChange={onModeChange}
            ariaLabel="Subtitle mode"
          />
        </Section>

        <Section label="Languages">
          <LanguagesField
            settings={settings}
            modeCaps={modeCaps}
            capsState={capsState}
            onSourceChange={onSourceChange}
            onTargetChange={(code) => update("targetLanguage", code)}
          />
        </Section>

        <Section label="Connection">
          <input
            className="ef-field"
            type="url"
            value={settings.serverUrl}
            placeholder="http://127.0.0.1:8787"
            aria-label="Server URL"
            onChange={(event) => update("serverUrl", event.currentTarget.value)}
          />
          <FieldError message={errors.serverUrl} />
          <input
            className="ef-field"
            type="password"
            value={settings.apiKey}
            placeholder="API key"
            aria-label="API key"
            onChange={(event) => update("apiKey", event.currentTarget.value)}
          />
          <FieldError message={errors.apiKey} />
        </Section>

        <Section label="Subtitle size">
          <div className="ef-stepper">
            <button
              type="button"
              className="ef-stepper-btn"
              aria-label="Decrease subtitle size"
              onClick={() => adjustFont(-1)}
            >
              −
            </button>
            <span className="ef-stepper-value">{settings.subtitleFontSize} px</span>
            <button
              type="button"
              className="ef-stepper-btn"
              aria-label="Increase subtitle size"
              onClick={() => adjustFont(1)}
            >
              +
            </button>
          </div>
          <FieldError message={errors.subtitleFontSize} />
        </Section>

        <div className="ef-actions">
          <button type="submit" className="ef-save" disabled={!validation.valid}>
            Save
          </button>
          {savedState ? <span className="ef-saved">{savedState}</span> : null}
        </div>
      </form>

      <HistoryPanel syncAvailable={capabilities?.sync?.available ?? null} />
    </main>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="ef-section">
      <p className="ef-section-label">{label}</p>
      {children}
    </section>
  );
}

function StatusPill({ capsState }: { capsState: CapsState }) {
  const map: Record<CapsState, { text: string; cls: string }> = {
    ok: { text: "Connected", cls: "ef-status-ok" },
    loading: { text: "Checking…", cls: "ef-status-loading" },
    error: { text: "Disconnected", cls: "ef-status-error" },
    idle: { text: "Not configured", cls: "ef-status-idle" },
  };
  const { text, cls } = map[capsState];
  return (
    <span className={`ef-status ${cls}`} role="status">
      <span className="ef-status-dot" />
      {text}
    </span>
  );
}

function LanguagesField({
  settings,
  modeCaps,
  capsState,
  onSourceChange,
  onTargetChange,
}: {
  settings: ExtensionSettings;
  modeCaps: ModeCapabilities | null;
  capsState: CapsState;
  onSourceChange: (code: string) => void;
  onTargetChange: (code: string) => void;
}) {
  if (capsState === "loading") {
    return <p className="ef-hint">Loading supported languages…</p>;
  }
  if (capsState === "idle") {
    return <p className="ef-hint">Set the server URL and API key below to load languages.</p>;
  }
  if (!modeCaps || capsState === "error") {
    return (
      <p className="ef-banner ef-banner-warn">
        Can’t reach the backend — check the Server URL and API key below.
      </p>
    );
  }
  if (!modeCaps.available) {
    return (
      <p className="ef-hint">
        Interpret mode isn’t available — the backend has no AST credentials configured.
      </p>
    );
  }

  const targets = targetOptions(modeCaps, settings.sourceLanguage);

  return (
    <div className="ef-langrow">
      {modeCaps.autoDetect ? (
        <span className="ef-picker-static" aria-label="Source language">
          Auto-detect
        </span>
      ) : (
        <LanguagePicker
          value={settings.sourceLanguage}
          options={sourceOptions(modeCaps)}
          onChange={onSourceChange}
          ariaLabel="Source language"
          placeholder="Source"
        />
      )}
      <span className="ef-arrow" aria-hidden="true">
        →
      </span>
      <LanguagePicker
        value={settings.targetLanguage}
        options={targets}
        onChange={onTargetChange}
        ariaLabel="Target language"
        placeholder="Target"
      />
    </div>
  );
}

function HistoryPanel({ syncAvailable }: { syncAvailable: boolean | null }) {
  const [sessions, setSessions] = useState<HistorySessionRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [segments, setSegments] = useState<HistorySegmentRecord[]>([]);
  const speakerNumbers = useMemo(
    () =>
      assignSpeakerNumbers(
        segments
          .map((s) => s.speakerId)
          .filter((id): id is string => id !== undefined)
      ),
    [segments]
  );
  const multiSpeaker = speakerNumbers.size >= 2;
  const [exportContent, setExportContent] = useState("");
  const [exportFormat, setExportFormat] = useState<"text" | "json" | "">("");
  const [historyError, setHistoryError] = useState("");
  const [lastSyncAtMs, setLastSyncAtMs] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void loadSessions()
      .then((loaded) => {
        if (!mounted) return;
        setSessions(loaded);
        setSelectedSessionId((current) => current || loaded[0]?.id || "");
      })
      .catch((error: unknown) => {
        if (mounted) setHistoryError(getErrorMessage(error));
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    void chrome.storage.local.get(LAST_SYNC_STORAGE_KEY).then((stored) => {
      const value: unknown = stored[LAST_SYNC_STORAGE_KEY];
      if (mounted && typeof value === "number") {
        setLastSyncAtMs(value);
      }
    });

    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (area !== "local" || !(LAST_SYNC_STORAGE_KEY in changes)) {
        return;
      }
      const value: unknown = changes[LAST_SYNC_STORAGE_KEY]?.newValue;
      if (typeof value === "number") {
        setLastSyncAtMs(value);
      }
      setSyncing(false);
      void refreshSessions();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
    // refreshSessions only touches state setters; the first instance is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let mounted = true;
    const applySessionState = (state: PersistedSessionState) => {
      setActiveSessionId(
        state.sessionState.status !== "idle" ? state.sessionState.localSessionId : null
      );
    };
    void loadPersistedState()
      .then((state) => {
        if (mounted) applySessionState(state);
      })
      .catch(() => {});

    const onSessionChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (area !== "session" || !(SESSION_STATE_STORAGE_KEY in changes)) {
        return;
      }
      void loadPersistedState()
        .then((state) => applySessionState(state))
        .catch(() => {});
    };
    chrome.storage.onChanged.addListener(onSessionChanged);
    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(onSessionChanged);
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    if (!selectedSessionId) {
      setSegments([]);
      setExportContent("");
      setExportFormat("");
      return;
    }
    void historyStore
      .getSessionSegments(selectedSessionId)
      .then((loaded) => {
        if (!mounted) return;
        setSegments(loaded);
        setExportContent("");
        setExportFormat("");
      })
      .catch((error: unknown) => {
        if (mounted) setHistoryError(getErrorMessage(error));
      });
    return () => {
      mounted = false;
    };
  }, [selectedSessionId]);

  async function refreshSessions() {
    try {
      setHistoryError("");
      const loaded = await loadSessions();
      setSessions(loaded);
      setSelectedSessionId((current) =>
        loaded.some((session) => session.id === current) ? current : loaded[0]?.id ?? "",
      );
    } catch (error: unknown) {
      setHistoryError(getErrorMessage(error));
    }
  }

  function syncNow() {
    setSyncing(true);
    void Promise.resolve(
      chrome.runtime.sendMessage({ type: "SYNC_NOW" } satisfies SyncNowMessage)
    ).catch(() => {});
    window.setTimeout(() => {
      setSyncing(false);
      void refreshSessions();
    }, 10_000);
  }

  async function exportSelectedSession(format: "text" | "json") {
    if (!selectedSessionId) return;
    try {
      setHistoryError("");
      const content =
        format === "text"
          ? await historyStore.exportSessionAsText(selectedSessionId)
          : await historyStore.exportSessionAsJson(selectedSessionId);
      setExportFormat(format);
      setExportContent(content);
    } catch (error: unknown) {
      setHistoryError(getErrorMessage(error));
    }
  }

  const selectedSession = sessions.find((session) => session.id === selectedSessionId);

  return (
    <section className="ef-card ef-history" aria-labelledby="history-heading">
      <div className="ef-history-head">
        <div>
          <h2 id="history-heading" className="ef-history-title">
            History
          </h2>
          <p className="ef-hint">
            {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
          </p>
        </div>
        <button type="button" className="ef-secondary" onClick={refreshSessions}>
          Refresh
        </button>
      </div>

      <SyncSection
        view={deriveSyncStatusView({ syncAvailable, lastSyncAtMs, sessions, activeSessionId })}
        syncing={syncing}
        onSyncNow={syncNow}
      />

      {historyError ? (
        <p role="alert" className="ef-banner ef-banner-error">
          {historyError}
        </p>
      ) : null}

      {sessions.length ? (
        <div className="ef-history-grid">
          <ul className="ef-session-list" aria-label="Local subtitle sessions">
            {sessions.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  onClick={() => setSelectedSessionId(session.id)}
                  className={
                    session.id === selectedSessionId
                      ? "ef-session-btn ef-session-sel"
                      : "ef-session-btn"
                  }
                >
                  <span className="ef-session-date">{formatDateTime(session.startedAt)}</span>
                  <span className="ef-session-meta">
                    {formatLanguages(session)} <SyncStatusBadge status={session.syncStatus} />
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <div className="ef-session-detail">
            {selectedSession ? (
              <>
                <div className="ef-detail-head">
                  <div>
                    <h3 className="ef-detail-title">
                      {formatDateTime(selectedSession.startedAt)}
                    </h3>
                    <p className="ef-hint">{formatLanguages(selectedSession)}</p>
                  </div>
                  <div className="ef-export-actions">
                    <button
                      type="button"
                      className="ef-secondary"
                      onClick={() => void exportSelectedSession("text")}
                    >
                      Text
                    </button>
                    <button
                      type="button"
                      className="ef-secondary"
                      onClick={() => void exportSelectedSession("json")}
                    >
                      JSON
                    </button>
                  </div>
                </div>

                {selectedSession.error ? (
                  <p role="status" className="ef-banner ef-banner-error">
                    {selectedSession.error.code}: {selectedSession.error.message}
                  </p>
                ) : null}

                <div className="ef-segments">
                  {segments.length ? (
                    segments.map((segment) => (
                      <article key={segment.segmentId} className="ef-segment">
                        <span className="ef-segment-time">{formatSegmentRange(segment)}</span>
                        {multiSpeaker && segment.speakerId ? (
                          <span className="ef-segment-speaker">
                            Speaker {speakerNumbers.get(segment.speakerId)}
                          </span>
                        ) : null}
                        <p className="ef-segment-source">{segment.sourceText}</p>
                        <p className="ef-segment-translation">{segment.translatedText}</p>
                      </article>
                    ))
                  ) : (
                    <p className="ef-hint">No final segments stored.</p>
                  )}
                </div>

                {exportContent ? (
                  <label className="ef-export-label">
                    {exportFormat === "json" ? "JSON export" : "Text export"}
                    <textarea readOnly value={exportContent} rows={8} className="ef-export" />
                  </label>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="ef-hint">No local sessions yet.</p>
      )}
    </section>
  );
}

function FieldError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <span role="alert" className="ef-error">
      {message}
    </span>
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to load settings";
}

function loadSessions(): Promise<HistorySessionRecord[]> {
  return historyStore.listSessions();
}

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function formatLanguages(session: HistorySessionRecord): string {
  return `${session.sourceLanguage ?? "auto"} → ${session.targetLanguage ?? "?"}`;
}

function formatSegmentRange(segment: HistorySegmentRecord): string {
  return `${formatDuration(segment.startTimeMs)} – ${formatDuration(segment.endTimeMs)}`;
}

function formatDuration(timeMs: number): string {
  const totalSeconds = Math.floor(timeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

const OPTIONS_CSS = `
${themeStyleSheet(LIGHT_THEME)}
* { box-sizing: border-box; }
body { margin: 0; background: var(--ef-bg); }
.ef-page {
  max-width: 720px; margin: 0 auto; padding: 28px 20px 48px;
  font-family: ${FONT_STACK}; color: var(--ef-text);
}
.ef-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.ef-wordmark { font-weight: 800; font-size: 20px; letter-spacing: -0.02em; }
.ef-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; padding: 5px 10px; border-radius: 20px; }
.ef-status-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.ef-status-ok { color: var(--ef-accent); background: var(--ef-accent-weak); }
.ef-status-error { color: #b3261e; background: #fdeceb; }
.ef-status-loading, .ef-status-idle { color: var(--ef-text-muted); background: #eef0f2; }

.ef-card {
  background: var(--ef-surface); border: 1px solid var(--ef-border); border-radius: 14px;
  box-shadow: 0 8px 30px rgba(20,30,40,0.06); padding: 18px 20px; display: grid; gap: 18px;
}
.ef-section { display: grid; gap: 8px; }
.ef-section-label { margin: 0; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ef-text-muted); }
.ef-hint { margin: 0; font-size: 13px; color: var(--ef-text-muted); }

${CONTROL_STYLES}

.ef-field { width: 100%; padding: 10px 12px; border: 1px solid var(--ef-border); border-radius: 9px; background: var(--ef-surface); font: inherit; font-size: 13px; color: var(--ef-text); }
.ef-field:focus-visible { outline: 2px solid var(--ef-accent); outline-offset: 1px; border-color: var(--ef-accent); }

.ef-stepper { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--ef-border); border-radius: 9px; padding: 5px; }
.ef-stepper-btn { width: 30px; height: 30px; border: 0; border-radius: 7px; background: #f1f3f5; font: inherit; font-size: 16px; font-weight: 700; color: var(--ef-text-muted); cursor: pointer; }
.ef-stepper-btn:hover { background: #e7eaec; }
.ef-stepper-btn:focus-visible { outline: 2px solid var(--ef-accent); outline-offset: 1px; }
.ef-stepper-value { min-width: 56px; text-align: center; font-size: 13px; font-weight: 700; }

.ef-actions { display: flex; align-items: center; gap: 12px; }
.ef-save { border: 0; border-radius: 9px; background: var(--ef-accent); color: #fff; font: inherit; font-size: 13px; font-weight: 700; padding: 11px 22px; cursor: pointer; }
.ef-save:hover:not(:disabled) { filter: brightness(0.95); }
.ef-save:disabled { opacity: 0.5; cursor: default; }
.ef-save:focus-visible { outline: 2px solid var(--ef-accent); outline-offset: 2px; }
.ef-saved { color: var(--ef-accent); font-size: 13px; font-weight: 600; }
.ef-error { color: #b3261e; font-size: 12.5px; font-weight: 500; }

.ef-secondary { border: 1px solid var(--ef-border); border-radius: 8px; background: var(--ef-surface); font: inherit; font-size: 12.5px; font-weight: 700; color: var(--ef-text); padding: 7px 12px; cursor: pointer; }
.ef-secondary:hover { border-color: #cfd4da; }

.ef-banner { margin: 0; padding: 9px 12px; border-radius: 9px; font-size: 12.5px; font-weight: 600; }
.ef-banner-error { color: #b3261e; background: #fdeceb; }
.ef-banner-warn { color: #8a5a00; background: #fdf3e2; }

.ef-history { margin-top: 18px; }
.ef-history-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.ef-history-title { margin: 0; font-size: 16px; font-weight: 700; }
.ef-history-grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 230px), 1fr)); }
.ef-session-list { display: grid; gap: 8px; list-style: none; margin: 0; padding: 0; }
.ef-session-btn { width: 100%; display: grid; gap: 4px; padding: 10px 12px; border: 1px solid var(--ef-border); border-radius: 9px; background: var(--ef-surface); font: inherit; color: var(--ef-text); cursor: pointer; text-align: left; }
.ef-session-btn:hover { border-color: #cfd4da; }
.ef-session-sel { border-color: var(--ef-accent); box-shadow: 0 0 0 3px var(--ef-accent-weak); }
.ef-session-date { font-size: 13px; font-weight: 700; }
.ef-session-meta { font-size: 12px; color: var(--ef-text-muted); }
.ef-session-detail { display: grid; gap: 14px; min-width: 0; }
.ef-detail-head { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
.ef-detail-title { margin: 0; font-size: 15px; font-weight: 700; }
.ef-export-actions { display: flex; gap: 8px; }
.ef-segments { display: grid; gap: 10px; }
.ef-segment { display: grid; gap: 4px; padding: 2px 0 2px 10px; border-left: 3px solid var(--ef-accent); }
.ef-segment-time { font-size: 12px; color: var(--ef-text-muted); font-variant-numeric: tabular-nums; }
.ef-segment-speaker { font-size: 12px; font-weight: 700; color: var(--ef-accent); }
.ef-segment-source { margin: 0; font-size: 14px; font-weight: 700; overflow-wrap: anywhere; }
.ef-segment-translation { margin: 0; font-size: 14px; color: var(--ef-text-muted); overflow-wrap: anywhere; }
.ef-export-label { display: grid; gap: 6px; font-size: 12.5px; font-weight: 700; }
.ef-export { width: 100%; border: 1px solid var(--ef-border); border-radius: 9px; padding: 10px; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ef-text); resize: vertical; }

.ef-sync-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.ef-sync-status { font-size: 13px; color: var(--ef-text-muted); }
.ef-sync-failed { color: #b3261e; }
.ef-badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 16px; }
.ef-badge-neutral { background: #eef0f2; color: var(--ef-text-muted); }
.ef-badge-waiting { background: #fdf3e2; color: #8a5a00; }
.ef-badge-ok { background: var(--ef-accent-weak); color: var(--ef-accent); }
.ef-badge-failed { background: #fdeceb; color: #b3261e; }
`;

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<OptionsApp />);
}
