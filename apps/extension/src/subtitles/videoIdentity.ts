// Query params that vary between visits to the same video (timestamps, playlist
// position, tracking) and must not split its identity.
const VOLATILE_PARAMS = new Set([
  "t", "time_continue", "start", "end", "list", "index", "feature", "si"
]);

/**
 * Canonical key for "the same video", so different URLs (timestamp, tracking,
 * playlist params) for one video share a cache. Best-effort: known providers get
 * a stable id; generic pages normalize to origin+path plus non-volatile query.
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

  const params = new URLSearchParams();
  const keys = [...parsed.searchParams.keys()].sort();
  for (const key of keys) {
    if (VOLATILE_PARAMS.has(key) || key.startsWith("utm_")) {
      continue;
    }
    params.set(key, parsed.searchParams.get(key) ?? "");
  }
  const search = params.toString();
  return `${parsed.origin}${parsed.pathname}${search ? `?${search}` : ""}`;
}

function youtubeId(parsed: URL): string | undefined {
  const host = parsed.hostname.replace(/^www\./, "");
  if (host === "youtu.be") {
    const id = parsed.pathname.slice(1);
    return id || undefined;
  }
  if (host === "youtube.com" || host === "m.youtube.com") {
    const v = parsed.searchParams.get("v");
    if (v) {
      return v;
    }
    const embed = /^\/embed\/([^/]+)/.exec(parsed.pathname);
    if (embed) {
      return embed[1];
    }
  }
  return undefined;
}
