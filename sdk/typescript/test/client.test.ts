// sdk/typescript/test/client.test.ts — unit tests for AgentRailClient helpers
// Uses Node built-in test runner so this file can run with `node --test` on Node ≥22.6

import assert from "node:assert";
import { describe, it } from "node:test";
import { AgentRailClient, DEFAULT_BASE_URL } from "../src/client.js";

describe("AgentRailClient.rollbackTask", () => {
  it("POSTs /tasks/{id}/rollback with the correct body and headers", async () => {
    let captured: {
      url: string;
      method: string;
      body: unknown;
      headers: Record<string, string>;
    } | null = null;

    const client = new AgentRailClient({
      baseUrl: DEFAULT_BASE_URL,
      apiKey: "test_key",
      retry: { maxAttempts: 1 },
    });

    // Replace global fetch briefly
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      captured = {
        url,
        method: init?.method ?? "GET",
        body,
        headers: Object.fromEntries(
          new Headers(init?.headers).entries(),
        ),
      };
      return new Response(
        JSON.stringify({
          data: {
            taskId: "tsk_demo_01",
            rollbackPrUrl: "https://github.com/example/pr/99",
            rollbackPrNumber: 99,
            newHeadSha: "abc123",
            revertedCommitSha: "def456",
            status: "rollback_pr_created",
            availableActions: [],
          },
          availableActions: [],
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    };

    try {
      const result = await client.rollbackTask(
        "tsk_demo_01",
        { reason: "Production regression" },
        "rollback-key-001",
      );

      assert.ok(captured, "fetch should have been called");
      assert.equal(
        captured!.url,
        "http://127.0.0.1:3000/tasks/tsk_demo_01/rollback",
      );
      assert.equal(captured!.method, "POST");
      assert.deepEqual(captured!.body, { reason: "Production regression" });
      assert.equal(
        captured!.headers["idempotency-key"],
        "rollback-key-001",
      );
      assert.equal(
        result.data.status,
        "rollback_pr_created",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
