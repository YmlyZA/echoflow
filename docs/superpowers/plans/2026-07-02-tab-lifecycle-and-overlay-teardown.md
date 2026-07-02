# Tab Lifecycle & Overlay Teardown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the content-script side of a session a complete lifecycle — closing/navigating the captured tab ends the session, stopping tears down the overlay, and the page can no longer observe or drive the overlay through a `window` event bridge.

**Architecture:** Testable units land in `src/` (a `SESSION_STOPPED` message + guard, an `onCaptureEnded` hook on the audio pipeline, a small overlay-session predicate); the entrypoints (`content.tsx`, `background.ts`, `offscreen/main.ts`) are then wired to use them. No new manifest permissions; navigation/tab-close ends the session (a navigated page can't be re-injected under `activeTab` + localhost host_permissions).

**Tech Stack:** TypeScript (ESM), WXT + React 19 MV3, Vitest, existing fake-track harness in `audioPipeline.test.ts`.

## Global Constraints

- All work in `apps/extension`. No changes to `packages/protocol` or `apps/backend`. No new manifest permissions (stay on `activeTab`, `storage`, `tabCapture`, `offscreen`, `scripting`).
- Extension tsconfig is `strict` but does NOT enable `exactOptionalPropertyTypes`/`noUncheckedIndexedAccess`.
- Vitest targets `src` only; entrypoint files (`content.tsx`, `background.ts`, `offscreen/main.ts`) have NO unit tests — verify them with `pnpm --filter @echoflow/extension typecheck` + the named grep checks + the pre-existing suite staying green.
- Slice A (serial queue, `isMessageForActiveSession`) is already merged on this base — reuse `createSerialQueue` for the new background listeners.
- After each task: `pnpm --filter @echoflow/extension typecheck` and `pnpm --filter @echoflow/extension test` stay green.
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: `SESSION_STOPPED` runtime message

**Files:**
- Modify: `apps/extension/src/messaging/messages.ts` (add the message type + union member + `isRuntimeMessage` entry)
- Test: `apps/extension/src/messaging/messages.test.ts` (extend)

**Interfaces:**
- Produces: `SessionStoppedMessage = { type: "SESSION_STOPPED"; localSessionId: string }`, added to the `RuntimeMessage` union and accepted by `isRuntimeMessage`. Consumed by content (Task 4) and background (Task 5).

- [ ] **Step 1: Write the failing test**

Add to `messages.test.ts` (match the file's existing test style):

```ts
  it("accepts a SESSION_STOPPED message", () => {
    expect(
      isRuntimeMessage({ type: "SESSION_STOPPED", localSessionId: "local-1" })
    ).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- messages`
Expected: FAIL — `isRuntimeMessage` returns false for the unknown type.

- [ ] **Step 3: Implement**

In `messages.ts`, add to the `RuntimeMessage` union:

```ts
  | SessionStoppedMessage
```

Add the interface (near `SessionStartedMessage`):

```ts
export interface SessionStoppedMessage {
  type: "SESSION_STOPPED";
  localSessionId: string;
}
```

Add `"SESSION_STOPPED"` to the array inside `isRuntimeMessage`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/extension test -- messages`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

```bash
git add apps/extension/src/messaging/messages.ts apps/extension/src/messaging/messages.test.ts
git commit -m "feat(extension): SESSION_STOPPED runtime message for overlay teardown

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Overlay-session predicate helper

**Files:**
- Create: `apps/extension/src/subtitles/overlaySession.ts`
- Test: `apps/extension/src/subtitles/overlaySession.test.ts`

**Interfaces:**
- Produces:
  - `isStopForCurrentSession(currentLocalSessionId: string | null, stoppedLocalSessionId: string): boolean` — true when the content script has no tracked session yet (`null`) or the ids match; false when a different session's stop arrives. Used by content (Task 4) to decide whether a `SESSION_STOPPED` should tear down its overlay.

- [ ] **Step 1: Write the failing test**

```ts
// apps/extension/src/subtitles/overlaySession.test.ts
import { describe, expect, it } from "vitest";
import { isStopForCurrentSession } from "./overlaySession";

describe("isStopForCurrentSession", () => {
  it("matches the tracked session id", () => {
    expect(isStopForCurrentSession("local-1", "local-1")).toBe(true);
  });

  it("ignores a stop for a different session", () => {
    expect(isStopForCurrentSession("local-1", "local-2")).toBe(false);
  });

  it("tears down when no session has been tracked yet", () => {
    expect(isStopForCurrentSession(null, "local-1")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- overlaySession`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/extension/src/subtitles/overlaySession.ts

/**
 * Whether a SESSION_STOPPED addressed to `stoppedLocalSessionId` should tear
 * down the overlay this content script is showing. An overlay that has not yet
 * seen any event (null tracked id) tears down for any stop; otherwise only its
 * own session's stop applies, so a stale/other-tab stop cannot clear a live
 * overlay.
 */
export function isStopForCurrentSession(
  currentLocalSessionId: string | null,
  stoppedLocalSessionId: string
): boolean {
  if (currentLocalSessionId === null) {
    return true;
  }

  return currentLocalSessionId === stoppedLocalSessionId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/extension test -- overlaySession`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

```bash
git add apps/extension/src/subtitles/overlaySession.ts apps/extension/src/subtitles/overlaySession.test.ts
git commit -m "feat(extension): overlay-session stop-targeting predicate

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `onCaptureEnded` hook on the audio pipeline

**Files:**
- Modify: `apps/extension/src/audio/audioPipeline.ts` (`AudioPipelineOptions` ~30-40; `start()` ~57-92; `stop()` ~94-106)
- Test: `apps/extension/src/audio/audioPipeline.test.ts` (extend; reuse the file's fake `getUserMedia`/track harness)

**Interfaces:**
- Consumes: existing `OffscreenAudioPipeline`.
- Produces: `AudioPipelineOptions` gains `onCaptureEnded?: (reason: string) => void`; the pipeline fires it once when a captured track ends, and detaches the listener on `stop()`. Consumed by offscreen (Task 5).

- [ ] **Step 1: Write the failing tests**

Open `audioPipeline.test.ts` first and match its existing harness (how it fakes `getUserMedia` and the returned `MediaStream`/tracks). The fake track must support `addEventListener`/`removeEventListener`/`dispatchEvent` (or the harness's existing event mechanism) and `stop()`. Add:

```ts
  it("invokes onCaptureEnded once when a captured track ends", async () => {
    const onCaptureEnded = vi.fn();
    const { pipeline, endTrack } = await startPipelineWithFakes({ onCaptureEnded });

    endTrack(); // fire the track's "ended" event
    endTrack(); // a second end must not double-report

    expect(onCaptureEnded).toHaveBeenCalledTimes(1);
    expect(onCaptureEnded).toHaveBeenCalledWith("capture_ended");
  });

  it("does not invoke onCaptureEnded for an ended event after stop", async () => {
    const onCaptureEnded = vi.fn();
    const { pipeline, endTrack } = await startPipelineWithFakes({ onCaptureEnded });

    await pipeline.stop();
    endTrack();

    expect(onCaptureEnded).not.toHaveBeenCalled();
  });
```

> `startPipelineWithFakes` is a helper you write (or adapt from the file's existing setup) that constructs an `OffscreenAudioPipeline` with fake `getUserMedia`/`AudioContextCtor`, calls `await pipeline.start()`, and returns the pipeline plus an `endTrack()` that triggers the fake track's `ended` handler. Match the fakes the existing tests already use — do not introduce a second style.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @echoflow/extension test -- audioPipeline`
Expected: FAIL — `onCaptureEnded` is never called (option unsupported).

- [ ] **Step 3: Implement**

Add to `AudioPipelineOptions`:

```ts
  onCaptureEnded?: (reason: string) => void;
```

In `start()`, after `this.stream = await getUserMedia(...)`, attach an ended listener to each track, firing the callback at most once:

```ts
    this.stream = await getUserMedia(
      buildChromeTabCaptureConstraints(this.options.streamId),
    );

    this.captureEndedHandler = () => {
      if (this.captureEndedFired) {
        return;
      }
      this.captureEndedFired = true;
      this.options.onCaptureEnded?.("capture_ended");
    };
    this.stream.getTracks().forEach((track) => {
      track.addEventListener("ended", this.captureEndedHandler!);
    });
```

Add the fields to the class:

```ts
  private captureEndedHandler: (() => void) | undefined;
  private captureEndedFired = false;
```

In `stop()`, detach before stopping the tracks:

```ts
    if (this.captureEndedHandler) {
      this.stream?.getTracks().forEach((track) => {
        track.removeEventListener("ended", this.captureEndedHandler!);
      });
      this.captureEndedHandler = undefined;
    }

    this.stream?.getTracks().forEach((track) => {
      track.stop();
    });
```

(Leave `captureEndedFired` as-is; a stopped pipeline is not restarted — a fresh `OffscreenAudioPipeline` is created per session.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/extension test -- audioPipeline`
Expected: PASS — both new tests plus the pre-existing pipeline tests green.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

```bash
git add apps/extension/src/audio/audioPipeline.ts apps/extension/src/audio/audioPipeline.test.ts
git commit -m "feat(extension): audio pipeline reports capture-track end

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Rewire `content.tsx` — drop the window bridge, track session id, teardown on stop

**Files:**
- Modify: `apps/extension/entrypoints/content.tsx`

**Interfaces:**
- Consumes: `isStopForCurrentSession` (Task 2), `SessionStoppedMessage` (Task 1).
- Produces: no exported API change — entrypoint wiring. Covered by smoke/e2e.

- [ ] **Step 1: Remove the `window` server-event bridge and dispatch directly**

Delete the entire first `useEffect` (the one that adds/removes the `"echoflow:server-event"` `window` listener and dispatches into the reducer). The reducer will be fed directly from the runtime handler instead.

- [ ] **Step 2: Track the current session id in a ref and rewrite the runtime handler**

Add near the other hooks:

```ts
  const currentSessionIdRef = useRef<string | null>(null);
```

(Import `useRef` from `react`.)

Rewrite the runtime-message `useEffect` handler so it dispatches directly, tracks the session id, and handles `SESSION_STOPPED`. Replace the whole `handleRuntimeMessage` body:

```ts
    function handleRuntimeMessage(message: unknown) {
      if (!isRuntimeMessage(message)) {
        return;
      }

      if (message.type === "SERVER_EVENT") {
        currentSessionIdRef.current = message.localSessionId;
        setHasSignal(true);
        setMode(message.mode);
        setSessionError(null);
        dispatchSubtitleEvent(message.event);
        return;
      }

      if (message.type === "CONNECTION_STATUS") {
        currentSessionIdRef.current = message.localSessionId;
        setConnectionStatus(message.status);
        return;
      }

      if (message.type === "SESSION_ERROR") {
        currentSessionIdRef.current = message.localSessionId;
        setConnectionStatus(null);
        setSessionError({ code: message.code, message: message.message });
        return;
      }

      if (message.type === "SESSION_STOPPED") {
        if (isStopForCurrentSession(currentSessionIdRef.current, message.localSessionId)) {
          onSessionEnded();
        }
      }
    }
```

Delete the `handleStopSubtitles` function and the `window.addEventListener("echoflow:stop-subtitles", …)` / its removal — the listener `useEffect` now only registers `chrome.runtime.onMessage`:

```ts
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);

    return () => {
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
    };
```

- [ ] **Step 3: Send `STOP_SESSION` directly (with the tracked id) from the Stop button**

Replace `handleStop`:

```ts
  function handleStop() {
    void chrome.runtime.sendMessage({
      type: "STOP_SESSION",
      localSessionId: currentSessionIdRef.current ?? undefined,
      reason: "overlay_stop"
    } satisfies StopSessionMessage);
  }
```

Add the imports at the top: `isStopForCurrentSession` from `../src/subtitles/overlaySession`. Keep the `StopSessionMessage` import.

- [ ] **Step 4: Add the `onSessionEnded` prop and wire teardown + re-injection guard in `main()`**

Give `EchoFlowMount` a prop:

```ts
function EchoFlowMount({ onSessionEnded }: { onSessionEnded: () => void }) {
```

Rewrite the `defineContentScript` `main()` to stash/unmount the root:

```ts
type EchoFlowWindow = Window & { __echoflowRoot?: Root };

export default defineContentScript({
  registration: "runtime",
  main() {
    const echoWindow = window as EchoFlowWindow;
    echoWindow.__echoflowRoot?.unmount();
    document.getElementById("echoflow-root")?.remove();

    const host = document.createElement("div");
    host.id = "echoflow-root";
    const shadowRoot = host.attachShadow({ mode: "open" });
    document.documentElement.append(host);

    const root = createRoot(shadowRoot);
    echoWindow.__echoflowRoot = root;

    function teardown() {
      root.unmount();
      host.remove();
      if (echoWindow.__echoflowRoot === root) {
        echoWindow.__echoflowRoot = undefined;
      }
    }

    root.render(<EchoFlowMount onSessionEnded={teardown} />);
  }
});
```

Import `Root` as a type from `react-dom/client` (`import { createRoot, type Root } from "react-dom/client";`). Remove the now-unused `isServerEvent` import if nothing else uses it (the direct-dispatch path no longer re-validates — the payload is already an `isServerEvent`-checked `ServerEvent` from the offscreen client).

- [ ] **Step 5: Verify (static — entrypoint has no unit test)**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

Run: `pnpm --filter @echoflow/extension test`
Expected: PASS — all pre-existing tests plus Tasks 1-3 green (content.tsx has no unit test by design).

Grep checks:

Run: `grep -n "echoflow:server-event\|echoflow:stop-subtitles" apps/extension/entrypoints/content.tsx`
Expected: NO matches (the window bridge is gone).

Run: `grep -n "dispatchSubtitleEvent(message.event)\|__echoflowRoot\|onSessionEnded\|isStopForCurrentSession" apps/extension/entrypoints/content.tsx`
Expected: direct dispatch, the root stash, the teardown prop, and the stop predicate are all present.

- [ ] **Step 6: Commit**

```bash
git add apps/extension/entrypoints/content.tsx
git commit -m "fix(extension): drop page-observable window bridge; teardown overlay on stop

Dispatch SERVER_EVENTs straight into the reducer instead of through a window
CustomEvent the host page could forge or observe; send STOP_SESSION directly
with the tracked localSessionId; unmount the overlay on SESSION_STOPPED; and
unmount a prior React root on re-injection so listeners do not leak.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Background tab lifecycle + `SESSION_STOPPED` emit; offscreen capture-ended wiring

**Files:**
- Modify: `apps/extension/entrypoints/background.ts` (register tab listeners in `defineBackground`; `stopSession` ~125-149; a `notifyTabSessionStopped` helper)
- Modify: `apps/extension/entrypoints/offscreen/main.ts` (pass `onCaptureEnded` to the pipeline)

**Interfaces:**
- Consumes: `createSerialQueue` (already imported in background from Slice A), `SessionStoppedMessage` (Task 1), `onCaptureEnded` option (Task 3).
- Produces: entrypoint wiring only.

- [ ] **Step 1: Emit `SESSION_STOPPED` to the tab when a session stops**

In `background.ts`, capture the stopped session's `tabId`/`localSessionId` before the state is reset, and notify the tab after teardown. Rewrite `stopSession`:

```ts
async function stopSession(reason: string): Promise<void> {
  if (sessionState.status !== "connecting" && sessionState.status !== "running") {
    await clearBadge();
    await commitSessionState(
      reduceSessionState(sessionState, { type: "STOP_COMPLETED" })
    );
    return;
  }

  const localSessionId = sessionState.localSessionId;
  const tabId = sessionState.tabId;

  await commitSessionState(
    reduceSessionState(sessionState, { type: "STOP_REQUESTED" })
  );

  await chrome.runtime.sendMessage({
    type: "STOP_SESSION",
    localSessionId,
    reason
  } satisfies StopSessionMessage);

  await clearBadge();
  await commitSessionState(
    reduceSessionState(sessionState, { type: "STOP_COMPLETED" })
  );

  await notifyTabSessionStopped(tabId, localSessionId);
}
```

Add the helper (best-effort — a closed/navigated tab rejects, which we swallow):

```ts
async function notifyTabSessionStopped(
  tabId: number,
  localSessionId: string
): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "SESSION_STOPPED",
      localSessionId
    } satisfies SessionStoppedMessage);
  } catch {
    // Tab was closed or navigated away — nothing to tear down there.
  }
}
```

Add `SessionStoppedMessage` to the `messages` import.

- [ ] **Step 2: Register tab lifecycle listeners (routed through the serial queue)**

In `background.ts`, inside `defineBackground(() => { … })`, after the `onMessage` listener, add:

```ts
  chrome.tabs.onRemoved.addListener((tabId) => {
    enqueueMessage(async () => {
      await ensureStateLoaded();
      if (
        sessionState.status !== "idle" &&
        sessionState.tabId === tabId
      ) {
        await stopSession("tab_closed");
      }
    });
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== "loading") {
      return;
    }

    enqueueMessage(async () => {
      await ensureStateLoaded();
      if (
        sessionState.status !== "idle" &&
        sessionState.tabId === tabId
      ) {
        await stopSession("tab_navigated");
      }
    });
  });
```

> `enqueueMessage` is the serial queue created in Slice A's `defineBackground` body. If it is a local `const` inside `defineBackground`, these listeners must be registered in the same scope (they are — inside the `defineBackground` callback). Confirm by reading the current `background.ts`.

- [ ] **Step 3: Wire `onCaptureEnded` in offscreen**

In `offscreen/main.ts`, pass `onCaptureEnded` to the `OffscreenAudioPipeline` constructor so a dead capture track reports an error and stops the session:

```ts
    const pipeline = new OffscreenAudioPipeline({
      streamId: message.streamId,
      client,
      workletModuleUrl: chrome.runtime.getURL("pcm-encoder.worklet.js"),
      onCaptureEnded: (reason) => {
        void chrome.runtime.sendMessage({
          type: "SESSION_ERROR",
          localSessionId: message.localSessionId,
          code: "capture_ended",
          message: "Tab audio capture ended"
        } satisfies SessionErrorMessage);
        void stopActiveSession(reason);
      }
    });
```

(`SessionErrorMessage` is already imported in `offscreen/main.ts`.)

- [ ] **Step 4: Verify (static — entrypoints have no unit test)**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

Run: `pnpm --filter @echoflow/extension test`
Expected: PASS — the full suite (172 pre-existing + Tasks 1-3's new tests) green.

Grep checks:

Run: `grep -n "onRemoved\|onUpdated\|tab_closed\|tab_navigated\|notifyTabSessionStopped" apps/extension/entrypoints/background.ts`
Expected: both listeners, both stop reasons, and the notify helper are present.

Run: `grep -n "onCaptureEnded\|capture_ended" apps/extension/entrypoints/offscreen/main.ts`
Expected: the pipeline is constructed with the `onCaptureEnded` handler.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/entrypoints/background.ts apps/extension/entrypoints/offscreen/main.ts
git commit -m "fix(extension): end session on tab close/navigate; notify overlay on stop

Register tabs.onRemoved/onUpdated (routed through the serial queue) so closing
or navigating the captured tab ends the session instead of leaving a zombie;
emit SESSION_STOPPED to the tab so the overlay tears down; and stop the session
when the capture track ends.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- #13 (remove window bridge) → Task 4 Steps 1-3. ✅
- Overlay Stop carries localSessionId → Task 4 Step 3 (tracked ref). ✅
- SESSION_STOPPED teardown → Task 1 (message) + Task 4 Step 2/4 (unmount) + Task 5 Step 1 (emit). ✅
- Overlay-session predicate → Task 2. ✅
- #4 tab lifecycle → Task 5 Step 2 (background listeners) + Task 3/Task 5 Step 3 (capture-ended net). ✅
- Re-injection guard → Task 4 Step 4 (root stash/unmount). ✅

**Placeholder scan:** No TBD/TODO. The two soft references (Task 3's `startPipelineWithFakes` and Task 5's `enqueueMessage` scope) are explicit "match the existing file" instructions, not blanks — the implementer confirms them by reading the current file.

**Type consistency:** `SessionStoppedMessage` shape identical in Tasks 1, 4, 5. `isStopForCurrentSession(currentLocalSessionId, stoppedLocalSessionId)` signature matches Task 4's call. `onCaptureEnded?: (reason: string) => void` added in Task 3, called with `"capture_ended"` and consumed in Task 5. `currentSessionIdRef` is a `useRef<string | null>` read in `handleStop` and `SESSION_STOPPED` — avoiding the stale-closure trap of reading state in a `[]`-deps effect.

**Ordering:** Tasks 1-3 are independent testable `src`/message additions (package stays green). Task 4 consumes 1 & 2; Task 5 consumes 1 & 3. Each task leaves typecheck + test green.
