import { timingSafeEqual } from "node:crypto";

/**
 * Origin policy for the WebSocket handshake. A browser always sends an Origin;
 * a non-browser client (tests, curl) sends none. The MV3 offscreen document that
 * owns the real client sends chrome-extension://<id>. We cannot pin an unpacked
 * extension id, so we allow any chrome-extension origin and reject web origins —
 * closing the CSWSH vector where an open web page connects to the local backend.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) {
    return true;
  }
  return origin.startsWith("chrome-extension://");
}

/** Constant-time API key comparison (length check leaks only length). */
export function timingSafeKeyMatch(
  provided: string | undefined,
  expected: string,
): boolean {
  if (provided === undefined) {
    return false;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Auth seam: routes depend on `(provided) => boolean`, not on how keys are
 * checked. Self-hosted deployments bind one static key (constant-time compare);
 * a future control plane swaps in a key→tenant lookup without touching routes.
 */
export function createApiKeyVerifier(
  expected: string,
): (provided: string | undefined) => boolean {
  return (provided) => timingSafeKeyMatch(provided, expected);
}
