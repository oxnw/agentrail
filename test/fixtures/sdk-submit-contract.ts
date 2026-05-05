import type { TaskSubmitRequest } from "../../sdk/typescript/src/index.js";

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

void adapterManagedSubmit;
void artifactDemoSubmit;
