import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useState } from "react";
import type {
  HistorySegmentRecord,
  HistorySessionRecord
} from "../../src/history/historyStore";
import { createHistoryStore } from "../../src/history/historyStore";
import {
  type ExtensionSettings,
  type SettingsValidationErrors,
  SUBTITLE_MODE_OPTIONS,
  coerceTargetForMode,
  targetOptionsForMode,
  loadSettings,
  saveSettings,
  validateSettings
} from "../../src/settings/settings";

const historyStore = createHistoryStore();

function OptionsApp() {
  const [settings, setSettings] = useState<ExtensionSettings>({
    serverUrl: "",
    apiKey: "",
    targetLanguage: "en",
    subtitleFontSize: 24,
    mode: "pipeline"
  });
  const [errors, setErrors] = useState<SettingsValidationErrors>({});
  const [savedState, setSavedState] = useState("");
  const [loadingError, setLoadingError] = useState("");

  useEffect(() => {
    let isMounted = true;

    void loadSettings()
      .then((loadedSettings) => {
        if (isMounted) {
          setSettings(loadedSettings);
          setErrors(validateSettings(loadedSettings).errors);
        }
      })
      .catch((error: unknown) => {
        if (isMounted) {
          setLoadingError(getErrorMessage(error));
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const validation = useMemo(() => validateSettings(settings), [settings]);

  function updateSetting<K extends keyof ExtensionSettings>(
    key: K,
    value: ExtensionSettings[K]
  ) {
    setSettings((currentSettings) => {
      const nextSettings = {
        ...currentSettings,
        [key]: value
      };

      setErrors(validateSettings(nextSettings).errors);

      return nextSettings;
    });
    setSavedState("");
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavedState("");

    try {
      const result = await saveSettings(settings);
      setErrors(result.errors);

      if (result.valid) {
        setSettings({
          ...settings,
          serverUrl: settings.serverUrl.trim(),
          apiKey: settings.apiKey.trim(),
          targetLanguage: settings.targetLanguage.trim()
        });
        setSavedState("Settings saved");
      }
    } catch (error: unknown) {
      setLoadingError(getErrorMessage(error));
    }
  }

  return (
    <main style={styles.main}>
      <h1>EchoFlow</h1>
      {loadingError ? (
        <p role="alert" style={styles.error}>
          {loadingError}
        </p>
      ) : null}
      <form onSubmit={onSubmit} style={styles.form}>
        <label style={styles.label}>
          Server URL
          <input
            type="url"
            value={settings.serverUrl}
            onChange={(event) =>
              updateSetting("serverUrl", event.currentTarget.value)
            }
            placeholder="https://api.example.com"
            style={styles.input}
          />
          <FieldError message={errors.serverUrl} />
        </label>

        <label style={styles.label}>
          API key
          <input
            type="password"
            value={settings.apiKey}
            onChange={(event) =>
              updateSetting("apiKey", event.currentTarget.value)
            }
            style={styles.input}
          />
          <FieldError message={errors.apiKey} />
        </label>

        <label style={styles.label}>
          Target language
          <select
            value={settings.targetLanguage}
            onChange={(event) =>
              updateSetting("targetLanguage", event.currentTarget.value)
            }
            style={styles.input}
          >
            {targetOptionsForMode(settings.mode).map((language) => (
              <option key={language.value} value={language.value}>
                {language.label}
              </option>
            ))}
          </select>
          <FieldError message={errors.targetLanguage} />
        </label>

        <label style={styles.label}>
          Subtitle mode
          <select
            value={settings.mode}
            onChange={(event) => {
              const nextMode = event.currentTarget.value as ExtensionSettings["mode"];
              updateSetting("mode", nextMode);
              updateSetting(
                "targetLanguage",
                coerceTargetForMode(nextMode, settings.targetLanguage)
              );
            }}
            style={styles.input}
          >
            {SUBTITLE_MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label style={styles.label}>
          Subtitle font size
          <input
            type="number"
            min="12"
            max="48"
            value={settings.subtitleFontSize}
            onChange={(event) =>
              updateSetting(
                "subtitleFontSize",
                Number(event.currentTarget.value)
              )
            }
            style={styles.input}
          />
          <FieldError message={errors.subtitleFontSize} />
        </label>

        <button type="submit" disabled={!validation.valid} style={styles.button}>
          Save
        </button>
        {savedState ? <p style={styles.saved}>{savedState}</p> : null}
      </form>
      <HistoryPanel />
    </main>
  );
}

function HistoryPanel() {
  const [sessions, setSessions] = useState<HistorySessionRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [segments, setSegments] = useState<HistorySegmentRecord[]>([]);
  const [exportContent, setExportContent] = useState("");
  const [exportFormat, setExportFormat] = useState<"text" | "json" | "">("");
  const [historyError, setHistoryError] = useState("");

  useEffect(() => {
    let isMounted = true;

    void loadSessions()
      .then((loadedSessions) => {
        if (!isMounted) {
          return;
        }

        setSessions(loadedSessions);
        setSelectedSessionId((currentSessionId) =>
          currentSessionId ||
          loadedSessions[0]?.id ||
          ""
        );
      })
      .catch((error: unknown) => {
        if (isMounted) {
          setHistoryError(getErrorMessage(error));
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    if (!selectedSessionId) {
      setSegments([]);
      setExportContent("");
      setExportFormat("");
      return;
    }

    void historyStore
      .getSessionSegments(selectedSessionId)
      .then((loadedSegments) => {
        if (isMounted) {
          setSegments(loadedSegments);
          setExportContent("");
          setExportFormat("");
        }
      })
      .catch((error: unknown) => {
        if (isMounted) {
          setHistoryError(getErrorMessage(error));
        }
      });

    return () => {
      isMounted = false;
    };
  }, [selectedSessionId]);

  async function refreshSessions() {
    try {
      setHistoryError("");
      const loadedSessions = await loadSessions();
      setSessions(loadedSessions);
      setSelectedSessionId((currentSessionId) =>
        loadedSessions.some((session) => session.id === currentSessionId)
          ? currentSessionId
          : loadedSessions[0]?.id ?? ""
      );
    } catch (error: unknown) {
      setHistoryError(getErrorMessage(error));
    }
  }

  async function exportSelectedSession(format: "text" | "json") {
    if (!selectedSessionId) {
      return;
    }

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

  const selectedSession = sessions.find(
    (session) => session.id === selectedSessionId
  );

  return (
    <section style={styles.historySection} aria-labelledby="history-heading">
      <div style={styles.sectionHeader}>
        <div>
          <h2 id="history-heading" style={styles.sectionTitle}>
            Local history
          </h2>
          <p style={styles.sectionMeta}>
            {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
          </p>
        </div>
        <button type="button" onClick={refreshSessions} style={styles.secondaryButton}>
          Refresh
        </button>
      </div>

      {historyError ? (
        <p role="alert" style={styles.error}>
          {historyError}
        </p>
      ) : null}

      {sessions.length ? (
        <div style={styles.historyGrid}>
          <ul style={styles.sessionList} aria-label="Local subtitle sessions">
            {sessions.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  onClick={() => setSelectedSessionId(session.id)}
                  style={
                    session.id === selectedSessionId
                      ? styles.selectedSessionButton
                      : styles.sessionButton
                  }
                >
                  <span style={styles.sessionDate}>
                    {formatDateTime(session.startedAt)}
                  </span>
                  <span style={styles.sessionStatus}>
                    {formatLanguages(session)} / {session.syncStatus}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <div style={styles.sessionDetail}>
            {selectedSession ? (
              <>
                <div style={styles.detailHeader}>
                  <div>
                    <h3 style={styles.detailTitle}>
                      {formatDateTime(selectedSession.startedAt)}
                    </h3>
                    <p style={styles.sectionMeta}>
                      {formatLanguages(selectedSession)}
                    </p>
                  </div>
                  <div style={styles.exportActions}>
                    <button
                      type="button"
                      onClick={() => void exportSelectedSession("text")}
                      style={styles.secondaryButton}
                    >
                      Text
                    </button>
                    <button
                      type="button"
                      onClick={() => void exportSelectedSession("json")}
                      style={styles.secondaryButton}
                    >
                      JSON
                    </button>
                  </div>
                </div>

                {selectedSession.error ? (
                  <p role="status" style={styles.error}>
                    {selectedSession.error.code}: {selectedSession.error.message}
                  </p>
                ) : null}

                <div style={styles.segmentList}>
                  {segments.length ? (
                    segments.map((segment) => (
                      <article key={segment.segmentId} style={styles.segmentRow}>
                        <span style={styles.segmentTime}>
                          {formatSegmentRange(segment)}
                        </span>
                        <p style={styles.segmentSource}>{segment.sourceText}</p>
                        <p style={styles.segmentTranslation}>
                          {segment.translatedText}
                        </p>
                      </article>
                    ))
                  ) : (
                    <p style={styles.emptyState}>No final segments stored.</p>
                  )}
                </div>

                {exportContent ? (
                  <label style={styles.exportPreviewLabel}>
                    {exportFormat === "json" ? "JSON export" : "Text export"}
                    <textarea
                      readOnly
                      value={exportContent}
                      rows={8}
                      style={styles.exportPreview}
                    />
                  </label>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      ) : (
        <p style={styles.emptyState}>No local sessions yet.</p>
      )}
    </section>
  );
}

function FieldError({ message }: { message: string | undefined }) {
  if (!message) {
    return null;
  }

  return (
    <span role="alert" style={styles.error}>
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
    timeStyle: "short"
  }).format(new Date(timestamp));
}

function formatLanguages(session: HistorySessionRecord): string {
  return `${session.sourceLanguage ?? "unknown"} -> ${
    session.targetLanguage ?? "unknown"
  }`;
}

function formatSegmentRange(segment: HistorySegmentRecord): string {
  return `${formatDuration(segment.startTimeMs)} - ${formatDuration(
    segment.endTimeMs
  )}`;
}

function formatDuration(timeMs: number): string {
  const totalSeconds = Math.floor(timeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
    2,
    "0"
  )}`;
}

const styles = {
  main: {
    boxSizing: "border-box",
    color: "#1f2937",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    margin: "0 auto",
    maxWidth: "920px",
    padding: "32px 20px"
  },
  form: {
    display: "grid",
    gap: "16px"
  },
  label: {
    display: "grid",
    gap: "6px",
    fontSize: "14px",
    fontWeight: 600
  },
  input: {
    border: "1px solid #cbd5e1",
    borderRadius: "6px",
    font: "inherit",
    padding: "10px 12px"
  },
  button: {
    alignSelf: "start",
    border: "0",
    borderRadius: "6px",
    background: "#1f2937",
    color: "#ffffff",
    cursor: "pointer",
    font: "inherit",
    fontWeight: 700,
    padding: "10px 16px"
  },
  error: {
    color: "#b91c1c",
    fontSize: "13px",
    fontWeight: 500
  },
  saved: {
    color: "#047857",
    fontSize: "13px",
    fontWeight: 600,
    margin: 0
  },
  historySection: {
    borderTop: "1px solid #e2e8f0",
    display: "grid",
    gap: "16px",
    marginTop: "32px",
    paddingTop: "28px"
  },
  sectionHeader: {
    alignItems: "center",
    display: "flex",
    justifyContent: "space-between",
    gap: "16px"
  },
  sectionTitle: {
    fontSize: "20px",
    lineHeight: 1.2,
    margin: 0
  },
  sectionMeta: {
    color: "#64748b",
    fontSize: "13px",
    margin: "4px 0 0"
  },
  secondaryButton: {
    border: "1px solid #94a3b8",
    borderRadius: "6px",
    background: "#ffffff",
    color: "#1f2937",
    cursor: "pointer",
    font: "inherit",
    fontSize: "13px",
    fontWeight: 700,
    padding: "8px 12px"
  },
  historyGrid: {
    display: "grid",
    gap: "18px",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))"
  },
  sessionList: {
    display: "grid",
    gap: "8px",
    listStyle: "none",
    margin: 0,
    padding: 0
  },
  sessionButton: {
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: "6px",
    color: "#1f2937",
    cursor: "pointer",
    display: "grid",
    gap: "4px",
    padding: "10px 12px",
    textAlign: "left",
    width: "100%"
  },
  selectedSessionButton: {
    background: "#ecfeff",
    border: "1px solid #0891b2",
    borderRadius: "6px",
    color: "#164e63",
    cursor: "pointer",
    display: "grid",
    gap: "4px",
    padding: "10px 12px",
    textAlign: "left",
    width: "100%"
  },
  sessionDate: {
    fontSize: "13px",
    fontWeight: 700
  },
  sessionStatus: {
    color: "#64748b",
    fontSize: "12px"
  },
  sessionDetail: {
    display: "grid",
    gap: "14px",
    minWidth: 0
  },
  detailHeader: {
    alignItems: "start",
    display: "flex",
    gap: "12px",
    justifyContent: "space-between"
  },
  detailTitle: {
    fontSize: "16px",
    lineHeight: 1.3,
    margin: 0
  },
  exportActions: {
    display: "flex",
    gap: "8px"
  },
  segmentList: {
    display: "grid",
    gap: "10px"
  },
  segmentRow: {
    borderLeft: "3px solid #0891b2",
    display: "grid",
    gap: "4px",
    padding: "2px 0 2px 10px"
  },
  segmentTime: {
    color: "#64748b",
    fontSize: "12px",
    fontVariantNumeric: "tabular-nums"
  },
  segmentSource: {
    fontSize: "14px",
    fontWeight: 700,
    margin: 0,
    overflowWrap: "anywhere"
  },
  segmentTranslation: {
    color: "#475569",
    fontSize: "14px",
    margin: 0,
    overflowWrap: "anywhere"
  },
  emptyState: {
    color: "#64748b",
    fontSize: "14px",
    margin: 0
  },
  exportPreviewLabel: {
    display: "grid",
    gap: "6px",
    fontSize: "13px",
    fontWeight: 700
  },
  exportPreview: {
    border: "1px solid #cbd5e1",
    borderRadius: "6px",
    boxSizing: "border-box",
    color: "#1f2937",
    font: "12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
    padding: "10px",
    resize: "vertical",
    width: "100%"
  }
} satisfies Record<string, React.CSSProperties>;

const root = document.getElementById("root");

if (root) {
  createRoot(root).render(<OptionsApp />);
}
