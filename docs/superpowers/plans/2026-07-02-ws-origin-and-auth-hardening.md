# WebSocket Origin & Auth Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block CSWSH/quota-abuse on the local backend (Origin allowlist on the WS handshake), compare API keys in constant time, and make the extension's runtime bus reject messages from other senders.

**Architecture:** Two small tested helpers carry the logic — a backend `wsAuth` module (`isAllowedOrigin` + `timingSafeKeyMatch`) wired into `server.ts`, and an extension `isInternalSender` predicate wired into the three `onMessage` listeners.

**Tech Stack:** TypeScript (ESM), Fastify + `@fastify/websocket` (`injectWS` in-process test), Vitest.

## Global Constraints

- Backend work in `apps/backend` (Tasks 1-2): tsconfig `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`; `.js` import specifiers. Extension work in `apps/extension` (Task 3): strict but NOT `exactOptionalPropertyTypes`.
- No new dependencies. No manifest changes.
- Default API key stays `dev-key` (documented) — do NOT change it. The Origin allowlist is the CSWSH defense.
- After each task, the touched package's `typecheck` + `test` stay green.
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: `wsAuth` helpers (Origin allowlist + constant-time key match)

**Files:**
- Create: `apps/backend/src/wsAuth.ts`
- Test: `apps/backend/src/wsAuth.test.ts`

**Interfaces:**
- Produces:
  - `isAllowedOrigin(origin: string | undefined): boolean` — `true` for `undefined` (non-browser) or an origin starting with `chrome-extension://`; `false` otherwise.
  - `timingSafeKeyMatch(provided: string | undefined, expected: string): boolean` — `false` for `undefined` or length mismatch; else constant-time equality.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backend/src/wsAuth.test.ts
import { describe, expect, it } from "vitest";
import { isAllowedOrigin, timingSafeKeyMatch } from "./wsAuth.js";

describe("isAllowedOrigin", () => {
  it("allows a non-browser client with no Origin", () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
  });

  it("allows a chrome extension origin", () => {
    expect(isAllowedOrigin("chrome-extension://abcdefghijklmnop")).toBe(true);
  });

  it("rejects a web page origin", () => {
    expect(isAllowedOrigin("https://evil.example")).toBe(false);
    expect(isAllowedOrigin("http://localhost:3000")).toBe(false);
  });
});

