import { describe, expect, it } from "vitest";
import { buildServerHttpUrl } from "./serverHttpUrl";

describe("buildServerHttpUrl", () => {
  it("maps ws/wss schemes to http/https", () => {
    expect(buildServerHttpUrl("ws://127.0.0.1:8787", "/v1/sync/pull")).toBe(
      "http://127.0.0.1:8787/v1/sync/pull"
    );
    expect(buildServerHttpUrl("wss://127.0.0.1:8787", "/v1/sync/pull")).toBe(
      "https://127.0.0.1:8787/v1/sync/pull"
    );
  });

  it("keeps http/https and joins the path through a trailing slash", () => {
    expect(buildServerHttpUrl("http://127.0.0.1:8787/", "/v1/capabilities")).toBe(
      "http://127.0.0.1:8787/v1/capabilities"
    );
    expect(buildServerHttpUrl("http://localhost:8787/base/", "/v1/capabilities")).toBe(
      "http://localhost:8787/base/v1/capabilities"
    );
  });

  it("strips query and hash and trims whitespace", () => {
    expect(
      buildServerHttpUrl("  http://127.0.0.1:8787?apiKey=x#frag  ", "/v1/sync/push")
    ).toBe("http://127.0.0.1:8787/v1/sync/push");
  });

  it("returns null for an unparseable url", () => {
    expect(buildServerHttpUrl("not a url", "/v1/capabilities")).toBeNull();
    expect(buildServerHttpUrl("", "/v1/capabilities")).toBeNull();
  });
});
