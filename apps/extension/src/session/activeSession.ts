import type { SessionState } from "./sessionState";

/**
 * Whether a runtime message should drive the currently active session's state
 * and UI. A message tagged with a different localSessionId belongs to a session
 * that has since been replaced and must be ignored (its own history may still be
 * recorded by the caller). A message with no id is treated as current for
 * backward compatibility with senders that omit it.
 */
export function isMessageForActiveSession(
  state: SessionState,
  messageLocalSessionId: string | undefined
): boolean {
  if (state.status === "idle") {
    return false;
  }

  if (messageLocalSessionId === undefined) {
    return true;
  }

  return messageLocalSessionId === state.localSessionId;
}
