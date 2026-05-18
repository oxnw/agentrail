import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

test("TypeScript SDK exposes adapter-managed submit without caller-supplied artifacts", () => {
  assert.doesNotThrow(() => {
    execFileSync(
      "npx",
      [
        "tsc",
        "--noEmit",
        "--ignoreConfig",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--strict",
        "--types",
        "node",
        "--allowImportingTsExtensions",
        "test/fixtures/sdk-submit-contract.ts",
      ],
      { cwd: new URL("..", import.meta.url), stdio: "pipe" },
    );
  });
});

test("OpenAPI TaskSubmitRequest supports adapter-managed submit and keeps artifact mode optional", () => {
  const spec = readFileSync(new URL("../docs/api/task-lifecycle.openapi.yaml", import.meta.url), "utf8");
  const schemaStart = spec.indexOf("    TaskSubmitRequest:");
  const schemaEnd = spec.indexOf("    TaskSubmissionResponse:", schemaStart);
  assert.notEqual(schemaStart, -1, "TaskSubmitRequest schema should exist");
  assert.notEqual(schemaEnd, -1, "TaskSubmissionResponse schema should follow TaskSubmitRequest");

  const schema = spec.slice(schemaStart, schemaEnd);
  assert.match(schema, /required:\s*\[summary\]/);
  assert.match(schema, /mode:/);
  assert.match(schema, /enum:\s*\[adapter_managed,\s*artifact\]/);
  assert.match(schema, /pullRequest:/);
  assert.match(schema, /artifacts:/);
});

test("OpenAPI task detail and submit response declare emitted routing and branch fields", () => {
  const spec = readFileSync(new URL("../docs/api/task-lifecycle.openapi.yaml", import.meta.url), "utf8");

  const detailStart = spec.indexOf("    TaskDetail:");
  const detailEnd = spec.indexOf("    TaskDetailResponse:", detailStart);
  assert.notEqual(detailStart, -1, "TaskDetail schema should exist");
  assert.notEqual(detailEnd, -1, "TaskDetailResponse schema should follow TaskDetail");
  const taskDetailSchema = spec.slice(detailStart, detailEnd);

  for (const field of [
    "submissionId",
    "prUrl",
    "prNumber",
    "branch",
    "baseBranch",
    "headSha",
    "assigneeAgentId",
    "triageQueueId",
    "assignmentSource",
    "routingDecisionId",
    "routingReason",
    "routingConfidence",
  ]) {
    assert.match(taskDetailSchema, new RegExp(`\\n\\s+${field}:`), `TaskDetail should declare ${field}`);
  }

  const submitStart = spec.indexOf("    TaskSubmissionResponse:");
  const submitEnd = spec.indexOf("    TaskCiStatusResponse:", submitStart);
  assert.notEqual(submitStart, -1, "TaskSubmissionResponse schema should exist");
  assert.notEqual(submitEnd, -1, "TaskCiStatusResponse schema should follow TaskSubmissionResponse");
  const submitResponseSchema = spec.slice(submitStart, submitEnd);

  for (const field of ["head", "base", "headSha"]) {
    assert.match(submitResponseSchema, new RegExp(`\\n\\s+${field}:`), `TaskSubmissionResponse should declare ${field}`);
  }
});

test("OpenAPI and SDK contracts expose CI and review freshness fields", () => {
  const spec = readFileSync(new URL("../docs/api/task-lifecycle.openapi.yaml", import.meta.url), "utf8");
  const typescript = readFileSync(new URL("../sdk/typescript/src/types.ts", import.meta.url), "utf8");
  const python = readFileSync(new URL("../sdk/python/src/agentrail/models.py", import.meta.url), "utf8");

  const ciStart = spec.indexOf("    TaskCiStatusResponse:");
  const ciEnd = spec.indexOf("    CircleCiWebhookReceiptResponse:", ciStart);
  assert.notEqual(ciStart, -1, "TaskCiStatusResponse schema should exist");
  assert.notEqual(ciEnd, -1, "CircleCiWebhookReceiptResponse schema should follow TaskCiStatusResponse");
  const ciSchema = spec.slice(ciStart, ciEnd);
  assert.match(ciSchema, /\n\s+headSha:/, "TaskCiStatusResponse.data should declare headSha");

  const reviewStart = spec.indexOf("    TaskReviewFeedbackResponse:");
  const reviewEnd = spec.indexOf("    TaskShipRequest:", reviewStart);
  assert.notEqual(reviewStart, -1, "TaskReviewFeedbackResponse schema should exist");
  assert.notEqual(reviewEnd, -1, "TaskShipRequest schema should follow TaskReviewFeedbackResponse");
  const reviewSchema = spec.slice(reviewStart, reviewEnd);
  assert.match(reviewSchema, /\n\s+headSha:/, "TaskReviewFeedbackResponse latestDecision should declare headSha");
  assert.match(reviewSchema, /enum:\s*\[approved,\s*changes_requested,\s*pending,\s*not_required,\s*review_required\]/, "Review outcome enum should include review_required");

  assert.match(typescript, /headSha\?: string \| null;/, "TypeScript SDK should expose optional headSha fields");
  assert.match(typescript, /"not_required"/, "TypeScript ReviewOutcome should include not_required");
  assert.match(typescript, /"review_required"/, "TypeScript ReviewOutcome should include review_required");
  assert.match(python, /head_sha: str \| None = Field\(default=None, alias="headSha"\)/, "Python SDK should expose optional head_sha fields");
  assert.match(python, /NOT_REQUIRED = "not_required"/, "Python ReviewOutcome should include not_required");
  assert.match(python, /REVIEW_REQUIRED = "review_required"/, "Python ReviewOutcome should include review_required");
});

test("OpenAPI and SDK auth scope contracts expose routing scopes", () => {
  const spec = readFileSync(new URL("../docs/api/task-lifecycle.openapi.yaml", import.meta.url), "utf8");
  const typescript = readFileSync(new URL("../sdk/typescript/src/types.ts", import.meta.url), "utf8");
  const python = readFileSync(new URL("../sdk/python/src/agentrail/models.py", import.meta.url), "utf8");

  for (const scope of ["routing:admin", "routing:read", "routing:evaluate"]) {
    assert.match(spec, new RegExp(`- ${scope}`), `OpenAPI AgentAuthScope should include ${scope}`);
    assert.match(typescript, new RegExp(`\\| "${scope}"`), `TypeScript AgentAuthScope should include ${scope}`);
    assert.match(python, new RegExp(`= "${scope}"`), `Python AgentAuthScope should include ${scope}`);
  }
});

test("Python package root re-exports Linear outbound request and response models", () => {
  const pythonInit = readFileSync(new URL("../sdk/python/src/agentrail/__init__.py", import.meta.url), "utf8");

  for (const symbol of [
    "LinearTaskCommentData",
    "LinearTaskCommentRequest",
    "LinearTaskCommentResponse",
    "LinearTaskWorkflowStateData",
    "LinearTaskWorkflowStateRequest",
    "LinearTaskWorkflowStateResponse",
  ]) {
    assert.match(
      pythonInit,
      new RegExp(`\\b${symbol}\\b`),
      `Python package root should reference ${symbol}`,
    );
    assert.match(
      pythonInit,
      new RegExp(`"${symbol}"`),
      `Python package __all__ should export ${symbol}`,
    );
  }
});
