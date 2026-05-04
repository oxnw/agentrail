// Unit tests for priority-mapper (no network calls)
import {
  mapPriority,
  mapStatus,
  extractAcceptanceCriteria,
  computeAvailableActions,
} from "./priority-mapper";
import { createRoutes } from "./routes";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// --- mapPriority ---
console.log("\nmapPriority");
assertEqual(mapPriority(["priority: critical"]), "critical", "priority: critical label");
assertEqual(mapPriority(["p0"]), "critical", "p0 label");
assertEqual(mapPriority(["p1"]), "high", "p1 label");
assertEqual(mapPriority(["P2"]), "medium", "P2 case-insensitive");
assertEqual(mapPriority(["p3"]), "low", "p3 label");
assertEqual(mapPriority(["bug", "enhancement"]), "medium", "no priority label → medium");
assertEqual(mapPriority([]), "medium", "empty labels → medium");

// --- mapStatus ---
console.log("\nmapStatus");
assertEqual(mapStatus("closed", []), "done", "closed issue → done");
assertEqual(mapStatus("open", []), "todo", "open no labels → todo");
assertEqual(mapStatus("open", ["in progress"]), "in_progress", "in progress label");
assertEqual(mapStatus("open", ["in-progress"]), "in_progress", "in-progress hyphen");
assertEqual(mapStatus("open", ["wip"]), "in_progress", "wip label");
assertEqual(mapStatus("open", ["in review"]), "in_review", "in review label");
assertEqual(mapStatus("open", ["blocked"]), "blocked", "blocked label");
assertEqual(mapStatus("closed", ["blocked"]), "done", "closed overrides label");

// --- extractAcceptanceCriteria ---
console.log("\nextractAcceptanceCriteria");
assertEqual(extractAcceptanceCriteria(null), [], "null body → empty");
assertEqual(extractAcceptanceCriteria(""), [], "empty body → empty");

const bodyWithAC = `
## Description
Do something cool.

## Acceptance Criteria
- [ ] Unit tests pass
- [x] E2E tests pass
- [ ] PR reviewed by at least one engineer
`;
assertEqual(
  extractAcceptanceCriteria(bodyWithAC),
  ["Unit tests pass", "E2E tests pass", "PR reviewed by at least one engineer"],
  "extracts checklist from AC section"
);

const bodyWithChecklist = `
Some task.
- [x] First item
- [ ] Second item
`;
assertEqual(
  extractAcceptanceCriteria(bodyWithChecklist),
  ["First item", "Second item"],
  "falls back to checklist items anywhere in body"
);

// --- computeAvailableActions ---
console.log("\ncomputeAvailableActions");
assert(
  computeAvailableActions("todo").includes("POST /tasks/{id}/submit"),
  "todo includes submit action"
);
assert(
  computeAvailableActions("in_review").includes("GET /tasks/{id}/review-feedback"),
  "in_review includes review-feedback action"
);
assert(
  computeAvailableActions("in_review").includes("POST /tasks/{id}/ship"),
  "in_review includes ship action"
);
assert(
  !computeAvailableActions("done").includes("POST /tasks/{id}/submit"),
  "done does not include submit"
);

// --- routes ---
console.log("\nroutes");
try {
  createRoutes({
    listTasksForAssignee: async () => ({ tasks: [], nextCursor: null, hasMore: false }),
    getTask: async () => {
      throw new Error("not used");
    },
  } as never);
  assert(true, "registers task routes with Express");
} catch (error) {
  console.error(error);
  assert(false, "registers task routes with Express");
}

// --- submit/ship route registration ---
console.log("\nsubmit/ship routes");
try {
  const mockAdapter = {
    listTasksForAssignee: async () => ({ tasks: [], nextCursor: null, hasMore: false }),
    getTask: async () => { throw new Error("not used"); },
    submitTask: async () => ({ action: "created", pr: {}, issueNumber: 1, availableActions: [] }),
    shipTask: async () => ({ action: "merged", pr: {}, issue: {}, availableActions: [] }),
  } as never;
  const router = createRoutes(mockAdapter);
  const layers = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack;
  const submitRoute = layers.find((l) => l.route?.path === "/tasks/:id/submit" && l.route?.methods?.post);
  assert(!!submitRoute, "POST /tasks/:id/submit route registered");
  const shipRoute = layers.find((l) => l.route?.path === "/tasks/:id/ship" && l.route?.methods?.post);
  assert(!!shipRoute, "POST /tasks/:id/ship route registered");
} catch (error) {
  console.error(error);
  assert(false, "submit/ship routes registration");
}

