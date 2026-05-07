import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { createServer } from "../src/app.ts";
import { AgentAuthStore } from "../src/agent-auth-store.ts";
import { AgentProfileStore } from "../src/agent-profile-store.ts";
import { runCli } from "../src/cli/index.ts";
import { createSetupConfig } from "../src/cli/setup-config.ts";
import { writeSetupFiles } from "../src/cli/setup-files.ts";
import type { PromptChoice, PromptSession } from "../src/cli/prompt.ts";
import { RoutingControlPlane } from "../src/intake-routing-control-plane.ts";
import { RoutingRuleStore } from "../src/routing-rule-store.ts";
import { AgentTaskQueue } from "../src/agent-task-queue.ts";
import { TaskEventStore } from "../src/task-event-store.ts";

const now = () => new Date("2026-05-06T12:00:00Z");

test("agent create provisions a managed local agent and doctor passes", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-create-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const harness = await createHarness();
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = homePath;

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
    else process.env.AGENTRAIL_HOME = previousHome;
    await harness.close();
  });

  await writeSetupRepo(repoRoot, homePath, harness.baseUrl, harness.operatorApiKey);

  const exitCode = await runCli([
    "agent",
    "create",
    "--base-url",
    harness.baseUrl,
    "--agent-id",
    "agt_builder",
    "--name",
    "Builder",
    "--runner",
    "codex",
    "--scopes",
    "tasks:read,tasks:write",
    "--repo-allowlist",
    "oxnw/agentrail",
    "--capability-tags",
    "code,tests,api",
    "--set-default-env",
  ], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.match(stdout.toString(), /Created agent Builder \(agt_builder\)\./);
  assert.match(stdout.toString(), /GitHub repo: https:\/\/github\.com\/oxnw\/agentrail/);
  assert.equal(stderr.toString(), "");

  const envPath = path.join(homePath, "agents", "agt_builder.env");
  const aliasPath = path.join(homePath, "agent.env");
  const envText = await readFile(envPath, "utf8");
  const aliasText = await readFile(aliasPath, "utf8");
  assert.match(envText, /AGENTRAIL_API_KEY_ID=akey_/);
  assert.match(envText, /AGENTRAIL_AGENT_ID=agt_builder/);
  assert.equal(aliasText, envText);

  const ruleSet = await getJson(harness.baseUrl, "/operator/routing/rule-sets/current", harness.operatorApiKey);
  assert.equal(ruleSet.status, 200);
  assert.equal(ruleSet.json.data.rules[0].id, "cli_agent_agt_builder");
  assert.equal(ruleSet.json.data.rules[0].target.id, "agt_builder");
});

test("agent create auto-generates agent ids and honors explicit env file paths", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-create-explicit-env-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const harness = await createHarness();
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = homePath;

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
    else process.env.AGENTRAIL_HOME = previousHome;
    await harness.close();
  });

  await writeSetupRepo(repoRoot, homePath, harness.baseUrl);

  const envPath = path.join("tmp", "custom-agent.env");
  const exitCode = await runCli([
    "agent",
    "create",
    "--setup-api-key",
    harness.operatorApiKey,
    "--base-url",
    harness.baseUrl,
    "--env-file",
    envPath,
    "--name",
    "Builder Prime",
    "--runner",
    "codex",
    "--scopes",
    "tasks:read,tasks:write",
    "--repo-allowlist",
    "oxnw/agentrail",
    "--capability-tags",
    "code,tests,api",
  ], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0, stderr.toString());
  const output = stdout.toString();
  const createdMatch = output.match(/Created agent .* \((agt_[a-z0-9_]+)\)\./i);
  assert.ok(createdMatch);
  assert.match(createdMatch[1], /^agt_codex_builder_prime_[0-9a-f]{8}$/);
  assert.match(output, /GitHub repo: https:\/\/github\.com\/oxnw\/agentrail/);

  const explicitEnvPath = path.join(repoRoot, envPath);
  const envText = await readFile(explicitEnvPath, "utf8");
  assert.match(envText, new RegExp(`AGENTRAIL_AGENT_ID=${createdMatch[1]}`));
  await assert.rejects(readFile(path.join(homePath, "agents", `${createdMatch[1]}.env`), "utf8"));
});

