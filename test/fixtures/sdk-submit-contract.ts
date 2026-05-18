import type {
  AgentRailClient,
  LinearTaskCommentRequest,
  LinearTaskCommentResponse,
  LinearTaskWorkflowStateRequest,
  LinearTaskWorkflowStateResponse,
  TaskCiStatusResponse,
  TaskDetailResponse,
  TaskReviewFeedbackResponse,
  TaskSubmissionResponse,
  TaskSubmitRequest
} from "../../sdk/typescript/src/index.ts";

const adapterManagedSubmit: TaskSubmitRequest = {
  summary: "Implemented the assigned task and pushed commits to the task branch.",
  mode: "adapter_managed",
  pullRequest: {
    title: "Fix adapter-managed submit contract",
    draft: false,
  },
};

const artifactDemoSubmit: TaskSubmitRequest = {
  summary: "Submitted deterministic local demo artifact.",
  mode: "artifact",
  artifacts: [
    {
      type: "pull_request",
      url: "https://github.com/oxnw/agentrail/pull/42",
    },
  ],
};

const submitResponse: TaskSubmissionResponse = {
  data: {
    submissionId: "ghpr_42",
    taskId: "tsk_123",
    status: "in_review",
    prUrl: "https://github.com/oxnw/agentrail/pull/42",
    prNumber: 42,
    head: "agentrail/task-123",
    base: "main",
    headSha: "abc123",
    action: "created",
    acceptedAt: "2026-05-05T12:00:00Z",
    availableActions: ["view_review_feedback", "view_ci_status"],
  },
  availableActions: ["view_review_feedback"],
};

const taskDetailResponse: TaskDetailResponse = {
  data: {
    id: "tsk_123",
    identifier: "AGEA-99",
    title: "Route issue",
    description: "Route provider issue snapshot.",
    status: "todo",
    priority: "high",
    assignee: { id: "triage_engineering", name: "Engineering Triage" },
    acceptanceCriteria: [],
    links: { issue: "https://github.com/oxnw/agentrail/issues/99" },
    context: { project: "Documentation", goal: "AgentRail routing" },
    updatedAt: "2026-05-05T12:00:00Z",
    submissionId: null,
    prUrl: null,
    prNumber: null,
    branch: null,
    baseBranch: null,
    headSha: null,
    assigneeAgentId: null,
    triageQueueId: "triage_engineering",
    assignmentSource: "manual_triage",
    routingDecisionId: "rdec_01JZROUTE0000000000000001",
    routingReason: {
      summary: "Multiple deterministic routing rules matched.",
      matchedRules: [],
      classifier: null,
      conflictReasons: ["ambiguous top-priority match"],
    },
    routingConfidence: 0,
    availableActions: [],
  },
  availableActions: [],
  meta: {
    tokenBudgetHint: "standard",
    truncatedFields: [],
  },
};

const ciStatusResponse: TaskCiStatusResponse = {
  data: {
    taskId: "tsk_123",
    submissionId: "ghpr_42",
    overallStatus: "running",
    summary: { total: 1, passed: 0, failed: 0, running: 1, queued: 0, cancelled: 0, skipped: 0 },
    workflows: [],
    checks: [],
    failureSummaries: [],
    flakyHints: [],
    updatedAt: "2026-05-05T12:05:00Z",
    headSha: "abc123",
    availableActions: ["view_ci_status", "view_review_feedback"],
  },
  availableActions: ["view_ci_status", "view_review_feedback"],
  meta: {
    tokenBudgetHint: "standard",
    truncatedFields: [],
  },
};

const reviewFeedbackResponse: TaskReviewFeedbackResponse = {
  data: {
    taskId: "tsk_123",
    latestDecision: {
      outcome: "not_required",
      reviewer: { id: "unknown", role: "unknown" },
      createdAt: "1970-01-01T00:00:00.000Z",
      headSha: null,
      summary: "No review decision required.",
    },
    comments: [],
    availableActions: ["view_ci_status"],
  },
  availableActions: ["view_ci_status"],
};

const linearCommentRequest: LinearTaskCommentRequest = {
  body: "Implemented the SDK contract and documented the outbound sync endpoints.",
};

const linearCommentResponse: LinearTaskCommentResponse = {
  data: {
    taskId: "tsk_123",
    linearIssueId: "LIN-42",
    commentId: "cmt_01JZLINEARCOMMENT0001",
    commentUrl: "https://linear.app/acme/comment/cmt_01JZLINEARCOMMENT0001",
    success: true,
    syncedAt: "2026-05-06T18:30:00Z",
    availableActions: ["get_task"],
  },
  availableActions: ["get_task"],
};

const linearWorkflowStateRequest: LinearTaskWorkflowStateRequest = {
  stateId: "state_in_review",
};

const linearWorkflowStateResponse: LinearTaskWorkflowStateResponse = {
  data: {
    taskId: "tsk_123",
    linearIssueId: "LIN-42",
    stateId: "state_in_review",
    stateName: "In Review",
    success: true,
    agentRailStatus: "in_review",
    syncedAt: "2026-05-06T18:31:00Z",
    availableActions: ["get_task"],
  },
  availableActions: ["get_task"],
};

async function exerciseLinearOutboundMethods(client: AgentRailClient): Promise<void> {
  const comment: LinearTaskCommentResponse = await client.createLinearTaskComment(
    "tsk_123",
    linearCommentRequest,
    "linear-comment-AGEA-133-v1",
  );
  const workflowState: LinearTaskWorkflowStateResponse = await client.updateLinearTaskWorkflowState(
    "tsk_123",
    linearWorkflowStateRequest,
    "linear-state-AGEA-133-v1",
  );
  void comment;
  void workflowState;
}

void adapterManagedSubmit;
void artifactDemoSubmit;
void submitResponse;
void taskDetailResponse;
void ciStatusResponse;
void reviewFeedbackResponse;
void linearCommentRequest;
void linearCommentResponse;
void linearWorkflowStateRequest;
void linearWorkflowStateResponse;
void exerciseLinearOutboundMethods;
