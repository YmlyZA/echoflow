# Automated E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the missing backend `stop`→clean-close CI coverage, and un-skip the extension smoke by moving its WebSocket client out of the sandboxed service worker into Node.

**Architecture:** The backend happy-path WS flow is already CI-tested in `server.test.ts`; add one `stop`-path test there. The extension smoke's only real blocker was the service worker being unable to open an outbound WS headlessly — relocate that socket to Node (the Playwright process) and inject each `ServerEvent` into the extension via `serviceWorker.evaluate(... onMessage.dispatch ...)`.

**Tech Stack:** Vitest, Fastify `injectWS`, Playwright, Node 22 global `WebSocket`.

## Global Constraints

- Deliverable 1 (backend `stop` test) rides the existing `pnpm test` → the `check` CI job. Deliverable 2 (extension smoke) stays a LOCAL smoke (`test:e2e` / `dev-smoke.sh`), NOT added to the required `check`.
- Reuse the existing `server.test.ts` harness (`createServer`, `injectWS`, `sendAudioFrame`, `collectServerEvents`, `openSockets`) — do not add a new harness or a redundant flow test.
- The extension smoke keeps ALL existing real-extension assertions (overlay shadow-DOM text + persisted `final` history segment) and the `START_FROM_POPUP` gesture workaround; only the WS client relocates to Node.
- Node 22 global `WebSocket` for the bridge — no new dependency.
- No new CI workflow/job; no interpret/AST e2e (credential-gated); no real `tabCapture`/offscreen coverage.

---

### Task 1: Backend `stop` → clean-close test

**Files:**
- Modify: `apps/backend/src/server.test.ts` (add one test to the existing `describe("backend realtime websocket", …)` block)

**Interfaces:**
- Consumes: the file's existing `createServer`, `injectWS`, `sendAudioFrame`, `collectServerEvents`, `openSockets` helpers.
- Produces: CI coverage of the `stop` → session-teardown → socket-close path.

- [ ] **Step 1: Write the test**

Add inside `describe("backend realtime websocket", …)` (e.g. right after the "emits language, progressive partials, and a final…" test):

```ts
it("closes the socket cleanly when the client sends stop", async () => {
  const server = createServer({ apiKey: "dev-key" });

  try {
    await server.ready();
    const socket = await server.injectWS("/v1/realtime", {
      headers: { "x-api-key": "dev-key" },
    });
    openSockets.push(socket);

    const events = collectServerEvents(socket, 4);
    socket.send(JSON.stringify({ type: "start", targetLanguage: "zh-CN" }));
    sendAudioFrame(socket, 0, 0);
    sendAudioFrame(socket, 1, 250);
    sendAudioFrame(socket, 2, 500);
    await events; // reached the final for seg-1

    const closed = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("socket did not close after stop")),
        1_000,
      );
      socket.on("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    socket.send(JSON.stringify({ type: "stop" }));

    const code = await closed;
    expect(code).not.toBe(1006); // clean close (not an abnormal 1006)
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run it (expected PASS — the stop path already works; this test locks it in)**

Run: `pnpm --filter @echoflow/backend test -- server`
Expected: PASS — the new test plus the existing `server.test.ts` cases green. (This is a characterization test of already-correct behavior; if it FAILS because the socket never closes on `stop`, that is a real defect — stop and investigate before proceeding.)

- [ ] **Step 3: Typecheck + commit**

Run: `pnpm --filter @echoflow/backend typecheck`
Expected: exit 0.

```bash
git add apps/backend/src/server.test.ts
git commit -m "test(backend): cover the WS stop -> clean-close path"
```

---

### Task 2: Un-skip the extension smoke (Node-side WS bridge)

**Files:**
- Modify: `apps/extension/e2e/extension-smoke.spec.ts`

**Interfaces:**
- Consumes: the real backend `/v1/realtime` (running locally); the extension's `SERVER_EVENT` runtime-message path.
- Produces: an un-skipped local full-stack smoke.

**Verification note:** this Playwright spec needs a built extension + a running backend + a browser, which a subagent generally cannot orchestrate. The implementer makes the code change and confirms it is well-formed (no `test.skip`, WS in Node, per-message dispatch injection). The definitive headless run (`bash scripts/dev-smoke.sh`) is performed by the CONTROLLER after this task — do not mark the task blocked if you cannot run the browser; report that the run is pending controller validation.

- [ ] **Step 1: Remove the skip**

In `apps/extension/e2e/extension-smoke.spec.ts`, delete the first line inside the test:

```ts
    test.skip(true, "headless service-worker WS connectivity blocker — see Direction D in docs/superpowers/backlog.md");
