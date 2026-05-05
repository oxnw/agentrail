import test from "node:test";
import assert from "node:assert/strict";

import { MultiCiStatusAdapter } from "../src/multi-ci-status-adapter.ts";

test("MultiCiStatusAdapter returns the first provider result and forwards webhooks to capable adapters", async () => {
  const calls: string[] = [];
  const adapter = new MultiCiStatusAdapter({
    adapters: [
      {
        async getTaskCiStatus(taskId: string) {
          calls.push(`first:${taskId}`);
          return null;
        }
      },
      {
        async getTaskCiStatus(taskId: string) {
          calls.push(`second:${taskId}`);
          return { data: { taskId, overallStatus: "passed" }, availableActions: [], meta: {} };
        },
        async receiveWebhook(payload: unknown) {
          calls.push(`webhook:${(payload as { rawBody: string }).rawBody}`);
          return { data: { accepted: true, deduplicated: false, matchedTasks: ["tsk_123"] }, availableActions: [] };
        }
      }
    ]
  });
  const body = await adapter.getTaskCiStatus("tsk_123");
  assert.equal(body!.data.overallStatus, "passed");
  const webhookBody = await adapter.receiveWebhook({ rawBody: '{"hello":"world"}', headers: {} });
  assert.deepEqual(webhookBody.data.matchedTasks, ["tsk_123"]);
  assert.deepEqual(calls, ["first:tsk_123", "second:tsk_123", 'webhook:{"hello":"world"}']);
});
