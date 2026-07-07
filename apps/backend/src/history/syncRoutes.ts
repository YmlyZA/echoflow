import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  isSyncPushRequest,
  type SyncPullResponse,
  type SyncPushResponse,
} from "@echoflow/protocol";
import type { HistoryRepository } from "./historyRepository.js";

export const SYNC_PUSH_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
export const SYNC_PULL_PAGE_LIMIT = 500;

export interface SyncRouteOptions {
  repository: HistoryRepository;
  verifyApiKey: (provided: string | undefined) => boolean;
}

/**
 * History sync routes. Auth is header-only (`x-api-key`): a cross-origin web
 * page cannot attach the header without a CORS preflight, which this server
 * never approves — so no separate Origin check is needed here.
 */
export function registerSyncRoutes(
  server: FastifyInstance,
  options: SyncRouteOptions,
): void {
  function authorized(request: FastifyRequest, reply: FastifyReply): boolean {
    const headerKey =
      typeof request.headers["x-api-key"] === "string"
        ? request.headers["x-api-key"]
        : undefined;
    if (!options.verifyApiKey(headerKey)) {
      void reply.code(401).send({ error: "Unauthorized" });
      return false;
    }
    return true;
  }

  server.post(
    "/v1/sync/push",
    { bodyLimit: SYNC_PUSH_BODY_LIMIT_BYTES },
    async (request, reply) => {
      if (!authorized(request, reply)) {
        return reply;
      }
      if (!isSyncPushRequest(request.body)) {
        return reply.code(400).send({ error: "invalid_sync_push" });
      }
      await options.repository.upsertSessions(request.body.sessions, null);
      await options.repository.upsertSegments(request.body.segments, null);
      const response: SyncPushResponse = {
        accepted: {
          sessions: request.body.sessions.length,
          segments: request.body.segments.length,
        },
      };
      return response;
    },
  );

  server.get("/v1/sync/pull", async (request, reply) => {
    if (!authorized(request, reply)) {
      return reply;
    }
    const query = request.query as Record<string, unknown>;
    const sinceRaw = typeof query.since === "string" ? query.since : undefined;
    const since = sinceRaw === undefined ? 0 : Number(sinceRaw);
    if (!Number.isInteger(since) || since < 0) {
      return reply.code(400).send({ error: "invalid_since" });
    }
    const response: SyncPullResponse = await options.repository.changesSince(
      since,
      SYNC_PULL_PAGE_LIMIT,
      null,
    );
    return response;
  });
}
