import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useState } from "react";
import {
  type ExtensionSettings,
  type SettingsValidationErrors,
  TARGET_LANGUAGE_OPTIONS,
  loadSettings,
  saveSettings,
  validateSettings
} from "../../src/settings/settings";

function OptionsApp() {
  const [settings, setSettings] = useState<ExtensionSettings>({
    serverUrl: "",
    apiKey: "",
    targetLanguage: "en",
    subtitleFontSize: 24
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
            {TARGET_LANGUAGE_OPTIONS.map((language) => (
              <option key={language.value} value={language.value}>
                {language.label}
              </option>
            ))}
          </select>
          <FieldError message={errors.targetLanguage} />
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
    </main>
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

const styles = {
  main: {
    boxSizing: "border-box",
    color: "#1f2937",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    margin: "0 auto",
    maxWidth: "560px",
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
  }
} satisfies Record<string, React.CSSProperties>;

const root = document.getElementById("root");

if (root) {
  createRoot(root).render(<OptionsApp />);
}