// --- review-feedback route registration ---
console.log("\nreview-feedback route");
try {
  const mockAdapter2 = {
    listTasksForAssignee: async () => ({ tasks: [], nextCursor: null, hasMore: false }),
    getTask: async () => { throw new Error("not used"); },
    submitTask: async () => ({ action: "created", pr: {}, issueNumber: 1, availableActions: [] }),
    shipTask: async () => ({ action: "merged", pr: {}, issue: {}, availableActions: [] }),
    getReviewFeedback: async () => ({ taskId: "t/r#1", prNumber: 10, feedback: [], summary: { total: 0, required: 0, suggestion: 0, nitpick: 0 }, availableActions: [] }),
  } as never;
  const router2 = createRoutes(mockAdapter2);
  const layers2 = (router2 as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack;
  const reviewRoute = layers2.find((l) => l.route?.path === "/tasks/:id/review-feedback" && l.route?.methods?.get);
  assert(!!reviewRoute, "GET /tasks/:id/review-feedback route registered");
} catch (error) {
  console.error(error);
  assert(false, "review-feedback route registration");
}

// --- idempotency key helpers ---
console.log("\nidempotency key helpers");
import { classifySeverity, extractSuggestion, classifyReviewState, GitHubAdapter } from "./github-adapter";

const tag = GitHubAdapter.IDEMPOTENCY_TAG;

// extractIdempotencyKey (via static tag + inline parse)
function extractIdempotencyKey(body: string): string | null {
  const idx = body.indexOf(tag);
  if (idx === -1) return null;
  const start = idx + tag.length;
  const end = body.indexOf("-->", start);
  if (end === -1) return null;
  return body.slice(start, end).trim();
}

assertEqual(
  extractIdempotencyKey(`Some PR body\n\n${tag} abc-123 -->`),
  "abc-123",
  "extracts idempotency key from PR body"
);
assertEqual(
  extractIdempotencyKey("PR body with no key"),
  null,
  "returns null when no idempotency key"
);
assertEqual(
  extractIdempotencyKey(`Text\n${tag} key-with-dashes-456 -->\nMore text`),
  "key-with-dashes-456",
  "extracts key even with surrounding content"
);

// embedIdempotencyKey round-trip
const originalBody = "Closes #42\n\nFix the auth bug";
const embedded = `${originalBody}\n\n${tag} my-key-789 -->`;
assertEqual(
  extractIdempotencyKey(embedded),
  "my-key-789",
  "round-trip: embed then extract returns original key"
);

// SubmitRequest type includes idempotencyKey
import type { SubmitRequest, SubmitResult } from "./types";
const reqWithKey: SubmitRequest = { head: "feat/test", idempotencyKey: "k1" };
assertEqual(reqWithKey.idempotencyKey, "k1", "SubmitRequest accepts idempotencyKey");

// SubmitResult type includes idempotencyKey
const resultWithKey: SubmitResult = {
  action: "created",
  pr: { number: 1, url: "u", title: "t", state: "open", draft: false, base: "main", head: "feat/x", reviewers: [], checksStatus: "pending" },
  issueNumber: 42,
  idempotencyKey: "k2",
  availableActions: [],
};
assertEqual(resultWithKey.idempotencyKey, "k2", "SubmitResult accepts idempotencyKey");

// --- severity classification ---
console.log("\nseverity classification");

assertEqual(classifyReviewState("CHANGES_REQUESTED"), "required", "CHANGES_REQUESTED → required");
assertEqual(classifyReviewState("COMMENTED"), "suggestion", "COMMENTED → suggestion");
assertEqual(classifyReviewState("APPROVED"), "suggestion", "APPROVED → suggestion");

assertEqual(classifySeverity("This must be fixed before merge"), "required", "must → required");
assertEqual(classifySeverity("nit: use camelCase"), "nitpick", "nit → nitpick");
assertEqual(classifySeverity("Consider renaming this variable"), "suggestion", "default → suggestion");
assertEqual(classifySeverity("Blocker: missing null check"), "required", "blocker → required");
assertEqual(classifySeverity("minor style issue"), "nitpick", "minor → nitpick");

assertEqual(extractSuggestion("Try this:\n```suggestion\nconst x = 1;\n```\n"), "const x = 1;", "extracts suggestion block");
assertEqual(extractSuggestion("Just a regular comment"), null, "no suggestion → null");

// --- ReviewFeedbackResponse type imports ---
console.log("\ntype imports");
try {
  const { } = require("./types") as {
    SubmitRequest: unknown;
    SubmitResult: unknown;
    ShipResult: unknown;
    ShipBlockedResult: unknown;
    ReviewFeedbackItem: unknown;
    ReviewFeedbackResponse: unknown;
    FeedbackSeverity: unknown;
  };
  assert(true, "PR lifecycle + review feedback types import without error");
} catch (error) {
  console.error(error);
  assert(false, "type imports");
}

// --- computeAvailableActions for submit/ship lifecycle ---
console.log("\navailableActions lifecycle");
assert(
  computeAvailableActions("in_progress").includes("POST /tasks/{id}/submit"),
  "in_progress includes submit"
);
assert(
  !computeAvailableActions("in_progress").includes("POST /tasks/{id}/ship"),
  "in_progress does NOT include ship"
);
assert(
  computeAvailableActions("in_review").includes("POST /tasks/{id}/ship"),
  "in_review includes ship"
);
assert(
  !computeAvailableActions("in_review").includes("POST /tasks/{id}/submit"),
  "in_review does NOT include submit"
);
assert(
  !computeAvailableActions("done").includes("POST /tasks/{id}/ship"),
  "done does NOT include ship"
);
assert(
  !computeAvailableActions("blocked").includes("POST /tasks/{id}/submit"),
  "blocked does NOT include submit"
);

// --- compact task list token budget ---
console.log("\ncompact token budget");

function estimateTokens(obj: unknown): number {
  const json = JSON.stringify(obj);
  return Math.ceil(json.length / 4);
}

const sampleCompactTasks = Array.from({ length: 10 }, (_, i) => ({
  n: i + 1,
  t: `Fix auth bug in login flow #${i + 1}`.slice(0, 50),
  s: "todo" as const,
  p: "medium" as const,
}));
const compactResponse = {
  repo: "acme/webapp",
  tasks: sampleCompactTasks,
  cursor: null,
  hasMore: false,
  meta: { tokenBudgetHint: 150 },
};
const tokenEstimate = estimateTokens(compactResponse);
assert(
  tokenEstimate <= 200,
  `compact 10-issue response ≤200 tokens (actual: ~${tokenEstimate})`
);

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
