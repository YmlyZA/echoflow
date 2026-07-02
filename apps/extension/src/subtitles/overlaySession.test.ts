import { describe, expect, it } from "vitest";
import { isStopForCurrentSession } from "./overlaySession";

describe("isStopForCurrentSession", () => {
  it("matches the tracked session id", () => {
    expect(isStopForCurrentSession("local-1", "local-1")).toBe(true);
  });

  it("ignores a stop for a different session", () => {
    expect(isStopForCurrentSession("local-1", "local-2")).toBe(false);
  });

  it("tears down when no session has been tracked yet", () => {
    expect(isStopForCurrentSession(null, "local-1")).toBe(true);
  });
});
