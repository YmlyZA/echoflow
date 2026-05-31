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

describe("backend realtime websocket", () => {
  it("emits deterministic language, partial, and final events after a start message", async () => {
    const server = createServer({ apiKey: "dev-key" });

    try {
      await server.ready();
      const socket = await server.injectWS("/v1/realtime", {
        headers: { "x-api-key": "dev-key" },
      });
      openSockets.push(socket);

      const events = collectServerEvents(socket, 3);
      socket.send(JSON.stringify({ type: "start", targetLanguage: "zh-CN" }));

      await expect(events).resolves.toEqual([
        {
          type: "language",
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
        },
        {
          type: "partial",
          segmentId: "fake-1",
          sourceText: "hello from fake speech",
          translatedText: "你好，来自模拟语音",
        },
        {
          type: "final",
          segmentId: "fake-1",
          sourceText: "hello from fake speech provider",
          translatedText: "你好，来自模拟语音提供器",
        },
      ]);
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

      const events = collectServerEvents(socket, 3);
      socket.send(Buffer.from([0x7b, 0xff, 0x00]));

      await expect(events).resolves.toEqual([
        {
          type: "language",
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
        },
        {
          type: "partial",
          segmentId: "fake-1",
          sourceText: "hello from fake speech",
          translatedText: "你好，来自模拟语音",
        },
        {
          type: "final",
          segmentId: "fake-1",
          sourceText: "hello from fake speech provider",
          translatedText: "你好，来自模拟语音提供器",
        },
      ]);
    } finally {
      await server.close();
    }
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