test("agent create interactive permission preset grants expected scopes", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-create-interactive-permissions-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const harness = await createHarness();
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = homePath;
  const prompt = new ScriptedPromptSession([
    { kind: "select", value: "codex" },
    { kind: "input", value: "Builder Ship" },
    { kind: "select", value: "read_write_ship" },
    { kind: "select", value: "coding_agent" },
    { kind: "input", value: "https://github.com/oxnw/agentrail" },
    { kind: "multiselect", value: ["backend", "api", "tests"] },
    { kind: "multiselect", value: [] },
    { kind: "select", value: "1" },
    { kind: "input", value: path.join(repoRoot, "AGENTS.md") },
    { kind: "confirm", value: true },
    { kind: "confirm", value: true },
  ]);

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
    else process.env.AGENTRAIL_HOME = previousHome;
    await harness.close();
  });

  await writeSetupRepo(repoRoot, homePath, harness.baseUrl, harness.operatorApiKey);

  const exitCode = await runCli([
    "agent",
    "create",
    "--base-url",
    harness.baseUrl,
  ], {
    cwd: repoRoot,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stdout,
    stderr,
    createPrompt: () => prompt,
  });

  assert.equal(exitCode, 0, stderr.toString());
  const createdMatch = stdout.toString().match(/Created agent .* \((agt_[a-z0-9_]+)\)\./i);
  assert.ok(createdMatch);
  assert.match(createdMatch[1], /^agt_codex_builder_ship_[0-9a-f]{8}$/);
  assert.match(stdout.toString(), /GitHub repo: https:\/\/github\.com\/oxnw\/agentrail/);
  const envPath = path.join(homePath, "agents", `${createdMatch[1]}.env`);
  const env = parseEnv(await readFile(envPath, "utf8"));
  const usage = await getJson(harness.baseUrl, `/agent-api-keys/${env.AGENTRAIL_API_KEY_ID}/usage`, harness.operatorApiKey);
  assert.equal(usage.status, 200);
  assert.deepEqual(usage.json.data.scopes, ["ci:read", "events:read", "reviews:read", "ship:write", "tasks:read", "tasks:write"]);
  assert.match(prompt.notes.map((note) => note.title).join("\n"), /Permissions selected/);
  assert.match(prompt.notes.map((note) => note.title).join("\n"), /Role guide/);
  assert.match(prompt.notes.map((note) => note.title).join("\n"), /Review agent setup/);
  assert.match(prompt.notes.map((note) => note.body).join("\n"), /GitHub repo: https:\/\/github\.com\/oxnw\/agentrail/);
  assert.match(prompt.notes.map((note) => note.body).join("\n"), /Role: General coding \(coding_agent\)/);
  assert.match(prompt.notes.map((note) => note.body).join("\n"), /Best for building and editing code/);
  assert.match(prompt.notes.map((note) => note.body).join("\n"), /Task capacity: 1/);
});

test("agent update rotates scopes, refreshes env files, and updates managed routing", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-update-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const harness = await createHarness();
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = homePath;

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
    else process.env.AGENTRAIL_HOME = previousHome;
    await harness.close();
  });

  await writeSetupRepo(repoRoot, homePath, harness.baseUrl);

  let exitCode = await runCli([
    "agent",
    "create",
    "--setup-api-key",
    harness.operatorApiKey,
    "--base-url",
    harness.baseUrl,
    "--agent-id",
    "agt_builder",
    "--name",
    "Builder",
    "--runner",
    "codex",
    "--scopes",
    "tasks:read,tasks:write",
    "--repo-allowlist",
    "oxnw/agentrail",
    "--capability-tags",
    "code,tests,api",
    "--set-default-env",
  ], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout: createMemoryWriter(),
    stderr: createMemoryWriter(),
  });
  assert.equal(exitCode, 0);

  const envPath = path.join(homePath, "agents", "agt_builder.env");
  const originalEnv = parseEnv(await readFile(envPath, "utf8"));

  exitCode = await runCli([
    "agent",
    "update",
    "--setup-api-key",
    harness.operatorApiKey,
    "--base-url",
    harness.baseUrl,
    "--agent-id",
    "agt_builder",
    "--env-file",
    path.relative(repoRoot, envPath),
    "--name",
    "Builder Updated",
    "--scopes",
    "tasks:read,ship:write",
    "--configure-routing",
    "--routing-labels",
    "frontend",
  ], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.match(stdout.toString(), /Updated agent agt_builder/);

  const updatedEnv = parseEnv(await readFile(envPath, "utf8"));
  assert.notEqual(updatedEnv.AGENTRAIL_API_KEY_ID, originalEnv.AGENTRAIL_API_KEY_ID);
  assert.notEqual(updatedEnv.AGENTRAIL_API_KEY, originalEnv.AGENTRAIL_API_KEY);

  const usage = await getJson(harness.baseUrl, `/agent-api-keys/${updatedEnv.AGENTRAIL_API_KEY_ID}/usage`, harness.operatorApiKey);
  assert.equal(usage.status, 200);
  assert.deepEqual(usage.json.data.scopes, ["ship:write", "tasks:read"]);
  assert.equal(usage.json.data.agent.displayName, "Builder Updated");

  const oldUsage = await getJson(harness.baseUrl, `/agent-api-keys/${originalEnv.AGENTRAIL_API_KEY_ID}/usage`, harness.operatorApiKey);
  assert.equal(oldUsage.status, 200);
  assert.equal(oldUsage.json.data.status, "rotated");

  const ruleSet = await getJson(harness.baseUrl, "/operator/routing/rule-sets/current", harness.operatorApiKey);
  assert.equal(ruleSet.status, 200);
  assert.deepEqual(ruleSet.json.data.rules[0].conditions.labelsAny, ["frontend"]);

  const aliasEnv = await readFile(path.join(homePath, "agent.env"), "utf8");
  assert.equal(aliasEnv, await readFile(envPath, "utf8"));
});

