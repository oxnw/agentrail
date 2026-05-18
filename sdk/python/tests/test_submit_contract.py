import unittest


from agentrail import (
    ReviewOutcome,
    TaskCiStatusResponse,
    TaskDetailResponse,
    TaskReviewFeedbackResponse,
    TaskSubmissionResponse,
    TaskSubmitRequest,
)


class TaskSubmitContractTest(unittest.TestCase):
    def test_adapter_managed_submit_serializes_without_artifacts(self) -> None:
        request = TaskSubmitRequest(
            summary="Implemented the assigned task and pushed commits to the task branch.",
            mode="adapter_managed",
            pullRequest={"title": "Fix adapter-managed submit contract", "draft": False},
        )

        self.assertEqual(
            request.model_dump(by_alias=True, exclude_none=True),
            {
                "summary": "Implemented the assigned task and pushed commits to the task branch.",
                "mode": "adapter_managed",
                "pullRequest": {
                    "title": "Fix adapter-managed submit contract",
                    "draft": False,
                },
            },
        )

    def test_artifact_demo_submit_remains_supported(self) -> None:
        request = TaskSubmitRequest(
            summary="Submitted deterministic local demo artifact.",
            mode="artifact",
            artifacts=[
                {
                    "type": "pull_request",
                    "url": "https://github.com/oxnw/agentrail/pull/42",
                }
            ],
        )

        self.assertEqual(
            request.model_dump(by_alias=True, exclude_none=True)["artifacts"],
            [
                {
                    "type": "pull_request",
                    "url": "https://github.com/oxnw/agentrail/pull/42",
                }
            ],
        )

    def test_submit_response_exposes_branch_metadata(self) -> None:
        response = TaskSubmissionResponse(
            data={
                "submissionId": "ghpr_42",
                "taskId": "tsk_123",
                "status": "in_review",
                "prUrl": "https://github.com/oxnw/agentrail/pull/42",
                "prNumber": 42,
                "head": "agentrail/task-123",
                "base": "main",
                "headSha": "abc123",
                "acceptedAt": "2026-05-05T12:00:00Z",
                "availableActions": ["view_review_feedback", "view_ci_status"],
            },
            availableActions=["view_review_feedback"],
        )

        self.assertEqual(response.data.head_sha, "abc123")

    def test_task_detail_exposes_routing_metadata(self) -> None:
        response = TaskDetailResponse(
            data={
                "id": "tsk_123",
                "identifier": "AGEA-99",
                "title": "Route issue",
                "description": "Route provider issue snapshot.",
                "status": "todo",
                "priority": "high",
                "assignee": {"id": "triage_engineering", "name": "Engineering Triage"},
                "acceptanceCriteria": [],
                "links": {"issue": "https://github.com/oxnw/agentrail/issues/99"},
                "context": {"project": "Documentation", "goal": "AgentRail routing"},
                "updatedAt": "2026-05-05T12:00:00Z",
                "headSha": None,
                "assigneeAgentId": None,
                "triageQueueId": "triage_engineering",
                "assignmentSource": "manual_triage",
                "routingDecisionId": "rdec_01JZROUTE0000000000000001",
                "routingReason": {
                    "summary": "Multiple deterministic routing rules matched.",
                    "matchedRules": [],
                    "classifier": None,
                    "conflictReasons": ["ambiguous top-priority match"],
                },
                "routingConfidence": 0,
                "availableActions": [],
            },
            availableActions=[],
            meta={"tokenBudgetHint": "standard", "truncatedFields": []},
        )

        self.assertIsNone(response.data.assignee_agent_id)
        self.assertEqual(response.data.triage_queue_id, "triage_engineering")

    def test_ci_status_exposes_head_sha(self) -> None:
        response = TaskCiStatusResponse(
            data={
                "taskId": "tsk_123",
                "submissionId": "ghpr_42",
                "overallStatus": "running",
                "summary": {
                    "total": 1,
                    "passed": 0,
                    "failed": 0,
                    "running": 1,
                    "queued": 0,
                    "cancelled": 0,
                    "skipped": 0,
                },
                "workflows": [],
                "checks": [],
                "failureSummaries": [],
                "flakyHints": [],
                "updatedAt": "2026-05-05T12:05:00Z",
                "headSha": "abc123",
                "availableActions": ["view_ci_status", "view_review_feedback"],
            },
            availableActions=["view_ci_status", "view_review_feedback"],
            meta={"tokenBudgetHint": "standard", "truncatedFields": []},
        )

        self.assertEqual(response.data.head_sha, "abc123")

    def test_review_feedback_exposes_head_sha_and_not_required(self) -> None:
        response = TaskReviewFeedbackResponse(
            data={
                "taskId": "tsk_123",
                "latestDecision": {
                    "outcome": "not_required",
                    "reviewer": {"id": "unknown", "role": "unknown"},
                    "createdAt": "1970-01-01T00:00:00Z",
                    "headSha": None,
                    "summary": "No review decision required.",
                },
                "comments": [],
                "availableActions": ["view_ci_status"],
            },
            availableActions=["view_ci_status"],
        )

        self.assertEqual(response.data.latest_decision.outcome, ReviewOutcome.NOT_REQUIRED)
        self.assertIsNone(response.data.latest_decision.head_sha)


if __name__ == "__main__":
    unittest.main()
