import { describe, expect, it, vi } from "vitest";
import { createSerialQueue } from "./serialQueue";

describe("createSerialQueue", () => {
  it("runs tasks one at a time in arrival order", async () => {
    const order: string[] = [];
    const enqueue = createSerialQueue();
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      enqueue(async () => {
        order.push("a-start");
        resolve();
        await new Promise<void>((r) => {
          releaseFirst = r;
        });
        order.push("a-end");
      });
    });

    enqueue(async () => {
      order.push("b");
    });

    await firstStarted;
    expect(order).toEqual(["a-start"]); // b has NOT started while a is in flight
    releaseFirst();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });

  it("isolates a rejecting task and keeps draining", async () => {
    const onError = vi.fn();
    const enqueue = createSerialQueue(onError);
    const ran: string[] = [];

    enqueue(async () => {
      throw new Error("boom");
    });
    enqueue(async () => {
      ran.push("after");
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(ran).toEqual(["after"]);
  });
});
