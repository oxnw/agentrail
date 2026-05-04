import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("demo script completes the AgentRail cycle and reports token metrics", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/agentrail-e2e-demo.mjs", "--json"],
    { cwd: process.cwd() }
  );
  const report = JSON.parse(stdout);

  assert.equal(report.result.taskId, "tsk_DEMOISSUETOSHIP01");
  assert.equal(report.result.shipStatus, "queued");
  assert.equal(report.metrics.successRate, 1);
  assert.ok(report.metrics.agentRail.estimatedTokens > 0);
  assert.ok(
    report.metrics.agentRail.estimatedTokens < report.metrics.rawGitHubEquivalent.estimatedTokens
  );
  assert.deepEqual(report.steps, [
    "list_my_tasks",
    "submit_first_pass",
    "read_failed_ci",
    "read_review_feedback",
    "submit_fix",
    "read_green_ci",
    "read_approved_review",
    "ship"
  ]);
});
