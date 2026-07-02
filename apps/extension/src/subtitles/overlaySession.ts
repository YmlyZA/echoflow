/**
 * Whether a SESSION_STOPPED addressed to `stoppedLocalSessionId` should tear
 * down the overlay this content script is showing. An overlay that has not yet
 * seen any event (null tracked id) tears down for any stop; otherwise only its
 * own session's stop applies, so a stale/other-tab stop cannot clear a live
 * overlay.
 */
export function isStopForCurrentSession(
  currentLocalSessionId: string | null,
  stoppedLocalSessionId: string
): boolean {
  if (currentLocalSessionId === null) {
    return true;
  }

  return currentLocalSessionId === stoppedLocalSessionId;
}
