import { afterEach, describe, expect, it } from "vitest";
import { createConfig } from "./config.js";

const ORIGINAL_ENV = {
  ECHOFLOW_API_KEY: process.env.ECHOFLOW_API_KEY,
  ECHOFLOW_PORT: process.env.ECHOFLOW_PORT,
  PORT: process.env.PORT,
};

describe("createConfig", () => {
  afterEach(() => {
    restoreEnv("ECHOFLOW_API_KEY", ORIGINAL_ENV.ECHOFLOW_API_KEY);
    restoreEnv("ECHOFLOW_PORT", ORIGINAL_ENV.ECHOFLOW_PORT);
    restoreEnv("PORT", ORIGINAL_ENV.PORT);
  });

  it("uses EchoFlow environment defaults", () => {
    process.env.ECHOFLOW_API_KEY = "custom-key";
    process.env.ECHOFLOW_PORT = "9999";
    delete process.env.PORT;

    expect(createConfig()).toEqual({
      apiKey: "custom-key",
      port: 9999,
    });
  });

  it("keeps PORT as a compatibility fallback", () => {
    delete process.env.ECHOFLOW_PORT;
    process.env.PORT = "7777";

    expect(createConfig().port).toBe(7777);
  });

  it("prefers explicit input over environment values", () => {
    process.env.ECHOFLOW_API_KEY = "env-key";
    process.env.ECHOFLOW_PORT = "9999";

    expect(createConfig({ apiKey: "input-key", port: 8888 })).toEqual({
      apiKey: "input-key",
      port: 8888,
    });
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
