import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createServer } from "./app.ts";
import { AgentAuthStore } from "./agent-auth-store.ts";
import { AgentRunStore } from "./agent-run-store.ts";
import {
  configPathForHome,
  defaultAgentRailHome,
  DEFAULT_EVENT_DELIVERY_STORE_PATH,
  DEFAULT_EVENT_SUBSCRIPTION_STORE_PATH,
  DEFAULT_PROVIDER_CURSOR_STORE_PATH,
  type ConnectedRepo,
} from "./cli/agentrail-home.ts";
import { loadEnvFile } from "./env-file.ts";
import { AgentRailEventDeliveryController, AgentRailEventDeliveryWorker } from "./event-delivery-worker.ts";
import { AgentRailEventSubscriptionStore } from "./event-subscription-store.ts";
import { TaskEventStore } from "./task-event-store.ts";
import { buildRuntime } from "./server-runtime.ts";

loadDotEnv();

const agentrailHome = path.resolve(process.cwd(), process.env.AGENTRAIL_HOME || defaultAgentRailHome());
const host = process.env.AGENTRAIL_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.AGENTRAIL_PORT || process.env.PORT || "3000", 10);
const publicBaseUrl =
  process.env.AGENTRAIL_PUBLIC_BASE_URL || `http://${host}:${port}`;
const storagePath = process.env.AGENTRAIL_EVENT_STORE_PATH;
const authStorePath = process.env.AGENTRAIL_AGENT_AUTH_STORE_PATH;
const agentRunStorePath = process.env.AGENTRAIL_AGENT_RUNS_STORE_PATH;
const providerCursorStorePath =
  process.env.AGENTRAIL_PROVIDER_CURSOR_STORE_PATH || path.join(agentrailHome, DEFAULT_PROVIDER_CURSOR_STORE_PATH);
process.env.AGENTRAIL_PROVIDER_CURSOR_STORE_PATH = providerCursorStorePath;
const eventSubscriptionStorePath =
  process.env.AGENTRAIL_EVENT_SUBSCRIPTION_STORE_PATH || path.join(agentrailHome, DEFAULT_EVENT_SUBSCRIPTION_STORE_PATH);
const eventDeliveryStorePath =
  process.env.AGENTRAIL_EVENT_DELIVERY_STORE_PATH || path.join(agentrailHome, DEFAULT_EVENT_DELIVERY_STORE_PATH);

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

type DeliveryControllerLike = {
  start(): void;
  stop(): Promise<void>;
};

async function stopDeliveryControllers(deliveryControllers: Array<{ stop(): Promise<void> } | null | undefined> = []) {
  try {
    await Promise.all(deliveryControllers.map((controller) => controller?.stop()));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error stopping delivery controllers: ${message}\n`);
  }
}

async function shutdown(deliveryControllers: Array<{ stop(): Promise<void> } | null | undefined> = []) {
  try {
    await stopDeliveryControllers(deliveryControllers);
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
  const startedDeliveryControllers: DeliveryControllerLike[] = [];
  try {
    const runtime = buildRuntime({
      githubToken,
      githubMode: providerConfig.github.mode,
      githubWebhookSecret,
      githubDeliveryMode: providerConfig.github.deliveryMode,
      githubIssueImportMode: providerConfig.github.importMode,
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
    const eventSubscriptionStore = new AgentRailEventSubscriptionStore({
      now,
      storagePath: eventSubscriptionStorePath,
    });
    const eventDeliveryWorker = new AgentRailEventDeliveryWorker({
      eventStore,
      eventSubscriptionStore,
      now,
      storagePath: eventDeliveryStorePath,
    });
    const eventDeliveryController = new AgentRailEventDeliveryController({
      eventStore,
      worker: eventDeliveryWorker,
    });

    server = createServer({
      store: eventStore,
      agentRunStore,
      eventSubscriptionStore,
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
    });

    server.listen(port, host, () => {
      process.stdout.write(`✓ AgentRail API ready at ${publicBaseUrl}\n`);
    });

    process.on("SIGTERM", () => {
      void shutdown([runtime.deliveryController, eventDeliveryController]);
    });
    process.on("SIGINT", () => {
      void shutdown([runtime.deliveryController, eventDeliveryController]);
    });
    if (runtime.deliveryController) {
      runtime.deliveryController.start();
      startedDeliveryControllers.push(runtime.deliveryController);
    }
    eventDeliveryController.start();
    startedDeliveryControllers.push(eventDeliveryController);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`AgentRail startup failed: ${message}\n`);
    void stopDeliveryControllers(startedDeliveryControllers).finally(() => {
      process.exit(1);
    });
  }
}

function loadDotEnv() {
  try {
    const homePath = path.resolve(process.cwd(), process.env.AGENTRAIL_HOME || defaultAgentRailHome());
    loadEnvFile(".env");
    loadEnvFile(".agentrail/server.env");
    loadEnvFile(path.join(homePath, "server.env"));
    loadEnvFile(path.join(homePath, "provider.env"), { overwrite: true });
  } catch {
    // .env loading is convenience-only; environment variables still work.
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
  github: { mode: "disabled" as const, deliveryMode: "polling" as const, importMode: "from_now" as const, pollIntervalMs: null },
  circleci: { mode: "disabled" as const, deliveryMode: "polling" as const, importMode: "from_now" as const, pollIntervalMs: null },
  linear: { mode: "disabled" as const, deliveryMode: "polling" as const, importMode: "from_now" as const, pollIntervalMs: null },
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

function parseProviderSettings(providerData?: { mode?: string; deliveryMode?: string; importMode?: string; pollIntervalMs?: number }): {
  mode: "real" | "disabled";
  deliveryMode: "polling" | "webhook";
  importMode: "from_now" | "backfill";
  pollIntervalMs: number | null;
} {
  return {
    mode: providerData?.mode === "real" ? "real" : "disabled",
    deliveryMode: providerData?.deliveryMode === "webhook" ? "webhook" : "polling",
    importMode: providerData?.importMode === "backfill" ? "backfill" : "from_now",
    pollIntervalMs: Number.isFinite(providerData?.pollIntervalMs) && Number(providerData.pollIntervalMs) > 0
      ? Number(providerData.pollIntervalMs)
      : null,
  };
}

function readProviderConfig(): {
  github: { mode: "real" | "disabled"; deliveryMode: "polling" | "webhook"; importMode: "from_now" | "backfill"; pollIntervalMs: number | null };
  circleci: { mode: "real" | "disabled"; deliveryMode: "polling" | "webhook"; importMode: "from_now" | "backfill"; pollIntervalMs: number | null };
  linear: { mode: "real" | "disabled"; deliveryMode: "polling" | "webhook"; importMode: "from_now" | "backfill"; pollIntervalMs: number | null };
  repos: ConnectedRepo[];
} {
  try {
    const content = readFileIfExists(configPathForHome(agentrailHome));
    if (!content) {
      return { ...DEFAULT_PROVIDER_CONFIG };
    }
    const parsed = JSON.parse(content) as {
      providers?: {
        github?: { mode?: string; deliveryMode?: string; importMode?: string; pollIntervalMs?: number };
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
