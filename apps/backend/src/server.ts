import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { createConfig, type BackendConfigInput } from "./config.js";
import { createSqliteHistoryRepository } from "./history/sqliteHistoryRepository.js";
import { registerSyncRoutes } from "./history/syncRoutes.js";
import { buildCapabilities } from "./realtime/capabilities.js";
import { createSubtitleSourceFactory } from "./realtime/subtitleSourceFactory.js";
import { RealtimeSession } from "./realtime/session.js";
import { createApiKeyVerifier, isAllowedOrigin } from "./wsAuth.js";

export function createServer(input: BackendConfigInput = {}): FastifyInstance {
  const config = createConfig(input);
  const verifyApiKey = createApiKeyVerifier(config.apiKey);
  const historyRepository =
    config.historyDbPath !== undefined
      ? createSqliteHistoryRepository(config.historyDbPath)
      : undefined;
  const server = Fastify({ logger: false });

  void server.register(websocket);

  server.get("/healthz", async () => ({ ok: true }));

  server.get("/v1/capabilities", async (request, reply) => {
    const headerKey =
      typeof request.headers["x-api-key"] === "string"
        ? request.headers["x-api-key"]
        : undefined;
    if (!verifyApiKey(headerKey)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    return buildCapabilities(config.providers, {
      syncAvailable: historyRepository !== undefined,
    });
  });

  if (historyRepository !== undefined) {
    const repository = historyRepository;
    registerSyncRoutes(server, { repository, verifyApiKey });
    server.addHook("onClose", async () => {
      await repository.close();
    });
  }

  void server.register(async (realtimeServer) => {
    realtimeServer.get(
      "/v1/realtime",
      {
        websocket: true,
        preValidation: async (request, reply) => {
          const origin =
            typeof request.headers.origin === "string"
              ? request.headers.origin
              : undefined;
          if (!isAllowedOrigin(origin)) {
            return reply.code(403).send({ error: "Forbidden origin" });
          }

          const headerKey =
            typeof request.headers["x-api-key"] === "string"
              ? request.headers["x-api-key"]
              : undefined;
          const queryApiKey =
            typeof request.query === "object" &&
            request.query !== null &&
            "apiKey" in request.query &&
            typeof request.query.apiKey === "string"
              ? request.query.apiKey
              : undefined;

          if (
            !verifyApiKey(headerKey) &&
            !verifyApiKey(queryApiKey)
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
