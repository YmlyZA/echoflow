import {
  isCapabilitiesDescriptor,
  type CapabilitiesDescriptor,
} from "@echoflow/protocol";
import { buildServerHttpUrl } from "./serverHttpUrl";

export async function fetchCapabilities(
  serverUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CapabilitiesDescriptor | null> {
  const url = buildServerHttpUrl(serverUrl, "/v1/capabilities");
  if (url === null) {
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
