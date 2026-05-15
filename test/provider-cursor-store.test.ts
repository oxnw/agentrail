import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { ProviderCursorStore } from "../src/provider-cursor-store.ts";

test("ProviderCursorStore persists and reloads normalized cursor records", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-provider-cursors-"));
  const storagePath = path.join(tempDir, "provider-cursors.json");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await writeFile(storagePath, JSON.stringify({
    cursors: [
      {
        provider: "github",
        resource: "issues",
        repository: "  oxnw/agentrail  ",
        cursor: "  2026-05-14T12:00:00.000Z  ",
        updatedAt: "2026-05-14T12:01:00.000Z",
      },
      {
        provider: "github",
        resource: "issues",
        repository: "",
        cursor: "2026-05-14T12:00:00.000Z",
        updatedAt: "2026-05-14T12:01:00.000Z",
      },
    ],
  }), "utf8");

  const store = new ProviderCursorStore({
    storagePath,
    now: () => new Date("2026-05-14T12:02:00.000Z"),
  });

  assert.equal(store.getCursor({ provider: "github", resource: "issues", repository: "oxnw/agentrail" }), "2026-05-14T12:00:00.000Z");
  store.setCursor({ provider: "github", resource: "issues", repository: "oxnw/agentrail" }, "2026-05-14T12:03:00.000Z");

  const reloaded = new ProviderCursorStore({ storagePath });
  assert.equal(reloaded.getCursor({ provider: "github", resource: "issues", repository: "oxnw/agentrail" }), "2026-05-14T12:03:00.000Z");

  const persisted = JSON.parse(await readFile(storagePath, "utf8"));
  assert.deepEqual(persisted.cursors.map((cursor: { repository: string; cursor: string; updatedAt: string }) => ({
    repository: cursor.repository,
    cursor: cursor.cursor,
    updatedAt: cursor.updatedAt,
  })), [{
    repository: "oxnw/agentrail",
    cursor: "2026-05-14T12:03:00.000Z",
    updatedAt: "2026-05-14T12:02:00.000Z",
  }]);
});
