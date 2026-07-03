export interface DrainGateOptions {
  /** Injectable timer (tests pass a manual trigger). Default setTimeout. */
  setTimer?: (fn: () => void, ms: number) => void;
  /** Max time to wait for the trailing final. Default 1500ms. */
  timeoutMs?: number;
}

/**
 * A one-shot gate for draining the trailing final on stop. `arm()` starts
 * caring about finals; `wait()` resolves on the next `onFinal()` after arming,
 * or when the timeout elapses — whichever first. Finals before `arm()` are
 * ignored (they are normal in-stream finals, not the trailing one).
 */
export function createDrainGate(options: DrainGateOptions = {}): {
  arm(): void;
  onFinal(): void;
  cancel(): void;
  wait(): Promise<void>;
} {
  const setTimer = options.setTimer ?? ((fn, ms) => void setTimeout(fn, ms));
  const timeoutMs = options.timeoutMs ?? 1500;
  let armed = false;
  let resolved = false;
  let resolve: (() => void) | undefined;

  const settle = (): void => {
    if (resolved) return;
    resolved = true;
    resolve?.();
  };

  return {
    arm(): void {
      armed = true;
    },
    onFinal(): void {
      if (armed) settle();
    },
    cancel(): void {
      // Abort an in-flight (or not-yet-started) wait immediately — used when the
      // stream is disposed (e.g. the client closed the socket on stop), so the
      // drain does not sit out its full timeout waiting for a trailing final
      // that can no longer arrive.
      settle();
    },
    wait(): Promise<void> {
      return new Promise<void>((res) => {
        resolve = res;
        if (resolved) {
          res();
          return;
        }
        setTimer(settle, timeoutMs);
      });
    }
  };
}
