export const circleCiTaskId = "tsk_01JZCIRCLECI0000000000001";

export const circleCiTaskSource = {
  ciProvider: "circleci",
  owner: "oxnw",
  repo: "agentrail",
  projectSlug: "gh/oxnw/agentrail",
  branch: "feature/circleci-status",
  headSha: "abc123",
  submissionId: "sub_circleci_01"
};

export const pipelineListResponse = {
  items: [
    {
      id: "pipeline-current",
      number: 88,
      state: "created",
      created_at: "2026-05-02T10:00:00Z",
      updated_at: "2026-05-02T10:04:00Z",
      trigger: { type: "webhook" },
      vcs: {
        branch: "feature/circleci-status",
        revision: "abc123"
      }
    },
    {
      id: "pipeline-prior",
      number: 87,
      state: "created",
      created_at: "2026-05-02T09:50:00Z",
      updated_at: "2026-05-02T09:56:00Z",
      trigger: { type: "webhook" },
      vcs: {
        branch: "feature/circleci-status",
        revision: "abc123"
      }
    }
  ]
};

export const currentWorkflowListResponse = {
  items: [
    {
      id: "workflow-build-current",
      pipeline_id: "pipeline-current",
      name: "build",
      status: "failed",
      created_at: "2026-05-02T10:00:05Z",
      stopped_at: "2026-05-02T10:04:00Z",
      url: "https://app.circleci.com/pipelines/github/oxnw/agentrail/88/workflows/workflow-build-current"
    },
    {
      id: "workflow-lint-current",
      pipeline_id: "pipeline-current",
      name: "lint",
      status: "success",
      created_at: "2026-05-02T10:00:06Z",
      stopped_at: "2026-05-02T10:02:00Z",
      url: "https://app.circleci.com/pipelines/github/oxnw/agentrail/88/workflows/workflow-lint-current"
    }
  ]
};

export const currentBuildJobsResponse = {
  items: [
    {
      id: "job-unit-current",
      job_number: 101,
      name: "unit-tests",
      status: "failed",
      type: "build",
      started_at: "2026-05-02T10:01:00Z",
      stopped_at: "2026-05-02T10:03:42Z",
      web_url: "https://app.circleci.com/pipelines/github/oxnw/agentrail/88/workflows/workflow-build-current/jobs/101"
    },
    {
      id: "job-contract-current",
      job_number: 102,
      name: "contract-tests",
      status: "running",
      type: "build",
      started_at: "2026-05-02T10:01:30Z",
      stopped_at: null,
      web_url: "https://app.circleci.com/pipelines/github/oxnw/agentrail/88/workflows/workflow-build-current/jobs/102"
    }
  ]
};

export const currentLintJobsResponse = {
  items: [
    {
      id: "job-eslint-current",
      job_number: 201,
      name: "eslint",
      status: "success",
      type: "build",
      started_at: "2026-05-02T10:00:45Z",
      stopped_at: "2026-05-02T10:01:12Z",
      web_url: "https://app.circleci.com/pipelines/github/oxnw/agentrail/88/workflows/workflow-lint-current/jobs/201"
    }
  ]
};

export const priorWorkflowListResponse = {
  items: [
    {
      id: "workflow-build-prior",
      pipeline_id: "pipeline-prior",
      name: "build",
      status: "success",
      created_at: "2026-05-02T09:50:05Z",
      stopped_at: "2026-05-02T09:56:00Z",
      url: "https://app.circleci.com/pipelines/github/oxnw/agentrail/87/workflows/workflow-build-prior"
    }
  ]
};

export const priorBuildJobsResponse = {
  items: [
    {
      id: "job-unit-prior",
      job_number: 100,
      name: "unit-tests",
      status: "success",
      type: "build",
      started_at: "2026-05-02T09:53:00Z",
      stopped_at: "2026-05-02T09:55:00Z",
      web_url: "https://app.circleci.com/pipelines/github/oxnw/agentrail/87/workflows/workflow-build-prior/jobs/100"
    }
  ]
};

export const failedUnitTestsResponse = {
  items: [
    {
      file: "test/ci-status-endpoint.test.js",
      name: "GET /tasks/{id}/ci-status returns structured failures",
      result: "failure",
      message: "Expected status 200 but received 500",
      source: "test/ci-status-endpoint.test.js"
    }
  ]
};

export const workflowCompletedWebhook = {
  id: "evt-circleci-workflow-1",
  type: "workflow-completed",
  happened_at: "2026-05-02T10:04:00Z",
  webhook: {
    id: "wh-circleci-1",
    name: "AgentRail CircleCI"
  },
  project: {
    id: "proj-circleci-1",
    name: "agentrail",
    slug: "gh/oxnw/agentrail"
  },
  pipeline: {
    id: "pipeline-current",
    number: 88,
    created_at: "2026-05-02T10:00:00Z",
    vcs: {
      branch: "feature/circleci-status",
      revision: "abc123"
    }
  },
  workflow: {
    id: "workflow-build-current",
    name: "build",
    created_at: "2026-05-02T10:00:05Z",
    stopped_at: "2026-05-02T10:04:00Z",
    url: "https://app.circleci.com/pipelines/github/oxnw/agentrail/88/workflows/workflow-build-current",
    status: "failed"
  }
};

export const jobCompletedWebhook = {
  id: "evt-circleci-job-1",
  type: "job-completed",
  happened_at: "2026-05-02T10:03:42Z",
  webhook: {
    id: "wh-circleci-1",
    name: "AgentRail CircleCI"
  },
  project: {
    id: "proj-circleci-1",
    name: "agentrail",
    slug: "gh/oxnw/agentrail"
  },
  pipeline: {
    id: "pipeline-current",
    number: 88,
    created_at: "2026-05-02T10:00:00Z",
    vcs: {
      branch: "feature/circleci-status",
      revision: "abc123"
    }
  },
  workflow: {
    id: "workflow-build-current",
    name: "build",
    created_at: "2026-05-02T10:00:05Z",
    stopped_at: "2026-05-02T10:04:00Z",
    url: "https://app.circleci.com/pipelines/github/oxnw/agentrail/88/workflows/workflow-build-current"
  },
  job: {
    id: "job-unit-current",
    number: 101,
    name: "unit-tests",
    started_at: "2026-05-02T10:01:00Z",
    stopped_at: "2026-05-02T10:03:42Z",
    status: "failed"
  }
};
