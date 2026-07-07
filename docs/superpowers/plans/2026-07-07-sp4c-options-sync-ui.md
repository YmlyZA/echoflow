# SP4c — Options Sync UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Options page surfaces sync: a status row (unavailable / last synced / N waiting / failed) with a "Sync now" button, and a per-session sync badge in the history panel.

**Architecture:** A pure `deriveSyncStatusView` helper + two presentational components (`SyncSection`, `SyncStatusBadge`) in `src/sync/`, tested with `renderToStaticMarkup` like the existing Popup/Onboarding components; the Options `HistoryPanel` wires them — reading `sync.available` from the already-fetched capabilities, `lastSyncAtMs` from `chrome.storage.local` (shared key module extracted from background.ts), and sending the existing `SYNC_NOW` runtime message. Spec: `docs/superpowers/specs/2026-07-07-self-hosted-history-sync-design.md` (SP4c row). This completes SP4.

**Tech Stack:** React 19, WXT/MV3 options page, Vitest + `react-dom/server`.

## Global Constraints

- **No new credentials UI** (spec decision 5) and **no new permissions**.
- Zero new npm dependencies. Extension TS is strict; imports have no `.js` extension.
- **No apostrophes in any user-facing label** introduced by this slice — `renderToStaticMarkup` escapes `'` to `&#x27;`, which breaks naive `toContain` assertions (established project gotcha). Copy is chosen apostrophe-free.
- Component tests follow the existing pattern (see `src/popup/PopupApp.test.tsx`): presentational component + `renderToStaticMarkup` + `toContain` assertions. Entrypoint wiring (options `main.tsx`, `background.ts`) is NOT unit-tested (repo convention: `test` targets `src/`; entrypoints are covered by e2e/smoke) — typecheck + build gate it.
- Sync UI must degrade quietly: `sync.available` absent/false → status row shows unavailable and the button is disabled; nothing errors.
- The storage keys `"echoflow.syncCursor"` / `"echoflow.lastSyncAtMs"` move to ONE shared module consumed by both background and options — values must not change (they are already persisted on users' machines).
- All commits DCO-signed: `git commit -s`, body ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Verification: `pnpm --filter @echoflow/extension test`, `pnpm typecheck`, `pnpm --filter @echoflow/extension build`. Baseline entering this slice: protocol 49 / backend 166 / extension 238.

---

### Task 1: `deriveSyncStatusView` (pure status derivation)

**Files:**
- Create: `apps/extension/src/sync/syncStatusView.ts`
- Create: `apps/extension/src/sync/syncStatusView.test.ts`

**Interfaces:**
- Consumes: `SyncStatus` type from `../history/historyStore`.
- Produces (Tasks 2–3 consume):

```ts
export interface SyncStatusViewInput {
  syncAvailable: boolean | null;                       // capabilities sync.available; null = unknown
  lastSyncAtMs: number | null;
  sessions: ReadonlyArray<{ syncStatus: SyncStatus }>;
}
export interface SyncStatusView {
  tone: "unavailable" | "failed" | "waiting" | "ok" | "empty";
  label: string;
  canSyncNow: boolean;
}
export function deriveSyncStatusView(
  input: SyncStatusViewInput,
  formatTime?: (ms: number) => string
): SyncStatusView;
```

- [ ] **Step 1: Write the failing test**

Create `apps/extension/src/sync/syncStatusView.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveSyncStatusView } from "./syncStatusView";

const fmt = (ms: number) => `T${ms}`;

function session(syncStatus: "local-only" | "pending" | "synced" | "failed") {
  return { syncStatus };
}

describe("deriveSyncStatusView", () => {
  it("is unavailable (button disabled) when the server lacks sync or capabilities are unknown", () => {
    for (const syncAvailable of [false, null] as const) {
      const view = deriveSyncStatusView({ syncAvailable, lastSyncAtMs: null, sessions: [] }, fmt);
      expect(view.tone).toBe("unavailable");
      expect(view.label).toBe("Sync is not available on this server");
      expect(view.canSyncNow).toBe(false);
    }
  });

  it("reports a failed attempt with the waiting count", () => {
    const view = deriveSyncStatusView(
      {
        syncAvailable: true,
        lastSyncAtMs: 1000,
        sessions: [session("failed"), session("pending"), session("synced")]
      },
      fmt
    );
    expect(view.tone).toBe("failed");
    expect(view.label).toBe("Last sync attempt failed · 2 waiting");
    expect(view.canSyncNow).toBe(true);
  });

  it("counts pending, failed and local-only sessions as waiting", () => {
    const view = deriveSyncStatusView(
      {
        syncAvailable: true,
        lastSyncAtMs: null,
        sessions: [session("pending"), session("local-only"), session("synced")]
      },
      fmt
    );
    expect(view.tone).toBe("waiting");
    expect(view.label).toBe("2 sessions waiting to sync");
  });

  it("uses the singular form for one waiting session", () => {
    const view = deriveSyncStatusView(
      { syncAvailable: true, lastSyncAtMs: null, sessions: [session("pending")] },
      fmt
    );
    expect(view.label).toBe("1 session waiting to sync");
  });

  it("shows the last-synced time when nothing is waiting", () => {
    const view = deriveSyncStatusView(
      { syncAvailable: true, lastSyncAtMs: 1234, sessions: [session("synced")] },
      fmt
    );
    expect(view.tone).toBe("ok");
    expect(view.label).toBe("Last synced T1234");
    expect(view.canSyncNow).toBe(true);
  });

  it("shows an empty state before any sync", () => {
    const view = deriveSyncStatusView(
      { syncAvailable: true, lastSyncAtMs: null, sessions: [] },
      fmt
    );
    expect(view.tone).toBe("empty");
    expect(view.label).toBe("Nothing to sync yet");
    expect(view.canSyncNow).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @echoflow/extension test syncStatusView`
Expected: FAIL — cannot resolve `./syncStatusView`.

- [ ] **Step 3: Implement**

Create `apps/extension/src/sync/syncStatusView.ts`:

```ts
import type { SyncStatus } from "../history/historyStore";

export interface SyncStatusViewInput {
  /** Capabilities sync.available; null while capabilities are unknown. */
  syncAvailable: boolean | null;
  lastSyncAtMs: number | null;
  sessions: ReadonlyArray<{ syncStatus: SyncStatus }>;
}

export interface SyncStatusView {
  tone: "unavailable" | "failed" | "waiting" | "ok" | "empty";
  label: string;
  canSyncNow: boolean;
}

const WAITING_STATUSES: ReadonlySet<SyncStatus> = new Set([
  "pending",
  "failed",
  "local-only"
]);

/** Pure derivation of the Options sync-status row from already-loaded state. */
export function deriveSyncStatusView(
  input: SyncStatusViewInput,
  formatTime: (ms: number) => string = defaultFormatTime
): SyncStatusView {
  if (input.syncAvailable !== true) {
    return {
      tone: "unavailable",
      label: "Sync is not available on this server",
      canSyncNow: false
    };
  }

  const waiting = input.sessions.filter((session) =>
    WAITING_STATUSES.has(session.syncStatus)
  ).length;

  if (input.sessions.some((session) => session.syncStatus === "failed")) {
    return {
      tone: "failed",
      label: `Last sync attempt failed · ${waiting} waiting`,
      canSyncNow: true
    };
  }
  if (waiting > 0) {
    return {
      tone: "waiting",
      label: `${waiting} ${waiting === 1 ? "session" : "sessions"} waiting to sync`,
      canSyncNow: true
    };
  }
  if (input.lastSyncAtMs !== null) {
    return {
      tone: "ok",
      label: `Last synced ${formatTime(input.lastSyncAtMs)}`,
      canSyncNow: true
    };
  }
  return { tone: "empty", label: "Nothing to sync yet", canSyncNow: true };
}

function defaultFormatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/extension test syncStatusView`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/sync/syncStatusView.ts apps/extension/src/sync/syncStatusView.test.ts
git commit -s -m "feat(extension): pure sync-status derivation for the options row

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `SyncSection` + `SyncStatusBadge` components

**Files:**
- Create: `apps/extension/src/sync/SyncSection.tsx`
- Create: `apps/extension/src/sync/SyncSection.test.tsx`
- Create: `apps/extension/src/sync/SyncStatusBadge.tsx`
- Create: `apps/extension/src/sync/SyncStatusBadge.test.tsx`

**Interfaces:**
- Consumes: `SyncStatusView` (Task 1), `SyncStatus` from `../history/historyStore`.
- Produces (Task 3 renders these):

```tsx
export function SyncSection(props: {
  view: SyncStatusView;
  syncing: boolean;
  onSyncNow: () => void;
}): JSX.Element;

export function SyncStatusBadge(props: { status: SyncStatus }): JSX.Element;
```

- [ ] **Step 1: Write the failing tests**

Create `apps/extension/src/sync/SyncSection.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SyncStatusView } from "./syncStatusView";
import { SyncSection } from "./SyncSection";

const okView: SyncStatusView = {
  tone: "ok",
  label: "Last synced 12:30",
  canSyncNow: true
};

describe("SyncSection", () => {
  it("shows the status label and an enabled Sync now button", () => {
    const html = renderToStaticMarkup(
      <SyncSection view={okView} syncing={false} onSyncNow={() => {}} />
    );
    expect(html).toContain("Last synced 12:30");
    expect(html).toContain("Sync now");
    expect(html).not.toContain("disabled");
  });

  it("disables the button and hides the label behind Syncing while a sync runs", () => {
    const html = renderToStaticMarkup(
      <SyncSection view={okView} syncing={true} onSyncNow={() => {}} />
    );
    expect(html).toContain("Syncing");
    expect(html).toContain("disabled");
  });

  it("disables the button when sync is unavailable", () => {
    const html = renderToStaticMarkup(
      <SyncSection
        view={{
          tone: "unavailable",
          label: "Sync is not available on this server",
          canSyncNow: false
        }}
        syncing={false}
        onSyncNow={() => {}}
      />
    );
    expect(html).toContain("Sync is not available on this server");
    expect(html).toContain("disabled");
  });

  it("carries the tone as a class for styling", () => {
    const html = renderToStaticMarkup(
      <SyncSection
        view={{ tone: "failed", label: "Last sync attempt failed · 1 waiting", canSyncNow: true }}
        syncing={false}
        onSyncNow={() => {}}
      />
    );
    expect(html).toContain("ef-sync-failed");
  });
});
```

Create `apps/extension/src/sync/SyncStatusBadge.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SyncStatusBadge } from "./SyncStatusBadge";

describe("SyncStatusBadge", () => {
  it("maps each sync status to a label and a tone class", () => {
    const cases = [
      { status: "local-only" as const, label: "Local", cls: "ef-badge-neutral" },
      { status: "pending" as const, label: "Waiting", cls: "ef-badge-waiting" },
      { status: "synced" as const, label: "Synced", cls: "ef-badge-ok" },
      { status: "failed" as const, label: "Sync failed", cls: "ef-badge-failed" }
    ];
    for (const { status, label, cls } of cases) {
      const html = renderToStaticMarkup(<SyncStatusBadge status={status} />);
      expect(html).toContain(label);
      expect(html).toContain(cls);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @echoflow/extension test SyncSection SyncStatusBadge`
Expected: FAIL — cannot resolve `./SyncSection` / `./SyncStatusBadge`.

- [ ] **Step 3: Implement**

Create `apps/extension/src/sync/SyncSection.tsx`:

```tsx
import type { SyncStatusView } from "./syncStatusView";

export interface SyncSectionProps {
  view: SyncStatusView;
  syncing: boolean;
  onSyncNow: () => void;
}

/** Presentational sync-status row for the Options history panel. */
export function SyncSection({ view, syncing, onSyncNow }: SyncSectionProps) {
  return (
    <div className="ef-sync-row">
      <span className={`ef-sync-status ef-sync-${view.tone}`} role="status">
        {syncing ? "Syncing…" : view.label}
      </span>
      <button
        type="button"
        className="ef-secondary"
        disabled={!view.canSyncNow || syncing}
        onClick={onSyncNow}
      >
        Sync now
      </button>
    </div>
  );
}
```

Create `apps/extension/src/sync/SyncStatusBadge.tsx`:

```tsx
import type { SyncStatus } from "../history/historyStore";

const BADGES: Record<SyncStatus, { label: string; className: string }> = {
  "local-only": { label: "Local", className: "ef-badge ef-badge-neutral" },
  pending: { label: "Waiting", className: "ef-badge ef-badge-waiting" },
  synced: { label: "Synced", className: "ef-badge ef-badge-ok" },
  failed: { label: "Sync failed", className: "ef-badge ef-badge-failed" }
};

/** Per-session sync-state pill for the Options history list. */
export function SyncStatusBadge({ status }: { status: SyncStatus }) {
  const badge = BADGES[status];
  return <span className={badge.className}>{badge.label}</span>;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @echoflow/extension test SyncSection SyncStatusBadge`
Expected: PASS — 5 tests across the two files.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/sync/SyncSection.tsx apps/extension/src/sync/SyncSection.test.tsx apps/extension/src/sync/SyncStatusBadge.tsx apps/extension/src/sync/SyncStatusBadge.test.tsx
git commit -s -m "feat(extension): SyncSection row + SyncStatusBadge components

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Shared storage keys + Options wiring + docs

**Files:**
- Create: `apps/extension/src/sync/syncStorageKeys.ts`
- Modify: `apps/extension/entrypoints/background.ts` (replace the two local key consts with imports)
- Modify: `apps/extension/entrypoints/options/main.tsx`
- Modify: `docs/superpowers/backlog.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `SyncSection`, `SyncStatusBadge` (Task 2), `deriveSyncStatusView` (Task 1), `SyncNowMessage` (`src/messaging/messages`), existing `capabilities` state + `HistoryPanel` in options `main.tsx`.
- Produces: `SYNC_CURSOR_STORAGE_KEY = "echoflow.syncCursor"` and `LAST_SYNC_STORAGE_KEY = "echoflow.lastSyncAtMs"` exported from `src/sync/syncStorageKeys.ts` (values MUST stay exactly these strings — they are live user data).

- [ ] **Step 1: Extract the storage keys module**

Create `apps/extension/src/sync/syncStorageKeys.ts`:

```ts
/**
 * chrome.storage.local keys shared by the background sync engine and the
 * Options sync UI. Values are persisted user state — never change them.
 */
export const SYNC_CURSOR_STORAGE_KEY = "echoflow.syncCursor";
export const LAST_SYNC_STORAGE_KEY = "echoflow.lastSyncAtMs";
```

In `apps/extension/entrypoints/background.ts`: delete the two local declarations
`const SYNC_CURSOR_STORAGE_KEY = "echoflow.syncCursor";` and
`const LAST_SYNC_STORAGE_KEY = "echoflow.lastSyncAtMs";` and add to the imports:

```ts
import {
  LAST_SYNC_STORAGE_KEY,
  SYNC_CURSOR_STORAGE_KEY
} from "../src/sync/syncStorageKeys";
```

Run: `pnpm --filter @echoflow/extension test && pnpm --filter @echoflow/extension typecheck`
Expected: PASS/clean (pure extraction).

- [ ] **Step 2: Wire the Options page**

All edits in `apps/extension/entrypoints/options/main.tsx` (read the file first; line references are approximate — anchor on the quoted code):

(a) Extend imports:

```tsx
import type { SyncNowMessage } from "../../src/messaging/messages";
import { deriveSyncStatusView } from "../../src/sync/syncStatusView";
import { SyncSection } from "../../src/sync/SyncSection";
import { SyncStatusBadge } from "../../src/sync/SyncStatusBadge";
import { LAST_SYNC_STORAGE_KEY } from "../../src/sync/syncStorageKeys";
```

(b) Pass sync availability into the history panel — change `<HistoryPanel />` to:

```tsx
      <HistoryPanel syncAvailable={capabilities?.sync?.available ?? null} />
```

and the component signature `function HistoryPanel() {` to:

```tsx
function HistoryPanel({ syncAvailable }: { syncAvailable: boolean | null }) {
```

(c) Inside `HistoryPanel`, alongside the existing state hooks, add:

```tsx
  const [lastSyncAtMs, setLastSyncAtMs] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
```

(d) After the existing sessions-loading `useEffect`, add the lastSync load + change subscription (a completed sync writes `LAST_SYNC_STORAGE_KEY`, which both settles the button and refreshes the list so badges flip to Synced):

```tsx
  useEffect(() => {
    let mounted = true;
    void chrome.storage.local.get(LAST_SYNC_STORAGE_KEY).then((stored) => {
      const value: unknown = stored[LAST_SYNC_STORAGE_KEY];
      if (mounted && typeof value === "number") {
        setLastSyncAtMs(value);
      }
    });

    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (area !== "local" || !(LAST_SYNC_STORAGE_KEY in changes)) {
        return;
      }
      const value: unknown = changes[LAST_SYNC_STORAGE_KEY]?.newValue;
      if (typeof value === "number") {
        setLastSyncAtMs(value);
      }
      setSyncing(false);
      void refreshSessions();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
    // refreshSessions only touches state setters; the first instance is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

(e) Next to the other `HistoryPanel` functions, add the manual trigger (fire-and-forget; a FAILED sync does not bump `lastSyncAtMs`, so a 10s fallback always settles the button and refreshes badges):

```tsx
  function syncNow() {
    setSyncing(true);
    void Promise.resolve(
      chrome.runtime.sendMessage({ type: "SYNC_NOW" } satisfies SyncNowMessage)
    ).catch(() => {});
    window.setTimeout(() => {
      setSyncing(false);
      void refreshSessions();
    }, 10_000);
  }
```

(f) Render the sync row: directly AFTER the closing `</div>` of `ef-history-head` (and before the `historyError` banner), add:

```tsx
      <SyncSection
        view={deriveSyncStatusView({ syncAvailable, lastSyncAtMs, sessions })}
        syncing={syncing}
        onSyncNow={syncNow}
      />
```

(g) Replace the raw status text in the session list row — change:

```tsx
                  <span className="ef-session-meta">
                    {formatLanguages(session)} · {session.syncStatus}
                  </span>
```

to:

```tsx
                  <span className="ef-session-meta">
                    {formatLanguages(session)} <SyncStatusBadge status={session.syncStatus} />
                  </span>
```

(h) Append to the `OPTIONS_CSS` constant (bottom of the file), before its closing backtick:

```css
.ef-sync-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.ef-sync-status { font-size: 13px; color: #5f6368; }
.ef-sync-failed { color: #c5221f; }
.ef-badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 16px; }
.ef-badge-neutral { background: #f1f3f4; color: #5f6368; }
.ef-badge-waiting { background: #fef7e0; color: #b05a00; }
.ef-badge-ok { background: #e6f4ea; color: #137333; }
.ef-badge-failed { background: #fce8e6; color: #c5221f; }
```

(If `OPTIONS_CSS` uses theme tokens/variables for colors, match the file's existing conventions instead of these hex literals — same tones.)

- [ ] **Step 3: Verify**

Run: `pnpm --filter @echoflow/extension test && pnpm typecheck && pnpm --filter @echoflow/extension build`
Expected: tests PASS, typecheck clean, build succeeds.

- [ ] **Step 4: Documentation**

In `docs/superpowers/backlog.md`, in the SP4 entry, replace the trailing `Next: SP4c (options/status UI).` with:

```markdown
**SP4c — options sync UI** shipped: sync status row in the History panel (unavailable / failed·N waiting / N waiting / last synced HH:MM / nothing yet, derived by the pure `deriveSyncStatusView`) with a "Sync now" button (sends `SYNC_NOW`; settles via a `chrome.storage.onChanged` listener on `lastSyncAtMs` + 10s fallback), and per-session `SyncStatusBadge` pills replacing the raw `syncStatus` text. **SP4 complete (a+b+c) — the sync arc is done.** Accounts/cloud control plane stay out of the OSS repo per the open-core design.
```

In `CLAUDE.md`, in the background bullet's sync sentence (added in SP4b), extend the final clause — change `all fire-and-forget so sync can never break capture.` to:

```
all fire-and-forget so sync can never break capture. The Options history panel shows the sync state (`src/sync/syncStatusView.ts` + `SyncSection`/`SyncStatusBadge`) and a manual "Sync now".
```

- [ ] **Step 5: Final verification + commit**

Run: `pnpm test && pnpm typecheck`
Expected: all packages PASS.

```bash
git add apps/extension/src/sync/syncStorageKeys.ts apps/extension/entrypoints/background.ts apps/extension/entrypoints/options/main.tsx docs/superpowers/backlog.md CLAUDE.md
git commit -s -m "feat(extension): options sync UI — status row, Sync now, session badges

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