```

- [ ] **Step 2: Move the WebSocket into Node in `bridgeFakeBackendEvents`**

Replace the entire `bridgeFakeBackendEvents` function with a version that opens the socket in the Node test process and injects each event into the service worker. The `start` frame + audio-frame pump are unchanged in content — only their execution context moves from `serviceWorker.evaluate` to Node:

```ts
async function bridgeFakeBackendEvents(
  serviceWorker: Awaited<ReturnType<typeof waitForServiceWorker>>,
  localSessionId: string,
): Promise<void> {
  const websocketUrl = new URL(serverUrl);
  websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
  websocketUrl.pathname = "/v1/realtime";
  websocketUrl.search = "";
  websocketUrl.searchParams.set("apiKey", apiKey);

  await new Promise<void>((resolve, reject) => {
    // Node 22 global WebSocket — the Playwright process CAN reach 127.0.0.1
    // (headless extension service workers cannot; that was the old blocker).
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
      // Fake provider emits one script step per frame; pump a few to reach
      // segment 1's final. The PCM bytes are ignored, so zero-filled is fine.
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

        // Inject the parsed ServerEvent into the extension the same way the
        // test injects START_FROM_POPUP — the background then forwards it to
        // the content script and records finals to history.
        await serviceWorker.evaluate(
          ({ localSessionId, event }) => {
            chrome.runtime.onMessage.dispatch({
              type: "SERVER_EVENT",
              localSessionId,
              event,
            });
          },
          { localSessionId, event },
        );

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
}
```

- [ ] **Step 3: Update the `test.describe` header comment**

Replace the block comment above the `test(...)` so it reflects reality: blocker #2 (service-worker WS) is resolved by running the socket in Node; blocker #1's `START_FROM_POPUP` gesture workaround remains; the real `tabCapture` gesture + offscreen audio pipeline are still not exercised headlessly (Node substitutes for the offscreen WS client). Keep it concise and accurate — no stale "skipped" language.

- [ ] **Step 4: Confirm the change is well-formed (static)**

Run: `grep -n "test.skip" apps/extension/e2e/extension-smoke.spec.ts`
Expected: no match (the skip is gone).
Run: `grep -n "serviceWorker.evaluate" apps/extension/e2e/extension-smoke.spec.ts`
Expected: the per-message dispatch injection is present inside `bridgeFakeBackendEvents`.
(The e2e spec is not covered by `pnpm typecheck` — Playwright compiles it at runtime — so there is no unit-level gate here; correctness is confirmed by the controller's headless run.)

- [ ] **Step 5: Commit**

```bash
git add apps/extension/e2e/extension-smoke.spec.ts
git commit -m "test(extension): un-skip the smoke by bridging the backend WS via Node"
```

---

## Self-Review

**Spec coverage:**
- Deliverable 1 (backend `stop`→clean-close, CI-gating) → Task 1. ✅ (happy-path flow already covered by pre-existing `server.test.ts` tests — not duplicated.)
- Deliverable 2 (un-skip smoke via Node-WS bridge, local) → Task 2. ✅
- CI split (backend gates via `pnpm test`; smoke stays local) → Global Constraints + Task 2 verification note. ✅
- Documented limitations (interpret/AST, gesture/offscreen) → carried in the spec + Task 3's header-comment update. ✅

**Placeholder scan:** No TBD/TODO. Task 1's test and Task 2's `bridgeFakeBackendEvents` are complete; Task 3 is a comment-accuracy edit (no code contract).

**Type consistency:** Task 1 reuses the exact existing helper names/signatures (`createServer`, `injectWS`, `sendAudioFrame`, `collectServerEvents`, `openSockets`). Task 2's rewritten `bridgeFakeBackendEvents` keeps the same signature `(serviceWorker, localSessionId) => Promise<void>` and the same `start`/`audio_frame` payload shapes the file already used; the only change is execution context (Node socket + `serviceWorker.evaluate` injection). `serverUrl`/`apiKey` are the module-level constants already defined in the file.

**Execution / verification reality:** Task 1 is fully verifiable in `pnpm test`. Task 2's headless run needs backend+browser orchestration the implementer can't guarantee; its definitive validation is the controller running `bash scripts/dev-smoke.sh` after the task (the implementer only confirms the change is well-formed).
