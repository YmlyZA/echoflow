export type TransportCallbacks = {
  onMessage: (data: Buffer) => void;
  onError: (error: Error) => void;
  onClose: (code: number, reason: string) => void;
};

export interface TransportLike {
  send(data: Buffer): void;
  close(): void;
}

export type ConnectFn = (callbacks: TransportCallbacks) => TransportLike;
export type TransportStatus = "reconnecting" | "live";

export interface ReconnectOptions {
  /** Consumer message sink (protocol-level parsing lives here). */
  onMessage: (data: Buffer) => void;
  /** Fatal error sink — called on a non-retryable failure or exhausted backoff. */
  onError: (error: Error) => void;
  /** (Re)send the session-init frame(s) on each fresh socket, incl. the first. */
  initialize: (transport: TransportLike) => void;
  /** Emitted on drop ("reconnecting") and on first message after reconnect ("live"). */
  onStatus: (status: TransportStatus) => void;
  /** true → retry with backoff; false → fatal. Default: defaultClassify. */
  classify?: (info: { code?: number; error?: Error }) => boolean;
  /** Backoff schedule (ms per attempt). Default: defaultBackoff. */
  backoff?: readonly number[];
  /** Injectable timer. Default setTimeout. */
  setTimer?: (fn: () => void, ms: number) => void;
}

export const defaultBackoff: readonly number[] = [500, 1000, 2000, 4000, 8000, 8000];

const RETRYABLE_CLOSE_CODES = new Set([1005, 1006, 1011, 1012, 1013]);

export function defaultClassify(info: { code?: number; error?: Error }): boolean {
  if (info.error) return true; // raw socket/network error
  if (info.code === undefined) return true;
  return RETRYABLE_CLOSE_CODES.has(info.code);
}

export function withReconnect(connect: ConnectFn, options: ReconnectOptions): TransportLike {
  const classify = options.classify ?? defaultClassify;
  const backoff = options.backoff ?? defaultBackoff;
  const setTimer = options.setTimer ?? ((fn, ms) => void setTimeout(fn, ms));

  let state: "live" | "reconnecting" = "live";
  let attempt = 0;
  let attemptSettled = false; // guards double-handling (onError + onClose) per socket
  let closedByUser = false;
  let current: TransportLike;

  const open = (): void => {
    attemptSettled = false;
    current = connect({
      onMessage: (data) => {
        if (state === "reconnecting") {
          state = "live";
          attempt = 0;
          options.onStatus("live");
        }
        options.onMessage(data);
      },
      onError: (error) => fail({ error }),
      onClose: (code) => fail({ code })
    });
    options.initialize(current);
  };

  const fail = (info: { code?: number; error?: Error }): void => {
    if (closedByUser || attemptSettled) return;
    attemptSettled = true;
    if (!classify(info) || attempt >= backoff.length) {
      options.onError(info.error ?? new Error(`transport closed: ${info.code ?? "unknown"}`));
      return;
    }
    if (state === "live") {
      state = "reconnecting";
      options.onStatus("reconnecting");
    }
    const delay = backoff[attempt] ?? backoff[backoff.length - 1] ?? 0;
    attempt += 1;
    setTimer(() => {
      if (!closedByUser) open();
    }, delay);
  };

  open();

  return {
    send(data: Buffer): void {
      if (state === "live") current.send(data);
    },
    close(): void {
      closedByUser = true;
      current.close();
    }
  };
}