describe("timingSafeKeyMatch", () => {
  it("matches an exact key", () => {
    expect(timingSafeKeyMatch("dev-key", "dev-key")).toBe(true);
  });

  it("rejects a wrong key, a length mismatch, and undefined", () => {
    expect(timingSafeKeyMatch("wrong-key", "dev-key")).toBe(false);
    expect(timingSafeKeyMatch("dev-key-longer", "dev-key")).toBe(false);
    expect(timingSafeKeyMatch(undefined, "dev-key")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/backend test -- wsAuth`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/backend/src/wsAuth.ts
import { timingSafeEqual } from "node:crypto";

/**
 * Origin policy for the WebSocket handshake. A browser always sends an Origin;
 * a non-browser client (tests, curl) sends none. The MV3 offscreen document that
 * owns the real client sends chrome-extension://<id>. We cannot pin an unpacked
 * extension id, so we allow any chrome-extension origin and reject web origins —
 * closing the CSWSH vector where an open web page connects to the local backend.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) {
    return true;
  }
  return origin.startsWith("chrome-extension://");
}

/** Constant-time API key comparison (length check leaks only length). */
export function timingSafeKeyMatch(
  provided: string | undefined,
  expected: string,
): boolean {
  if (provided === undefined) {
    return false;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/backend test -- wsAuth`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @echoflow/backend typecheck`
Expected: exit 0.

```bash
git add apps/backend/src/wsAuth.ts apps/backend/src/wsAuth.test.ts
git commit -m "feat(backend): WS origin allowlist + constant-time key match helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire `wsAuth` into `server.ts`

**Files:**
- Modify: `apps/backend/src/server.ts` (`/v1/capabilities` handler; `/v1/realtime` `preValidation`)
- Test: `apps/backend/src/server.test.ts` (extend)

**Interfaces:**
- Consumes: `isAllowedOrigin`, `timingSafeKeyMatch` (Task 1).
- Produces: WS handshake `403` on a disallowed Origin (before the key check); `401` on a bad key (both endpoints, constant-time).

- [ ] **Step 1: Write the failing tests**

Add to `server.test.ts` (mirror the existing `injectWS` usage; a header named `origin` is accepted):

```ts
  it("rejects a websocket handshake from a web page origin", async () => {
    const server = createServer({ apiKey: "dev-key" });
    try {
      await server.ready();
      await expect(
        server.injectWS("/v1/realtime", {
          headers: { "x-api-key": "dev-key", origin: "https://evil.example" },
        }),
      ).rejects.toThrow("Unexpected server response: 403");
    } finally {
      await server.close();
    }
  });

  it("accepts a websocket handshake from a chrome extension origin", async () => {
    const server = createServer({ apiKey: "dev-key" });
    try {
      await server.ready();
      const socket = await server.injectWS("/v1/realtime", {
        headers: { "x-api-key": "dev-key", origin: "chrome-extension://abcdefghijklmnop" },
      });
      expect(socket).toBeDefined();
      socket.terminate();
    } finally {
      await server.close();
    }
  });
```

> Match the existing tests' socket-cleanup style (they push to an `openSockets` array or call a close/terminate helper). If the file tracks sockets in an array for teardown, use that instead of `socket.terminate()` — read the file's existing pattern and follow it. The fixed assertions are the `403` reject and the chrome-extension accept.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @echoflow/backend test -- server`
Expected: FAIL — the web-origin handshake currently succeeds (no Origin check), so the `rejects.toThrow("403")` fails.

- [ ] **Step 3: Implement**

In `server.ts`, import the helpers:

```ts
import { isAllowedOrigin, timingSafeKeyMatch } from "./wsAuth.js";
```

Replace the `/v1/capabilities` key check:

```ts
  server.get("/v1/capabilities", async (request, reply) => {
    const headerKey =
      typeof request.headers["x-api-key"] === "string"
        ? request.headers["x-api-key"]
        : undefined;
    if (!timingSafeKeyMatch(headerKey, config.apiKey)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    return buildCapabilities(config.providers);
  });
```

Replace the `/v1/realtime` `preValidation` body:

```ts
        preValidation: async (request, reply) => {
          const origin =
            typeof request.headers.origin === "string"
              ? request.headers.origin
              : undefined;
          if (!isAllowedOrigin(origin)) {
            return reply.code(403).send({ error: "Forbidden origin" });
          }

          const headerKey =
            typeof request.headers["x-api-key"] === "string"
              ? request.headers["x-api-key"]
              : undefined;
          const queryApiKey =
            typeof request.query === "object" &&
            request.query !== null &&
            "apiKey" in request.query &&
            typeof request.query.apiKey === "string"
              ? request.query.apiKey
              : undefined;

          if (
            !timingSafeKeyMatch(headerKey, config.apiKey) &&
            !timingSafeKeyMatch(queryApiKey, config.apiKey)
          ) {
            return reply.code(401).send({ error: "Unauthorized" });
          }

          return undefined;
        },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/backend test -- server`
Expected: PASS — new origin tests green; the existing `401` missing/wrong-key tests, the query-string-key test, and the no-Origin flow tests all still pass (no Origin → allowed; timing-safe match authenticates).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @echoflow/backend typecheck`
Expected: exit 0.

```bash
git add apps/backend/src/server.ts apps/backend/src/server.test.ts
git commit -m "fix(backend): reject cross-origin WS handshakes; constant-time key check

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Extension runtime-message sender validation

**Files:**
- Modify: `apps/extension/src/messaging/messages.ts` (add `isInternalSender`)
- Test: `apps/extension/src/messaging/messages.test.ts` (extend)
- Modify: `apps/extension/entrypoints/background.ts`, `apps/extension/entrypoints/offscreen/main.ts`, `apps/extension/entrypoints/content.tsx` (guard each `onMessage` listener)

**Interfaces:**
- Produces: `isInternalSender(sender: { id?: string }, runtimeId: string): boolean` — `true` iff `sender.id === runtimeId`. Consumed by the three listeners as `isInternalSender(sender, chrome.runtime.id)`.

- [ ] **Step 1: Write the failing test**

Add to `messages.test.ts`:

```ts
  it("accepts a sender that is this extension and rejects others", () => {
    expect(isInternalSender({ id: "ext-1" }, "ext-1")).toBe(true);
    expect(isInternalSender({ id: "other-ext" }, "ext-1")).toBe(false);
    expect(isInternalSender({}, "ext-1")).toBe(false);
  });
```

Add `isInternalSender` to the import from `./messages`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test -- messages`
Expected: FAIL — `isInternalSender` not exported.

- [ ] **Step 3: Implement the helper**

In `messages.ts`:

```ts
export function isInternalSender(
  sender: { id?: string },
  runtimeId: string
): boolean {
  return sender.id === runtimeId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @echoflow/extension test -- messages`
Expected: PASS.

- [ ] **Step 5: Guard the three listeners**

`background.ts` — the `chrome.runtime.onMessage` listener callback gains `sender` and the guard:

```ts
  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (!isInternalSender(sender, chrome.runtime.id)) {
      return;
    }
    if (!isRuntimeMessage(message)) {
      return;
    }
    enqueueMessage(() => handleRuntimeMessage(message));
  });
```

(Import `isInternalSender` alongside `isRuntimeMessage`.)

`offscreen/main.ts` — same guard at the top of its `onMessage` listener:

```ts
chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!isInternalSender(sender, chrome.runtime.id)) {
    return;
  }
  if (!isRuntimeMessage(message)) {
    return;
  }
  // …existing START_SESSION / STOP_SESSION handling…
});
```

`content.tsx` — change `handleRuntimeMessage` to receive and check the sender:

```ts
    function handleRuntimeMessage(message: unknown, sender: chrome.runtime.MessageSender) {
      if (!isInternalSender(sender, chrome.runtime.id)) {
        return;
      }
      if (!isRuntimeMessage(message)) {
        return;
      }
      // …existing SERVER_EVENT / CONNECTION_STATUS / SESSION_ERROR / SESSION_STOPPED handling…
    }
```

`chrome.runtime.onMessage.addListener(handleRuntimeMessage)` already passes `(message, sender)` so the reference-based `removeListener(handleRuntimeMessage)` still works. Import `isInternalSender` in each file.

- [ ] **Step 6: Verify**

Run: `pnpm --filter @echoflow/extension typecheck`
Expected: exit 0.

Run: `pnpm --filter @echoflow/extension test`
Expected: PASS — messages test + all pre-existing tests green (entrypoint guards have no unit test).

Run: `grep -n "isInternalSender" apps/extension/entrypoints/background.ts apps/extension/entrypoints/offscreen/main.ts apps/extension/entrypoints/content.tsx`
Expected: the guard is present in all three listeners.

- [ ] **Step 7: Commit**

```bash
git add apps/extension/src/messaging/messages.ts apps/extension/src/messaging/messages.test.ts apps/extension/entrypoints/background.ts apps/extension/entrypoints/offscreen/main.ts apps/extension/entrypoints/content.tsx
git commit -m "fix(extension): only accept runtime messages from this extension

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- #3 Origin allowlist → Task 1 (`isAllowedOrigin`) + Task 2 (wire, 403 before key). ✅
- Constant-time key compare → Task 1 (`timingSafeKeyMatch`) + Task 2 (both endpoints). ✅
- Extension sender validation → Task 3. ✅
- Default key unchanged; not-configurable Origin — honored (no code touches the default or adds config). ✅

**Placeholder scan:** No TBD/TODO. Task 2's socket-cleanup note is an explicit "match the file's existing teardown" instruction with the fixed assertions stated.

**Type consistency:** `isAllowedOrigin(origin: string | undefined)` and `timingSafeKeyMatch(provided: string | undefined, expected: string)` signatures match their Task 2 call sites (headers narrowed to `string | undefined`). `isInternalSender(sender, runtimeId)` matches the three listener call sites (`sender, chrome.runtime.id`). Header access uses `typeof … === "string"` narrowing for `noUncheckedIndexedAccess`/array-header safety.

**Ordering:** Task 1 (backend helper) → Task 2 (backend wire) → Task 3 (extension, independent). Each leaves its package green.
