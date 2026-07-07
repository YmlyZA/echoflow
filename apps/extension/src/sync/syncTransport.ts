import {
  isSyncPullResponse,
  type SyncPullResponse,
  type SyncPushRequest,
  type SyncPushResponse
} from "@echoflow/protocol";
import { buildServerHttpUrl } from "../settings/serverHttpUrl";

export interface SyncTransport {
  push(request: SyncPushRequest): Promise<SyncPushResponse>;
  pull(since: number): Promise<SyncPullResponse>;
}

export interface FetchSyncTransportOptions {
  serverUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/** HTTP transport for the backend /v1/sync routes. Null when serverUrl is unparseable. */
export function createFetchSyncTransport(
  options: FetchSyncTransportOptions
): SyncTransport | null {
  const pushUrl = buildServerHttpUrl(options.serverUrl, "/v1/sync/push");
  const pullUrl = buildServerHttpUrl(options.serverUrl, "/v1/sync/pull");
  if (pushUrl === null || pullUrl === null) {
    return null;
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async push(request) {
      const response = await fetchImpl(pushUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey
        },
        body: JSON.stringify(request)
      });
      if (!response.ok) {
        throw new Error(`sync_push_failed_${response.status}`);
      }
      return (await response.json()) as SyncPushResponse;
    },
    async pull(since) {
      const response = await fetchImpl(`${pullUrl}?since=${since}`, {
        headers: { "x-api-key": options.apiKey }
      });
      if (!response.ok) {
        throw new Error(`sync_pull_failed_${response.status}`);
      }
      const data: unknown = await response.json();
      if (!isSyncPullResponse(data)) {
        throw new Error("sync_pull_invalid_response");
      }
      return data;
    }
  };
}
