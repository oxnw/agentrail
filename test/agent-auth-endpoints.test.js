import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createServer } from "../src/app.js";
import { AgentAuthStore } from "../src/agent-auth-store.js";
import { TaskEventStore } from "../src/task-event-store.js";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  return `http://${address.address}:${address.port}`;
}

test("agent keys bootstrap admin access, gate protected routes by scope, and expose usage", async (t) => {
  const now = new Date("2026-05-01T04:30:00Z");
  const authStore = new AgentAuthStore({ now: () => now });
  const ciStatusAdapter = {
    async getTaskCiStatus(taskId) {
      return {
        data: {
          taskId,
          submissionId: "sub_01JY4Y4A9P10G6EM7Q3JJ2M1A2",
          overallStatus: "passed",
          summary: {
            total: 1,
            passed: 1,
            failed: 0,
            running: 0,
            queued: 0,
            cancelled: 0,
            skipped: 0
          },
          workflows: [],
          checks: [],
          failureSummaries: [],
          flakyHints: [],
          updatedAt: "2026-05-01T04:30:00Z",
          availableActions: ["view_review_feedback"]
        },
        availableActions: ["view_review_feedback"],
        meta: {
          tokenBudgetHint: "compact",
          truncatedFields: []
        }
      };
    }
  };
  const server = createServer({
    store: new TaskEventStore(),
    authStore,
    ciStatusAdapter,
    now: () => now
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const adminResponse = await fetch(`${baseUrl}/agent-api-keys`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": "bootstrap-admin-AGEA-7-v1"
    },
    body: JSON.stringify({
      agent: {
        id: "agt_cto",
        displayName: "CTO",
        role: "cto"
      },
      scopes: ["auth:admin"],
      rateLimit: {
        windowSeconds: 60,
        maxRequests: 20
      }
    })
  });

  assert.equal(adminResponse.status, 201);
  const adminBody = await adminResponse.json();

  const ciKeyResponse = await fetch(`${baseUrl}/agent-api-keys`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminBody.data.apiKey}`,
      "content-type": "application/json",
      "Idempotency-Key": "ci-reader-AGEA-7-v1"
    },
    body: JSON.stringify({
      agent: {
        id: "agt_ci_reader",
        displayName: "CI Reader",
        role: "platform_ci",
        externalIdentities: [
          {
            provider: "github",
            subject: "agentrail-ci-reader"
          }
        ]
      },
      scopes: ["ci:read"],
      rateLimit: {
        windowSeconds: 60,
        maxRequests: 4
      }
    })
  });

  assert.equal(ciKeyResponse.status, 201);
  const ciKeyBody = await ciKeyResponse.json();

  const ciResponse = await fetch(
    `${baseUrl}/tasks/tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V/ci-status`,
    {
      headers: {
        authorization: `Bearer ${ciKeyBody.data.apiKey}`
      }
    }
  );
  assert.equal(ciResponse.status, 200);
  const ciBody = await ciResponse.json();
  assert.equal(ciBody.data.overallStatus, "passed");

  const webhookResponse = await fetch(`${baseUrl}/task-webhook-subscriptions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ciKeyBody.data.apiKey}`,
      "content-type": "application/json",
      "Idempotency-Key": "webhook-denied-AGEA-7-v1"
    },
    body: JSON.stringify({
      url: "https://agents.example.com/webhooks/task-events",
      eventTypes: ["task.updated"],
      secret: "whsec_live_agentrail_contract_001"
    })
  });

  assert.equal(webhookResponse.status, 403);
  const webhookBody = await webhookResponse.json();
  assert.equal(webhookBody.error.code, "insufficient_scope");
  assert.equal(webhookBody.error.details.requiredScope, "webhooks:write");
  assert.deepEqual(webhookBody.error.details.availableActions, ["request_scope"]);

  const webhookReadKeyResponse = await fetch(`${baseUrl}/agent-api-keys`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminBody.data.apiKey}`,
      "content-type": "application/json",
      "Idempotency-Key": "webhook-reader-AGEA-17-v1"
    },
    body: JSON.stringify({
      agent: {
        id: "agt_webhook_reader",
        displayName: "Webhook Reader",
        role: "platform_ci"
      },
      scopes: ["webhooks:read"],
      rateLimit: {
        windowSeconds: 60,
        maxRequests: 4
      }
    })
  });

  assert.equal(webhookReadKeyResponse.status, 201);
  const webhookReadKeyBody = await webhookReadKeyResponse.json();

  const webhookListResponse = await fetch(`${baseUrl}/task-webhook-subscriptions`, {
    headers: {
      authorization: `Bearer ${webhookReadKeyBody.data.apiKey}`
    }
  });

  assert.equal(webhookListResponse.status, 200);
  const webhookListBody = await webhookListResponse.json();
  assert.deepEqual(webhookListBody.data, []);
  assert.deepEqual(webhookListBody.availableActions, ["create"]);

  const webhookCreateWithReadKeyResponse = await fetch(`${baseUrl}/task-webhook-subscriptions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${webhookReadKeyBody.data.apiKey}`,
      "content-type": "application/json",
      "Idempotency-Key": "webhook-reader-denied-AGEA-17-v1"
    },
    body: JSON.stringify({
      url: "https://agents.example.com/webhooks/task-events",
      eventTypes: ["task.updated"],
      secret: "whsec_live_agentrail_contract_001"
    })
  });

  assert.equal(webhookCreateWithReadKeyResponse.status, 403);
  const webhookCreateWithReadKeyBody = await webhookCreateWithReadKeyResponse.json();
  assert.equal(webhookCreateWithReadKeyBody.error.details.requiredScope, "webhooks:write");

  const usageResponse = await fetch(`${baseUrl}/agent-api-keys/${ciKeyBody.data.id}/usage`, {
    headers: {
      authorization: `Bearer ${adminBody.data.apiKey}`
    }
  });

  assert.equal(usageResponse.status, 200);
  const usageBody = await usageResponse.json();
  assert.equal(usageBody.data.keyId, ciKeyBody.data.id);
  assert.equal(usageBody.data.agent.id, "agt_ci_reader");
  assert.equal(usageBody.data.totals.accepted, 1);
  assert.equal(usageBody.data.totals.denied, 1);
  assert.deepEqual(usageBody.data.byScope, [
    {
      scope: "ci:read",
      count: 1
    }
  ]);
  assert.deepEqual(usageBody.availableActions, ["rotate"]);
});

