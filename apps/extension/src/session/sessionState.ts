import {
  validateSettings,
  type ExtensionSettings,
  type SettingsValidationErrors
} from "../settings/settings";

export type SessionStatus =
  | "idle"
  | "connecting"
  | "running"
  | "stopping"
  | "error";

export interface SessionError {
  code: string;
  message: string;
}

export interface ActiveSessionDetails {
  localSessionId: string;
  tabId: number;
  streamId: string;
  targetLanguage: string;
  remoteSessionId?: string;
}

export type SessionState =
  | {
      status: "idle";
      validationErrors?: SettingsValidationErrors;
    }
  | ({
      status: "connecting";
    } & ActiveSessionDetails)
  | ({
      status: "running";
    } & ActiveSessionDetails)
  | ({
      status: "stopping";
    } & ActiveSessionDetails)
  | ({
      status: "error";
      error: SessionError;
    } & ActiveSessionDetails);

export type SessionStateEvent =
  | ({
      type: "START_CONNECTING";
      settings: ExtensionSettings;
    } & Omit<ActiveSessionDetails, "targetLanguage" | "remoteSessionId">)
  | {
      type: "SESSION_STARTED";
      remoteSessionId?: string;
    }
  | {
      type: "STOP_REQUESTED";
    }
  | {
      type: "SESSION_ERROR";
      error: SessionError;
    }
  | {
      type: "STOP_COMPLETED";
    };

export function createInitialSessionState(): SessionState {
  return { status: "idle" };
}

export function reduceSessionState(
  state: SessionState,
  event: SessionStateEvent
): SessionState {
  switch (event.type) {
    case "START_CONNECTING": {
      const validation = validateSettings(event.settings);

      if (!validation.valid) {
        return {
          status: "idle",
          validationErrors: validation.errors
        };
      }

      return {
        status: "connecting",
        localSessionId: event.localSessionId,
        tabId: event.tabId,
        streamId: event.streamId,
        targetLanguage: event.settings.targetLanguage
      };
    }
    case "SESSION_STARTED":
      if (state.status !== "connecting") {
        return state;
      }

      return {
        ...state,
        status: "running",
        remoteSessionId: event.remoteSessionId
      };
    case "STOP_REQUESTED":
      if (state.status !== "connecting" && state.status !== "running") {
        return state;
      }

      return {
        ...state,
        status: "stopping"
      };
    case "SESSION_ERROR":
      if (state.status === "idle") {
        return state;
      }

      return {
        ...state,
        status: "error",
        error: event.error
      };
    case "STOP_COMPLETED":
      return createInitialSessionState();
  }
}
