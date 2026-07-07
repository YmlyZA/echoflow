import type { ServerEvent } from "@echoflow/protocol";
import { isServerEvent } from "@echoflow/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { createServer } from "./server.js";

const openSockets: WebSocket[] = [];

afterEach(() => {
  for (const socket of openSockets.splice(0)) {
    socket.terminate();
  }
});

function sendAudioFrame(
  socket: WebSocket,
  sequenceNumber: number,
  timestampMs: number,
): void {
  socket.send(
    JSON.stringify({
      type: "audio_frame",
      frame: { sequenceNumber, timestampMs },
    }),
  );
  socket.send(Buffer.from([1, 2, 3]));
}

const SEGMENT_ONE = [
  { type: "language", sourceLanguage: "en", targetLanguage: "zh-CN" },
  { type: "partial", segmentId: "seg-1", sourceText: "hello", speakerId: "spk-a" },
  { type: "partial", segmentId: "seg-1", sourceText: "hello from", speakerId: "spk-a" },
  {
    type: "final",
    segmentId: "seg-1",
    sourceText: "hello from echoflow",
    translatedText: "[zh-CN] hello from echoflow",
    startTimeMs: 0,
    endTimeMs: 500,
    speakerId: "spk-a",
  },
];

describe("GET /v1/capabilities", () => {
  it("serves capabilities to an authorized request", async () => {
    const server = createServer({ apiKey: "dev-key" });
    try {
      const res = await server.inject({
        method: "GET",
        url: "/v1/capabilities",
        headers: { "x-api-key": "dev-key" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { modes: { pipeline: { available: boolean }; interpret: { available: boolean } } };
      expect(body.modes.pipeline.available).toBe(true);
      expect(typeof body.modes.interpret.available).toBe("boolean");
    } finally {
      await server.close();
    }
  });

  it("rejects /v1/capabilities without a valid key", async () => {
    const server = createServer({ apiKey: "dev-key" });
    try {
      const res = await server.inject({ method: "GET", url: "/v1/capabilities" });
      expect(res.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });
});

describe("backend realtime websocket", () => {
  it("emits language, progressive partials, and a final once frames drive a segment", async () => {
    const server = createServer({ apiKey: "dev-key" });

    try {
      await server.ready();
      const socket = await server.injectWS("/v1/realtime", {
        headers: { "x-api-key": "dev-key" },
      });
      openSockets.push(socket);

      const events = collectServerEvents(socket, 4);
      socket.send(JSON.stringify({ type: "start", targetLanguage: "zh-CN" }));
      sendAudioFrame(socket, 0, 0);
      sendAudioFrame(socket, 1, 250);
      sendAudioFrame(socket, 2, 500);

      const received = await events;
      expect(received).toHaveLength(SEGMENT_ONE.length);
      expect(received).toEqual(expect.arrayContaining(SEGMENT_ONE));
    } finally {
      await server.close();
    }
  });

  it("closes the socket cleanly when the client sends stop", async () => {
    const server = createServer({ apiKey: "dev-key" });

    try {
      await server.ready();
      const socket = await server.injectWS("/v1/realtime", {
        headers: { "x-api-key": "dev-key" },
      });
      openSockets.push(socket);

      const events = collectServerEvents(socket, 4);
      socket.send(JSON.stringify({ type: "start", targetLanguage: "zh-CN" }));
      sendAudioFrame(socket, 0, 0);
      sendAudioFrame(socket, 1, 250);
      sendAudioFrame(socket, 2, 500);
      await events; // reached the final for seg-1

      const closed = new Promise<number>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("socket did not close after stop")),
          1_000,
        );
        socket.on("close", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });

      socket.send(JSON.stringify({ type: "stop" }));

      const code = await closed;
      expect(code).not.toBe(1006); // clean close (not an abnormal 1006)
    } finally {
      await server.close();
    }
  });

  it("rejects missing and wrong api keys before websocket work starts", async () => {
    const server = createServer({ apiKey: "dev-key" });

    try {
      await server.ready();
      await expect(server.injectWS("/v1/realtime")).rejects.toThrow(
        "Unexpected server response: 401",
      );
      await expect(
        server.injectWS("/v1/realtime", {
          headers: { "x-api-key": "wrong-key" },
        }),
      ).rejects.toThrow("Unexpected server response: 401");
    } finally {
      await server.close();
    }
  });

  it("accepts api keys from the websocket query string for browser clients", async () => {
    const server = createServer({ apiKey: "dev-key" });

    try {
      await server.ready();
      const socket = await server.injectWS("/v1/realtime?apiKey=dev-key");
      openSockets.push(socket);

      const events = collectServerEvents(socket, 4);
      socket.send(JSON.stringify({ type: "start", targetLanguage: "zh-CN" }));
      sendAudioFrame(socket, 0, 0);
      sendAudioFrame(socket, 1, 250);
      sendAudioFrame(socket, 2, 500);

      const received = await events;
      expect(received).toHaveLength(SEGMENT_ONE.length);
      expect(received).toEqual(expect.arrayContaining(SEGMENT_ONE));
    } finally {
      await server.close();
    }
  });

  it("rejects a websocket handshake from a web page origin", async () => {
    const server = createServer({ apiKey: "dev-key" });
    try {
      await server.ready();
      await expect(
        server.injectWS("/v1/realtime", {
          headers: { "x-api-key": "dev-key", origin: "https://evil.example" },
        }),
      ).rejects.toThrow("Unexpected server response: 403");
    } finally {
      await server.close();
    }
  });

  it("accepts a websocket handshake from a chrome extension origin", async () => {
    const server = createServer({ apiKey: "dev-key" });
    try {
      await server.ready();
      const socket = await server.injectWS("/v1/realtime", {
        headers: { "x-api-key": "dev-key", origin: "chrome-extension://abcdefghijklmnop" },
      });
      openSockets.push(socket);
      expect(socket).toBeDefined();
    } finally {
      await server.close();
    }
  });

  it("sends a protocol error for malformed client messages", async () => {
    const server = createServer({ apiKey: "dev-key" });

    try {
      await server.ready();
      const socket = await server.injectWS("/v1/realtime", {
        headers: { "x-api-key": "dev-key" },
      });
      openSockets.push(socket);

      const event = collectServerEvents(socket, 1);
      socket.send(JSON.stringify({ type: "definitely-not-supported" }));

      await expect(event).resolves.toEqual([
        {
          type: "error",
          code: "invalid_client_message",
          message: "Malformed client message",
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it("treats binary frames as audio even when their bytes look like json", async () => {
    const server = createServer({ apiKey: "dev-key" });

    try {
      await server.ready();
      const socket = await server.injectWS("/v1/realtime", {
        headers: { "x-api-key": "dev-key" },
      });
      openSockets.push(socket);

      const events = collectServerEvents(socket, 4);
      socket.send(JSON.stringify({ type: "start", targetLanguage: "zh-CN" }));
      socket.send(Buffer.from([0x7b, 0xff, 0x00]));
      socket.send(Buffer.from([0x7b, 0xff, 0x00]));
      socket.send(Buffer.from([0x7b, 0xff, 0x00]));

      const binaryExpected = [
        { type: "language", sourceLanguage: "en", targetLanguage: "zh-CN" },
        { type: "partial", segmentId: "seg-1", sourceText: "hello", speakerId: "spk-a" },
        { type: "partial", segmentId: "seg-1", sourceText: "hello from", speakerId: "spk-a" },
        {
          type: "final",
          segmentId: "seg-1",
          sourceText: "hello from echoflow",
          translatedText: "[zh-CN] hello from echoflow",
          startTimeMs: 0,
          endTimeMs: 0,
          speakerId: "spk-a",
        },
      ];
      const received = await events;
      expect(received).toHaveLength(binaryExpected.length);
      expect(received).toEqual(expect.arrayContaining(binaryExpected));
    } finally {
      await server.close();
    }
  });
});

describe("history sync wiring", () => {
  const pushBody = {
    sessions: [{ id: "s1", updatedAtMs: 100, payload: { videoKey: "youtube:x" } }],
    segments: [
      { sessionId: "s1", segmentId: "e0:seg-1", payload: { sourceText: "hi" } },
    ],
  };

  it("does not register sync routes by default and reports sync unavailable", async () => {
    const server = createServer();
    await server.ready();

    const push = await server.inject({
      method: "POST",
      url: "/v1/sync/push",
      headers: { "x-api-key": "dev-key" },
      payload: pushBody,
    });
    expect(push.statusCode).toBe(404);

    const caps = await server.inject({
      method: "GET",
      url: "/v1/capabilities",
      headers: { "x-api-key": "dev-key" },
    });
    expect(caps.json().sync).toEqual({ available: false });

    await server.close();
  });

  it("registers sync routes when historyDbPath is set and round-trips a push", async () => {
    const server = createServer({ historyDbPath: ":memory:" });
    await server.ready();

    const caps = await server.inject({
      method: "GET",
      url: "/v1/capabilities",
      headers: { "x-api-key": "dev-key" },
    });
    expect(caps.json().sync).toEqual({ available: true });

    const push = await server.inject({
      method: "POST",
      url: "/v1/sync/push",
      headers: { "x-api-key": "dev-key" },
      payload: pushBody,
    });
    expect(push.statusCode).toBe(200);
    expect(push.json()).toEqual({ accepted: { sessions: 1, segments: 1 } });

    const pull = await server.inject({
      method: "GET",
      url: "/v1/sync/pull?since=0",
      headers: { "x-api-key": "dev-key" },
    });
    expect(pull.statusCode).toBe(200);
    expect(pull.json().sessions).toEqual(pushBody.sessions);
    expect(pull.json().segments).toEqual(pushBody.segments);

    await server.close();
  });

  it("rejects sync requests without the api key", async () => {
    const server = createServer({ historyDbPath: ":memory:" });
    await server.ready();

    const res = await server.inject({
      method: "GET",
      url: "/v1/sync/pull",
    });
    expect(res.statusCode).toBe(401);

    await server.close();
  });
});

function collectServerEvents(
  socket: WebSocket,
  expectedCount: number,
): Promise<ServerEvent[]> {
  return new Promise((resolve, reject) => {
    const events: ServerEvent[] = [];
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${expectedCount} server events`));
    }, 1_000);

    socket.on("error", reject);
    socket.on("message", (data) => {
      const parsed: unknown = JSON.parse(data.toString());
      if (!isServerEvent(parsed)) {
        clearTimeout(timeout);
        reject(new Error(`Received invalid server event: ${data.toString()}`));
        return;
      }

      events.push(parsed);
      if (events.length === expectedCount) {
        clearTimeout(timeout);
        resolve(events);
      }
    });
  });
}
