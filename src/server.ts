import fs from "node:fs";

import { createAgentShipCycleDemoStore } from "./agent-ship-cycle-demo.js";
import { createServer } from "./app.js";
import { CircleCiStatusAdapter } from "./circleci-status-adapter.js";
import { GitHubActionsCiAdapter } from "./github-actions-ci-adapter.js";
import { GitHubSubmitAdapter } from "./github-submit-adapter.js";
import { MultiCiStatusAdapter } from "./multi-ci-status-adapter.js";
import { TaskEventStore } from "./task-event-store.js";

loadDotEnv();

const host = process.env.AGENTRAIL_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.AGENTRAIL_PORT || process.env.PORT || "3000", 10);
const publicBaseUrl =
  process.env.AGENTRAIL_PUBLIC_BASE_URL || `http://${host}:${port}`;
const storagePath = process.env.AGENTRAIL_EVENT_STORE_PATH || undefined;

const fallbackMode = (process.env.AGENTRAIL_FALLBACK_MODE ?? "false").toLowerCase() === "true";

const now = () => new Date();
const eventStore = new TaskEventStore({ now, storagePath });
const demoStore = createAgentShipCycleDemoStore({
  now,
  eventStore,
  apiBaseUrl: publicBaseUrl,
});

const githubToken = process.env.GITHUB_TOKEN || null;
const circleciToken = process.env.CIRCLECI_TOKEN || null;
const taskSourcesJson = process.env.AGENTRAIL_TASK_SOURCES || null;
let taskSources: Map<string, unknown> | null = null;

let taskLifecycleStore: GitHubSubmitAdapter | ReturnType<typeof createAgentShipCycleDemoStore> = demoStore;
if (taskSourcesJson) {
  try {
    const parsed = JSON.parse(taskSourcesJson);
    taskSources = new Map(Object.entries(parsed));
    if (githubToken) {
      taskLifecycleStore = new GitHubSubmitAdapter({
        taskSources,
        githubToken,
        delegate: demoStore,
      });
      // Delegate non-submit methods back to demo store
      const storeWithFallback = taskLifecycleStore as unknown as ReturnType<typeof createAgentShipCycleDemoStore>;
      storeWithFallback.listMyTasks = demoStore.listMyTasks.bind(demoStore);
      storeWithFallback.getTask = demoStore.getTask.bind(demoStore);
      storeWithFallback.getTaskCiStatus = demoStore.getTaskCiStatus.bind(demoStore);
      storeWithFallback.getTaskReviewFeedback = demoStore.getTaskReviewFeedback.bind(demoStore);
      storeWithFallback.shipTask = demoStore.shipTask.bind(demoStore);
      storeWithFallback.rollbackTask = demoStore.rollbackTask.bind(demoStore);
    }
  } catch {
    process.stderr.write("Warning: AGENTRAIL_TASK_SOURCES is not valid JSON; using demo store.\n");
  }
}

const ciStatusAdapter = buildCiStatusAdapter({
  taskSources,
  githubToken,
  circleciToken,
  demoStore
});

const server = createServer({
  store: eventStore,
  taskLifecycleStore,
  ciStatusAdapter,
  reviewFeedbackAdapter: demoStore,
  now,
  publicBaseUrl,
  fallbackMode,
});

server.listen(port, host, () => {
  process.stdout.write(`AgentRail local API listening on ${publicBaseUrl}\n`);
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function shutdown() {
  server.close(() => {
    process.exit(0);
  });
}

function loadDotEnv() {
  try {
    const content = readFileIfExists(".env");
    if (!content) return;

    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) continue;

      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      if (key && process.env[key] === undefined) {
        process.env[key] = stripQuotes(value);
      }
    }
  } catch {
    // .env loading is convenience-only; environment variables still work.
  }
}

function readFileIfExists(filePath: string): string | null {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function buildCiStatusAdapter({ taskSources, githubToken, circleciToken, demoStore }: {
  taskSources: Map<string, unknown> | null;
  githubToken: string | null;
  circleciToken: string | null;
  demoStore: ReturnType<typeof createAgentShipCycleDemoStore>;
}) {
  const adapters = [];

  if (taskSources && githubToken) {
    adapters.push(
      new GitHubActionsCiAdapter({
        taskSources,
        githubToken
      })
    );
  }

  if (taskSources && circleciToken) {
    adapters.push(
      new CircleCiStatusAdapter({
        taskSources,
        circleciToken
      })
    );
  }

  if (adapters.length === 0) {
    return demoStore;
  }

  return new MultiCiStatusAdapter({
    adapters: [...adapters, demoStore]
  });
}
