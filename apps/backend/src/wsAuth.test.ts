import { describe, expect, it } from "vitest";
import { createApiKeyVerifier, isAllowedOrigin, timingSafeKeyMatch } from "./wsAuth.js";

describe("isAllowedOrigin", () => {
  it("allows a non-browser client with no Origin", () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
  });

  it("allows a chrome extension origin", () => {
    expect(isAllowedOrigin("chrome-extension://abcdefghijklmnop")).toBe(true);
  });

  it("rejects a web page origin", () => {
    expect(isAllowedOrigin("https://evil.example")).toBe(false);
    expect(isAllowedOrigin("http://localhost:3000")).toBe(false);
  });
});

describe("timingSafeKeyMatch", () => {
  it("matches an exact key", () => {
    expect(timingSafeKeyMatch("dev-key", "dev-key")).toBe(true);
  });

  it("rejects a wrong key, a length mismatch, and undefined", () => {
    expect(timingSafeKeyMatch("wrong-key", "dev-key")).toBe(false);
    expect(timingSafeKeyMatch("dev-key-longer", "dev-key")).toBe(false);
    expect(timingSafeKeyMatch(undefined, "dev-key")).toBe(false);
  });
});

describe("createApiKeyVerifier", () => {
  it("verifies the matching key and rejects others", () => {
    const verify = createApiKeyVerifier("secret-key");
    expect(verify("secret-key")).toBe(true);
    expect(verify("wrong-key")).toBe(false);
    expect(verify("")).toBe(false);
    expect(verify(undefined)).toBe(false);
  });
});
