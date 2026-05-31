import { describe, expect, it } from "vitest";
import {
  createInitialSessionState,
  reduceSessionState,
  type SessionState
} from "./sessionState";

describe("session state", () => {
  it("moves from idle to connecting with valid settings", () => {
    const nextState = reduceSessionState(createInitialSessionState(), {
      type: "START_CONNECTING",
      localSessionId: "local-1",
      tabId: 7,
      streamId: "stream-1",
      settings: validSettings()
    });

    expect(nextState).toMatchObject({
      status: "connecting",
      localSessionId: "local-1",
      tabId: 7,
      streamId: "stream-1",
      targetLanguage: "zh-CN"
    });
  });

  it("moves from connecting to running", () => {
    const state = connectingState();

    const nextState = reduceSessionState(state, {
      type: "SESSION_STARTED",
      remoteSessionId: "remote-1"
    });

    expect(nextState).toMatchObject({
      status: "running",
      localSessionId: "local-1",
      remoteSessionId: "remote-1"
    });
  });

  it("moves from running to stopping", () => {
    const state: SessionState = {
      ...connectingState(),
      status: "running",
      remoteSessionId: "remote-1"
    };

    const nextState = reduceSessionState(state, { type: "STOP_REQUESTED" });

    expect(nextState).toMatchObject({
      status: "stopping",
      localSessionId: "local-1",
      remoteSessionId: "remote-1"
    });
  });

  it("returns from error to idle after stop", () => {
    const state: SessionState = {
      ...connectingState(),
      status: "error",
      error: {
        code: "realtime_failed",
        message: "Realtime failed"
      }
    };

    const nextState = reduceSessionState(state, { type: "STOP_COMPLETED" });

    expect(nextState).toEqual(createInitialSessionState());
  });

  it("does not start without valid settings", () => {
    const nextState = reduceSessionState(createInitialSessionState(), {
      type: "START_CONNECTING",
      localSessionId: "local-1",
      tabId: 7,
      streamId: "stream-1",
      settings: {
        ...validSettings(),
        apiKey: ""
      }
    });

    expect(nextState.status).toBe("idle");
    expect(nextState.validationErrors).toMatchObject({
      apiKey: "API key is required"
    });
  });
});

function connectingState(): SessionState {
  return {
    status: "connecting",
    localSessionId: "local-1",
    tabId: 7,
    streamId: "stream-1",
    targetLanguage: "zh-CN"
  };
}

function validSettings() {
  return {
    serverUrl: "https://api.example.com",
    apiKey: "secret",
    targetLanguage: "zh-CN",
    subtitleFontSize: 24
  };
}
