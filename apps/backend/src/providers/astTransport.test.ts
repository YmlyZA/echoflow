import { describe, expect, it } from "vitest";
import type { AstTransport, AstTransportFactory } from "./astTransport.js";

describe("AstTransport contract", () => {
  it("a stub factory satisfies the interface used by the provider", () => {
    const sent: Buffer[] = [];
    const factory: AstTransportFactory = (_options, _callbacks) => {
      const transport: AstTransport = {
        send: (data) => sent.push(data),
        close: () => {},
      };
      return transport;
    };
    const t = factory(
      { endpoint: "wss://x", headers: {} },
      { onMessage: () => {}, onError: () => {}, onClose: () => {} },
    );
    t.send(Buffer.from([1, 2, 3]));
    expect(sent).toHaveLength(1);
  });
});
