import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createServer } from "../../src/app.ts";
import { AgentAuthStore } from "../../src/agent-auth-store.ts";
import { AgentProfileStore } from "../../src/agent-profile-store.ts";
import { AgentTaskQueue } from "../../src/agent-task-queue.ts";
import { RoutingControlPlane } from "../../src/intake-routing-control-plane.ts";
import { RoutingRuleStore } from "../../src/routing-rule-store.ts";
import { TaskEventStore } from "../../src/task-event-store.ts";
import { createSetupConfig, type DetectedRepoContext } from "../../src/cli/setup-config.ts";
import { currentAgentEnvPathForHome, operatorEnvPathForHome, recipePathForHome } from "../../src/cli/agentrail-home.ts";
import { writeSetupFiles } from "../../src/cli/setup-files.ts";

const now = () => new Date("2026-05-06T00:00:00Z");
const DEFAULT_TEST_REPO_SLUG = "oxnw/agentrail";

export interface SetupDoctorHarness {
  server: ReturnType<typeof createServer>;
  baseUrl: string;
  operatorApiKey: string;
  agentApiKey: string;
  agentId: string;
  repoAllowlist: string[];
  taskQueue: AgentTaskQueue;
  close: () => Promise<void>;
}

export async function createSetupDoctorHarness({
  agentId = "agt_setup",
  repoAllowlist = ["oxnw/agentrail"],
}: {
  agentId?: string;
  repoAllowlist?: string[];
} = {}): Promise<SetupDoctorHarness> {
  const eventStore = new TaskEventStore({ now });
  const taskQueue = new AgentTaskQueue({ now, eventStore });
  const authStore = new AgentAuthStore({ now });
  const agentProfileStore = new AgentProfileStore({ now });
  const routingRuleStore = new RoutingRuleStore({ now });
  const routingControlPlane = new RoutingControlPlane({
    now,
    taskQueue,
    agentProfileStore,
    routingRuleStore,
  });
  const server = createServer({
    store: eventStore,
    authStore,
    taskLifecycleStore: taskQueue,
    routingControlPlane,
    now,
  });
  const baseUrl = await listen(server);
  try {
    const operatorApiKey = await bootstrapAdminKey(baseUrl);
    const agentApiKey = await createAgentKey(baseUrl, operatorApiKey, agentId);

    await seedAgentProfile({
      baseUrl,
      operatorApiKey,
      agentId,
      repoAllowlist,
    });
    await seedRoutingRuleSet({
      baseUrl,
      operatorApiKey,
      agentId,
      repoAllowlist,
    });

    return {
      server,
      baseUrl,
      operatorApiKey,
      agentApiKey,
      agentId,
      repoAllowlist,
      taskQueue,
      close: () => closeServer(server),
    };
  } catch (error) {
    await closeServer(server);
    throw error;
  }
}

export async function seedSetupVerificationTask({
  baseUrl,
  operatorApiKey,
  agentId,
  sourceRef = "agentrail-doctor:test",
}: {
  baseUrl: string;
  operatorApiKey: string;
  agentId: string;
  sourceRef?: string;
}): Promise<void> {
  const response = await fetch(`${baseUrl}/operator/setup/verification-task`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${operatorApiKey}`,
      "content-type": "application/json",
      "idempotency-key": `setup-verification:${agentId}:test`,
    },
    body: JSON.stringify({
      agentId,
      sourceRef,
    }),
  });
  const bodyText = await response.text();
  assert.equal(response.status, 201, bodyText);
}

export async function writeDoctorRepo({
  repoRoot,
  homePath = repoRoot,
  baseUrl,
  agentApiKey,
  agentId,
  repoAllowlist = ["oxnw/agentrail"],
  routingMode = "rules_only",
  routingClassifierRunner = "codex",
  routingClassifierModel = null,
}: {
  repoRoot: string;
  homePath?: string;
  baseUrl: string;
  agentApiKey: string;
  agentId: string;
  repoAllowlist?: string[];
  routingMode?: "rules_only" | "ai_assist";
  routingClassifierRunner?: "codex" | "claude-code" | "cursor" | "custom" | string;
  routingClassifierModel?: string | null;
}): Promise<void> {
  const detectedRepo: DetectedRepoContext = {
    repoPath: repoRoot,
    remoteSlug: repoAllowlist[0] ?? DEFAULT_TEST_REPO_SLUG,
    defaultBranch: "main",
    gitIgnoreHasAgentrail: true,
  };
  const config = createSetupConfig({
    cwd: repoRoot,
    detectedRepo,
    interactionMode: "non_interactive",
    acceptedDefaults: true,
    mode: "server",
    baseUrl,
    providerMode: "disabled",
    repoAllowlist,
    routingMode,
    routingClassifierRunner,
    routingClassifierModel,
  });

  await writeSetupFiles({
    homePath,
    config,
  });
  await mkdir(homePath, { recursive: true });
  await writeFile(
    currentAgentEnvPathForHome(homePath),
    [
      `AGENTRAIL_BASE_URL=${baseUrl}`,
      `AGENTRAIL_API_KEY=${agentApiKey}`,
      `AGENTRAIL_AGENT_ID=${agentId}`,
      "AGENTRAIL_AGENT_RUNNER=codex",
      `AGENTRAIL_REPO_ALLOWLIST=${repoAllowlist.join(",")}`,
      `AGENTRAIL_AGENT_RECIPE_PATH=${recipePathForHome(homePath)}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Expected server address info.");
  }

  return `http://${address.address}:${address.port}`;
}

