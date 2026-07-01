import { describe, expect, it } from "vitest";
import { deriveVersion } from "./deriveVersion";

describe("deriveVersion", () => {
  it("derives a plain release version", () => {
    expect(deriveVersion("v0.1.0")).toEqual({
      version: "0.1.0",
      versionName: "0.1.0",
      prerelease: false
    });
  });

  it("accepts a tag without the leading v", () => {
    expect(deriveVersion("1.2.3")).toEqual({
      version: "1.2.3",
      versionName: "1.2.3",
      prerelease: false
    });
  });

  it("keeps the suffix in versionName and marks prerelease", () => {
    expect(deriveVersion("v0.1.0-beta.2")).toEqual({
      version: "0.1.0",
      versionName: "0.1.0-beta.2",
      prerelease: true
    });
  });

  it("handles an rc suffix", () => {
    expect(deriveVersion("v2.0.0-rc.1")).toEqual({
      version: "2.0.0",
      versionName: "2.0.0-rc.1",
      prerelease: true
    });
  });

  it.each(["v1", "v1.2", "1.2.3.4.5", "vx.y.z", "", "v1.2.-beta", "v01.2.3"])(
    "rejects malformed tag %j",
    (tag) => {
      expect(() => deriveVersion(tag)).toThrow(/Invalid release tag/);
    }
  );
});
