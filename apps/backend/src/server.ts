import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { createConfig, type BackendConfigInput } from "./config.js";
import { FakeSpeechProvider } from "./providers/fakeSpeechProvider.js";
import { FakeTranslationProvider } from "./providers/fakeTranslationProvider.js";
import { RealtimeSession } from "./realtime/session.js";

export function createServer(input: BackendConfigInput = {}): FastifyInstance {
  const config = createConfig(input);
  const server = Fastify({ logger: false });

  void server.register(websocket);

  server.get("/healthz", async () => ({ ok: true }));

  void server.register(async (realtimeServer) => {
    realtimeServer.get(
      "/v1/realtime",
      {
        websocket: true,
        preValidation: async (request, reply) => {
          if (request.headers["x-api-key"] !== config.apiKey) {
            return reply.code(401).send({ error: "Unauthorized" });
          }

          return undefined;
        },
      },
      (socket) => {
        const session = new RealtimeSession({
          socket,
          speechProvider: new FakeSpeechProvider(),
          translationProvider: new FakeTranslationProvider(),
          defaultTargetLanguage: "zh-CN",
        });

        session.start();
      },
    );
  });

  return server;
}
