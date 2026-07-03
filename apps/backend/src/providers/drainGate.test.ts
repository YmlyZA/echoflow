import { describe, expect, it } from "vitest";
import { createDrainGate } from "./drainGate";

describe("createDrainGate", () => {
  it("resolves when a final arrives after arming", async () => {
    const gate = createDrainGate({ setTimer: () => {}, timeoutMs: 1000 });
    gate.arm();
    const waited = gate.wait();
    gate.onFinal();
    await expect(waited).resolves.toBeUndefined();
  });

  it("resolves via the timeout when no final arrives", async () => {
    let fire: () => void = () => {};
    const gate = createDrainGate({ setTimer: (fn) => { fire = fn; }, timeoutMs: 1000 });
    gate.arm();
    const waited = gate.wait();
    fire(); // simulate the timeout elapsing
    await expect(waited).resolves.toBeUndefined();
  });

  it("ignores finals emitted before arming", async () => {
    let fire: () => void = () => {};
    const gate = createDrainGate({ setTimer: (fn) => { fire = fn; }, timeoutMs: 1000 });
    gate.onFinal(); // pre-arm final must NOT satisfy the wait
    gate.arm();
    const waited = gate.wait();
    let settled = false;
    void waited.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    fire();
    await expect(waited).resolves.toBeUndefined();
  });

  it("resolves immediately when wait() is called after a final already settled it", async () => {
    const gate = createDrainGate({ setTimer: () => {}, timeoutMs: 1000 });
    gate.arm();
    gate.onFinal(); // settles before wait() is called
    await expect(gate.wait()).resolves.toBeUndefined();
  });

  it("cancel() resolves an in-flight wait without waiting for the timeout", async () => {
    const gate = createDrainGate({ setTimer: () => {}, timeoutMs: 1000 });
    gate.arm();
    const waited = gate.wait(); // timeout timer is a no-op, so only cancel can settle it
    gate.cancel();
    await expect(waited).resolves.toBeUndefined();
  });

  it("cancel() before wait() makes the subsequent wait() resolve immediately", async () => {
    const gate = createDrainGate({ setTimer: () => {}, timeoutMs: 1000 });
    gate.cancel();
    await expect(gate.wait()).resolves.toBeUndefined();
  });
});
