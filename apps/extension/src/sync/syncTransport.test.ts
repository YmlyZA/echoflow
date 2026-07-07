import { describe, expect, it } from "vitest";
import type { SyncPullResponse } from "@echoflow/protocol";
import { createFetchSyncTransport } from "./syncTransport";

const emptyPull: SyncPullResponse = {
  sessions: [],
  segments: [],
  nextCursor: 7,
  hasMore: false
};

function fakeFetch(
  handler: (url: string, init?: RequestInit) => { status: number; body: unknown }
): { impl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

describe("createFetchSyncTransport", () => {
  it("returns null for an unparseable serverUrl", () => {
    expect(
      createFetchSyncTransport({ serverUrl: "not a url", apiKey: "k" })
    ).toBeNull();
  });

  it("POSTs the push request as JSON with the api key header", async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 200,
      body: { accepted: { sessions: 1, segments: 2 } }
    }));
    const transport = createFetchSyncTransport({
      serverUrl: "ws://127.0.0.1:8787",
      apiKey: "secret",
      fetchImpl: impl
    });

    const request = { sessions: [], segments: [] };
    const response = await transport!.push(request);

    expect(response.accepted).toEqual({ sessions: 1, segments: 2 });
    expect(calls[0].url).toBe("http://127.0.0.1:8787/v1/sync/push");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.headers).toMatchObject({
      "content-type": "application/json",
      "x-api-key": "secret"
    });
    expect(calls[0].init?.body).toBe(JSON.stringify(request));
  });

  it("GETs pull with the since cursor and validates the response", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: emptyPull }));
    const transport = createFetchSyncTransport({
      serverUrl: "http://127.0.0.1:8787",
      apiKey: "secret",
      fetchImpl: impl
    });

    const page = await transport!.pull(5);

    expect(page).toEqual(emptyPull);
    expect(calls[0].url).toBe("http://127.0.0.1:8787/v1/sync/pull?since=5");
    expect(calls[0].init?.headers).toMatchObject({ "x-api-key": "secret" });
  });

  it("throws on non-ok responses with the status in the message", async () => {
    const { impl } = fakeFetch(() => ({ status: 401, body: { error: "Unauthorized" } }));
    const transport = createFetchSyncTransport({
      serverUrl: "http://127.0.0.1:8787",
      apiKey: "wrong",
      fetchImpl: impl
    });

    await expect(transport!.push({ sessions: [], segments: [] })).rejects.toThrow(
      "sync_push_failed_401"
    );
    await expect(transport!.pull(0)).rejects.toThrow("sync_pull_failed_401");
  });

  it("throws when the pull response fails the protocol guard", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: { nope: true } }));
    const transport = createFetchSyncTransport({
      serverUrl: "http://127.0.0.1:8787",
      apiKey: "secret",
      fetchImpl: impl
    });

    await expect(transport!.pull(0)).rejects.toThrow("sync_pull_invalid_response");
  });
});