async function bootstrapAdminKey(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/agent-api-keys`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "bootstrap-setup-doctor-admin",
    },
    body: JSON.stringify({
      agent: {
        id: "agt_operator",
        displayName: "Operator",
        role: "operator",
      },
      scopes: ["auth:admin", "routing:admin", "routing:read", "tasks:read"],
    }),
  });
  const bodyText = await response.text();
  assert.equal(response.status, 201, bodyText);
  return JSON.parse(bodyText).data.apiKey as string;
}

async function createAgentKey(baseUrl: string, operatorApiKey: string, agentId: string): Promise<string> {
  const response = await fetch(`${baseUrl}/agent-api-keys`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${operatorApiKey}`,
      "content-type": "application/json",
      "idempotency-key": `create-agent-key:${agentId}`,
    },
    body: JSON.stringify({
      agent: {
        id: agentId,
        displayName: "Setup Agent",
        role: "coding_agent",
      },
      scopes: ["tasks:read", "tasks:write", "ci:read", "reviews:read", "events:read"],
    }),
  });
  const bodyText = await response.text();
  assert.equal(response.status, 201, bodyText);
  return JSON.parse(bodyText).data.apiKey as string;
}

async function seedAgentProfile({
  baseUrl,
  operatorApiKey,
  agentId,
  repoAllowlist,
}: {
  baseUrl: string;
  operatorApiKey: string;
  agentId: string;
  repoAllowlist: string[];
}): Promise<void> {
  const response = await fetch(`${baseUrl}/operator/routing/agent-profiles/${agentId}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${operatorApiKey}`,
      "content-type": "application/json",
      "idempotency-key": `profile:${agentId}`,
    },
    body: JSON.stringify({
      displayName: "Setup Agent",
      role: "coding_agent",
      status: "active",
      capabilityTags: ["code", "tests", "api"],
      ownershipTags: [],
      repoAllowlist,
      maxConcurrentTasks: 1,
      sourceRef: "AGEA-121",
      changeReason: "Seed setup doctor test profile.",
    }),
  });
  const bodyText = await response.text();
  assert.equal(response.status, 200, bodyText);
}

async function seedRoutingRuleSet({
  baseUrl,
  operatorApiKey,
  agentId,
  repoAllowlist,
}: {
  baseUrl: string;
  operatorApiKey: string;
  agentId: string;
  repoAllowlist: string[];
}): Promise<void> {
  const response = await fetch(`${baseUrl}/operator/routing/rule-sets/current`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${operatorApiKey}`,
      "content-type": "application/json",
      "idempotency-key": `rule-set:${agentId}`,
    },
    body: JSON.stringify({
      sourceRef: "AGEA-121",
      changeReason: "Seed setup doctor test routing state.",
      rules: [
        {
          id: "setup-bootstrap-rule",
          name: "Route setup tasks to the new agent",
          enabled: true,
          priority: 100,
          conditions: {
            repositories: repoAllowlist,
          },
          target: {
            type: "agent",
            id: agentId,
          },
          confidence: 1,
          explanation: "Setup doctor harness routes matching repos to the test agent.",
        },
      ],
      classifier: {
        enabled: false,
        provider: "internal-router",
        confidenceThreshold: 0.8,
        maxCandidates: 3,
        fallbackTriageQueueId: "triage_default",
      },
    }),
  });
  const bodyText = await response.text();
  assert.equal(response.status, 201, bodyText);
}
