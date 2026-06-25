import type { SubtitleMode } from "@echoflow/protocol";

export interface ExtensionSettings {
  serverUrl: string;
  apiKey: string;
  targetLanguage: string;
  sourceLanguage: string;
  subtitleFontSize: number;
  mode: SubtitleMode;
}

export type SettingsValidationErrors = Partial<
  Record<keyof ExtensionSettings, string>
>;

export interface SettingsValidationResult {
  valid: boolean;
  errors: SettingsValidationErrors;
}

export interface SettingsStorageAdapter {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

export const SETTINGS_STORAGE_KEY = "echoflow.settings";
export const DEFAULT_SUBTITLE_FONT_SIZE = 24;

const DEFAULT_TARGET_LANGUAGE = "en";
const DEFAULT_SUBTITLE_MODE: SubtitleMode = "pipeline";

export function counterpartSource(target: string): string {
  return target === "zh-CN" || target === "zh-TW" ? "en" : "zh";
}

export const SUBTITLE_MODE_OPTIONS = [
  { value: "pipeline" as const, label: "一致 (免费)" },
  { value: "interpret" as const, label: "实时 (付费)" }
] as const;

const MIN_SUBTITLE_FONT_SIZE = 12;
const MAX_SUBTITLE_FONT_SIZE = 48;

export type StoredExtensionSettings = Partial<ExtensionSettings>;

// Best-effort default target for a fresh install, before backend capabilities
// are known. The capability-driven picker (and coercePair) refine it once the
// descriptor loads; the persisted value is just a sensible starting point.
export function getDefaultTargetLanguage(browserLanguage: string): string {
  const normalized = browserLanguage.trim().toLowerCase();

  if (normalized.startsWith("zh")) {
    if (
      normalized.includes("hant") ||
      normalized.includes("-tw") ||
      normalized.includes("-hk") ||
      normalized.includes("-mo")
    ) {
      return "zh-TW";
    }

    return "zh-CN";
  }

  return DEFAULT_TARGET_LANGUAGE;
}

export function resolveSettings(
  storedSettings: StoredExtensionSettings | undefined,
  browserLanguage: string
): ExtensionSettings {
  const targetLanguage =
    storedSettings?.targetLanguage ?? getDefaultTargetLanguage(browserLanguage);
  return {
    serverUrl: storedSettings?.serverUrl ?? "",
    apiKey: storedSettings?.apiKey ?? "",
    targetLanguage,
    sourceLanguage:
      storedSettings?.sourceLanguage ?? counterpartSource(targetLanguage),
    subtitleFontSize:
      storedSettings?.subtitleFontSize ?? DEFAULT_SUBTITLE_FONT_SIZE,
    mode: storedSettings?.mode ?? DEFAULT_SUBTITLE_MODE
  };
}

export function validateSettings(
  settings: ExtensionSettings
): SettingsValidationResult {
  const errors: SettingsValidationErrors = {};
  const serverUrl = settings.serverUrl.trim();

  if (!serverUrl) {
    errors.serverUrl = "Server URL is required";
  } else {
    try {
      const parsedUrl = new URL(serverUrl);

      if (!["http:", "https:", "ws:", "wss:"].includes(parsedUrl.protocol)) {
        errors.serverUrl = "Server URL must use http, https, ws, or wss";
      }
    } catch {
      errors.serverUrl = "Server URL must be a valid URL";
    }
  }

  if (!settings.apiKey.trim()) {
    errors.apiKey = "API key is required";
  }

  if (!settings.targetLanguage.trim()) {
    errors.targetLanguage = "Target language is required";
  }

  if (
    !Number.isFinite(settings.subtitleFontSize) ||
    settings.subtitleFontSize < MIN_SUBTITLE_FONT_SIZE ||
    settings.subtitleFontSize > MAX_SUBTITLE_FONT_SIZE
  ) {
    errors.subtitleFontSize = `Subtitle font size must be between ${MIN_SUBTITLE_FONT_SIZE} and ${MAX_SUBTITLE_FONT_SIZE}`;
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors
  };
}

export async function loadSettings(
  storage: SettingsStorageAdapter = createChromeStorageAdapter(),
  browserLanguage = getBrowserLanguage()
): Promise<ExtensionSettings> {
  const storedSettings =
    await storage.get<StoredExtensionSettings>(SETTINGS_STORAGE_KEY);

  return resolveSettings(storedSettings, browserLanguage);
}

export async function saveSettings(
  settings: ExtensionSettings,
  storage: SettingsStorageAdapter = createChromeStorageAdapter()
): Promise<SettingsValidationResult> {
  const validation = validateSettings(settings);

  if (!validation.valid) {
    return validation;
  }

  await storage.set(SETTINGS_STORAGE_KEY, {
    serverUrl: settings.serverUrl.trim(),
    apiKey: settings.apiKey.trim(),
    targetLanguage: settings.targetLanguage.trim(),
    sourceLanguage: settings.sourceLanguage.trim(),
    subtitleFontSize: settings.subtitleFontSize,
    mode: settings.mode
  });

  return validation;
}

export function buildRealtimeWebSocketUrl(serverUrl: string): string {
  const url = new URL(serverUrl.trim());

  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  }

  url.pathname = joinUrlPath(url.pathname, "v1/realtime");
  url.search = "";
  url.hash = "";

  return url.toString();
}

export function createChromeStorageAdapter(): SettingsStorageAdapter {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const storage = getChromeLocalStorage();

      return new Promise((resolve, reject) => {
        storage.get(key, (items) => {
          const error = chrome.runtime.lastError;

          if (error) {
            reject(new Error(error.message));
            return;
          }

          resolve(items[key] as T | undefined);
        });
      });
    },
    async set<T>(key: string, value: T): Promise<void> {
      const storage = getChromeLocalStorage();

      return new Promise((resolve, reject) => {
        storage.set({ [key]: value }, () => {
          const error = chrome.runtime.lastError;

          if (error) {
            reject(new Error(error.message));
            return;
          }

          resolve();
        });
      });
    }
  };
}

function getBrowserLanguage(): string {
  return globalThis.navigator?.language ?? DEFAULT_TARGET_LANGUAGE;
}

function getChromeLocalStorage(): chrome.storage.LocalStorageArea {
  if (!globalThis.chrome?.storage?.local) {
    throw new Error("chrome.storage.local is unavailable");
  }

  return globalThis.chrome.storage.local;
}

function joinUrlPath(basePath: string, childPath: string): string {
  const normalizedBasePath = basePath.endsWith("/")
    ? basePath.slice(0, -1)
    : basePath;

  return `${normalizedBasePath}/${childPath}`;
}
