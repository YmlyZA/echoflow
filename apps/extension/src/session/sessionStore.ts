import { createInitialSessionState, type SessionState } from "./sessionState";

export interface PersistedSessionState {
  sessionState: SessionState;
  detectedSourceLanguage: string;
}

export interface SessionStateStorage {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

export const SESSION_STATE_STORAGE_KEY = "echoflow.session";

export async function loadPersistedState(
  storage: SessionStateStorage = createChromeSessionStorageAdapter(),
): Promise<PersistedSessionState> {
  const stored = await storage.get<PersistedSessionState>(
    SESSION_STATE_STORAGE_KEY,
  );

  return (
    stored ?? {
      sessionState: createInitialSessionState(),
      detectedSourceLanguage: "unknown",
    }
  );
}

export async function persistState(
  value: PersistedSessionState,
  storage: SessionStateStorage = createChromeSessionStorageAdapter(),
): Promise<void> {
  await storage.set(SESSION_STATE_STORAGE_KEY, value);
}

export function createInMemorySessionStorage(): SessionStateStorage {
  const map = new Map<string, unknown>();

  return {
    async get<T>(key: string): Promise<T | undefined> {
      return map.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      map.set(key, value);
    },
  };
}

export function createChromeSessionStorageAdapter(): SessionStateStorage {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const storage = getChromeSessionStorage();

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
      const storage = getChromeSessionStorage();

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
    },
  };
}

function getChromeSessionStorage(): chrome.storage.SessionStorageArea {
  if (!globalThis.chrome?.storage?.session) {
    throw new Error("chrome.storage.session is unavailable");
  }

  return globalThis.chrome.storage.session;
}
