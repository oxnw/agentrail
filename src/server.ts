import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { createServer } from "./app.ts";
import { AgentAuthStore } from "./agent-auth-store.ts";
import { TaskEventStore } from "./task-event-store.ts";
import { buildRuntime } from "./server-runtime.ts";

loadDotEnv();

const host = process.env.AGENTRAIL_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.AGENTRAIL_PORT || process.env.PORT || "3000", 10);
const publicBaseUrl =
  process.env.AGENTRAIL_PUBLIC_BASE_URL || `http://${host}:${port}`;
const storagePath = process.env.AGENTRAIL_EVENT_STORE_PATH || undefined;

const fallbackMode = (process.env.AGENTRAIL_FALLBACK_MODE ?? "false").toLowerCase() === "true";

const now = () => new Date();
const eventStore = new TaskEventStore({ now, storagePath });

const githubToken = process.env.GITHUB_TOKEN || null;
const circleciToken = process.env.CIRCLECI_TOKEN || null;

let server: ReturnType<typeof createServer> | null = null;

if (isMainModule()) {
  startServer();
}

function shutdown() {
  server?.close(() => {
    process.exit(0);
  });
}

export function startServer() {
  try {
    const runtime = buildRuntime({
      githubToken,
      circleciToken,
      now,
      eventStore,
      publicBaseUrl
    });

    const authStore = new AgentAuthStore({ now });

    server = createServer({
      store: eventStore,
      taskLifecycleStore: runtime.taskLifecycleStore,
      ciStatusAdapter: runtime.ciStatusAdapter,
      reviewFeedbackAdapter: runtime.reviewFeedbackAdapter,
      rollbackAdapter: runtime.rollbackAdapter,
      intakeAdapter: runtime.intakeAdapter,
      routingControlPlane: runtime.routingControlPlane,
      authStore,
      now,
      publicBaseUrl,
      fallbackMode,
    });

    server.listen(port, host, () => {
      process.stdout.write(`AgentRail API listening on ${publicBaseUrl}\n`);
    });

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`AgentRail startup failed: ${message}\n`);
    process.exit(1);
  }
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

function isMainModule() {
  const entryPoint = process.argv[1];
  return Boolean(entryPoint) && import.meta.url === pathToFileURL(entryPoint).href;
}
