import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { createConfig, type BackendConfigInput } from "./config.js";
import { buildCapabilities } from "./realtime/capabilities.js";
import { createSubtitleSourceFactory } from "./realtime/subtitleSourceFactory.js";
import { RealtimeSession } from "./realtime/session.js";

export function createServer(input: BackendConfigInput = {}): FastifyInstance {
  const config = createConfig(input);
  const server = Fastify({ logger: false });

  void server.register(websocket);

  server.get("/healthz", async () => ({ ok: true }));

  server.get("/v1/capabilities", async (request, reply) => {
    if (request.headers["x-api-key"] !== config.apiKey) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    return buildCapabilities(config.providers);
  });

  void server.register(async (realtimeServer) => {
    realtimeServer.get(
      "/v1/realtime",
      {
        websocket: true,
        preValidation: async (request, reply) => {
          const queryApiKey =
            typeof request.query === "object" &&
            request.query !== null &&
            "apiKey" in request.query &&
            typeof request.query.apiKey === "string"
              ? request.query.apiKey
              : undefined;

          if (
            request.headers["x-api-key"] !== config.apiKey &&
            queryApiKey !== config.apiKey
          ) {
            return reply.code(401).send({ error: "Unauthorized" });
          }

          return undefined;
        },
      },
      (socket) => {
        const session = new RealtimeSession({
          socket,
          createSubtitleSource: createSubtitleSourceFactory(config.providers),
          defaultTargetLanguage: "zh-CN",
        });

        session.start();
      },
    );
  });

  return server;
}
