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
    url = new URL("/v1/capabilities", serverUrl).toString();
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
