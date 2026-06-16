import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOLCENGINE_ASR_ENDPOINT,
  DEFAULT_VOLCENGINE_ASR_RESOURCE_ID,
} from "./providerConfig.js";

describe("Volcengine ASR defaults", () => {
  it("targets the bidirectional bigmodel endpoint and duration resource", () => {
    expect(DEFAULT_VOLCENGINE_ASR_ENDPOINT).toBe(
      "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
    );
    expect(DEFAULT_VOLCENGINE_ASR_RESOURCE_ID).toBe("volc.bigasr.sauc.duration");
  });
});
