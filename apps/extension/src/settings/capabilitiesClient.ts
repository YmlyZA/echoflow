import {
  isCapabilitiesDescriptor,
  type CapabilitiesDescriptor,
} from "@echoflow/protocol";

export async function fetchCapabilities(
  serverUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CapabilitiesDescriptor | null> {
  let url: string;
  try {
    const parsed = new URL(serverUrl.trim());
    if (parsed.protocol === "wss:") {
      parsed.protocol = "https:";
    } else if (parsed.protocol === "ws:") {
      parsed.protocol = "http:";
    }
    const normalizedBase = parsed.pathname.endsWith("/")
      ? parsed.pathname.slice(0, -1)
      : parsed.pathname;
    parsed.pathname = `${normalizedBase}/v1/capabilities`;
    parsed.search = "";
    parsed.hash = "";
    url = parsed.toString();
  } catch {
    return null;
  }

  try {
    const response = await fetchImpl(url, { headers: { "x-api-key": apiKey } });
    if (!response.ok) {
      return null;
    }
    const data: unknown = await response.json();
    return isCapabilitiesDescriptor(data) ? data : null;
  } catch {
    return null;
  }
}
