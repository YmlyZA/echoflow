# Browser Audio Translation Extension Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Chrome/Chromium extension MVP that captures active tab audio, streams it to a cloud backend, and displays bilingual source/translation subtitles with local history.

**Architecture:** Use a pnpm TypeScript monorepo with a WXT Manifest V3 extension, shared protocol package, and Fastify WebSocket backend. The extension owns capture, overlay UI, settings, and local history; the backend owns WebSocket sessions, fake-first STT/translation providers, and protocol event emission.

**Tech Stack:** pnpm workspaces, TypeScript, WXT, React, Shadow DOM, Dexie, Chrome extension APIs, Fastify, `@fastify/websocket`, Vitest, Playwright.

## Pre-Flight Notes

- Design spec: `docs/plans/2026-05-31-browser-audio-translation-extension-design.md`
- Current workspace is not a git repo. The first implementation task initializes git so later commit steps work.
- Use the Lore Commit Protocol from `AGENTS.md` for every commit.
- Keep real STT/translation providers out of the first pass. Use fake providers until the extension/backend protocol is proven end to end.
- Do not add login, cloud history, TTS, microphone capture, or system audio in this MVP.

## Task 1: Initialize Repository And Monorepo

**Files:**

- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `apps/extension/package.json`
- Create: `apps/backend/package.json`
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`

**Step 1: Initialize git**

Run:

```bash
git init
```

Expected: repository initialized.

**Step 2: Create root workspace files**

Create `package.json`:

```json
{
  "name": "echoflow",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.0.0",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck",
    "lint": "pnpm -r lint"
  },
  "devDependencies": {
    "typescript": "^5.8.0",
    "vitest": "^3.0.0"
  }
}
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  }
}
```

Create `.gitignore`:

```gitignore
node_modules/
dist/
.output/
coverage/
.env
.env.*
!.env.example
*.log
```

**Step 3: Create package shells**

Create `packages/protocol/package.json`:

```json
{
  "name": "@echoflow/protocol",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "tsc -p tsconfig.json --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.8.0",
    "vitest": "^3.0.0"
  }
}
```

Create `packages/protocol/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "declaration": true
  },
  "include": ["src/**/*.ts"]
}
```

Create minimal `apps/extension/package.json` and `apps/backend/package.json` with only `name`, `private`, `type`, and temporary scripts that return success. Later tasks replace them.

**Step 4: Install dependencies**

Run:

```bash
pnpm install
```

Expected: lockfile created and dependencies installed.

**Step 5: Verify**

Run:

```bash
pnpm typecheck
```

Expected: all workspace typecheck scripts pass.

**Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore apps packages pnpm-lock.yaml
git commit -m "Establish the monorepo foundation for the extension MVP

Constraint: Workspace started without git or package structure
Confidence: high
Scope-risk: narrow
Directive: Keep future packages inside apps/* or packages/*
Tested: pnpm typecheck
Not-tested: Runtime behavior not present yet"
```

## Task 2: Define Shared Protocol Types First

**Files:**

- Create: `packages/protocol/src/index.ts`
- Create: `packages/protocol/src/events.ts`
- Create: `packages/protocol/src/session.ts`
- Create: `packages/protocol/src/events.test.ts`

**Step 1: Write failing protocol tests**

Create `packages/protocol/src/events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isServerEvent, makeFinalSegment } from "./events";

describe("protocol events", () => {
  it("accepts final subtitle events", () => {
    expect(
      isServerEvent({
        type: "final",
        segmentId: "s1",
        sourceText: "hello everyone",
        translatedText: "大家好"
      })
    ).toBe(true);
  });

  it("rejects unknown event types", () => {
    expect(isServerEvent({ type: "unknown" })).toBe(false);
  });

  it("creates finalized history segments", () => {
    expect(
      makeFinalSegment({
        sessionId: "local-1",
        segmentId: "s1",
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        sourceText: "hello",
        translatedText: "你好",
        startTimeMs: 0,
        endTimeMs: 900
      }).status
    ).toBe("final");
  });
});
```

