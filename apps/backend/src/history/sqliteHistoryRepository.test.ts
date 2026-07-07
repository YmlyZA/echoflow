import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeHistoryRepositoryContract } from "./historyRepositoryContract.js";
import { createSqliteHistoryRepository } from "./sqliteHistoryRepository.js";

describeHistoryRepositoryContract(() => createSqliteHistoryRepository(":memory:"));

describe("sqlite persistence", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("survives close and reopen on the same file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "echoflow-sync-"));
    dirs.push(dir);
    const path = join(dir, "history.db");

    const first = createSqliteHistoryRepository(path);
    await first.upsertSessions(
      [{ id: "s1", updatedAtMs: 100, payload: { videoKey: "youtube:x" } }],
      null,
    );
    const cursor = (await first.changesSince(0, 500, null)).nextCursor;
    await first.close();

    const second = createSqliteHistoryRepository(path);
    const page = await second.changesSince(0, 500, null);
    expect(page.sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(page.sessions[0]?.payload).toEqual({ videoKey: "youtube:x" });

    // The seq counter must also persist: new writes continue past the old cursor.
    await second.upsertSessions([{ id: "s2", updatedAtMs: 100, payload: {} }], null);
    const delta = await second.changesSince(cursor, 500, null);
    expect(delta.sessions.map((s) => s.id)).toEqual(["s2"]);
    await second.close();
  });
});
