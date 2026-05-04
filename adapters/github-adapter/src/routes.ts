import { Router, Request, Response } from "express";
import { GitHubAdapter } from "./github-adapter";
import { ErrorResponse, SubmitRequest } from "./types";

export function createRoutes(adapter: GitHubAdapter): Router {
  const router = Router();

  // GET /tasks/mine — list issues assigned to the caller
  router.get("/tasks/mine", async (req: Request, res: Response) => {
    const assignee = req.query.assignee as string | undefined;
    const cursor = req.query.cursor as string | undefined;
    const perPage = Math.min(parseInt(req.query.per_page as string || "20", 10), 50);

    if (!assignee) {
      const err: ErrorResponse = {
        error: "Missing required query parameter: assignee",
        code: "missing_parameter",
        availableActions: ["GET /tasks/mine?assignee={github_username}"],
      };
      return res.status(400).json(err);
    }

    try {
      const format = req.query.format as string | undefined;
      if (format === "full") {
        const { tasks, nextCursor, hasMore } = await adapter.listTasksForAssignee(
          assignee,
          cursor,
          perPage
        );
        return res.json({
          tasks,
          cursor: nextCursor,
          hasMore,
          meta: { tokenBudgetHint: tasks.length * 25 },
        });
      }
      const result = await adapter.listTasksCompact(assignee, cursor, perPage);
      return res.json({
        ...result,
        meta: { tokenBudgetHint: result.tasks.length * 15 },
      });
    } catch (err: unknown) {
      const status = (err as { status?: number }).status ?? 500;
      const errRes: ErrorResponse = {
        error: status === 404 ? "Repository or assignee not found" : "GitHub API error",
        code: status === 404 ? "not_found" : "upstream_error",
        availableActions: ["GET /tasks/mine"],
      };
      return res.status(status === 404 ? 404 : 502).json(errRes);
    }
  });

  // GET /tasks/:id — full task context for a single issue
  // id format: owner/repo#number  (URL-encoded as owner%2Frepo%23number)
  // Also supports a simpler numeric form if repo is known from env
  router.get("/tasks/:id", async (req: Request, res: Response) => {
    const rawId = decodeURIComponent(String(req.params.id));

    // Parse "owner/repo#123" or plain "123"
    const match = rawId.match(/^(.+)#(\d+)$/) ?? rawId.match(/^(\d+)$/);
    if (!match) {
      const err: ErrorResponse = {
        error: `Invalid task id format: "${rawId}". Expected "owner/repo#number" or a plain issue number.`,
        code: "invalid_id",
        availableActions: ["GET /tasks/{owner}/{repo}#{number}"],
      };
      return res.status(400).json(err);
    }

    const issueNumber = parseInt(match[match.length - 1], 10);

    try {
      const task = await adapter.getTask(issueNumber);
      return res.json({ task });
    } catch (err: unknown) {
      const status = (err as { status?: number }).status ?? 500;
      const errRes: ErrorResponse = {
        error: status === 404 ? `Task ${rawId} not found` : "GitHub API error",
        code: status === 404 ? "not_found" : "upstream_error",
        availableActions: ["GET /tasks/mine"],
      };
      return res.status(status === 404 ? 404 : 502).json(errRes);
    }
  });

  // GET /tasks/:id/review-feedback — unified PR review feedback
  router.get("/tasks/:id/review-feedback", async (req: Request, res: Response) => {
    const rawId = decodeURIComponent(String(req.params.id));
    const match = rawId.match(/^(.+)#(\d+)$/) ?? rawId.match(/^(\d+)$/);
    if (!match) {
      const err: ErrorResponse = {
        error: `Invalid task id format: "${rawId}". Expected "owner/repo#number" or a plain issue number.`,
        code: "invalid_id",
        availableActions: ["GET /tasks/{id}"],
      };
      return res.status(400).json(err);
    }

    const issueNumber = parseInt(match[match.length - 1], 10);
    const prNumber = req.query.pr ? parseInt(req.query.pr as string, 10) : undefined;

    if (!prNumber) {
      const err: ErrorResponse = {
        error: 'Missing required query parameter: "pr" (pull request number)',
        code: "missing_parameter",
        availableActions: ["GET /tasks/{id}"],
      };
      return res.status(400).json(err);
    }

    try {
      const result = await adapter.getReviewFeedback(issueNumber, prNumber);
      return res.json(result);
    } catch (err: unknown) {
      const status = (err as { status?: number }).status ?? 500;
      const errRes: ErrorResponse = {
        error: status === 404 ? `PR #${prNumber} not found` : "GitHub API error",
        code: status === 404 ? "not_found" : "upstream_error",
        availableActions: ["GET /tasks/{id}"],
      };
      return res.status(status === 404 ? 404 : 502).json(errRes);
    }
  });

  // POST /tasks/:id/submit — create a PR for an issue
  router.post("/tasks/:id/submit", async (req: Request, res: Response) => {
    const rawId = decodeURIComponent(String(req.params.id));
    const match = rawId.match(/^(.+)#(\d+)$/) ?? rawId.match(/^(\d+)$/);
    if (!match) {
      const err: ErrorResponse = {
        error: `Invalid task id format: "${rawId}". Expected "owner/repo#number" or a plain issue number.`,
        code: "invalid_id",
        availableActions: ["GET /tasks/{id}"],
      };
      return res.status(400).json(err);
    }

    const issueNumber = parseInt(match[match.length - 1], 10);
    const submitReq: SubmitRequest = req.body;

    if (!submitReq.head) {
      const err: ErrorResponse = {
        error: 'Missing required field: "head" (source branch name)',
        code: "missing_parameter",
        availableActions: ["POST /tasks/{id}/submit"],
      };
      return res.status(400).json(err);
    }

    try {
      const result = await adapter.submitTask(issueNumber, submitReq);
      const status = result.action === "created" ? 201 : 200;
      return res.status(status).json(result);
    } catch (err: unknown) {
      const statusCode = (err as { status?: number }).status ?? 500;
      const message = (err as { message?: string }).message ?? "GitHub API error";

      if (statusCode === 422) {
        const errRes: ErrorResponse = {
          error: `Cannot create PR: ${message}`,
          code: "validation_error",
          availableActions: ["GET /tasks/{id}"],
        };
        return res.status(422).json(errRes);
      }

      const errRes: ErrorResponse = {
        error: statusCode === 404 ? `Task ${rawId} not found` : "GitHub API error",
        code: statusCode === 404 ? "not_found" : "upstream_error",
        availableActions: ["GET /tasks/mine"],
      };
      return res.status(statusCode === 404 ? 404 : 502).json(errRes);
    }
  });

  // POST /tasks/:id/ship — merge a PR and close the linked issue
  router.post("/tasks/:id/ship", async (req: Request, res: Response) => {
    const rawId = decodeURIComponent(String(req.params.id));
    const match = rawId.match(/^(.+)#(\d+)$/) ?? rawId.match(/^(\d+)$/);
    if (!match) {
      const err: ErrorResponse = {
        error: `Invalid task id format: "${rawId}". Expected "owner/repo#number" or a plain issue number.`,
        code: "invalid_id",
        availableActions: ["GET /tasks/{id}"],
      };
      return res.status(400).json(err);
    }

    const issueNumber = parseInt(match[match.length - 1], 10);
    const prNumber = req.body.prNumber as number | undefined;
    const mergeMethod = (req.body.mergeMethod as "merge" | "squash" | "rebase") ?? "squash";

    if (!prNumber) {
      const err: ErrorResponse = {
        error: 'Missing required field: "prNumber"',
        code: "missing_parameter",
        availableActions: ["GET /tasks/{id}"],
      };
      return res.status(400).json(err);
    }

    try {
      const result = await adapter.shipTask(issueNumber, prNumber, mergeMethod);
      if (result.action === "blocked") {
        return res.status(409).json(result);
      }
      return res.json(result);
    } catch (err: unknown) {
      const statusCode = (err as { status?: number }).status ?? 500;
      const errRes: ErrorResponse = {
        error: statusCode === 404 ? `PR #${prNumber} not found` : "GitHub API error",
        code: statusCode === 404 ? "not_found" : "upstream_error",
        availableActions: ["GET /tasks/{id}"],
      };
      return res.status(statusCode === 404 ? 404 : 502).json(errRes);
    }
  });

  return router;
}
