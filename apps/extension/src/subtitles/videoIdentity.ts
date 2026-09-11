// Query params that vary between visits to the same video (timestamps, playlist
// position, tracking) and must not split its identity.
const VOLATILE_PARAMS = new Set([
  "t", "time_continue", "start", "end", "list", "index", "feature", "si"
]);

/**
 * Canonical key for "the same video", so different URLs (timestamp, tracking,
 * playlist params) for one video share a cache. Best-effort: known providers get
 * a stable id; generic pages normalize to origin+path plus non-volatile query.
 *
 * The fragment is an in-page anchor (`#notes`) and is dropped — except when it
 * is a hash route (`#/video/123`, `#!/watch/7`), where it *is* the page identity
 * and is kept (its own query, if any, gets the same volatile-param filtering).
 */
export function videoIdentity(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const youtube = youtubeId(parsed);
  if (youtube !== undefined) {
    return `youtube:${youtube}`;
  }

  const search = stableQuery(parsed.searchParams);
  return `${parsed.origin}${parsed.pathname}${search ? `?${search}` : ""}${hashRoute(parsed.hash)}`;
}

function stableQuery(source: URLSearchParams): string {
  const params = new URLSearchParams();
  const keys = [...source.keys()].sort();
  for (const key of keys) {
    if (VOLATILE_PARAMS.has(key) || key.startsWith("utm_")) {
      continue;
    }
    params.set(key, source.get(key) ?? "");
  }
  return params.toString();
}

/** `#/path?x=1` or `#!/path` → normalized route; a plain anchor → "". */
function hashRoute(hash: string): string {
  const match = /^#!?(\/.*)$/.exec(hash);
  if (match === null) {
    return "";
  }
  const [routePath, routeQuery = ""] = match[1].split("?", 2) as [string, string?];
  const search = stableQuery(new URLSearchParams(routeQuery));
  return `#${routePath}${search ? `?${search}` : ""}`;
}

function youtubeId(parsed: URL): string | undefined {
  const host = parsed.hostname.replace(/^www\./, "");
  if (host === "youtu.be") {
    const id = trimSlashes(parsed.pathname);
    return id || undefined;
  }
  if (host === "youtube.com" || host === "m.youtube.com") {
    const v = parsed.searchParams.get("v");
    if (v) {
      return v;
    }
    const path = /^\/(?:embed|shorts)\/([^/]+)/.exec(parsed.pathname);
    if (path) {
      return path[1];
    }
  }
  return undefined;
}

function trimSlashes(pathname: string): string {
  return pathname.replace(/^\/+/, "").replace(/\/+$/, "");
}
