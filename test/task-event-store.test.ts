import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

import { TaskEventStore } from "../src/task-event-store.ts";

test("TaskEventStore persists appended events to an append-only local outbox file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-store-"));
  const storagePath = path.join(tempDir, "task-events.ndjson");
  const FIXTURE_NOW = new Date("2026-05-01T03:25:15Z");
  const now = () => FIXTURE_NOW;
  const event = {
    id: "evt_01JY50DG4S5SJC48W0MVV8R3H2",
    type: "task.updated",
    occurredAt: "2026-05-01T03:25:15Z",
    sequence: 4128,
    taskVersion: 9,
    traceId: "trc_01JY50DCRX3AVNQBE6Q71RQB9N",
    data: {
      taskId: "tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V",
      taskIdentifier: "AGEA-13",
      status: "in_review",
      previousStatus: "in_progress",
      changedFields: ["status", "availableActions"],
      actor: { id: "agt_cto", role: "cto" },
      summary: "Submission accepted and routed to CEO review.",
      availableActions: ["ship"],
      links: {
        task: "https://api.agentrail.app/v1/tasks/tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V",
        reviewFeedback: "https://api.agentrail.app/v1/tasks/tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V/review-feedback",
        ciStatus: null,
        shipOperation: null
      }
    }
  };
  const firstStore = new TaskEventStore({ storagePath, now });
  await firstStore.append(event);
  const serialized = await readFile(storagePath, "utf8");
  assert.match(serialized, /evt_01JY50DG4S5SJC48W0MVV8R3H2/);
  const secondStore = new TaskEventStore({ storagePath, now });
  const resumed = secondStore.resolveCursor("evt_01JY50DG4S5SJC48W0MVV8R3H2");
  assert.equal(resumed.sequence, 4128);
  assert.equal(secondStore.getMaxSequence(), 4128);
});