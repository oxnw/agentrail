import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createServer } from "./app.ts";
import { AgentAuthStore } from "./agent-auth-store.ts";
import { AgentRunStore } from "./agent-run-store.ts";
import { configPathForHome, defaultAgentRailHome, type ConnectedRepo } from "./cli/agentrail-home.ts";
import { loadEnvFile, parseSimpleEnv } from "./env-file.ts";
import { TaskEventStore } from "./task-event-store.ts";
import { buildRuntime } from "./server-runtime.ts";
import { createDesktopAwaitingUserNotifier, parseDesktopNotificationsEnabled } from "./desktop-notifier.ts";

loadDotEnv();

const host = process.env.AGENTRAIL_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.AGENTRAIL_PORT || process.env.PORT || "3000", 10);
const publicBaseUrl =
  process.env.AGENTRAIL_PUBLIC_BASE_URL || `http://${host}:${port}`;
const storagePath = process.env.AGENTRAIL_EVENT_STORE_PATH;
const authStorePath = process.env.AGENTRAIL_AGENT_AUTH_STORE_PATH;
const agentRunStorePath = process.env.AGENTRAIL_AGENT_RUNS_STORE_PATH;
const desktopNotificationsEnabled = parseDesktopNotificationsEnabled(process.env.AGENTRAIL_DESKTOP_NOTIFICATIONS);

const fallbackMode = (process.env.AGENTRAIL_FALLBACK_MODE ?? "false").toLowerCase() === "true";

const now = () => new Date();
const eventStore = new TaskEventStore({ now, storagePath });

const githubToken = process.env.GITHUB_TOKEN || null;
const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET || null;
const circleciToken = process.env.CIRCLECI_TOKEN || null;
const circleciWebhookSecret = process.env.CIRCLECI_WEBHOOK_SECRET || null;
const linearApiKey = process.env.LINEAR_API_KEY || null;
const linearWebhookSecret = process.env.LINEAR_WEBHOOK_SECRET || null;

let server: ReturnType<typeof createServer> | null = null;

