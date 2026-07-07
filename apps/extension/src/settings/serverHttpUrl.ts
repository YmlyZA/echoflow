/**
 * Derive an HTTP(S) endpoint on the configured server from the stored
 * serverUrl (which users may enter as ws://, wss://, http:// or https://).
 * Returns null when serverUrl is unparseable.
 */
export function buildServerHttpUrl(serverUrl: string, path: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl.trim());
  } catch {
    return null;
  }

  if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  } else if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  }

  const normalizedBase = parsed.pathname.endsWith("/")
    ? parsed.pathname.slice(0, -1)
    : parsed.pathname;
  parsed.pathname = `${normalizedBase}${path}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}
