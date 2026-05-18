import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { runCli } from "../src/cli/index.ts";
import { createSetupConfig, type DetectedRepoContext } from "../src/cli/setup-config.ts";
import { writeSetupFiles } from "../src/cli/setup-files.ts";

const detectedRepo: DetectedRepoContext = {
  repoPath: "",
  remoteSlug: "oxnw/agentrail",
  defaultBranch: "main",
  gitIgnoreHasAgentrail: true,
};

test("provider connect github writes provider.env and updates config", async (t) => {
  const { repoRoot, homePath } = await setupProviderTest(t, {
    GITHUB_TOKEN: "ghp_test_provider_token",
  });
  const fetch = createFetchStub([
    {
      ok: true,
      status: 200,
      json: { login: "octocat" },
    },
    {
      ok: true,
      status: 200,
      json: { login: "octocat" },
    },
    {
      ok: true,
      status: 200,
      json: { full_name: "oxnw/agentrail" },
    },
    {
      ok: true,
      status: 200,
      json: { workflows: [{ id: 1, state: "active", path: ".github/workflows/ci.yml" }] },
    },
  ]);

  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const exitCode = await runCli(["provider", "connect", "github"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
    providerFetch: fetch as any,
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.match(stdout.toString(), /^\u2713 Connected GitHub using GITHUB_TOKEN in polling mode\.\n$/);
  assert.doesNotMatch(stdout.toString(), /Run `agentrail provider test github`/);
  assert.equal(fetch.calls.length, 4);
  assert.equal(fetch.calls[0]?.url, "https://api.github.com/user");
  assert.equal(fetch.calls[3]?.url, "https://api.github.com/repos/oxnw/agentrail/actions/workflows");
  assert.equal(fetch.calls[0]?.headers.authorization, "Bearer ghp_test_provider_token");

  const providerEnv = await readFile(path.join(homePath, "provider.env"), "utf8");
  assert.match(providerEnv, /GITHUB_TOKEN="ghp_test_provider_token"/);

  const nextConfig = JSON.parse(await readFile(path.join(homePath, "config.json"), "utf8"));
  assert.equal(nextConfig.providers.github.mode, "real");
  assert.equal(nextConfig.providers.github.tokenEnv, "GITHUB_TOKEN");
});

test("provider connect github in webhook mode registers repo hooks before writing success config", async (t) => {
  const { repoRoot, homePath } = await setupProviderTest(t, {
    GITHUB_TOKEN: "ghp_webhook_provider_token",
    GITHUB_WEBHOOK_SECRET: "github_webhook_secret",
  }, { baseUrl: "https://agentrail.example.com" });
  const fetch = createFetchStub([
    {
      ok: true,
      status: 200,
      json: { login: "octocat" },
    },
    {
      ok: true,
      status: 200,
      json: [],
    },
    {
      ok: true,
      status: 201,
      json: {
        id: 9001,
        active: true,
        events: ["issues", "workflow_run", "pull_request_review"],
        config: { url: "https://agentrail.example.com/providers/github/webhooks" },
      },
    },
    {
      ok: true,
      status: 200,
      json: { login: "octocat" },
    },
    {
      ok: true,
      status: 200,
      json: { full_name: "oxnw/agentrail" },
    },
    {
      ok: true,
      status: 200,
      json: { workflows: [{ id: 1, state: "active", path: ".github/workflows/ci.yml" }] },
    },
  ]);

  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const exitCode = await runCli(["provider", "connect", "github", "--delivery-mode", "webhook"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
    providerFetch: fetch as any,
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.match(stdout.toString(), /^\u2713 Connected GitHub using GITHUB_TOKEN in webhook mode\.\n$/);
  assert.equal(fetch.calls.length, 6);
  assert.equal(fetch.calls[0]?.url, "https://api.github.com/user");
  assert.equal(fetch.calls[1]?.url, "https://api.github.com/repos/oxnw/agentrail/hooks?per_page=100");
  assert.equal(fetch.calls[1]?.method, "GET");
  assert.equal(fetch.calls[2]?.url, "https://api.github.com/repos/oxnw/agentrail/hooks");
  assert.equal(fetch.calls[2]?.method, "POST");
  assert.deepEqual(JSON.parse(fetch.calls[2]?.body ?? "{}"), {
    name: "web",
    active: true,
    events: ["issues", "workflow_run", "pull_request_review"],
    config: {
      url: "https://agentrail.example.com/providers/github/webhooks",
      content_type: "json",
      secret: "github_webhook_secret",
      insecure_ssl: "0",
    },
  });

  const nextConfig = JSON.parse(await readFile(path.join(homePath, "config.json"), "utf8"));
  assert.equal(nextConfig.providers.github.deliveryMode, "webhook");
  assert.deepEqual(nextConfig.providers.github.registeredWebhooks, [
    {
      repoSlug: "oxnw/agentrail",
      hookId: 9001,
      url: "https://agentrail.example.com/providers/github/webhooks",
      events: ["issues", "workflow_run", "pull_request_review"],
      active: true,
    },
  ]);
});

test("provider connect github interactively prompts for a masked token", async (t) => {
  const { repoRoot, homePath } = await setupProviderTest(t);
  const fetch = createFetchStub([
    {
      ok: true,
      status: 200,
      json: { login: "octocat" },
    },
    {
      ok: true,
      status: 200,
      json: { login: "octocat" },
    },
    {
      ok: true,
      status: 200,
      json: { full_name: "oxnw/agentrail" },
    },
    {
      ok: true,
      status: 200,
      json: { workflows: [{ id: 1, state: "active", path: ".github/workflows/ci.yml" }] },
    },
  ]);
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const prompt = new ScriptedPromptSession([
    { kind: "select", value: "polling" },
    { kind: "secret", value: "ghp_interactive_provider_token" },
    { kind: "select", value: "60000" },
  ]);

  const exitCode = await runCli(["provider", "connect", "github"], {
    cwd: repoRoot,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stdout,
    stderr,
    createPrompt: () => prompt as any,
    providerFetch: fetch as any,
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.equal(stdout.toString(), "");
  assert.equal(stderr.toString(), "");
  assert.deepEqual(prompt.calls, ["select", "note", "secret", "select", "spinner", "close"]);
  assert.match(prompt.notes[0]?.body ?? "", /Personal Access Token/);
  assert.deepEqual(prompt.selectMessages, [
    "How do you want to receive GitHub events?",
    "How often should AgentRail poll GitHub for issue and CI updates?",
  ]);
  assert.equal(prompt.secretMessages[0], "Paste your GitHub Personal Access Token (GITHUB_TOKEN)");
  assert.deepEqual(prompt.spinnerEvents, [
    { kind: "start", message: "Testing GitHub connection" },
    { kind: "stop", message: "\u2713 Connected GitHub using GITHUB_TOKEN in polling mode." },
  ]);
  assert.equal(fetch.calls.length, 4);
  assert.equal(fetch.calls[0]?.headers.authorization, "Bearer ghp_interactive_provider_token");

  const providerEnv = await readFile(path.join(homePath, "provider.env"), "utf8");
  assert.match(providerEnv, /GITHUB_TOKEN="ghp_interactive_provider_token"/);

  const nextConfig = JSON.parse(await readFile(path.join(homePath, "config.json"), "utf8"));
  assert.equal(nextConfig.providers.github.mode, "real");
  assert.equal(nextConfig.providers.github.tokenEnv, "GITHUB_TOKEN");
});

test("provider connect circleci interactively asks for pasted token and webhook secret", async (t) => {
  const { repoRoot, homePath } = await setupProviderTest(t, {}, { baseUrl: "https://agentrail.example.com" });
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const fetch = createFetchStub([
    {
      ok: true,
      status: 200,
      json: { items: [] },
    },
    {
      ok: true,
      status: 200,
      json: { items: [] },
    },
  ]);
  const prompt = new ScriptedPromptSession([
    { kind: "select", value: "webhook" },
    { kind: "secret", value: "circleci_interactive_token" },
    { kind: "secret", value: "circleci_interactive_webhook_secret" },
    { kind: "input", value: "circleci/PquHykoWvRFZ8YUqRFv8Ae/NMPTTkVpcJUhKtTusWTrj1" },
  ]);

  const exitCode = await runCli(["provider", "connect", "circleci"], {
    cwd: repoRoot,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stdout,
    stderr,
    createPrompt: () => prompt as any,
    providerFetch: fetch as any,
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.equal(stdout.toString(), "");
  assert.doesNotMatch(stdout.toString(), /Run `agentrail provider test circleci`/);
  assert.equal(stderr.toString(), "");
  assert.deepEqual(prompt.calls, ["select", "note", "secret", "secret", "input", "spinner", "close"]);
  assert.deepEqual(prompt.selectMessages, ["How do you want to receive CircleCI events?"]);
  assert.match(prompt.notes[0]?.body ?? "", /project slug/i);
  assert.deepEqual(prompt.secretMessages, [
    "Paste your CircleCI token (CIRCLECI_TOKEN)",
    "Paste your CircleCI webhook secret (CIRCLECI_WEBHOOK_SECRET)",
  ]);
  assert.deepEqual(prompt.spinnerEvents, [
    { kind: "start", message: "Testing CircleCI connection" },
    { kind: "stop", message: "\u2713 Connected CircleCI using CIRCLECI_TOKEN, CIRCLECI_WEBHOOK_SECRET, and project slug in webhook mode." },
  ]);
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[0]?.url, "https://circleci.com/api/v2/project/circleci/PquHykoWvRFZ8YUqRFv8Ae/NMPTTkVpcJUhKtTusWTrj1/pipeline?branch=main");
  assert.equal(fetch.calls[0]?.headers["Circle-Token"], "circleci_interactive_token");

  const providerEnv = await readFile(path.join(homePath, "provider.env"), "utf8");
  assert.match(providerEnv, /CIRCLECI_TOKEN="circleci_interactive_token"/);
  assert.match(providerEnv, /CIRCLECI_WEBHOOK_SECRET="circleci_interactive_webhook_secret"/);

  const nextConfig = JSON.parse(await readFile(path.join(homePath, "config.json"), "utf8"));
  assert.equal(nextConfig.providers.circleci.mode, "real");
  assert.equal(nextConfig.providers.circleci.tokenEnv, "CIRCLECI_TOKEN");
  assert.equal(nextConfig.providers.circleci.webhookSecretEnv, "CIRCLECI_WEBHOOK_SECRET");
  assert.equal(nextConfig.repos[0].circleciProjectSlug, "circleci/PquHykoWvRFZ8YUqRFv8Ae/NMPTTkVpcJUhKtTusWTrj1");
});

test("provider test circleci fails clearly when no project slug is stored", async (t) => {
  const { repoRoot, homePath } = await setupProviderTest(t, {
    CIRCLECI_TOKEN: "circleci_test_token",
  });
  const configPath = path.join(homePath, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.providers.circleci = {
    mode: "real",
    tokenEnv: "CIRCLECI_TOKEN",
    deliveryMode: "polling",
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const exitCode = await runCli(["provider", "test", "circleci"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /no CircleCI project slug is stored/i);
});

test("provider test circleci validates the configured project slug", async (t) => {
  const { repoRoot, homePath } = await setupProviderTest(t, {
    CIRCLECI_TOKEN: "circleci_test_token",
  });
  const configPath = path.join(homePath, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.providers.circleci = {
    mode: "real",
    tokenEnv: "CIRCLECI_TOKEN",
    deliveryMode: "polling",
  };
  config.repos[0].circleciProjectSlug = "circleci/PquHykoWvRFZ8YUqRFv8Ae/NMPTTkVpcJUhKtTusWTrj1";
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const fetch = createFetchStub([
    {
      ok: true,
      status: 200,
      json: { items: [] },
    },
  ]);
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const exitCode = await runCli(["provider", "test", "circleci"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
    providerFetch: fetch as any,
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.match(stdout.toString(), /CircleCI connection test passed/i);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0]?.url, "https://circleci.com/api/v2/project/circleci/PquHykoWvRFZ8YUqRFv8Ae/NMPTTkVpcJUhKtTusWTrj1/pipeline?branch=main");
  assert.equal(fetch.calls[0]?.headers["Circle-Token"], "circleci_test_token");
});

test("provider doctor github reports missing workflow readiness", async (t) => {
  const { repoRoot, homePath } = await setupProviderTest(t, {
    GITHUB_TOKEN: "ghp_test_provider_token",
  });
  await rm(path.join(repoRoot, ".github"), { recursive: true, force: true });
  const configPath = path.join(homePath, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.providers.github = {
    mode: "real",
    tokenEnv: "GITHUB_TOKEN",
    deliveryMode: "polling",
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const fetch = createFetchStub([
    { ok: true, status: 200, json: { login: "octocat" } },
    { ok: true, status: 200, json: { full_name: "oxnw/agentrail" } },
    { ok: true, status: 200, json: { workflows: [] } },
  ]);

  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const exitCode = await runCli(["provider", "doctor", "github"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
    providerFetch: fetch as any,
  });

  assert.equal(exitCode, 1);
  assert.equal(stderr.toString(), "");
  assert.match(stdout.toString(), /GitHub readiness: blocked/u);
  assert.match(stdout.toString(), /No workflow files were found under `.github\/workflows`/u);
});

test("provider connect github creates a starter workflow for a Node repo when readiness needs it", async (t) => {
  const { repoRoot, homePath } = await setupProviderTest(t, {
    GITHUB_TOKEN: "ghp_test_provider_token",
  });
  await rm(path.join(repoRoot, ".github"), { recursive: true, force: true });
  await writeFile(path.join(repoRoot, "package.json"), JSON.stringify({
    name: "provider-ready-repo",
    private: true,
    scripts: {
      typecheck: "tsc --noEmit",
      test: "node --test",
    },
  }, null, 2));
  const configPath = path.join(homePath, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.providers.github = {
    mode: "real",
    tokenEnv: "GITHUB_TOKEN",
    deliveryMode: "polling",
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const fetch = createFetchStub([
    { ok: true, status: 200, json: { login: "octocat" } },
    { ok: true, status: 200, json: { login: "octocat" } },
    { ok: true, status: 200, json: { full_name: "oxnw/agentrail" } },
    { ok: true, status: 200, json: { workflows: [] } },
    { ok: true, status: 200, json: { login: "octocat" } },
    { ok: true, status: 200, json: { full_name: "oxnw/agentrail" } },
    { ok: true, status: 200, json: { workflows: [{ id: 1, state: "active", path: ".github/workflows/agentrail-ci.yml" }] } },
  ]);

  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const exitCode = await runCli(["provider", "connect", "github"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
    providerFetch: fetch as any,
  });

  assert.equal(exitCode, 0, stderr.toString());
  const workflowPath = path.join(repoRoot, ".github", "workflows", "agentrail-ci.yml");
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /pull_request:/u);
  assert.match(workflow, /npm run typecheck/u);
  assert.match(stdout.toString(), /Applied: oxnw\/agentrail: created \.github\/workflows\/agentrail-ci\.yml/u);
  assert.match(stdout.toString(), /GitHub: ready/u);
});

test("provider connect circleci creates a starter config for a Node repo when readiness needs it", async (t) => {
  const { repoRoot, homePath } = await setupProviderTest(t, {
    CIRCLECI_TOKEN: "circleci_test_token",
  });
  await rm(path.join(repoRoot, ".circleci"), { recursive: true, force: true });
  await writeFile(path.join(repoRoot, "package.json"), JSON.stringify({
    name: "provider-ready-repo",
    private: true,
    scripts: {
      test: "node --test",
    },
  }, null, 2));
  const configPath = path.join(homePath, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.providers.circleci = {
    mode: "real",
    tokenEnv: "CIRCLECI_TOKEN",
    deliveryMode: "polling",
  };
  config.repos[0].circleciProjectSlug = "circleci/PquHykoWvRFZ8YUqRFv8Ae/NMPTTkVpcJUhKtTusWTrj1";
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const fetch = createFetchStub([
    { ok: true, status: 200, json: { items: [] } },
    { ok: true, status: 200, json: { items: [] } },
    { ok: true, status: 200, json: { items: [] } },
  ]);

  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const exitCode = await runCli(["provider", "connect", "circleci", "--project-slug", "circleci/PquHykoWvRFZ8YUqRFv8Ae/NMPTTkVpcJUhKtTusWTrj1"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
    providerFetch: fetch as any,
  });

  assert.equal(exitCode, 0, stderr.toString());
  const configFile = await readFile(path.join(repoRoot, ".circleci", "config.yml"), "utf8");
  assert.match(configFile, /version: 2\.1/u);
  assert.match(configFile, /npm test/u);
  assert.match(stdout.toString(), /Applied: oxnw\/agentrail: created \.circleci\/config\.yml/u);
  assert.match(stdout.toString(), /CircleCI: ready/u);
});

test("provider connect linear validates the API key, writes provider.env, and updates config", async (t) => {
  const { repoRoot, homePath } = await setupProviderTest(t);
  const fetch = createFetchStub([
    {
      ok: true,
      status: 200,
      json: {
        data: {
          viewer: { id: "lin_user_1", name: "Maya Reviewer" },
        },
      },
    },
    {
      ok: true,
      status: 200,
      json: {
        data: {
          viewer: { id: "lin_user_1", name: "Maya Reviewer" },
          teams: { nodes: [{ id: "team_1", key: "ENG", name: "Engineering" }] },
        },
      },
    },
  ]);
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const prompt = new ScriptedPromptSession([
    { kind: "select", value: "polling" },
    { kind: "secret", value: "lin_api_key_interactive" },
    { kind: "select", value: "300000" },
  ]);

  const exitCode = await runCli(["provider", "connect", "linear"], {
    cwd: repoRoot,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stdout,
    stderr,
    createPrompt: () => prompt as any,
    providerFetch: fetch as any,
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.equal(stdout.toString(), "");
  assert.equal(stderr.toString(), "");
  assert.deepEqual(prompt.calls, ["select", "note", "secret", "select", "spinner", "close"]);
  assert.deepEqual(prompt.selectMessages, [
    "How do you want to receive Linear events?",
    "How often should AgentRail poll Linear for issue updates?",
  ]);
  assert.match(prompt.notes[0]?.body ?? "", /Connect Linear so AgentRail can import issues and keep them in sync/i);
  assert.deepEqual(prompt.secretMessages, ["Paste your Linear API key (LINEAR_API_KEY)"]);
  assert.deepEqual(prompt.spinnerEvents, [
    { kind: "start", message: "Testing Linear connection" },
    {
      kind: "stop",
      message: "\u2713 Connected Linear using LINEAR_API_KEY in polling mode. Start AgentRail to discover and refresh issues automatically, or run `agentrail linear import ENG-123` to import one now.",
    },
  ]);
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[0]?.url, "https://api.linear.app/graphql");
  assert.equal(fetch.calls[0]?.headers.authorization, "lin_api_key_interactive");

  const providerEnv = await readFile(path.join(homePath, "provider.env"), "utf8");
  assert.match(providerEnv, /LINEAR_API_KEY="lin_api_key_interactive"/);
  assert.doesNotMatch(providerEnv, /LINEAR_WEBHOOK_SECRET=/);

  const nextConfig = JSON.parse(await readFile(path.join(homePath, "config.json"), "utf8"));
  assert.equal(nextConfig.providers.linear.mode, "real");
  assert.equal(nextConfig.providers.linear.tokenEnv, "LINEAR_API_KEY");
  assert.equal(nextConfig.providers.linear.deliveryMode, "polling");
  assert.equal(nextConfig.providers.linear.pollIntervalMs, 300000);
});

test("provider connect github fails when GitHub rejects the token", async (t) => {
  const { repoRoot, homePath } = await setupProviderTest(t, {
    GITHUB_TOKEN: "ghp_bad_provider_token",
  });
  const fetch = createFetchStub([
    {
      ok: false,
      status: 401,
      text: "Bad credentials",
    },
  ]);
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();

  const exitCode = await runCli(["provider", "connect", "github"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
    providerFetch: fetch as any,
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /GitHub connection test failed: GitHub rejected the token\./);
  await assert.rejects(readFile(path.join(homePath, "provider.env"), "utf8"));
});

test("provider connect emits deprecation warnings for --sync-mode via injected stderr", async (t) => {
  const { repoRoot, homePath } = await setupProviderTest(t, {
    GITHUB_TOKEN: "ghp_sync_mode_token",
  });
  const fetch = createFetchStub([
    {
      ok: true,
      status: 200,
      json: { login: "octocat" },
    },
    {
      ok: true,
      status: 200,
      json: { login: "octocat" },
    },
    {
      ok: true,
      status: 200,
      json: { full_name: "oxnw/agentrail" },
    },
    {
      ok: true,
      status: 200,
      json: { workflows: [{ id: 1, state: "active", path: ".github/workflows/ci.yml" }] },
    },
  ]);
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();

  const exitCode = await runCli(["provider", "connect", "github", "--sync-mode", "polling"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
    providerFetch: fetch as any,
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.match(stderr.toString(), /--sync-mode is deprecated/u);
  const providerEnv = await readFile(path.join(homePath, "provider.env"), "utf8");
  assert.match(providerEnv, /GITHUB_TOKEN="ghp_sync_mode_token"/);
});

test("provider test github fails clearly when not connected", async (t) => {
  const { repoRoot } = await setupProviderTest(t);

  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const exitCode = await runCli(["provider", "test", "github"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 1, stderr.toString());
  assert.match(stderr.toString(), /GitHub is not connected yet/);
});

test("provider test github in webhook mode fails when no registered hook metadata is configured", async (t) => {
  const { repoRoot, homePath } = await setupProviderTest(t, {
    GITHUB_TOKEN: "ghp_test_provider_token",
    GITHUB_WEBHOOK_SECRET: "github_webhook_secret",
  }, { baseUrl: "https://agentrail.example.com" });
  const configPath = path.join(homePath, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.providers.github = {
    mode: "real",
    tokenEnv: "GITHUB_TOKEN",
    deliveryMode: "webhook",
    webhookSecretEnv: "GITHUB_WEBHOOK_SECRET",
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const fetch = createFetchStub([]);
  const exitCode = await runCli(["provider", "test", "github"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
    providerFetch: fetch as any,
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /GitHub webhook mode is configured, but no registered GitHub webhook metadata exists/);
  assert.equal(fetch.calls.length, 0);
});

test("provider list shows registered GitHub webhook status and events", async (t) => {
  const { repoRoot, homePath } = await setupProviderTest(t, {
    GITHUB_TOKEN: "ghp_test_provider_token",
    GITHUB_WEBHOOK_SECRET: "github_webhook_secret",
  }, { baseUrl: "https://agentrail.example.com" });
  const configPath = path.join(homePath, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.providers.github = {
    mode: "real",
    tokenEnv: "GITHUB_TOKEN",
    deliveryMode: "webhook",
    webhookSecretEnv: "GITHUB_WEBHOOK_SECRET",
    registeredWebhooks: [{
      repoSlug: "oxnw/agentrail",
      hookId: 42,
      url: "https://agentrail.example.com/providers/github/webhooks",
      events: ["issues", "workflow_run", "pull_request_review"],
      active: true,
    }],
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const exitCode = await runCli(["provider", "list"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.match(stdout.toString(), /registered webhooks: 1/u);
  assert.match(stdout.toString(), /oxnw\/agentrail: hook 42 active events=issues,workflow_run,pull_request_review -> https:\/\/agentrail\.example\.com\/providers\/github\/webhooks/u);
});

test("provider test github in webhook mode verifies stored hook status and events", async (t) => {
  const { repoRoot, homePath } = await setupProviderTest(t, {
    GITHUB_TOKEN: "ghp_test_provider_token",
    GITHUB_WEBHOOK_SECRET: "github_webhook_secret",
  }, { baseUrl: "https://agentrail.example.com" });
  const configPath = path.join(homePath, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.providers.github = {
    mode: "real",
    tokenEnv: "GITHUB_TOKEN",
    deliveryMode: "webhook",
    webhookSecretEnv: "GITHUB_WEBHOOK_SECRET",
    registeredWebhooks: [{
      repoSlug: "oxnw/agentrail",
      hookId: 42,
      url: "https://agentrail.example.com/providers/github/webhooks",
      events: ["issues", "workflow_run", "pull_request_review"],
      active: true,
    }],
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const fetch = createFetchStub([
    {
      ok: true,
      status: 200,
      json: { login: "octocat" },
    },
    {
      ok: true,
      status: 200,
      json: { full_name: "oxnw/agentrail" },
    },
    {
      ok: true,
      status: 200,
      json: [{
        id: 42,
        active: true,
        events: ["issues", "workflow_run", "pull_request_review"],
        config: { url: "https://agentrail.example.com/providers/github/webhooks" },
      }],
    },
  ]);
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const exitCode = await runCli(["provider", "test", "github"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
    providerFetch: fetch as any,
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.match(stdout.toString(), /GitHub connection test passed/u);
  assert.equal(fetch.calls.length, 3);
  assert.equal(fetch.calls[2]?.url, "https://api.github.com/repos/oxnw/agentrail/hooks?per_page=100");
});

test("provider test github in webhook mode requires stored hooks for every configured repo", async (t) => {
  const { repoRoot, homePath } = await setupProviderTest(t, {
    GITHUB_TOKEN: "ghp_test_provider_token",
    GITHUB_WEBHOOK_SECRET: "github_webhook_secret",
  }, { baseUrl: "https://agentrail.example.com" });
  const configPath = path.join(homePath, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.repos = [
    ...config.repos,
    {
      path: path.join(repoRoot, "benchmark"),
      slug: "oxnw/agentrail-benchmark",
      defaultBranch: "main",
    },
  ];
  config.providers.github = {
    mode: "real",
    tokenEnv: "GITHUB_TOKEN",
    deliveryMode: "webhook",
    webhookSecretEnv: "GITHUB_WEBHOOK_SECRET",
    registeredWebhooks: [{
      repoSlug: "oxnw/agentrail",
      hookId: 42,
      url: "https://agentrail.example.com/providers/github/webhooks",
      events: ["issues", "workflow_run", "pull_request_review"],
      active: true,
    }],
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const fetch = createFetchStub([
    {
      ok: true,
      status: 200,
      json: { login: "octocat" },
    },
    {
      ok: true,
      status: 200,
      json: { full_name: "oxnw/agentrail" },
    },
    {
      ok: true,
      status: 200,
      json: { full_name: "oxnw/agentrail-benchmark" },
    },
    {
      ok: true,
      status: 200,
      json: [{
        id: 42,
        active: true,
        events: ["issues", "workflow_run", "pull_request_review"],
        config: { url: "https://agentrail.example.com/providers/github/webhooks" },
      }],
    },
  ]);
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const exitCode = await runCli(["provider", "test", "github"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
    providerFetch: fetch as any,
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /missing registered GitHub webhook metadata for configured repositories: oxnw\/agentrail-benchmark/u);
});

test("provider test github in webhook mode rejects stored hooks missing events", async (t) => {
  const { repoRoot, homePath } = await setupProviderTest(t, {
    GITHUB_TOKEN: "ghp_test_provider_token",
    GITHUB_WEBHOOK_SECRET: "github_webhook_secret",
  }, { baseUrl: "https://agentrail.example.com" });
  const configPath = path.join(homePath, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.providers.github = {
    mode: "real",
    tokenEnv: "GITHUB_TOKEN",
    deliveryMode: "webhook",
    webhookSecretEnv: "GITHUB_WEBHOOK_SECRET",
    registeredWebhooks: [{
      repoSlug: "oxnw/agentrail",
      hookId: 42,
      url: "https://agentrail.example.com/providers/github/webhooks",
      events: ["issues"],
      active: true,
    }],
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const fetch = createFetchStub([
    {
      ok: true,
      status: 200,
      json: { login: "octocat" },
    },
    {
      ok: true,
      status: 200,
      json: { full_name: "oxnw/agentrail" },
    },
    {
      ok: true,
      status: 200,
      json: [{
        id: 42,
        active: true,
        events: ["issues"],
        config: { url: "https://agentrail.example.com/providers/github/webhooks" },
      }],
    },
  ]);
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const exitCode = await runCli(["provider", "test", "github"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
    providerFetch: fetch as any,
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /missing events: workflow_run, pull_request_review/u);
});

test("provider test github validates token and configured repo access", async (t) => {
  const { repoRoot } = await setupProviderTest(t, {
    GITHUB_TOKEN: "ghp_test_provider_token",
  });
  const connectFetch = createFetchStub([
    {
      ok: true,
      status: 200,
      json: { login: "octocat" },
    },
    {
      ok: true,
      status: 200,
      json: { login: "octocat" },
    },
    {
      ok: true,
      status: 200,
      json: { full_name: "oxnw/agentrail" },
    },
    {
      ok: true,
      status: 200,
      json: { workflows: [{ id: 1, state: "active", path: ".github/workflows/ci.yml" }] },
    },
  ]);

  const connectStdout = createMemoryWriter();
  const connectStderr = createMemoryWriter();
  assert.equal(await runCli(["provider", "connect", "github"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout: connectStdout,
    stderr: connectStderr,
    providerFetch: connectFetch as any,
  }), 0, connectStderr.toString());

  const testFetch = createFetchStub([
    {
      ok: true,
      status: 200,
      json: { login: "octocat" },
    },
    {
      ok: true,
      status: 200,
      json: { full_name: "oxnw/agentrail" },
    },
  ]);
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();

  const exitCode = await runCli(["provider", "test", "github"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
    providerFetch: testFetch as any,
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.match(stdout.toString(), /GitHub connection test passed/);
  assert.equal(testFetch.calls.length, 2);
  assert.equal(testFetch.calls[0]?.url, "https://api.github.com/user");
  assert.equal(testFetch.calls[1]?.url, "https://api.github.com/repos/oxnw/agentrail");
  assert.equal(testFetch.calls[0]?.headers.authorization, "Bearer ghp_test_provider_token");
});

test("provider test github prefers provider.env over stale runtime env", async (t) => {
  const { repoRoot } = await setupProviderTest(t, {
    GITHUB_TOKEN: "ghp_good_provider_token",
  });
  const connectFetch = createFetchStub([
    {
      ok: true,
      status: 200,
      json: { login: "octocat" },
    },
    {
      ok: true,
      status: 200,
      json: { login: "octocat" },
    },
    {
      ok: true,
      status: 200,
      json: { full_name: "oxnw/agentrail" },
    },
    {
      ok: true,
      status: 200,
      json: { workflows: [{ id: 1, state: "active", path: ".github/workflows/ci.yml" }] },
    },
  ]);

  const connectStdout = createMemoryWriter();
  const connectStderr = createMemoryWriter();
  assert.equal(await runCli(["provider", "connect", "github"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout: connectStdout,
    stderr: connectStderr,
    providerFetch: connectFetch as any,
  }), 0, connectStderr.toString());

  process.env.GITHUB_TOKEN = "ghp_stale_runtime_token";
  const testFetch = createFetchStub([
    {
      ok: true,
      status: 200,
      json: { login: "octocat" },
    },
    {
      ok: true,
      status: 200,
      json: { full_name: "oxnw/agentrail" },
    },
  ]);
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();

  const exitCode = await runCli(["provider", "test", "github"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
    providerFetch: testFetch as any,
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.match(stdout.toString(), /GitHub connection test passed/);
  assert.equal(testFetch.calls[0]?.headers.authorization, "Bearer ghp_good_provider_token");
});

test("provider test github fails when token cannot access configured repo", async (t) => {
  const { repoRoot } = await setupProviderTest(t, {
    GITHUB_TOKEN: "ghp_no_repo_access_token",
  });
  const connectFetch = createFetchStub([
    {
      ok: true,
      status: 200,
      json: { login: "octocat" },
    },
    {
      ok: true,
      status: 200,
      json: { login: "octocat" },
    },
    {
      ok: true,
      status: 200,
      json: { full_name: "oxnw/agentrail" },
    },
    {
      ok: true,
      status: 200,
      json: { workflows: [{ id: 1, state: "active", path: ".github/workflows/ci.yml" }] },
    },
  ]);

  const connectStdout = createMemoryWriter();
  const connectStderr = createMemoryWriter();
  assert.equal(await runCli(["provider", "connect", "github"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout: connectStdout,
    stderr: connectStderr,
    providerFetch: connectFetch as any,
  }), 0, connectStderr.toString());

  const testFetch = createFetchStub([
    {
      ok: true,
      status: 200,
      json: { login: "octocat" },
    },
    {
      ok: false,
      status: 404,
      text: "Not found",
    },
  ]);
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();

  const exitCode = await runCli(["provider", "test", "github"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
    providerFetch: testFetch as any,
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /token cannot access oxnw\/agentrail/);
});

test("provider test linear fails clearly when not connected", async (t) => {
  const { repoRoot } = await setupProviderTest(t);

  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const exitCode = await runCli(["provider", "test", "linear"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 1, stderr.toString());
  assert.match(stderr.toString(), /Linear is not connected yet/);
});

async function setupProviderTest(
  t: { after(fn: () => unknown): void },
  env: Record<string, string> = {},
  options: { baseUrl?: string } = {},
): Promise<{ repoRoot: string; homePath: string }> {
  let repoRoot: string | undefined;
  let homePath: string | undefined;
  const previousHome = process.env.AGENTRAIL_HOME;
  const previousEnv = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );

  t.after(async () => {
    try {
      if (repoRoot) {
        await rm(repoRoot, { recursive: true, force: true });
      }
      if (homePath) {
        await rm(homePath, { recursive: true, force: true });
      }
    } finally {
      if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
      else process.env.AGENTRAIL_HOME = previousHome;
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-provider-repo-"));
  homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-provider-home-"));
  process.env.AGENTRAIL_HOME = homePath;
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }

  const config = createSetupConfig({
    cwd: repoRoot,
    detectedRepo: {
      ...detectedRepo,
      repoPath: repoRoot,
    },
    interactionMode: "non_interactive",
    acceptedDefaults: true,
    providerMode: "disabled",
    baseUrl: options.baseUrl,
  });
  await writeSetupFiles({ homePath, config });
  await writeFile(path.join(repoRoot, "package.json"), JSON.stringify({
    name: "provider-test-repo",
    private: true,
    scripts: {
      typecheck: "tsc --noEmit",
      test: "node --test",
    },
  }, null, 2));
  await mkdir(path.join(repoRoot, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(repoRoot, ".github", "workflows", "ci.yml"), [
    "name: CI",
    "",
    "on:",
    "  pull_request:",
    "  push:",
    "",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: npm ci",
    "      - run: npm test",
    "",
  ].join("\n"), "utf8");
  await mkdir(path.join(repoRoot, ".circleci"), { recursive: true });
  await writeFile(path.join(repoRoot, ".circleci", "config.yml"), [
    "version: 2.1",
    "",
    "jobs:",
    "  test:",
    "    docker:",
    "      - image: cimg/node:22.11",
    "    steps:",
    "      - checkout",
    "      - run: npm ci",
    "      - run: npm test",
    "",
    "workflows:",
    "  ci:",
    "    jobs:",
    "      - test",
    "",
  ].join("\n"), "utf8");
  return { repoRoot, homePath };
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

class ScriptedPromptSession {
  readonly calls: string[] = [];
  readonly notes: Array<{ title?: string; body: string }> = [];
  readonly messages: string[] = [];
  readonly secretMessages: string[] = [];
  readonly selectMessages: string[] = [];
  readonly spinnerEvents: Array<{ kind: "start" | "stop" | "error"; message?: string }> = [];
  readonly #steps: Array<{ kind: "input" | "secret" | "confirm" | "select"; value: string | boolean }>;

  constructor(steps: Array<{ kind: "input" | "secret" | "confirm" | "select"; value: string | boolean }>) {
    this.#steps = [...steps];
  }

  async note(options: { title?: string; body: string }): Promise<void> {
    this.calls.push("note");
    this.notes.push(options);
  }

  async message(body: string): Promise<void> {
    this.calls.push("message");
    this.messages.push(body);
  }

  async input(): Promise<string> {
    const step = this.#next("input");
    this.calls.push("input");
    return String(step.value);
  }

  async secret(options: { message?: string } = {}): Promise<string> {
    const step = this.#next("secret");
    this.calls.push("secret");
    this.secretMessages.push(options.message ?? "");
    return String(step.value);
  }

  async select(options: { message?: string; choices: Array<{ value: string }> }): Promise<string> {
    const step = this.#next("select");
    this.calls.push("select");
    this.selectMessages.push(options.message ?? "");
    assert.ok(
      options.choices.some((choice) => choice.value === String(step.value)),
      `scripted select value "${String(step.value)}" is not among choices: [${options.choices.map((choice) => choice.value).join(", ")}]`,
    );
    return String(step.value);
  }

  async confirm(): Promise<boolean> {
    const step = this.#next("confirm");
    this.calls.push("confirm");
    return Boolean(step.value);
  }

  async close(): Promise<void> {
    this.calls.push("close");
    assert.equal(this.#steps.length, 0);
  }

  spinner() {
    this.calls.push("spinner");
    return {
      start: (message?: string) => {
        this.spinnerEvents.push({ kind: "start", message });
      },
      stop: (message?: string) => {
        this.spinnerEvents.push({ kind: "stop", message });
      },
      error: (message?: string) => {
        this.spinnerEvents.push({ kind: "error", message });
      },
    };
  }

  #next(kind: "input" | "secret" | "confirm" | "select") {
    const step = this.#steps.shift();
    assert.ok(step, `expected scripted ${kind} step`);
    assert.equal(step.kind, kind);
    return step;
  }
}

function createFetchStub(responses: Array<{
  ok: boolean;
  status: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const stub = async (
    url: string | URL,
    options: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ) => {
    const next = responses.shift();
    assert.ok(next, `unexpected fetch call for ${String(url)}`);
    calls.push({
      url: String(url),
      method: options.method ?? "GET",
      headers: options.headers ?? {},
      body: options.body,
    });
    return {
      ok: next.ok,
      status: next.status,
      async json() {
        return next.json ?? {};
      },
      async text() {
        return next.text ?? "";
      },
      headers: {
        get(name: string) {
          return next.headers?.[name.toLowerCase()] ?? null;
        },
      },
    };
  };

  return Object.assign(stub, { calls });
}
