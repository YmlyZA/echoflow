import { describe, expect, it } from "vitest";
import { isRuntimeMessage } from "./messages";

describe("isRuntimeMessage", () => {
  it("accepts CONNECTION_STATUS messages", () => {
    expect(
      isRuntimeMessage({
        type: "CONNECTION_STATUS",
        localSessionId: "local-1",
        status: "reconnecting",
      }),
    ).toBe(true);
  });

  it("rejects unknown message types", () => {
    expect(isRuntimeMessage({ type: "NOPE" })).toBe(false);
  });
});
