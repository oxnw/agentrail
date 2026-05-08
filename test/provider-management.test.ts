import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0]?.url, "https://api.github.com/user");
  assert.equal(fetch.calls[0]?.headers.authorization, "Bearer ghp_test_provider_token");

  const providerEnv = await readFile(path.join(homePath, "provider.env"), "utf8");
  assert.match(providerEnv, /GITHUB_TOKEN="ghp_test_provider_token"/);

  const nextConfig = JSON.parse(await readFile(path.join(homePath, "config.json"), "utf8"));
  assert.equal(nextConfig.providers.github.mode, "real");
  assert.equal(nextConfig.providers.github.tokenEnv, "GITHUB_TOKEN");
});

test("provider connect github interactively prompts for a masked token", async (t) => {
  const { repoRoot, homePath } = await setupProviderTest(t);
  const fetch = createFetchStub([
    {
      ok: true,
      status: 200,
      json: { login: "octocat" },
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
  assert.equal(fetch.calls.length, 1);
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
  const prompt = new ScriptedPromptSession([
    { kind: "select", value: "webhook" },
    { kind: "secret", value: "circleci_interactive_token" },
    { kind: "secret", value: "circleci_interactive_webhook_secret" },
  ]);

  const exitCode = await runCli(["provider", "connect", "circleci"], {
    cwd: repoRoot,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stdout,
    stderr,
    createPrompt: () => prompt as any,
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.match(stdout.toString(), /^\u2713 Connected CircleCI using CIRCLECI_TOKEN and CIRCLECI_WEBHOOK_SECRET in webhook mode\.\n$/);
  assert.doesNotMatch(stdout.toString(), /Run `agentrail provider test circleci`/);
  assert.equal(stderr.toString(), "");
  assert.deepEqual(prompt.calls, ["select", "note", "secret", "secret", "close"]);
  assert.deepEqual(prompt.selectMessages, ["How do you want to receive CircleCI events?"]);
  assert.match(prompt.notes[0]?.body ?? "", /Paste your CircleCI token and webhook secret when prompted\./);
  assert.deepEqual(prompt.secretMessages, [
    "Paste your CircleCI token (CIRCLECI_TOKEN)",
    "Paste your CircleCI webhook secret (CIRCLECI_WEBHOOK_SECRET)",
  ]);

  const providerEnv = await readFile(path.join(homePath, "provider.env"), "utf8");
  assert.match(providerEnv, /CIRCLECI_TOKEN="circleci_interactive_token"/);
  assert.match(providerEnv, /CIRCLECI_WEBHOOK_SECRET="circleci_interactive_webhook_secret"/);

  const nextConfig = JSON.parse(await readFile(path.join(homePath, "config.json"), "utf8"));
  assert.equal(nextConfig.providers.circleci.mode, "real");
  assert.equal(nextConfig.providers.circleci.tokenEnv, "CIRCLECI_TOKEN");
  assert.equal(nextConfig.providers.circleci.webhookSecretEnv, "CIRCLECI_WEBHOOK_SECRET");
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
  assert.equal(fetch.calls.length, 1);
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
}>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const stub = async (url: string | URL, options: { headers?: Record<string, string> } = {}) => {
    const next = responses.shift();
    assert.ok(next, `unexpected fetch call for ${String(url)}`);
    calls.push({
      url: String(url),
      headers: options.headers ?? {},
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
    };
  };

  return Object.assign(stub, { calls });
}
