import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApiKeyVerifier } from "../wsAuth.js";
import { createInMemoryHistoryRepository } from "./inMemoryHistoryRepository.js";
import { registerSyncRoutes } from "./syncRoutes.js";

const KEY = "test-key";

let server: FastifyInstance;

function makeServer(): FastifyInstance {
  server = Fastify({ logger: false });
  registerSyncRoutes(server, {
    repository: createInMemoryHistoryRepository(),
    verifyApiKey: createApiKeyVerifier(KEY),
  });
  return server;
}

afterEach(async () => {
  await server.close();
});

const pushBody = {
  sessions: [
    { id: "s1", updatedAtMs: 100, payload: { videoKey: "youtube:x" } },
  ],
  segments: [
    { sessionId: "s1", segmentId: "e0:seg-1", payload: { sourceText: "hi" } },
  ],
};

describe("POST /v1/sync/push", () => {
  it("rejects a missing or wrong api key with 401", async () => {
    const app = makeServer();
    const noKey = await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      payload: pushBody,
    });
    expect(noKey.statusCode).toBe(401);

    const wrongKey = await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      headers: { "x-api-key": "nope" },
      payload: pushBody,
    });
    expect(wrongKey.statusCode).toBe(401);
  });

  it("rejects a malformed body with 400", async () => {
    const app = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      headers: { "x-api-key": KEY },
      payload: { sessions: "nope" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_sync_push" });
  });

  it("accepts a valid push and reports counts", async () => {
    const app = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      headers: { "x-api-key": KEY },
      payload: pushBody,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: { sessions: 1, segments: 1 } });
  });
});

describe("GET /v1/sync/pull", () => {
  it("rejects a missing api key with 401", async () => {
    const app = makeServer();
    const res = await app.inject({ method: "GET", url: "/v1/sync/pull" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a non-integer or negative since with 400", async () => {
    const app = makeServer();
    for (const since of ["abc", "-1", "1.5"]) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/sync/pull?since=${since}`,
        headers: { "x-api-key": KEY },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "invalid_since" });
    }
  });

  it("round-trips pushed records, then returns an empty delta", async () => {
    const app = makeServer();
    await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      headers: { "x-api-key": KEY },
      payload: pushBody,
    });

    const full = await app.inject({
      method: "GET",
      url: "/v1/sync/pull",
      headers: { "x-api-key": KEY },
    });
    expect(full.statusCode).toBe(200);
    const body = full.json();
    expect(body.sessions).toEqual(pushBody.sessions);
    expect(body.segments).toEqual(pushBody.segments);
    expect(body.hasMore).toBe(false);

    const delta = await app.inject({
      method: "GET",
      url: `/v1/sync/pull?since=${body.nextCursor}`,
      headers: { "x-api-key": KEY },
    });
    expect(delta.json()).toEqual({
      sessions: [],
      segments: [],
      nextCursor: body.nextCursor,
      hasMore: false,
    });
  });
});
