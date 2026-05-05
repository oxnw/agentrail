// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

import {
  GitHubReviewFeedbackAdapter,
  ReviewFeedbackSourceError
} from "../src/github-review-feedback-adapter.ts";

function mockFetch(routes) {
  return async (url) => {
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return handler();
      }
    }

    return { ok: false, status: 404, text: async () => "Not Found" };
  };
}

function jsonResponse(body) {
  return () => ({ ok: true, status: 200, json: async () => body });
}

test("getTaskReviewFeedback returns null for unknown task", async () => {
  const adapter = new GitHubReviewFeedbackAdapter({
    taskSources: {},
    fetch: async () => ({ ok: true, json: async () => [] })
  });

  const result = await adapter.getTaskReviewFeedback("tsk_unknown");
  assert.equal(result, null);
});

test("getTaskReviewFeedback unifies reviews, review comments, and issue comments", async () => {
  const adapter = new GitHubReviewFeedbackAdapter({
    taskSources: {
      tsk_abc: { owner: "acme", repo: "web", pullNumber: 42 }
    },
    fetch: mockFetch({
      "pulls/42/reviews": jsonResponse([
        {
          id: 1,
          state: "CHANGES_REQUESTED",
          user: { login: "alice" },
          author_association: "OWNER",
          body: "Please fix the error handling.",
          submitted_at: "2026-05-01T10:00:00Z"
        }
      ]),
      "pulls/42/comments": jsonResponse([
        {
          id: 100,
          author_association: "OWNER",
          body: "This must be fixed.",
          path: "src/app.js",
          line: 15,
          original_line: null
        },
        {
          id: 101,
          author_association: "CONTRIBUTOR",
          body: "Consider renaming this.\n```suggestion\nconst betterName = true;\n```",
          path: "src/util.js",
          line: 8,
          original_line: null
        }
      ]),
      "issues/42/comments": jsonResponse([
        {
          id: 200,
          author_association: "MEMBER",
          body: "Looks good overall, nice work."
        }
      ])
    })
  });

  const result = await adapter.getTaskReviewFeedback("tsk_abc");

  assert.equal(result.data.taskId, "tsk_abc");
  assert.equal(result.data.latestDecision.outcome, "changes_requested");
  assert.equal(result.data.latestDecision.reviewer.id, "alice");

  const comments = result.data.comments;
  assert.equal(comments.length, 4);

  assert.equal(comments[0].severity, "must_fix");
  assert.equal(comments[0].id, "review_1");
  assert.equal(comments[1].severity, "must_fix");
  assert.equal(comments[1].file, "src/app.js");
  assert.equal(comments[1].line, 15);

  assert.equal(comments[2].severity, "should_fix");
  assert.equal(comments[2].file, "src/util.js");
  assert.equal(comments[2].suggestedAction, "const betterName = true;");

  assert.equal(comments[3].severity, "note");
  assert.equal(comments[3].id, "ic_200");
});

test("getTaskReviewFeedback returns pending decision when no reviews exist", async () => {
  const adapter = new GitHubReviewFeedbackAdapter({
    taskSources: {
      tsk_abc: { owner: "acme", repo: "web", pullNumber: 42 }
    },
    fetch: mockFetch({
      "pulls/42/reviews": jsonResponse([]),
      "pulls/42/comments": jsonResponse([]),
      "issues/42/comments": jsonResponse([])
    })
  });

  const result = await adapter.getTaskReviewFeedback("tsk_abc");

  assert.equal(result.data.latestDecision.outcome, "pending");
  assert.equal(result.data.comments.length, 0);
  assert.deepEqual(result.data.availableActions, ["refresh"]);
});

