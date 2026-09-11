import { describe, expect, it } from "vitest";
import { describeBlocker } from "./describeBlocker";

describe("describeBlocker", () => {
  it("describes missing ASR credentials", () => {
    expect(describeBlocker("asr_credentials_missing")).toContain("VOLCENGINE_ASR_APP_KEY");
  });

  it("describes an unimplemented provider", () => {
    expect(describeBlocker("asr_provider_unimplemented")).toContain("not implemented");
  });

  it("falls back for an unknown code", () => {
    expect(describeBlocker("quantum_flux")).toContain("quantum_flux");
  });

  it("never uses an apostrophe", () => {
    for (const code of [
      "asr_credentials_missing",
      "translation_credentials_missing",
      "interpret_credentials_missing",
      "asr_provider_unimplemented",
      "translation_provider_unimplemented",
      "unknown_code",
    ]) {
      expect(describeBlocker(code)).not.toContain("'");
    }
  });
});
