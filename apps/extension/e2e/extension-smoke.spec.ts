import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type BrowserContextOptions,
  type Page
} from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(extensionRoot, "..", "..");
const extensionPath = path.join(extensionRoot, ".output", "chrome-mv3");
const fixturePath = path.join(
  extensionRoot,
  "e2e",
  "fixtures",
  "test-video.html",
);
const serverUrl =
  process.env.ECHOFLOW_E2E_SERVER_URL ?? "http://127.0.0.1:8787";
const apiKey = process.env.ECHOFLOW_E2E_API_KEY ?? "dev-key";

test.describe("extension fake backend smoke", () => {
  // Skipped: two blockers prevent this test from running headlessly.
  //
  // 1. The popup's Start gesture (chrome.tabCapture.getMediaStreamId) requires
  //    a real user gesture and cannot be synthesised in headless Playwright.
  //    triggerPopupStart below works around this by dispatching START_FROM_POPUP
  //    directly onto the runtime message bus, so the background creates a local
  //    history session that waitForStartFromPopupBoundary can observe.
  //
  // 2. bridgeFakeBackendEvents opens a WebSocket to the fake backend from
  //    within serviceWorker.evaluate(), but headless Chromium's extension
  //    service-worker context cannot establish outbound TCP connections to
  //    127.0.0.1 via the CDP-executed path — the backend receives no connection
  //    and the 10-second timeout fires.  The same call succeeds from Node.js
  //    and from headed-mode browser pages, so this is a Playwright headless /
  //    service-worker restriction, not a backend or extension bug.
  //
  // Both blockers are tracked as Direction D in docs/superpowers/backlog.md
  // ("Automated e2e … blocker: tabCapture needs a real user gesture").
  // Run `bash scripts/dev-smoke.sh` for a headed integration smoke.
  test("streams fake backend subtitles into overlay and local history", async () => {
    test.skip(true, "headless service-worker WS connectivity blocker — see Direction D in docs/superpowers/backlog.md");

    execFileSync("pnpm", ["--filter", "@echoflow/extension", "build"], {
      cwd: repoRoot,
      stdio: "inherit",
    });

    await expectBackendReady();

    const userDataDir = path.join(
      tmpdir(),
      `echoflow-extension-smoke-${Date.now()}`,
    );
    mkdirSync(userDataDir, { recursive: true });

    const fixtureServer = await startFixtureServer();
    const context = await launchExtensionContext(userDataDir);

    try {
      const page = await context.newPage();
      await page.goto(fixtureServer.url);

      const serviceWorker = await waitForServiceWorker(context);
      const extensionId = new URL(serviceWorker.url()).host;

      await configureExtension(serviceWorker, {
        apiKey,
        serverUrl,
        targetLanguage: "zh-CN",
        subtitleFontSize: 24,
      });

      await page.bringToFront();
      await triggerPopupStart(serviceWorker);
      const captureBoundarySession =
        await waitForStartFromPopupBoundary(serviceWorker);

      await bridgeFakeBackendEvents(
        serviceWorker,
        captureBoundarySession.id as string,
      );

      await expectOverlayText(page, "hello from echoflow");
      await expectOverlayText(page, "[zh-CN] hello from echoflow");

      await expect
        .poll(() => readHistorySegments(serviceWorker), {
          message: "final fake backend segment should be stored in history",
          timeout: 10_000,
        })
        .toContainEqual(
          expect.objectContaining({
            sourceText: "hello from echoflow",
            translatedText: "[zh-CN] hello from echoflow",
            status: "final",
          }),
        );

      expect(extensionId).toMatch(/^[a-p]{32}$/);
    } finally {
      await context.close();
      await fixtureServer.close();
    }
  });
});

async function launchExtensionContext(
  userDataDir: string,
): Promise<BrowserContext> {
  const options: BrowserContextOptions = {
    channel: "chromium",
    headless: process.env.ECHOFLOW_E2E_HEADLESS !== "0",
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--allow-file-access-from-files",
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  };

  return chromium.launchPersistentContext(userDataDir, options);
}