test("protected routes return token-efficient auth and rate-limit errors", async (t) => {
  const now = new Date("2026-05-01T04:40:00Z");
  const authStore = new AgentAuthStore({ now: () => now });
  const { data: key } = authStore.createKey(
    {
      agent: {
        id: "agt_rate_limited",
        displayName: "Rate Limited Agent",
        role: "agent"
      },
      scopes: ["ci:read"],
      rateLimit: {
        windowSeconds: 60,
        maxRequests: 1
      }
    },
    "rate-limited-AGEA-7-v1"
  );
  const server = createServer({
    store: new TaskEventStore(),
    authStore,
    ciStatusAdapter: {
      async getTaskCiStatus(taskId) {
        return {
          data: {
            taskId,
            submissionId: "sub_01JY4Y4A9P10G6EM7Q3JJ2M1A2",
            overallStatus: "passed",
            summary: {
              total: 0,
              passed: 0,
              failed: 0,
              running: 0,
              queued: 0,
              cancelled: 0,
              skipped: 0
            },
            workflows: [],
            checks: [],
            failureSummaries: [],
            flakyHints: [],
            updatedAt: "2026-05-01T04:40:00Z",
            availableActions: []
          },
          availableActions: [],
          meta: {
            tokenBudgetHint: "compact",
            truncatedFields: []
          }
        };
      }
    }
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = await listen(server);
  const unauthenticated = await fetch(
    `${baseUrl}/tasks/tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V/ci-status`
  );
  assert.equal(unauthenticated.status, 401);
  const unauthenticatedBody = await unauthenticated.json();
  assert.equal(unauthenticatedBody.error.code, "unauthorized");
  assert.deepEqual(unauthenticatedBody.error.details.availableActions, ["reauthenticate"]);

  const first = await fetch(`${baseUrl}/tasks/tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V/ci-status`, {
    headers: {
      authorization: `Bearer ${key.apiKey}`
    }
  });
  assert.equal(first.status, 200);

  const limited = await fetch(`${baseUrl}/tasks/tsk_01JY4X8Q6J5Q3P7M0N2K3R4T5V/ci-status`, {
    headers: {
      authorization: `Bearer ${key.apiKey}`
    }
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  const limitedBody = await limited.json();
  assert.equal(limitedBody.error.code, "rate_limited");
  assert.equal(limitedBody.error.details.limit.maxRequests, 1);
  assert.equal(limitedBody.error.details.remaining, 0);
  assert.deepEqual(limitedBody.error.details.availableActions, ["retry"]);
});