**Step 2: Run test to verify failure**

Run:

```bash
pnpm --filter @echoflow/protocol test
```

Expected: FAIL because `events.ts` does not exist.

**Step 3: Implement protocol**

Create `packages/protocol/src/events.ts` with discriminated unions:

```ts
export type LanguageEvent = {
  type: "language";
  sourceLanguage: string;
  targetLanguage: string;
};

export type PartialSubtitleEvent = {
  type: "partial";
  segmentId: string;
  sourceText: string;
  translatedText?: string;
};

export type FinalSubtitleEvent = {
  type: "final";
  segmentId: string;
  sourceText: string;
  translatedText: string;
};

export type ErrorEvent = {
  type: "error";
  code: string;
  message: string;
};

export type ServerEvent =
  | LanguageEvent
  | PartialSubtitleEvent
  | FinalSubtitleEvent
  | ErrorEvent;

export type SubtitleSegment = {
  sessionId: string;
  segmentId: string;
  startTimeMs: number;
  endTimeMs: number;
  sourceLanguage: string;
  targetLanguage: string;
  sourceText: string;
  translatedText: string;
  confidence?: number;
  status: "final";
};

export function isServerEvent(value: unknown): value is ServerEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as { type?: unknown };
  return (
    event.type === "language" ||
    event.type === "partial" ||
    event.type === "final" ||
    event.type === "error"
  );
}

export function makeFinalSegment(input: Omit<SubtitleSegment, "status">): SubtitleSegment {
  return { ...input, status: "final" };
}
```

Create `packages/protocol/src/session.ts` and `packages/protocol/src/index.ts` exporting session config and protocol types.

**Step 4: Verify**

Run:

```bash
pnpm --filter @echoflow/protocol test
pnpm --filter @echoflow/protocol typecheck
```

Expected: tests and typecheck pass.

**Step 5: Commit**

Use Lore commit with `Tested: pnpm --filter @echoflow/protocol test; pnpm --filter @echoflow/protocol typecheck`.

## Task 3: Build Backend WebSocket With Fake Providers

**Files:**

- Modify: `apps/backend/package.json`
- Create: `apps/backend/tsconfig.json`
- Create: `apps/backend/src/server.ts`
- Create: `apps/backend/src/config.ts`
- Create: `apps/backend/src/realtime/session.ts`
- Create: `apps/backend/src/providers/fakeSpeechProvider.ts`
- Create: `apps/backend/src/providers/fakeTranslationProvider.ts`
- Create: `apps/backend/src/server.test.ts`

**Step 1: Add backend dependencies**

Install:

```bash
pnpm --filter @echoflow/backend add fastify @fastify/websocket ws @echoflow/protocol
pnpm --filter @echoflow/backend add -D typescript tsx vitest @types/ws
```

Expected: dependencies added.

**Step 2: Write failing WebSocket test**

Create a test that starts Fastify with `injectWS`, connects with `x-api-key: dev-key`, sends a JSON control message `{ "type": "start" }`, then expects `language`, `partial`, and `final` events.

Run:

```bash
pnpm --filter @echoflow/backend test
```

Expected: FAIL because server module does not exist.

**Step 3: Implement server factory**

Implement `createServer()` in `apps/backend/src/server.ts`. Register `@fastify/websocket`, add a `/healthz` HTTP route, and add `/v1/realtime` WebSocket route. Reject missing or wrong API keys before accepting useful work.

**Step 4: Implement fake providers**

Fake speech provider emits deterministic source text for any received binary or text audio frame. Fake translation provider returns a deterministic target string. Keep both behind small interfaces so real providers can replace them later.

**Step 5: Implement session orchestration**

`RealtimeSession` should:

- receive frames
- emit `language` once
- emit `partial` for interim text
- emit `final` for finalized text
- catch provider errors and send `error`
- clean up on socket close

**Step 6: Verify**

Run:

```bash
pnpm --filter @echoflow/backend test
pnpm --filter @echoflow/backend typecheck
```