async function startFixtureServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const fixtureHtml = readFileSync(fixturePath);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixtureHtml);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Failed to bind fixture server");
  }

  return {
    url: `http://127.0.0.1:${address.port}/test-video.html`,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function waitForServiceWorker(context: BrowserContext) {
  const existingWorker = context.serviceWorkers()[0];

  return existingWorker ?? context.waitForEvent("serviceworker");
}

async function configureExtension(
  serviceWorker: Awaited<ReturnType<typeof waitForServiceWorker>>,
  settings: {
    serverUrl: string;
    apiKey: string;
    targetLanguage: string;
    subtitleFontSize: number;
  },
): Promise<void> {
  await serviceWorker.evaluate(async (storedSettings) => {
    await chrome.storage.local.set({
      "echoflow.settings": storedSettings,
    });
  }, settings);
}

// The popup's real Start path calls chrome.tabCapture.getMediaStreamId which
// requires a genuine user gesture (cannot be synthesised in headless Playwright).
// We send a START_FROM_POPUP message directly from the service-worker context
// with a placeholder streamId so the background still creates a local history
// session and transitions into the connecting/error path that
// waitForStartFromPopupBoundary can observe. The bridge + overlay/history
// assertions that follow are independent of how the session was started.
async function triggerPopupStart(
  serviceWorker: Awaited<ReturnType<typeof waitForServiceWorker>>,
): Promise<void> {
  await serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    // Read the settings stored by configureExtension and supply defaults for
    // optional fields (sourceLanguage, mode) so validateSettings accepts the
    // message in the background.
    const stored = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        chrome.storage.local.get("echoflow.settings", (items) => {
          const error = chrome.runtime.lastError;

          if (error) {
            reject(new Error(error.message));
          } else {
            resolve(
              (items["echoflow.settings"] as Record<string, unknown>) ?? {},
            );
          }
        });
      },
    );

    // sendMessage cannot target the service worker itself; dispatch directly on
    // the onMessage event so the background handler receives it in the same
    // context (mirrors how bridgeFakeBackendEvents injects SERVER_EVENT messages).
    chrome.runtime.onMessage.dispatch({
      type: "START_FROM_POPUP",
      tabId: tab.id,
      // A real gesture is needed to obtain a valid stream id; we supply a
      // placeholder so the background creates a history session and hits the
      // capture boundary regardless.
      streamId: "synthetic-stream-id-no-gesture",
      settings: {
        serverUrl: String(stored.serverUrl ?? ""),
        apiKey: String(stored.apiKey ?? ""),
        targetLanguage: String(stored.targetLanguage ?? "en"),
        sourceLanguage: String(stored.sourceLanguage ?? "zh"),
        subtitleFontSize: Number(stored.subtitleFontSize ?? 24),
        mode: (stored.mode as string) ?? "pipeline",
      },
    });
  });
}

// Poll until the background's startSession has written at least one session to
// IndexedDB (it does so via historyStore.createLocalSession early in the start
// path, before any network or capture step can fail). Return that session so its
// id can be passed to bridgeFakeBackendEvents.
async function waitForStartFromPopupBoundary(
  serviceWorker: Awaited<ReturnType<typeof waitForServiceWorker>>,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const sessions = await readHistoryStore(serviceWorker, "sessions");

    if (sessions.length > 0) {
      return sessions[sessions.length - 1];
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    "START_FROM_POPUP did not create a local history session within the deadline",
  );
}