test("agent update replays the same rotation request and later accepts a different update", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-update-replay-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const harness = await createHarness();
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = homePath;

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
    else process.env.AGENTRAIL_HOME = previousHome;
    await harness.close();
  });

  await writeSetupRepo(repoRoot, homePath, harness.baseUrl);

  let exitCode = await runCli([
    "agent",
    "create",
    "--setup-api-key",
    harness.operatorApiKey,
    "--base-url",
    harness.baseUrl,
    "--agent-id",
    "agt_builder",
    "--name",
    "Builder",
    "--runner",
    "codex",
    "--scopes",
    "tasks:read,tasks:write",
    "--repo-allowlist",
    "oxnw/agentrail",
    "--capability-tags",
    "code,tests,api",
    "--set-default-env",
  ], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout: createMemoryWriter(),
    stderr: createMemoryWriter(),
  });
  assert.equal(exitCode, 0);

  const envPath = path.join(homePath, "agents", "agt_builder.env");
  const originalEnv = parseEnv(await readFile(envPath, "utf8"));

  exitCode = await runCli([
    "agent",
    "update",
    "--setup-api-key",
    harness.operatorApiKey,
    "--base-url",
    harness.baseUrl,
    "--agent-id",
    "agt_builder",
    "--api-key-id",
    originalEnv.AGENTRAIL_API_KEY_ID,
    "--env-file",
    path.relative(repoRoot, envPath),
    "--name",
    "Builder Updated",
    "--scopes",
    "tasks:read,ship:write",
  ], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout: createMemoryWriter(),
    stderr: createMemoryWriter(),
  });
  assert.equal(exitCode, 0);

  const firstUpdatedEnv = parseEnv(await readFile(envPath, "utf8"));

  exitCode = await runCli([
    "agent",
    "update",
    "--setup-api-key",
    harness.operatorApiKey,
    "--base-url",
    harness.baseUrl,
    "--agent-id",
    "agt_builder",
    "--api-key-id",
    originalEnv.AGENTRAIL_API_KEY_ID,
    "--env-file",
    path.relative(repoRoot, envPath),
    "--name",
    "Builder Updated",
    "--scopes",
    "tasks:read,ship:write",
  ], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout: createMemoryWriter(),
    stderr: createMemoryWriter(),
  });
  assert.equal(exitCode, 0);

  const replayedEnv = parseEnv(await readFile(envPath, "utf8"));
  assert.equal(replayedEnv.AGENTRAIL_API_KEY_ID, firstUpdatedEnv.AGENTRAIL_API_KEY_ID);
  assert.equal(replayedEnv.AGENTRAIL_API_KEY, firstUpdatedEnv.AGENTRAIL_API_KEY);

  exitCode = await runCli([
    "agent",
    "update",
    "--setup-api-key",
    harness.operatorApiKey,
    "--base-url",
    harness.baseUrl,
    "--agent-id",
    "agt_builder",
    "--env-file",
    path.relative(repoRoot, envPath),
    "--name",
    "Builder Final",
    "--scopes",
    "tasks:read,tasks:write",
  ], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout: createMemoryWriter(),
    stderr: createMemoryWriter(),
  });
  assert.equal(exitCode, 0);

  const finalEnv = parseEnv(await readFile(envPath, "utf8"));
  assert.notEqual(finalEnv.AGENTRAIL_API_KEY_ID, firstUpdatedEnv.AGENTRAIL_API_KEY_ID);
});