Expected: backend tests and typecheck pass.

**Step 7: Commit**

Use Lore commit with `Tested: pnpm --filter @echoflow/backend test; pnpm --filter @echoflow/backend typecheck`.

## Task 4: Scaffold WXT Extension

**Files:**

- Modify: `apps/extension/package.json`
- Create: `apps/extension/wxt.config.ts`
- Create: `apps/extension/tsconfig.json`
- Create: `apps/extension/entrypoints/background.ts`
- Create: `apps/extension/entrypoints/offscreen.html`
- Create: `apps/extension/entrypoints/offscreen.ts`
- Create: `apps/extension/entrypoints/content.tsx`
- Create: `apps/extension/entrypoints/options/index.html`
- Create: `apps/extension/entrypoints/options/main.tsx`

**Step 1: Add extension dependencies**

Run:

```bash
pnpm --filter @echoflow/extension add @echoflow/protocol @wxt-dev/module-react dexie react react-dom
pnpm --filter @echoflow/extension add -D wxt typescript vitest @types/chrome @types/react @types/react-dom
```

Expected: dependencies installed.

**Step 2: Configure WXT manifest**

Create `wxt.config.ts` with MV3 permissions:

```ts
import { defineConfig } from "wxt";
import react from "@wxt-dev/module-react";

export default defineConfig({
  modules: [react()],
  manifest: {
    name: "EchoFlow",
    description: "Real-time bilingual subtitles for tab audio.",
    version: "0.0.1",
    manifest_version: 3,
    permissions: ["activeTab", "storage", "tabCapture", "offscreen"],
    action: {
      default_title: "EchoFlow"
    }
  }
});
```

**Step 3: Add initial entrypoints**

Create minimal background, offscreen, content, and options entrypoints that compile but do not capture audio yet.

**Step 4: Verify build**

Run:

```bash
pnpm --filter @echoflow/extension build
pnpm --filter @echoflow/extension typecheck
```

Expected: WXT builds `.output/` successfully and typecheck passes.

**Step 5: Commit**

Use Lore commit with `Tested: pnpm --filter @echoflow/extension build; pnpm --filter @echoflow/extension typecheck`.

## Task 5: Implement Settings Storage And Language Defaults

**Files:**

- Create: `apps/extension/src/settings/settings.ts`
- Create: `apps/extension/src/settings/settings.test.ts`
- Modify: `apps/extension/entrypoints/options/main.tsx`

**Step 1: Write failing tests**

Test:

- missing server URL makes settings invalid
- missing API key makes settings invalid
- `navigator.language` maps to default target language
- manual target language overrides browser default

Run:

```bash
pnpm --filter @echoflow/extension test -- settings
```

Expected: FAIL because settings module does not exist.

**Step 2: Implement settings module**

Use `chrome.storage.local` behind a wrapper. Keep pure validation and language default functions independently testable without Chrome APIs.

**Step 3: Implement options UI**

Add fields for:

- server URL
- API key
- target language
- subtitle font size

Show saved state and validation errors.

**Step 4: Verify**

Run:

```bash
pnpm --filter @echoflow/extension test -- settings
pnpm --filter @echoflow/extension typecheck
```

Expected: tests and typecheck pass.

**Step 5: Commit**

Use Lore commit with settings verification commands.

## Task 6: Implement Subtitle Reducer And Overlay UI

**Files:**

- Create: `apps/extension/src/subtitles/reducer.ts`
- Create: `apps/extension/src/subtitles/reducer.test.ts`
- Create: `apps/extension/src/overlay/SubtitleOverlay.tsx`
- Create: `apps/extension/src/overlay/SubtitleOverlay.test.tsx`
- Modify: `apps/extension/entrypoints/content.tsx`

**Step 1: Write reducer tests**

Test:

- `partial` updates current segment
- `final` locks segment
- translation may lag source text
- `error` stores transient error state
- `language` updates detected source and target language

Run:

```bash
pnpm --filter @echoflow/extension test -- reducer
```

Expected: FAIL because reducer does not exist.

**Step 2: Implement reducer**

Keep reducer pure and based on `@echoflow/protocol` events.

**Step 3: Implement overlay**

Render:

- first line source text
- second line translated text
- compact controls for stop, hide, drag handle, font size
- transient error message

Mount into Shadow DOM from `content.tsx`.

**Step 4: Verify**

Run:

```bash
pnpm --filter @echoflow/extension test -- reducer
pnpm --filter @echoflow/extension typecheck
```

Expected: tests and typecheck pass.

**Step 5: Commit**

Use Lore commit with reducer and typecheck verification.

## Task 7: Implement Local History With IndexedDB

**Files:**

- Create: `apps/extension/src/history/db.ts`
- Create: `apps/extension/src/history/historyStore.ts`
- Create: `apps/extension/src/history/historyStore.test.ts`
- Modify: `apps/extension/entrypoints/options/main.tsx`

**Step 1: Write failing history tests**

Test:

- create local session
- append only final segments
- record errors in session metadata
- export session as text
- export session as JSON

Run:

```bash
pnpm --filter @echoflow/extension test -- historyStore
```

Expected: FAIL because history store does not exist.

**Step 2: Implement Dexie schema**

Tables:

- `sessions`
- `segments`

Include `remoteSessionId?: string` and `syncStatus: "local-only" | "pending" | "synced" | "failed"`.

**Step 3: Add history/options UI**

List local sessions and provide view/export controls. Keep search out of scope.

**Step 4: Verify**

Run:

```bash
pnpm --filter @echoflow/extension test -- historyStore
pnpm --filter @echoflow/extension typecheck
```

Expected: tests and typecheck pass.

**Step 5: Commit**

Use Lore commit with history verification commands.

## Task 8: Implement Background Session Orchestration

**Files:**

- Create: `apps/extension/src/messaging/messages.ts`
- Create: `apps/extension/src/session/sessionState.ts`
- Create: `apps/extension/src/session/sessionState.test.ts`
- Modify: `apps/extension/entrypoints/background.ts`
- Modify: `apps/extension/entrypoints/content.tsx`
- Modify: `apps/extension/entrypoints/offscreen.ts`

**Step 1: Write state tests**

Test:

- idle to connecting
- connecting to running
- running to stopping
- error to idle after stop
- cannot start without valid settings

Run:

```bash
pnpm --filter @echoflow/extension test -- sessionState
```

Expected: FAIL because session state module does not exist.

**Step 2: Implement typed message schema**

Messages:

- `START_SESSION`
- `STOP_SESSION`
- `SESSION_STARTED`
- `SESSION_ERROR`
- `SERVER_EVENT`
- `OFFSCREEN_READY`

**Step 3: Implement background click flow**

On action click:

- load settings
- open options if invalid
- inject content script
- create local session
- create offscreen document
- request tab capture stream ID
- send start command to offscreen

**Step 4: Implement stop flow**

Stop offscreen streaming, finalize session metadata, clear badge state.

**Step 5: Verify**

Run:

```bash
pnpm --filter @echoflow/extension test -- sessionState
pnpm --filter @echoflow/extension typecheck
```

Expected: tests and typecheck pass.

**Step 6: Commit**

Use Lore commit with orchestration verification commands.

## Task 9: Implement Offscreen Audio And WebSocket Client

**Files:**

- Create: `apps/extension/src/audio/audioPipeline.ts`
- Create: `apps/extension/src/audio/audioPipeline.test.ts`
- Create: `apps/extension/src/realtime/realtimeClient.ts`
- Create: `apps/extension/src/realtime/realtimeClient.test.ts`
- Modify: `apps/extension/entrypoints/offscreen.ts`

**Step 1: Write WebSocket client tests**

Test:

- sends session start metadata
- sends audio frames
- parses server events
- emits error on invalid server messages
- retries limited connection failures

Run:

```bash
pnpm --filter @echoflow/extension test -- realtimeClient
```

