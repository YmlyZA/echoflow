import { describe, expect, it, vi } from "vitest";
import { fetchCapabilities } from "./capabilitiesClient.js";

const DESCRIPTOR = {
  modes: {
    pipeline: { available: true, autoDetect: true, languages: [{ code: "en", label: "English", pivot: false }] },
    interpret: { available: true, autoDetect: false, languages: [{ code: "zh", label: "中文", pivot: true }] },
  },
};

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn(impl) as unknown as typeof fetch;
}

describe("fetchCapabilities", () => {
  it("requests <origin>/v1/capabilities with the api key and returns the descriptor", async () => {
    const f = mockFetch(async (url, init) => {
      expect(url).toBe("http://127.0.0.1:8787/v1/capabilities");
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("k");
      return new Response(JSON.stringify(DESCRIPTOR), { status: 200 });
    });
    const result = await fetchCapabilities("http://127.0.0.1:8787", "k", f);
    expect(result).toEqual(DESCRIPTOR);
  });

  it("returns null on a non-200 response", async () => {
    const f = mockFetch(async () => new Response("nope", { status: 401 }));
    expect(await fetchCapabilities("http://127.0.0.1:8787", "k", f)).toBeNull();
  });

  it("returns null on a malformed body", async () => {
    const f = mockFetch(async () => new Response(JSON.stringify({ modes: {} }), { status: 200 }));
    expect(await fetchCapabilities("http://127.0.0.1:8787", "k", f)).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    const f = mockFetch(async () => { throw new Error("network"); });
    expect(await fetchCapabilities("http://127.0.0.1:8787", "k", f)).toBeNull();
  });

  it("returns null for an unparseable serverUrl", async () => {
    const f = mockFetch(async () => new Response("{}", { status: 200 }));
    expect(await fetchCapabilities("not a url", "k", f)).toBeNull();
  });
});