async function shutdown(deliveryController?: { stop(): Promise<void> } | null) {
  try {
    await deliveryController?.stop();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error stopping delivery controller: ${message}\n`);
  } finally {
    if (!server) {
      process.exit(0);
      return;
    }
    server.close(() => {
      process.exit(0);
    });
  }
}

export function startServer() {
  try {
    const runtime = buildRuntime({
      githubToken,
      githubMode: providerConfig.github.mode,
      githubWebhookSecret,
      githubDeliveryMode: providerConfig.github.deliveryMode,
      githubPollIntervalMs: providerConfig.github.pollIntervalMs,
      circleciToken,
      circleciMode: providerConfig.circleci.mode,
      circleciWebhookSecret,
      circleciDeliveryMode: providerConfig.circleci.deliveryMode,
      circleciPollIntervalMs: providerConfig.circleci.pollIntervalMs,
      linearApiKey,
      linearMode: providerConfig.linear.mode,
      linearWebhookSecret,
      linearDeliveryMode: providerConfig.linear.deliveryMode,
      linearPollIntervalMs: providerConfig.linear.pollIntervalMs,
      repos: providerConfig.repos,
      now,
      eventStore,
      publicBaseUrl
    });

    const authStore = new AgentAuthStore({ now, storagePath: authStorePath });
    const agentRunStore = new AgentRunStore({ now, storagePath: agentRunStorePath });

    server = createServer({
      store: eventStore,
      agentRunStore,
      taskLifecycleStore: runtime.taskLifecycleStore,
      ciStatusAdapter: runtime.ciStatusAdapter,
      githubWebhookSecret,
      reviewFeedbackAdapter: runtime.reviewFeedbackAdapter,
      rollbackAdapter: runtime.rollbackAdapter,
      intakeAdapter: runtime.intakeAdapter,
      linearIntakeAdapter: runtime.linearIntakeAdapter,
      linearWebhookAdapter: runtime.linearWebhookAdapter,
      routingControlPlane: runtime.routingControlPlane,
      authStore,
      now,
      publicBaseUrl,
      fallbackMode,
      awaitingUserNotifier: createDesktopAwaitingUserNotifier({ enabled: desktopNotificationsEnabled }),
    });

    server.listen(port, host, () => {
      process.stdout.write(`✓ AgentRail API ready at ${publicBaseUrl}\n`);
    });

    process.on("SIGTERM", () => {
      void shutdown(runtime.deliveryController);
    });
    process.on("SIGINT", () => {
      void shutdown(runtime.deliveryController);
    });
    runtime.deliveryController?.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`AgentRail startup failed: ${message}\n`);
    process.exit(1);
  }
}

function loadDotEnv() {
  try {
    const explicitEnvKeys = new Set(Object.keys(process.env));
    const agentrailHome = process.env.AGENTRAIL_HOME || defaultAgentRailHome();
    // Precedence: explicit process env wins, then the selected AgentRail home
    // env files override cwd defaults so setup-generated config is stable from
    // any invocation directory.
    loadEnvFile(".env");
    loadEnvFile(".agentrail/server.env");
    loadHomeEnvFile(path.join(agentrailHome, "server.env"), explicitEnvKeys);
    loadHomeEnvFile(path.join(agentrailHome, "provider.env"), explicitEnvKeys);
  } catch {
    // .env loading is convenience-only; environment variables still work.
  }
}

function loadHomeEnvFile(filePath: string, explicitEnvKeys: Set<string>): void {
  const content = readFileIfExists(filePath);
  if (!content) return;

  for (const [key, value] of Object.entries(parseSimpleEnv(content))) {
    if (!explicitEnvKeys.has(key)) {
      process.env[key] = value;
    }
  }
}

function readFileIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") {
      return null;
    }
    throw error;
  }
}

const DEFAULT_PROVIDER_CONFIG = {
  github: { mode: "disabled" as const, deliveryMode: "polling" as const, pollIntervalMs: null },
  circleci: { mode: "disabled" as const, deliveryMode: "polling" as const, pollIntervalMs: null },
  linear: { mode: "disabled" as const, deliveryMode: "polling" as const, pollIntervalMs: null },
  repos: [] as ConnectedRepo[],
};

const providerConfig = readProviderConfig();

if (isMainModule()) {
  startServer();
}

function isConnectedRepo(value: unknown): value is ConnectedRepo {
  return typeof value === "object"
    && value !== null
    && typeof (value as ConnectedRepo).path === "string"
    && typeof (value as ConnectedRepo).slug === "string"
    && typeof (value as ConnectedRepo).defaultBranch === "string";
}

function parseProviderSettings(providerData?: { mode?: string; deliveryMode?: string; pollIntervalMs?: number }): {
  mode: "real" | "disabled";
  deliveryMode: "polling" | "webhook";
  pollIntervalMs: number | null;
} {
  return {
    mode: providerData?.mode === "real" ? "real" : "disabled",
    deliveryMode: providerData?.deliveryMode === "webhook" ? "webhook" : "polling",
    pollIntervalMs: Number.isFinite(providerData?.pollIntervalMs) && Number(providerData.pollIntervalMs) > 0
      ? Number(providerData.pollIntervalMs)
      : null,
  };
}

function readProviderConfig(): {
  github: { mode: "real" | "disabled"; deliveryMode: "polling" | "webhook"; pollIntervalMs: number | null };
  circleci: { mode: "real" | "disabled"; deliveryMode: "polling" | "webhook"; pollIntervalMs: number | null };
  linear: { mode: "real" | "disabled"; deliveryMode: "polling" | "webhook"; pollIntervalMs: number | null };
  repos: ConnectedRepo[];
} {
  try {
    const homePath = process.env.AGENTRAIL_HOME || defaultAgentRailHome();
    const content = readFileIfExists(configPathForHome(homePath));
    if (!content) {
      return { ...DEFAULT_PROVIDER_CONFIG };
    }
    const parsed = JSON.parse(content) as {
      providers?: {
        github?: { mode?: string; deliveryMode?: string; pollIntervalMs?: number };
        circleci?: { mode?: string; deliveryMode?: string; pollIntervalMs?: number };
        linear?: { mode?: string; deliveryMode?: string; pollIntervalMs?: number };
      };
      repos?: ConnectedRepo[];
    };
    return {
      github: parseProviderSettings(parsed.providers?.github),
      circleci: parseProviderSettings(parsed.providers?.circleci),
      linear: parseProviderSettings(parsed.providers?.linear),
      repos: Array.isArray(parsed.repos) ? parsed.repos.filter(isConnectedRepo) : [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Warning: Failed to read AgentRail provider config; using disabled providers: ${message}\n`);
    return { ...DEFAULT_PROVIDER_CONFIG };
  }
}

function isMainModule() {
  const entryPoint = process.argv[1];
  return Boolean(entryPoint) && import.meta.url === pathToFileURL(entryPoint).href;
}