Expected: FAIL because client does not exist.

**Step 2: Implement realtime client**

Use browser `WebSocket`. Keep protocol parsing separate from WebSocket object so parsing stays unit-testable.

**Step 3: Implement audio pipeline**

In offscreen document:

- resolve stream ID to `MediaStream`
- connect stream to `AudioContext.destination` to preserve audible playback
- chunk audio with `MediaRecorder` for MVP
- send chunks over realtime client

Prefer `MediaRecorder` for MVP simplicity. Leave `AudioWorklet` as a later optimization if provider format requires it.

**Step 4: Verify**

Run:

```bash
pnpm --filter @echoflow/extension test -- realtimeClient
pnpm --filter @echoflow/extension typecheck
```

Expected: tests and typecheck pass.

**Step 5: Commit**

Use Lore commit with realtime client verification commands.

## Task 10: Wire End-To-End Fake Backend Flow

**Files:**

- Create: `apps/extension/e2e/fixtures/test-video.html`
- Create: `apps/extension/e2e/extension-smoke.spec.ts`
- Modify: `apps/extension/package.json`
- Modify: `apps/backend/package.json`
- Create: `scripts/dev-smoke.sh`

**Step 1: Add Playwright**

Run:

```bash
pnpm --filter @echoflow/extension add -D @playwright/test
```

Expected: dependency installed.

**Step 2: Write smoke test**

The smoke test should:

- start fake backend
- build extension
- launch Chromium with the built extension
- open `test-video.html`
- configure extension settings
- trigger extension action
- assert overlay renders source and translation text
- assert final segment appears in local history

**Step 3: Add dev smoke script**

`scripts/dev-smoke.sh` should start backend and run the Playwright extension smoke test with clear cleanup.

**Step 4: Verify**

Run:

```bash
pnpm build
pnpm test
bash scripts/dev-smoke.sh
```

Expected:

- all packages build
- unit tests pass
- smoke test passes in Chromium

**Step 5: Commit**

Use Lore commit with `Tested: pnpm build; pnpm test; bash scripts/dev-smoke.sh`.

## Task 11: Add Developer Documentation

**Files:**

- Create: `README.md`
- Create: `.env.example`
- Modify: `docs/plans/2026-05-31-browser-audio-translation-extension-design.md` if implementation discoveries changed assumptions

**Step 1: Document setup**

`README.md` should include:

- install: `pnpm install`
- dev backend: `pnpm --filter @echoflow/backend dev`
- dev extension: `pnpm --filter @echoflow/extension dev`
- build extension: `pnpm --filter @echoflow/extension build`
- test commands
- how to load `.output/chrome-mv3` in Chrome
- MVP scope and exclusions

**Step 2: Add environment example**

`.env.example`:

```env
ECHOFLOW_API_KEY=dev-key
ECHOFLOW_PORT=8787
```

**Step 3: Verify docs commands**

Run the documented commands at least through build/test:

```bash
pnpm build
pnpm test
```

Expected: commands pass.

**Step 4: Commit**

Use Lore commit with `Tested: pnpm build; pnpm test`.

## Final Verification

Run:

```bash
pnpm typecheck
pnpm test
pnpm build
bash scripts/dev-smoke.sh
```

Expected:

- typecheck passes for protocol, backend, and extension
- unit tests pass
- backend builds
- extension builds
- fake end-to-end subtitle flow passes

Manual Chrome check:

1. Load built extension from `apps/extension/.output/chrome-mv3`.
2. Open local test video page.
3. Configure backend URL and API key.
4. Click extension action.
5. Confirm bilingual overlay appears.
6. Confirm original tab audio remains audible.
7. Stop the session.
8. Confirm local history contains only finalized segments.

## Deferred Work

- Real STT provider adapter.
- Real translation provider adapter.
- Provider selection and secrets management.
- Server-side history and account model.
- Microphone source provider.
- System audio source provider.
- TTS playback and original audio volume control.
- Store packaging and privacy policy.