async function bridgeFakeBackendEvents(
  serviceWorker: Awaited<ReturnType<typeof waitForServiceWorker>>,
  localSessionId: string,
): Promise<void> {
  await serviceWorker.evaluate(
    async ({ apiKey, localSessionId, serverUrl }) => {
      await new Promise<void>((resolve, reject) => {
        const websocketUrl = new URL(serverUrl);

        websocketUrl.protocol =
          websocketUrl.protocol === "https:" ? "wss:" : "ws:";
        websocketUrl.pathname = "/v1/realtime";
        websocketUrl.search = "";
        websocketUrl.searchParams.set("apiKey", apiKey);

        const socket = new WebSocket(websocketUrl);
        const timeout = setTimeout(() => {
          socket.close();
          reject(new Error("Timed out waiting for fake backend final event"));
        }, 10_000);

        socket.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("Fake backend websocket failed"));
        };

        socket.onopen = () => {
          socket.send(
            JSON.stringify({
              type: "start",
              sessionId: localSessionId,
              tabTitle: "EchoFlow smoke fixture",
              tabUrl: "http://127.0.0.1/test-video.html",
              targetLanguage: "zh-CN",
              audioFormat: {
                mimeType: "audio/pcm",
                codec: "pcm_s16le",
                sampleRateHz: 16000,
                channelCount: 1,
                bitsPerSample: 16,
              },
              clientCapabilities: {
                binaryAudioFrames: true,
                partialSubtitles: true,
                finalSubtitles: true,
                languageEvents: true,
                errorEvents: true,
              },
            }),
          );
          // The streaming fake speech provider emits one script step per audio
          // frame; pump a few so it reaches segment 1's final ("hello from
          // echoflow" is 3 words -> partial, partial, final). The PCM bytes are
          // ignored by the fake provider, so a zero-filled buffer is fine.
          const silentPcmFrame = new ArrayBuffer(320);
          for (let sequenceNumber = 0; sequenceNumber < 4; sequenceNumber += 1) {
            socket.send(
              JSON.stringify({
                type: "audio_frame",
                sessionId: localSessionId,
                frame: { sequenceNumber, timestampMs: sequenceNumber * 100 },
              }),
            );
            socket.send(silentPcmFrame);
          }
        };

        socket.onmessage = (message) => {
          void (async () => {
            const event = JSON.parse(String(message.data));

            chrome.runtime.onMessage.dispatch({
              type: "SERVER_EVENT",
              localSessionId,
              event,
            });

            if (event.type === "final") {
              clearTimeout(timeout);
              socket.close();
              resolve();
            }
          })().catch((error: unknown) => {
            clearTimeout(timeout);
            socket.close();
            reject(error);
          });
        };
      });
    },
    { apiKey, localSessionId, serverUrl },
  );
}

async function expectOverlayText(page: Page, expectedText: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const host = document.querySelector("#echoflow-root");
          return host?.shadowRoot?.textContent ?? "";
        }),
      { timeout: 10_000 },
    )
    .toContain(expectedText);
}

async function readHistorySegments(
  serviceWorker: Awaited<ReturnType<typeof waitForServiceWorker>>,
): Promise<Array<Record<string, unknown>>> {
  return readHistoryStore(serviceWorker, "segments");
}

async function readHistoryStore(
  serviceWorker: Awaited<ReturnType<typeof waitForServiceWorker>>,
  storeName: "segments" | "sessions",
): Promise<Array<Record<string, unknown>>> {
  return serviceWorker.evaluate(async (storeName) => {
    const databases = await indexedDB.databases?.();

    if (
      databases &&
      !databases.some((database) => database.name === "echoflow-history")
    ) {
      return [];
    }

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("echoflow-history");

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });

    try {
      if (!database.objectStoreNames.contains(storeName)) {
        const databaseName = database.name;

        database.close();
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(databaseName);

          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve();
          request.onblocked = () => reject(new Error("History database blocked"));
        });

        return [];
      }

      return await new Promise<Array<Record<string, unknown>>>(
        (resolve, reject) => {
          const transaction = database.transaction(storeName, "readonly");
          const request = transaction.objectStore(storeName).getAll();

          request.onerror = () => reject(request.error);
          request.onsuccess = () =>
            resolve(request.result as Array<Record<string, unknown>>);
        },
      );
    } finally {
      database.close();
    }
  }, storeName);
}

async function expectBackendReady(): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          const response = await fetch(new URL("/healthz", serverUrl));
          return response.ok;
        } catch {
          return false;
        }
      },
      {
        message: `fake backend should be reachable at ${serverUrl}`,
        timeout: 10_000,
      },
    )
    .toBe(true);
}
