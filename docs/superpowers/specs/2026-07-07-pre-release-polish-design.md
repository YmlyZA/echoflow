# Pre-Release Polish Design (v0.1.0)

> Captured 2026-07-07. Three small accepted-minor fixes from the SP4 review trail, batched as one
> slice ahead of the project's **first release tag** (`v0.1.0` — licensing + the complete SP1a–SP4c
> history arc). One PR (`chore/pre-release-polish`); the tag is cut after it merges.

## (a) Sync UX — exclude the active session from "waiting"; honest failed wording

**Problem.** `deriveSyncStatusView` counts every `local-only` session as waiting, but the engine
(`syncEngine.ts` outbox) deliberately excludes the currently-capturing session. While capturing,
the Options row shows "1 session waiting to sync" and Sync now cannot clear it — misleading.
Separately, the `failed` label "Last sync attempt failed · N waiting" implies the whole attempt
failed when failure is per-session (one poisoned session keeps the row red even though everything
else synced).

**Design.**
- `SyncStatusViewInput.sessions` becomes `ReadonlyArray<{ id: string; syncStatus: SyncStatus }>`
  and the input gains `activeSessionId: string | null`. The waiting count (and the failed check)
  skip the session whose `id === activeSessionId` — mirroring the engine's outbox rule exactly.
- Failed label becomes `` `${failed} ${failed === 1 ? "session" : "sessions"} could not sync` ``
  (failed = failed sessions excluding the active one; no apostrophes). Other labels unchanged.
- Options learns the active session from the background's **already-persisted session state**:
  `chrome.storage.session[SESSION_STATE_STORAGE_KEY]` (`src/session/sessionStore.ts`,
  `PersistedSessionState.sessionState`), which extension pages can read (MV3 trusted context).
  `HistoryPanel` loads it once and subscribes to `chrome.storage.onChanged` (area `"session"`) —
  `activeSessionId = sessionState.status !== "idle" ? sessionState.localSessionId : null`.
  Read failures / absent key degrade to `null` (today's behavior).

**Tests.** `syncStatusView.test.ts` reworked for the new input shape: active `local-only` session
excluded from waiting (and an active `pending`-during-race excluded too — the rule is by id, not
status); failed label counts failed sessions and uses singular/plural; existing precedence cases
updated. Options wiring stays entrypoint territory (typecheck/build + e2e).

## (b) Backend graceful shutdown (`dev.ts`)

**Problem.** `dev.ts` never calls `server.close()`, so the `onClose` hook that closes the sqlite
`HistoryRepository` never runs on Ctrl-C/SIGTERM (accepted minor from the SP4a review; sqlite is
crash-safe so this is hygiene, not data loss).

**Design.** In `dev.ts`, after `listen`:

```ts
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log(`Received ${signal}, shutting down...`);
    void server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
```

`process.once` prevents double-close on repeated signals; a second Ctrl-C during shutdown kills the
process via Node's default handler (since the `once` handler is consumed) — acceptable for a dev
script. No unit test (dev script; typecheck + manual Ctrl-C check post-merge).

## (c) Record Volcengine `UsageResponse(154)` instead of dropping it

**Problem.** `parseAstMessage` recognizes event 154 but returns a bare `{ kind: "usage" }`,
discarding the payload. The backlog wants usage recorded (billing-relevant for the paid mode).

**Constraint.** The usage payload's protobuf field semantics are **unverified** (same policy as the
speaker fields: no guessing wire semantics without a real sample).

**Design — generic decode + log (v1).**
- `astProtocol.ts`: the `usage` variant becomes `{ kind: "usage"; details: string }` where
  `details` is a compact, deterministic rendering of the message's top-level fields — for each
  field number in ascending order: varints as `«n»=«value»`, length-delimited as `«n»=bytes(«len»)`
  (a new small `describeFields(fields)` helper; skips the already-known event field). No semantic
  interpretation.
- The interpret adapter (where `AstServerEvent`s are consumed) logs it once per event:
  `console.info("EchoFlow: volcengine usage", details)` — observable in the backend terminal, and
  each logged line doubles as the future sample for a structured decode.
- `AstServerEvent` consumers that switch on `kind` are unaffected (usage stays a no-op for the
  subtitle flow).

**Tests.** `astProtocol.test.ts`: a synthetic usage message (event=154 + a varint field + a bytes
field) parses to `kind: "usage"` with the expected `details` string; existing parse tests
unaffected. Adapter logging is a one-line side effect covered by the parse contract (no
console-spy test needed unless the adapter test file already spies — follow its conventions).

## Release (after merge)

First tag: **`v0.1.0`** on the merge commit → the existing tag-driven CI
(`docs/RELEASING.md`) builds and publishes the GitHub Release with
`echoflow-0.1.0-chrome.zip`. Highlights for the release notes: layered open-source licensing
(MIT + AGPL-3.0 + DCO), the complete video-anchored history arc (SP1a–SP3), self-hosted
cross-device sync (SP4a–c), plus the audit-remediation hardening that preceded them.

## Non-goals

- Structured usage decode / usage persistence (needs a real sample; the logs produce one).
- Surfacing per-session "could not sync" details in the UI beyond the row label.
- Graceful-shutdown handling anywhere but `dev.ts` (tests close servers explicitly).
