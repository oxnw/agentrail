// sdk/typescript/test/webhooks.test.ts — focused webhook helper coverage
// Uses Node built-in test runner so this file can run with `node --test` on Node ≥22.6

import assert from "node:assert";
import { describe, it } from "node:test";
import { createHmac } from "node:crypto";
import {
  parseWebhookEvent,
  verifyWebhookSignature,
} from "../src/webhooks.js";
import type { WebhookHeaders, TaskLifecycleEvent } from "../src/types.js";

function makeSignature(rawBody: string, secret: string): string {
  return (
    "sha256=" +
    createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex")
  );
}

function makeEventBody(type: string, payload: unknown): string {
  return JSON.stringify({ type, data: payload });
}

describe("verifyWebhookSignature", () => {
  const secret = "whsec_test_secret_123";

  it("returns true for a valid signature", () => {
    const body = '{"type":"task.updated"}';
    const sig = makeSignature(body, secret);
    assert.strictEqual(verifyWebhookSignature(body, secret, sig), true);
  });

  it("returns false for a tampered body", () => {
    const body = '{"type":"task.updated"}';
    const sig = makeSignature(body, secret);
    assert.strictEqual(
      verifyWebhookSignature(body + "x", secret, sig),
      false,
    );
  });

  it("returns false for a wrong secret", () => {
    const body = '{"type":"task.updated"}';
    const sig = makeSignature(body, secret);
    assert.strictEqual(
      verifyWebhookSignature(body, secret + "x", sig),
      false,
    );
  });

  it("returns false for a mismatched signature length", () => {
    assert.strictEqual(
      verifyWebhookSignature("{}", secret, "short"),
      false,
    );
  });

  it("accepts Buffer payloads", () => {
    const body = Buffer.from('{"type":"task.updated"}');
    const sig = makeSignature(body.toString("utf8"), secret);
    assert.strictEqual(verifyWebhookSignature(body, secret, sig), true);
  });
});

describe("parseWebhookEvent", () => {
  const secret = "whsec_test_secret_123";

  it("parses a valid signed event", () => {
    const payload = makeEventBody("task.updated", {
      taskId: "tsk_01",
      taskIdentifier: "AGEA-1",
      status: "in_progress",
      previousStatus: "todo",
      changedFields: ["status"],
      actor: { id: "agt_1", role: "developer" },
      summary: "Task updated",
      availableActions: [],
      links: { task: "/tasks/tsk_01" },
    });
    const sig = makeSignature(payload, secret);
    const event = parseWebhookEvent(payload, secret, {
      "x-agentrail-webhook-id": "wh_1",
      "x-agentrail-event-id": "evt_1",
      "x-agentrail-event-type": "task.updated",
      "x-agentrail-delivery-id": "dlv_1",
      "x-agentrail-delivery-attempt": "1",
      "x-agentrail-signature": sig,
    });
    assert.strictEqual(event.type, "task.updated");
    assert.strictEqual((event as any).data.taskIdentifier, "AGEA-1");
  });

  it("throws on an invalid signature", () => {
    const payload = makeEventBody("task.updated", { taskId: "tsk_01" });
    assert.throws(
      () =>
        parseWebhookEvent(payload, secret, {
          "x-agentrail-webhook-id": "wh_1",
          "x-agentrail-event-id": "evt_1",
          "x-agentrail-event-type": "task.updated",
          "x-agentrail-delivery-id": "dlv_1",
          "x-agentrail-delivery-attempt": "1",
          "x-agentrail-signature": "sha256=bad",
        }),
      /Invalid webhook signature/,
    );
  });
});
