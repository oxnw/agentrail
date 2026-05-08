import http from "node:http";
import assert from "node:assert/strict";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";

import { runCli } from "../src/cli/index.ts";
import { withTemporaryLocalServer } from "../src/cli/local-bootstrap.ts";
import { createSetupConfig } from "../src/cli/setup-config.ts";

test("init creates local operator state and writes local setup env files", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-init-local-"));
  const agentrailHome = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = agentrailHome;

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(agentrailHome, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
    else process.env.AGENTRAIL_HOME = previousHome;
  });

  const exitCode = await runCli([
    "init",
    "--yes",
    "--mode",
    "server",
    "--provider-mode",
    "disabled",
    "--repo",
    repoRoot,
    "--base-url",
    "http://127.0.0.1:3000",
  ], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
    detectRepoContext: async () => ({
      repoPath: repoRoot,
      remoteSlug: "oxnw/agentrail",
      defaultBranch: "main",
      gitIgnoreHasAgentrail: true,
    }),
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.equal(stderr.toString(), "");
  assert.match(stdout.toString(), /operator\.env/);

  const operatorEnv = await readFile(path.join(agentrailHome, "operator.env"), "utf8");
  const authStore = await readFile(path.join(agentrailHome, "stores", "agent-auth.json"), "utf8");
  const serverEnv = await readFile(path.join(agentrailHome, "server.env"), "utf8");

  assert.match(operatorEnv, /AGENTRAIL_OPERATOR_KEY=ar_live_/);
  assert.match(operatorEnv, /AGENTRAIL_OPERATOR_KEY_ID=akey_/);
  assert.match(authStore, /agt_operator/);
  assert.match(serverEnv, new RegExp(`AGENTRAIL_AGENT_AUTH_STORE_PATH=${escapeForRegExp(path.join(agentrailHome, "stores", "agent-auth.json"))}`));
});

test("standalone agent create starts a temporary local server when the configured server is stopped", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-create-temp-server-"));
  const agentrailHome = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousHome = process.env.AGENTRAIL_HOME;
  const baseUrl = await reserveClosedLocalBaseUrl();
  process.env.AGENTRAIL_HOME = agentrailHome;
  const detectRepoContext = async () => ({
    repoPath: repoRoot,
    remoteSlug: "oxnw/agentrail",
    defaultBranch: "main",
    gitIgnoreHasAgentrail: true,
  });

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(agentrailHome, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
    else process.env.AGENTRAIL_HOME = previousHome;
  });

  const initExitCode = await runCli([
    "init",
    "--yes",
    "--mode",
    "server",
    "--provider-mode",
    "disabled",
    "--repo",
    repoRoot,
    "--base-url",
    baseUrl,
  ], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
    detectRepoContext,
  });
  assert.equal(initExitCode, 0, stderr.toString());

  const createExitCode = await runCli([
    "agent",
    "create",
    "--agent-id",
    "agt_temp_create",
    "--name",
    "Temp Create",
    "--runner",
    "codex",
    "--scopes",
    "tasks:read,tasks:write",
    "--repo-allowlist",
    "oxnw/agentrail",
    "--capability-tags",
    "code,tests",
    "--set-default-env",
  ], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
    detectRepoContext,
  });

  assert.equal(createExitCode, 0, stderr.toString());
  assert.match(stdout.toString(), /Created agent Temp Create \(agt_temp_create\)\./);

  const envText = await readFile(path.join(agentrailHome, "agents", "agt_temp_create.env"), "utf8");
  assert.match(envText, new RegExp(`AGENTRAIL_BASE_URL=${escapeForRegExp(baseUrl)}`));
});

test("temporary local verification reuses an already-running healthy server", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-init-reuse-server-"));
  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP address for test server.");
  }

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const config = createSetupConfig({
    cwd: repoRoot,
    detectedRepo: {
      repoPath: repoRoot,
      remoteSlug: "oxnw/agentrail",
      defaultBranch: "main",
      gitIgnoreHasAgentrail: true,
    },
    interactionMode: "non_interactive",
    acceptedDefaults: true,
    providerMode: "disabled",
    baseUrl: `http://${address.address}:${address.port}`,
  });

  const reusedBaseUrl = await withTemporaryLocalServer({
    repoRoot,
    config,
    handler: async ({ baseUrl }) => baseUrl,
  });

  assert.equal(reusedBaseUrl, `http://${address.address}:${address.port}`);
});

test("temporary local verification starts a temp server when the healthy server lacks provisioning routes", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-init-fallback-server-"));
  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: { message: "Not found" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP address for test server.");
  }

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const config = createSetupConfig({
    cwd: repoRoot,
    detectedRepo: {
      repoPath: repoRoot,
      remoteSlug: "oxnw/agentrail",
      defaultBranch: "main",
      gitIgnoreHasAgentrail: true,
    },
    interactionMode: "non_interactive",
    acceptedDefaults: true,
    providerMode: "disabled",
    baseUrl: `http://${address.address}:${address.port}`,
  });

  const baseUrl = await withTemporaryLocalServer({
    repoRoot,
    config,
    validateExistingBaseUrl: async (existingBaseUrl) => {
      const response = await fetch(new URL("operator/routing/agent-profiles/agt_operator", `${existingBaseUrl}/`), {
        headers: {
          accept: "application/json",
        },
      });
      return response.status !== 404;
    },
    handler: async ({ baseUrl: temporaryBaseUrl }) => temporaryBaseUrl,
  });

  assert.notEqual(baseUrl, `http://${address.address}:${address.port}`);
});

test("temporary local verification normalizes wildcard listen hosts to a routable localhost URL", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-init-wildcard-host-"));

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  const config = createSetupConfig({
    cwd: repoRoot,
    detectedRepo: {
      repoPath: repoRoot,
      remoteSlug: "oxnw/agentrail",
      defaultBranch: "main",
      gitIgnoreHasAgentrail: true,
    },
    interactionMode: "non_interactive",
    acceptedDefaults: true,
    providerMode: "disabled",
    host: "0.0.0.0",
    baseUrl: "http://127.0.0.1:3000",
  });

  const baseUrl = await withTemporaryLocalServer({
    repoRoot,
    config,
    handler: async ({ baseUrl: temporaryBaseUrl }) => temporaryBaseUrl,
  });

  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
});

function createMemoryWriter() {
  let buffer = "";
  return {
    write(chunk: string | Uint8Array) {
      buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
    toString() {
      return buffer;
    },
  };
}

async function reserveClosedLocalBaseUrl(): Promise<string> {
  const server = http.createServer((_request, response) => {
    response.writeHead(204).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP address for temporary server.");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return baseUrl;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
