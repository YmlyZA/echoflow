import { describe, expect, it } from "vitest";
import { createConfig } from "./config.js";
import {
  assertConfigUsable,
  describeConfigHealth,
  formatConfigHealth,
} from "./configHealth.js";

const fakeConfig = () =>
  createConfig({
    providers: { asr: { provider: "fake" }, translation: { provider: "fake" } },
  });

const volcAsrNoCreds = () =>
  createConfig({
    providers: { asr: { provider: "volcengine" }, translation: { provider: "fake" } },
  });

const volcAsrWithCreds = () =>
  createConfig({
    providers: {
      asr: {
        provider: "volcengine",
        volcengine: {
          appKey: "app",
          accessKey: "secret",
          resourceId: "res",
          endpoint: "wss://example.test",
        },
      },
      translation: { provider: "fake" },
    },
  });

const asrUnimplemented = () =>
  createConfig({
    providers: { asr: { provider: "aliyun" }, translation: { provider: "fake" } },
  });

const translationUnimplemented = () =>
  createConfig({
    providers: { asr: { provider: "fake" }, translation: { provider: "tencent" } },
  });

const openAiNoCreds = () =>
  createConfig({
    providers: { asr: { provider: "openai" }, translation: { provider: "openai" } },
  });

const openAiWithCreds = () =>
  createConfig({
    providers: {
      asr: {
        provider: "openai",
        openai: { apiKey: "sk", baseUrl: "https://api.openai.com/v1", model: "m", silenceMs: 600 },
      },
      translation: {
        provider: "openai",
        openai: { apiKey: "sk", baseUrl: "https://api.openai.com/v1", model: "m" },
      },
    },
  });

describe("describeConfigHealth", () => {
  it("treats openai as implemented and names OPENAI_API_KEY when a leg is missing", () => {
    const health = describeConfigHealth(openAiNoCreds());
    expect(health.find((c) => c.name === "asr")).toMatchObject({
      provider: "openai",
      ready: false,
      demo: false,
      unimplemented: false,
      missing: ["OPENAI_API_KEY"],
    });
    expect(health.find((c) => c.name === "translation")).toMatchObject({
      ready: false,
      unimplemented: false,
      missing: ["OPENAI_API_KEY"],
    });
  });

  it("marks credentialed openai legs ready and not demo", () => {
    const health = describeConfigHealth(openAiWithCreds());
    for (const name of ["asr", "translation"] as const) {
      expect(health.find((c) => c.name === name)).toMatchObject({ ready: true, demo: false, missing: [] });
    }
  });

  it("marks fake providers ready and demo", () => {
    const asr = describeConfigHealth(fakeConfig()).find((c) => c.name === "asr");
    expect(asr).toMatchObject({ provider: "fake", ready: true, demo: true, missing: [] });
  });

  it("marks a selected provider without credentials not ready", () => {
    const asr = describeConfigHealth(volcAsrNoCreds()).find((c) => c.name === "asr");
    expect(asr?.ready).toBe(false);
    expect(asr?.demo).toBe(false);
    expect(asr?.missing).toEqual([
      "VOLCENGINE_ASR_APP_KEY",
      "VOLCENGINE_ASR_ACCESS_KEY",
    ]);
  });

  it("marks a credentialed provider ready and not demo", () => {
    const asr = describeConfigHealth(volcAsrWithCreds()).find((c) => c.name === "asr");
    expect(asr).toMatchObject({ ready: true, demo: false, missing: [] });
  });

  it("reports interpret as not ready without an AST key", () => {
    const interpret = describeConfigHealth(fakeConfig()).find(
      (c) => c.name === "interpret",
    );
    expect(interpret?.ready).toBe(false);
    expect(interpret?.missing).toEqual(["VOLCENGINE_AST_API_KEY"]);
  });

  it("marks an unimplemented asr provider not ready, not demo, and unimplemented", () => {
    const asr = describeConfigHealth(asrUnimplemented()).find((c) => c.name === "asr");
    expect(asr).toMatchObject({
      provider: "aliyun",
      ready: false,
      demo: false,
      unimplemented: true,
      missing: [],
    });
  });

  it("marks an unimplemented translation provider not ready, not demo, and unimplemented", () => {
    const translation = describeConfigHealth(translationUnimplemented()).find(
      (c) => c.name === "translation",
    );
    expect(translation).toMatchObject({
      provider: "tencent",
      ready: false,
      demo: false,
      unimplemented: true,
      missing: [],
    });
  });
});

describe("assertConfigUsable", () => {
  it("accepts the all-fake demo configuration", () => {
    expect(() => assertConfigUsable(describeConfigHealth(fakeConfig()))).not.toThrow();
  });

  it("accepts a backend with no interpret credentials", () => {
    expect(() =>
      assertConfigUsable(describeConfigHealth(volcAsrWithCreds())),
    ).not.toThrow();
  });

  it("throws naming the missing variables", () => {
    expect(() => assertConfigUsable(describeConfigHealth(volcAsrNoCreds()))).toThrow(
      /VOLCENGINE_ASR_APP_KEY/,
    );
  });

  it("throws naming OPENAI_API_KEY for an openai leg without a key", () => {
    expect(() => assertConfigUsable(describeConfigHealth(openAiNoCreds()))).toThrow(
      /asr requires OPENAI_API_KEY; translation requires OPENAI_API_KEY/,
    );
  });

  it("throws naming the provider for an unimplemented asr provider, not a blank message", () => {
    expect(() =>
      assertConfigUsable(describeConfigHealth(asrUnimplemented())),
    ).toThrow(/asr provider aliyun is not implemented yet; use fake, volcengine or openai/);
  });

  it("throws naming the provider for an unimplemented translation provider, not a blank message", () => {
    expect(() =>
      assertConfigUsable(describeConfigHealth(translationUnimplemented())),
    ).toThrow(
      /translation provider tencent is not implemented yet; use fake, volcengine or openai/,
    );
  });
});

describe("formatConfigHealth", () => {
  it("names the demo mode in plain text", () => {
    expect(formatConfigHealth(describeConfigHealth(fakeConfig()))).toContain("demo");
  });

  it("names the provider and suggests alternatives for an unimplemented provider", () => {
    const text = formatConfigHealth(describeConfigHealth(asrUnimplemented()));
    expect(text).toContain("aliyun is not implemented yet; use fake, volcengine or openai");
  });
});
