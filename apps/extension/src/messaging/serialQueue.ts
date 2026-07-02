/**
 * Runs async tasks strictly one at a time in the order they were enqueued.
 * A rejecting task is reported to `onError` and does not break the chain, so
 * later tasks still run. Used to serialize lifecycle message handling so a
 * STOP cannot interleave into a half-finished START.
 */
export function createSerialQueue(
  onError: (error: unknown) => void = () => {}
): (task: () => Promise<void>) => void {
  let tail: Promise<void> = Promise.resolve();

  return (task: () => Promise<void>) => {
    tail = tail.then(task).catch(onError);
  };
}
