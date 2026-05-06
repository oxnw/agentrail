import type {
  TaskDetailResponse,
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

void adapterManagedSubmit;
void artifactDemoSubmit;
void submitResponse;
void taskDetailResponse;