test("getTaskReviewFeedback throws ReviewFeedbackSourceError on GitHub 403", async () => {
  const adapter = new GitHubReviewFeedbackAdapter({
    taskSources: {
      tsk_abc: { owner: "acme", repo: "web", pullNumber: 42 }
    },
    fetch: async () => ({
      ok: false,
      status: 403,
      text: async () => "rate limited"
    })
  });

  await assert.rejects(
    () => adapter.getTaskReviewFeedback("tsk_abc"),
    (error) => {
      assert.ok(error instanceof ReviewFeedbackSourceError);
      assert.equal(error.statusCode, 429);
      assert.equal(error.code, "review_source_rate_limited");
      return true;
    }
  );
});

test("getTaskReviewFeedback validates task source requires pullNumber", async () => {
  const adapter = new GitHubReviewFeedbackAdapter({
    taskSources: {
      tsk_abc: { owner: "acme", repo: "web" }
    },
    fetch: async () => ({ ok: true, json: async () => [] })
  });

  await assert.rejects(
    () => adapter.getTaskReviewFeedback("tsk_abc"),
    (error) => {
      assert.ok(error instanceof ReviewFeedbackSourceError);
      assert.equal(error.code, "review_source_misconfigured");
      assert.equal(error.details.field, "pullNumber");
      return true;
    }
  );
});

test("getTaskReviewFeedback resolves pullNumber from persisted task submissions", async () => {
  const adapter = new GitHubReviewFeedbackAdapter({
    taskSources: {},
    getTask: () => ({
      id: "tsk_abc",
      identifier: "AGEA-101",
      title: "Persist PR metadata",
      description: "",
      status: "in_review",
      priority: "high",
      assignee: { id: "agt_test", name: "Test Agent" },
      acceptanceCriteria: [],
      links: { issue: "https://example.com/issues/101" },
      context: { project: "acme/web", goal: "test" },
      updatedAt: "2026-05-05T12:00:00Z",
      availableActions: ["ship", "view_review_feedback"],
      submissions: [
        {
          id: "ghpr_42",
          summary: "Persist submit state",
          artifacts: [],
          checks: [],
          notes: null,
          submittedAt: "2026-05-05T12:00:00Z",
          prUrl: "https://github.com/acme/web/pull/42",
          prNumber: 42,
        },
      ],
      latestSubmissionId: "ghpr_42",
      ciStatus: null,
      reviewOutcome: null,
      shipOperation: null,
      rollbackOperation: null,
      dueAt: null,
      createdAt: "2026-05-05T12:00:00Z",
      version: 2,
      source: {
        provider: "github",
        owner: "acme",
        repo: "web",
        branch: "feat/persist-submit",
        baseBranch: "main",
      },
    }),
    fetch: mockFetch({
      "pulls/42/reviews": jsonResponse([]),
      "pulls/42/comments": jsonResponse([]),
      "issues/42/comments": jsonResponse([]),
    }),
  });

  const result = await adapter.getTaskReviewFeedback("tsk_abc");

  assert.equal(result.data.taskId, "tsk_abc");
  assert.equal(result.data.latestDecision.outcome, "pending");
  assert.deepEqual(result.data.comments, []);
});

test("getTaskReviewFeedback extracts suggestion blocks from review comments", async () => {
  const adapter = new GitHubReviewFeedbackAdapter({
    taskSources: {
      tsk_abc: { owner: "acme", repo: "web", pullNumber: 7 }
    },
    fetch: mockFetch({
      "pulls/7/reviews": jsonResponse([]),
      "pulls/7/comments": jsonResponse([
        {
          id: 300,
          author_association: "OWNER",
          body: "Should use a map here.\n```suggestion\nconst lookup = new Map();\n```",
          path: "src/index.js",
          line: 22,
          original_line: null
        }
      ]),
      "issues/7/comments": jsonResponse([])
    })
  });

  const result = await adapter.getTaskReviewFeedback("tsk_abc");
  const comment = result.data.comments[0];

  assert.equal(comment.suggestedAction, "const lookup = new Map();");
  assert.equal(comment.file, "src/index.js");
  assert.equal(comment.line, 22);
});