test("agent create does not write env files when verification fails after key creation", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-agent-create-failure-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const harness = await createHarness();
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = homePath;

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
    else process.env.AGENTRAIL_HOME = previousHome;
    await harness.close();
  });

  await writeSetupRepo(repoRoot, homePath, harness.baseUrl);

  const exitCode = await runCli([
    "agent",
    "create",
    "--setup-api-key",
    harness.operatorApiKey,
    "--base-url",
    harness.baseUrl,
    "--agent-id",
    "agt_builder",
    "--name",
    "Builder",
    "--runner",
    "codex",
    "--scopes",
    "ship:write",
    "--repo-allowlist",
    "oxnw/agentrail",
    "--capability-tags",
    "code,tests,api",
  ], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 1);
  await assert.rejects(readFile(path.join(homePath, "agents", "agt_builder.env"), "utf8"));
  await assert.rejects(readFile(path.join(homePath, "agent.env"), "utf8"));
  assert.match(stderr.toString(), /Create partially succeeded on the server\./);
  assert.match(stderr.toString(), /apiKeyId: akey_/);
});

async function createHarness() {
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
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing server address.");
  }
  const baseUrl = `http://${address.address}:${address.port}`;
  const operatorApiKey = await bootstrapOperator(baseUrl);

  return {
    baseUrl,
    operatorApiKey,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function bootstrapOperator(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/agent-api-keys`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "bootstrap-agent-management-operator",
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
  const text = await response.text();
  assert.equal(response.status, 201, `Bootstrap failed: ${response.status} ${response.statusText}\n${text}`);
  const json = JSON.parse(text);
  return json.data.apiKey as string;
}

async function writeSetupRepo(repoRoot: string, homePath: string, baseUrl: string, operatorApiKey?: string): Promise<void> {
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
    baseUrl,
    providerMode: "disabled",
  });
  await writeSetupFiles({
    homePath,
    config,
  });
  if (operatorApiKey) {
    await writeFile(path.join(homePath, "operator.env"), [
      `AGENTRAIL_BASE_URL=${baseUrl}`,
      `AGENTRAIL_OPERATOR_KEY=${operatorApiKey}`,
      "AGENTRAIL_OPERATOR_KEY_ID=akey_operator_test",
      "",
    ].join("\n"), { mode: 0o600 });
  }
}

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

class ScriptedPromptSession implements PromptSession {
  readonly notes: Array<{ title?: string; body: string }> = [];
  readonly messages: string[] = [];
  readonly #steps: Array<{ kind: "select" | "multiselect" | "confirm" | "input" | "secret"; value: string | boolean | string[] }>;

  constructor(steps: Array<{ kind: "select" | "multiselect" | "confirm" | "input" | "secret"; value: string | boolean | string[] }>) {
    this.#steps = [...steps];
  }

  async select(options: { message: string; choices: PromptChoice[]; defaultValue?: string }): Promise<string> {
    const step = this.#next("select");
    const allowed = new Set(options.choices.map((choice) => choice.value));
    assert.ok(allowed.has(String(step.value)));
    return String(step.value);
  }

  async multiselect(options: { message: string; choices: PromptChoice[]; defaultValues?: string[]; required?: boolean }): Promise<string[]> {
    const step = this.#next("multiselect");
    const values = Array.isArray(step.value) ? step.value.map(String) : [];
    const allowed = new Set(options.choices.map((choice) => choice.value));
    values.forEach((value) => assert.ok(allowed.has(value)));
    return values;
  }

  async confirm(): Promise<boolean> {
    const step = this.#next("confirm");
    return Boolean(step.value);
  }

  async input(): Promise<string> {
    const step = this.#next("input");
    return String(step.value);
  }

  async secret(): Promise<string> {
    const step = this.#next("secret");
    return String(step.value);
  }

  spinner() {
    return {
      start() {},
      stop() {},
      error() {},
    };
  }

  async note(options: { title?: string; body: string }): Promise<void> {
    this.notes.push(options);
  }

  async message(body: string): Promise<void> {
    this.messages.push(body);
  }

  async close(): Promise<void> {
    assert.equal(this.#steps.length, 0);
  }

  #next(kind: "select" | "multiselect" | "confirm" | "input" | "secret") {
    const step = this.#steps.shift();
    assert.ok(step, `expected ${kind} prompt step`);
    assert.equal(step.kind, kind);
    return step;
  }
}

async function getJson<T = any>(baseUrl: string, route: string, apiKey: string): Promise<{ status: number; json: T | null }> {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
    },
  });
  const text = await response.text();
  let json: T | null;
  try {
    json = text ? JSON.parse(text) as T : null;
  } catch {
    throw new Error(`Expected JSON from ${route}, got ${response.status}: ${text.slice(0, 200)}`);
  }
  return {
    status: response.status,
    json,
  };
}

function parseEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/u)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}
