import { describe, expect, it } from "vitest";
import { withReconnect, defaultClassify, type TransportCallbacks, type TransportLike } from "./reconnectingTransport";

/** A mock transport whose callbacks the test drives directly. */
function makeMock() {
  const sockets: Array<{ cb: TransportCallbacks; sent: Buffer[]; closed: boolean }> = [];
  const connect = (cb: TransportCallbacks): TransportLike => {
    const socket = { cb, sent: [] as Buffer[], closed: false };
    sockets.push(socket);
    return {
      send: (d) => socket.sent.push(d),
      close: () => { socket.closed = true; }
    };
  };
  return { connect, sockets };
}

const B = (s: string) => Buffer.from(s);

describe("withReconnect", () => {
  it("does not emit status on the first connect and runs initialize once", () => {
    const { connect, sockets } = makeMock();
    const statuses: string[] = [];
    withReconnect(connect, {
      onMessage: () => {}, onError: () => {},
      initialize: (t) => t.send(B("init")),
      onStatus: (s) => statuses.push(s),
      setTimer: () => {}
    });
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent.map(String)).toEqual(["init"]);
    expect(statuses).toEqual([]);
  });

  it("reconnects on a retryable close: reconnecting → re-init → live on first message", () => {
    const { connect, sockets } = makeMock();
    const statuses: string[] = [];
    const messages: string[] = [];
    let fireTimer: () => void = () => {};
    withReconnect(connect, {
      onMessage: (d) => messages.push(String(d)), onError: () => {},
      initialize: (t) => t.send(B("init")),
      onStatus: (s) => statuses.push(s),
      setTimer: (fn) => { fireTimer = fn; }
    });
    sockets[0]!.cb.onClose(1006, "abnormal");   // retryable drop
    expect(statuses).toEqual(["reconnecting"]);
    fireTimer();                                 // backoff elapses → reconnect
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.sent.map(String)).toEqual(["init"]); // re-initialized
    expect(statuses).toEqual(["reconnecting"]);  // not live until data flows
    sockets[1]!.cb.onMessage(B("hello"));
    expect(statuses).toEqual(["reconnecting", "live"]);
    expect(messages).toEqual(["hello"]);
  });

  it("drops sends while reconnecting and resumes after recovery", () => {
    const { connect, sockets } = makeMock();
    let fireTimer: () => void = () => {};
    const t = withReconnect(connect, {
      onMessage: () => {}, onError: () => {},
      initialize: () => {}, onStatus: () => {},
      setTimer: (fn) => { fireTimer = fn; }
    });
    sockets[0]!.cb.onClose(1006, "x");
    t.send(B("dropped"));                         // during gap → dropped
    fireTimer();
    sockets[1]!.cb.onMessage(B("m"));             // back to live
    t.send(B("kept"));
    expect(sockets[1]!.sent.map(String)).toEqual(["kept"]);
  });

  it("propagates a fatal (non-retryable) close without retrying", () => {
    const { connect, sockets } = makeMock();
    const errors: string[] = [];
    withReconnect(connect, {
      onMessage: () => {}, onError: (e) => errors.push(e.message),
      initialize: () => {}, onStatus: () => {}, setTimer: () => {}
    });
    sockets[0]!.cb.onClose(4401, "unauthorized"); // fatal code
    expect(sockets).toHaveLength(1);              // no reconnect
    expect(errors).toHaveLength(1);
  });

  it("gives up after the backoff schedule is exhausted", () => {
    const { connect, sockets } = makeMock();
    const errors: string[] = [];
    let fireTimer: () => void = () => {};
    withReconnect(connect, {
      onMessage: () => {}, onError: (e) => errors.push(e.message),
      initialize: () => {}, onStatus: () => {},
      backoff: [10, 10], setTimer: (fn) => { fireTimer = fn; }
    });
    sockets[0]!.cb.onClose(1006, "x"); fireTimer(); // attempt 1
    sockets[1]!.cb.onClose(1006, "x"); fireTimer(); // attempt 2
    sockets[2]!.cb.onClose(1006, "x");              // exhausted → fatal
    expect(errors).toHaveLength(1);
    expect(sockets).toHaveLength(3);
  });

  it("stops reconnecting after close()", () => {
    const { connect, sockets } = makeMock();
    let fireTimer: () => void = () => {};
    const t = withReconnect(connect, {
      onMessage: () => {}, onError: () => {},
      initialize: () => {}, onStatus: () => {},
      setTimer: (fn) => { fireTimer = fn; }
    });
    sockets[0]!.cb.onClose(1006, "x");
    t.close();
    fireTimer();                                   // must NOT reconnect
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(true);
  });

  it("schedules only one reconnect when a socket fires both onError and onClose", () => {
    const { connect, sockets } = makeMock();
    let timers = 0;
    withReconnect(connect, {
      onMessage: () => {}, onError: () => {},
      initialize: () => {}, onStatus: () => {},
      setTimer: () => { timers += 1; }
    });
    sockets[0]!.cb.onError(new Error("net"));   // first failure settles the attempt
    sockets[0]!.cb.onClose(1006, "x");           // same socket → must be ignored
    expect(timers).toBe(1);
  });

  it("defaultClassify: network errors + abnormal codes retryable, clean/app codes fatal", () => {
    expect(defaultClassify({ error: new Error("net") })).toBe(true);
    expect(defaultClassify({ code: 1006 })).toBe(true);
    expect(defaultClassify({ code: 1000 })).toBe(false);
    expect(defaultClassify({ code: 4401 })).toBe(false);
  });
});
