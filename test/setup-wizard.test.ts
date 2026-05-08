import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { Writable } from "node:stream";
import test from "node:test";

import { runCli } from "../src/cli/index.ts";
import {
  createPromptSession,
  PromptCancelledError,
  type ClackPromptsLike,
} from "../src/cli/prompt.ts";
import type { DetectedRepoContext, SetupConfig } from "../src/cli/setup-config.ts";
import type { PromptChoice, PromptSession } from "../src/cli/prompt.ts";

const detectedRepo: DetectedRepoContext = {
  repoPath: "/tmp/agentrail",
  remoteSlug: "oxnw/agentrail",
  defaultBranch: "main",
  gitIgnoreHasAgentrail: true,
};

test("runCli starts the guided setup wizard in TTY mode by default", async () => {
  const agentrailHome = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = agentrailHome;
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const writes: Array<{ homePath?: string; repoRoot?: string; config: SetupConfig }> = [];
  const prompt = new ScriptedPromptSession([
    { kind: "input", value: "/tmp/custom-agentrail" },
    { kind: "input", value: "https://github.com/custom/agentrail" },
    { kind: "input", value: "develop" },
    { kind: "input", value: "http://127.0.0.1:4100" },
    { kind: "confirm", value: false },
    { kind: "confirm", value: true },
    { kind: "confirm", value: false },
    { kind: "confirm", value: false },
  ]);

  const exitCode = await runCli(["init"], {
    cwd: detectedRepo.repoPath,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stdout,
    stderr,
    detectRepoContext: async () => detectedRepo,
    createPrompt: () => prompt,
    writeSetupFiles: async ({ homePath, repoRoot, config }) => {
      writes.push({ homePath, repoRoot, config });
      return {
        writtenPaths: [
          `${homePath}/config.json`,
          `${homePath}/agent.env.example`,
          `${homePath}/server.env`,
          `${homePath}/README.md`,
        ],
      };
    },
  });

  if (previousHome === undefined) {
    delete process.env.AGENTRAIL_HOME;
  } else {
    process.env.AGENTRAIL_HOME = previousHome;
  }
  await rm(agentrailHome, { recursive: true, force: true });

  assert.equal(exitCode, 0);
  assert.deepEqual(prompt.calls, ["input", "input", "input", "input", "confirm", "confirm", "confirm", "confirm"]);
  assert.equal(prompt.notes[0]?.title, "Review setup plan");
  assert.match(prompt.notes[0]?.body ?? "", /AgentRail is ready to create its local home and connect your first repo\./);
  assert.match(prompt.notes[0]?.body ?? "", /Setup choices:/);
  assert.match(prompt.notes[0]?.body ?? "", /GitHub repo: https:\/\/github\.com\/custom\/agentrail/);
  assert.match(prompt.notes[0]?.body ?? "", /Provider mode: real/);
  assert.match(prompt.notes[0]?.body ?? "", /Local API base URL: http:\/\/127\.0\.0\.1:4100/);
  assert.equal(prompt.messages[0], `AgentRail home: ${agentrailHome}`);
  assert.equal(prompt.messages[1], "Detected repo you can connect: /tmp/agentrail");
  assert.equal(prompt.messages[2], "GitHub repo detected: https://github.com/oxnw/agentrail • default branch: main");
  assert.equal(prompt.notes[1]?.title, "What happens next");
  assert.match(prompt.notes[1]?.body ?? "", /`~\/\.agentrail\/operator\.env`/);
  assert.match(prompt.notes[1]?.body ?? "", /`~\/\.agentrail\/agents\/<agentId>\.env`/);
  assert.match(prompt.notes[1]?.body ?? "", /offer first-agent creation/i);
  assert.match(prompt.notes[1]?.body ?? "", /agentrail provider connect github/i);
  assert.match(prompt.notes[1]?.body ?? "", /final verification step/i);
  assert.match(prompt.notes[1]?.body ?? "", /refresh your global AgentRail home/i);
  assert.match(prompt.notes[1]?.body ?? "", /`agentrail server start`/);
  assert.equal(prompt.interactions[0]?.message, "Which local repo should AgentRail connect first?");
  assert.equal(prompt.interactions[1]?.message, "Primary GitHub repo URL");
  assert.doesNotMatch(stdout.toString(), /AgentRail local setup/i);
  assert.doesNotMatch(stdout.toString(), /Local git repo detected:/);
  assert.doesNotMatch(stdout.toString(), /Review setup plan/i);
  assert.doesNotMatch(stdout.toString(), /Detected:/);
  assert.doesNotMatch(stdout.toString(), /Wrote setup files:/);
  assert.equal(stdout.toString(), "");
  assert.doesNotMatch(stdout.toString(), /Equivalent command:/);
  assert.equal(stderr.toString(), "");
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.homePath, agentrailHome);
  assert.deepEqual(writes[0]?.config.repos.map((repo) => repo.slug), ["custom/agentrail"]);
  assert.equal(writes[0]?.config.repos[0]?.defaultBranch, "develop");
  assert.equal(writes[0]?.config.server.baseUrl, "http://127.0.0.1:4100");
  assert.equal(writes[0]?.config.providers.github.mode, "real");
});

test("runCli can connect GitHub during init with a hidden token prompt and shows provider follow-up commands", async () => {
  const agentrailHome = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = agentrailHome;
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const prompt = new ScriptedPromptSession([
    { kind: "input", value: detectedRepo.repoPath },
    { kind: "input", value: `https://github.com/${detectedRepo.remoteSlug}` },
    { kind: "input", value: detectedRepo.defaultBranch },
    { kind: "input", value: "http://127.0.0.1:3000" },
    { kind: "confirm", value: false },
    { kind: "confirm", value: true },
    { kind: "confirm", value: false },
    { kind: "confirm", value: true },
    { kind: "select", value: "polling" },
    { kind: "secret", value: "ghp_init_flow_token" },
    { kind: "select", value: "60000" },
  ]);
  const fetch = createFetchStub([
    {
      ok: true,
      status: 200,
      json: { login: "octocat" },
    },
  ]);

  const exitCode = await runCli(["init"], {
    cwd: detectedRepo.repoPath,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stdout,
    stderr,
    detectRepoContext: async () => detectedRepo,
    createPrompt: () => prompt,
    providerFetch: fetch as any,
  });

  assert.equal(exitCode, 0, stderr.toString());
  assert.equal(stderr.toString(), "");
  assert.equal(stdout.toString(), "");
  assert.doesNotMatch(stdout.toString(), /Run `agentrail provider test github`/);
  const providerEnv = await readFile(path.join(agentrailHome, "provider.env"), "utf8");
  assert.match(providerEnv, /GITHUB_TOKEN="ghp_init_flow_token"/);
  assert.ok(prompt.calls.includes("secret"));
  assert.deepEqual(prompt.spinnerEvents, [
    { kind: "start", message: "Testing GitHub connection" },
    { kind: "stop", message: "\u2713 Connected GitHub using GITHUB_TOKEN in polling mode." },
  ]);
  assert.match(prompt.notes.map((note) => note.body).join("\n"), /agentrail provider list/i);
  assert.match(prompt.notes.map((note) => note.body).join("\n"), /agentrail provider connect github/i);
  assert.match(prompt.notes.map((note) => note.body).join("\n"), /agentrail provider connect circleci/i);
  assert.match(prompt.notes.map((note) => note.body).join("\n"), /agentrail provider connect linear/i);
  assert.match(prompt.notes.map((note) => note.body).join("\n"), /agentrail linear import ENG-123/i);

  if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
  else process.env.AGENTRAIL_HOME = previousHome;
  await rm(agentrailHome, { recursive: true, force: true });
});

test("runCli lets the user cancel instead of writing files at the final confirmation step", async () => {
  const agentrailHome = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = agentrailHome;
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const prompt = new ScriptedPromptSession([
    { kind: "input", value: detectedRepo.repoPath },
    { kind: "input", value: `https://github.com/${detectedRepo.remoteSlug}` },
    { kind: "input", value: detectedRepo.defaultBranch },
    { kind: "input", value: "http://127.0.0.1:3000" },
    { kind: "confirm", value: false },
    { kind: "confirm", value: false },
  ]);
  let didWrite = false;

  const exitCode = await runCli(["init"], {
    cwd: detectedRepo.repoPath,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stdout,
    stderr,
    detectRepoContext: async () => detectedRepo,
    createPrompt: () => prompt,
    writeSetupFiles: async () => {
      didWrite = true;
      throw new Error("writeSetupFiles should not run after cancellation");
    },
  });

  if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
  else process.env.AGENTRAIL_HOME = previousHome;
  await rm(agentrailHome, { recursive: true, force: true });

  assert.equal(exitCode, 1);
  assert.equal(didWrite, false);
  assert.match(stderr.toString(), /Setup cancelled\./);
  assert.equal(prompt.notes.length, 1);
  assert.equal(prompt.notes[0]?.title, "Review setup plan");
});

test("runCli re-prompts when the GitHub repo input is not a valid owner/repo or GitHub URL", async () => {
  const agentrailHome = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = agentrailHome;
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const prompt = new ScriptedPromptSession([
    { kind: "input", value: detectedRepo.repoPath },
    { kind: "input", value: "random text" },
    { kind: "input", value: "custom/agentrail" },
    { kind: "input", value: detectedRepo.defaultBranch },
    { kind: "input", value: "http://127.0.0.1:3000" },
    { kind: "confirm", value: false },
    { kind: "confirm", value: false },
  ]);

  const exitCode = await runCli(["init"], {
    cwd: detectedRepo.repoPath,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stdout,
    stderr,
    detectRepoContext: async () => detectedRepo,
    createPrompt: () => prompt,
    writeSetupFiles: async () => {
      throw new Error("writeSetupFiles should not run after cancellation");
    },
  });

  if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
  else process.env.AGENTRAIL_HOME = previousHome;
  await rm(agentrailHome, { recursive: true, force: true });

  assert.equal(exitCode, 1);
  assert.deepEqual(
    prompt.interactions.filter((interaction) => interaction.message === "Primary GitHub repo URL").length,
    2,
  );
  assert.deepEqual(prompt.messages, [
    `AgentRail home: ${agentrailHome}`,
    "Detected repo you can connect: /tmp/agentrail",
    "GitHub repo detected: https://github.com/oxnw/agentrail • default branch: main",
    "Use a GitHub repo URL like https://github.com/owner/repo.",
  ]);
});

test("runCli normalizes .git suffix from GitHub repo input", async () => {
  const agentrailHome = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = agentrailHome;
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const writes: Array<{ homePath?: string; repoRoot?: string; config: SetupConfig }> = [];
  const prompt = new ScriptedPromptSession([
    { kind: "input", value: detectedRepo.repoPath },
    { kind: "input", value: "https://github.com/custom/agentrail.git" },
    { kind: "input", value: detectedRepo.defaultBranch },
    { kind: "input", value: "http://127.0.0.1:3000" },
    { kind: "confirm", value: false },
    { kind: "confirm", value: true },
    { kind: "confirm", value: false },
    { kind: "confirm", value: false },
  ]);

  const exitCode = await runCli(["init"], {
    cwd: detectedRepo.repoPath,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stdout,
    stderr,
    detectRepoContext: async () => detectedRepo,
    createPrompt: () => prompt,
    writeSetupFiles: async ({ homePath, repoRoot, config }) => {
      writes.push({ homePath, repoRoot, config });
      return { writtenPaths: [] };
    },
  });

  if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
  else process.env.AGENTRAIL_HOME = previousHome;
  await rm(agentrailHome, { recursive: true, force: true });

  assert.equal(exitCode, 0);
  assert.equal(writes[0]?.config.repos[0]?.slug, "custom/agentrail");
  assert.match(prompt.notes[0]?.body ?? "", /GitHub repo: https:\/\/github\.com\/custom\/agentrail/);
});

test("runCli print-only mode does not show file-write next steps", async () => {
  const agentrailHome = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = agentrailHome;
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const prompt = new ScriptedPromptSession([
    { kind: "input", value: detectedRepo.repoPath },
    { kind: "input", value: `https://github.com/${detectedRepo.remoteSlug}` },
    { kind: "input", value: detectedRepo.defaultBranch },
    { kind: "input", value: "http://127.0.0.1:3000" },
    { kind: "confirm", value: false },
  ]);
  let didWrite = false;

  const exitCode = await runCli(["init", "--interactive", "--print-only"], {
    cwd: detectedRepo.repoPath,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stdout,
    stderr,
    detectRepoContext: async () => detectedRepo,
    createPrompt: () => prompt,
    writeSetupFiles: async () => {
      didWrite = true;
      throw new Error("writeSetupFiles should not run in print-only mode");
    },
  });

  if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
  else process.env.AGENTRAIL_HOME = previousHome;
  await rm(agentrailHome, { recursive: true, force: true });

  assert.equal(exitCode, 0);
  assert.equal(didWrite, false);
  assert.match(stdout.toString(), /Equivalent command:/);
  assert.match(stdout.toString(), /No files were written\./);
  assert.equal(stderr.toString(), "");
  assert.equal(prompt.notes.length, 1);
  assert.equal(prompt.notes[0]?.title, "Review setup plan");
  assert.doesNotMatch(prompt.notes.map((note) => note.title).join("\n"), /Next steps/);
});

test("runCli requires explicit flags in non-TTY mode", async () => {
  const agentrailHome = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = agentrailHome;
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();

  const exitCode = await runCli(["init"], {
    cwd: detectedRepo.repoPath,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
    detectRepoContext: async () => detectedRepo,
  });

  if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
  else process.env.AGENTRAIL_HOME = previousHome;
  await rm(agentrailHome, { recursive: true, force: true });

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /non-tty setup requires explicit flags or --yes/i);
  assert.match(stderr.toString(), /--mode server/i);
  assert.match(stderr.toString(), /--repo \/tmp\/agentrail/i);
});

test("runCli rejects unsafe --yes defaults", async () => {
  const agentrailHome = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = agentrailHome;
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();

  const exitCode = await runCli(["init", "--yes", "--mode", "server"], {
    cwd: detectedRepo.repoPath,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
    detectRepoContext: async () => ({
      ...detectedRepo,
      gitIgnoreHasAgentrail: false,
    }),
  });

  if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
  else process.env.AGENTRAIL_HOME = previousHome;
  await rm(agentrailHome, { recursive: true, force: true });

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /--yes is only allowed for safe local defaults/i);
  assert.match(stderr.toString(), /live GitHub, CircleCI, or Linear providers/i);
});

test("runCli validates --yes safe defaults against the target repo", async () => {
  const agentrailHome = await mkdtemp(path.join(os.tmpdir(), "agentrail-home-"));
  const previousHome = process.env.AGENTRAIL_HOME;
  process.env.AGENTRAIL_HOME = agentrailHome;
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const writes: Array<{ homePath?: string; repoRoot?: string; config: SetupConfig }> = [];
  const detectedByPath = new Map<string, DetectedRepoContext>([
    [
      "/tmp/invocation",
      {
        ...detectedRepo,
        repoPath: "/tmp/invocation",
        remoteSlug: "unsafe/invocation",
        gitIgnoreHasAgentrail: false,
      },
    ],
    [
      "/tmp/safe-target",
      {
        ...detectedRepo,
        repoPath: "/tmp/safe-target",
        remoteSlug: "safe/target",
        gitIgnoreHasAgentrail: true,
      },
    ],
  ]);

  const exitCode = await runCli([
    "init",
    "--yes",
    "--mode",
    "server",
    "--provider-mode",
    "disabled",
    "--repo",
    "/tmp/safe-target",
  ], {
    cwd: "/tmp/invocation",
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
    detectRepoContext: async (cwd) => {
      const detected = detectedByPath.get(cwd);
      if (!detected) throw new Error(`Unexpected repo detection path: ${cwd}`);
      return detected;
    },
    writeSetupFiles: async ({ homePath, repoRoot, config }) => {
      writes.push({ homePath, repoRoot, config });
      return {
        writtenPaths: [
          `${homePath}/config.json`,
          `${homePath}/agent.env.example`,
          `${homePath}/server.env`,
          `${homePath}/README.md`,
        ],
      };
    },
  });

  if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
  else process.env.AGENTRAIL_HOME = previousHome;
  await rm(agentrailHome, { recursive: true, force: true });

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.homePath, agentrailHome);
});

test("createPromptSession wraps Clack with AgentRail branding", async () => {
  const calls: Array<[string, unknown]> = [];
  const output = createMemoryWriter();
  const session = createPromptSession({
    output,
    clack: {
      intro() {},
      select: async (options) => {
        calls.push(["select", options]);
        return "real" as any;
      },
      multiselect: async () => [],
      confirm: async () => true,
      text: async () => "",
      note() {},
      cancel() {},
      isCancel() {
        return false;
      },
    } satisfies ClackPromptsLike,
  });

  const value = await session.select({
    message: "GitHub remote",
    defaultValue: "real",
    choices: [
      { value: "real", label: "Real GitHub and CircleCI", hint: "Use live providers", disabled: false },
    ],
  });

  assert.equal(value, "real");
  assert.match(output.toString(), /Local Setup/i);
  assert.match(output.toString(), /Set up local files, access, and your first agent\./i);
  assert.match(output.toString(), /█|╔|╗/);
  assert.equal(calls[0][0], "select");
  assert.equal((calls[0][1] as { message: string }).message, "GitHub remote");
  assert.deepEqual((calls[0][1] as { options: unknown[] }).options, [
    { value: "real", label: "Real GitHub and CircleCI", hint: "Use live providers", disabled: false },
  ]);
});

test("createPromptSession forwards explanatory notes to Clack", async () => {
  const calls: Array<[string, unknown, unknown]> = [];
  const session = createPromptSession({
    output: createMemoryWriter(),
    clack: {
      intro() {},
      select: async () => "real" as any,
      multiselect: async () => [],
      confirm: async () => true,
      text: async () => "",
      note(message, title) {
        calls.push(["note", title, message]);
      },
      cancel() {},
      isCancel() {
        return false;
      },
    } satisfies ClackPromptsLike,
  });

  await session.note({
    title: "What this setting does",
    body: "AgentRail writes .agentrail/ here.",
  });

  assert.deepEqual(calls[0], ["note", "What this setting does", "AgentRail writes .agentrail/ here."]);
});

test("createPromptSession forwards inline messages to Clack log.message", async () => {
  const calls: Array<[string, unknown, unknown]> = [];
  const session = createPromptSession({
    output: createMemoryWriter(),
    clack: {
      intro() {},
      select: async () => "real" as any,
      multiselect: async () => [],
      confirm: async () => true,
      text: async () => "",
      note() {},
      log: {
        message(message, options) {
          calls.push(["message", message, options]);
        },
      },
      cancel() {},
      isCancel() {
        return false;
      },
    } satisfies ClackPromptsLike,
  });

  await session.message("Local git repo detected: /tmp/agentrail");

  assert.equal(calls[0]?.[0], "message");
  assert.equal(calls[0]?.[1], "Local git repo detected: /tmp/agentrail");
});

test("createPromptSession passes detected defaults through the Clack text placeholder path", async () => {
  const calls: Array<[string, unknown]> = [];
  const session = createPromptSession({
    output: createMemoryWriter(),
    clack: {
      intro() {},
      select: async () => "real" as any,
      multiselect: async () => [],
      confirm: async () => true,
      text: async (options) => {
        calls.push(["text", options]);
        return options.defaultValue ?? "";
      },
      note() {},
      cancel() {},
      isCancel() {
        return false;
      },
    } satisfies ClackPromptsLike,
  });

  const value = await session.input({
    message: "Target GitHub repo",
    defaultValue: "/tmp/agentrail",
  });

  assert.equal(value, "/tmp/agentrail");
  assert.equal(calls[0][0], "text");
  assert.equal((calls[0][1] as { defaultValue?: string }).defaultValue, "/tmp/agentrail");
  assert.equal((calls[0][1] as { placeholder?: string }).placeholder, "/tmp/agentrail");
});

test("createPromptSession converts Clack cancellation into a typed error", async () => {
  const cancelToken = Symbol("cancel");
  const calls: Array<[string, unknown]> = [];
  const session = createPromptSession({
    output: createMemoryWriter(),
    clack: {
      intro() {},
      select: async () => cancelToken,
      multiselect: async () => [],
      confirm: async () => true,
      text: async () => "",
      note() {},
      cancel(message) {
        calls.push(["cancel", message]);
      },
      isCancel(value) {
        return value === cancelToken;
      },
    } satisfies ClackPromptsLike,
  });

  await assert.rejects(
    () => session.select({
      message: "GitHub remote",
      choices: [{ value: "real", label: "Real" }],
    }),
    PromptCancelledError,
  );

  assert.equal(calls[0][0], "cancel");
  assert.match(String(calls[0][1]), /cancelled/i);
});

test("createPromptSession forwards multiselect choices and defaults to Clack", async () => {
  const calls: Array<[string, unknown]> = [];
  const session = createPromptSession({
    output: createMemoryWriter(),
    clack: {
      intro() {},
      select: async () => "real" as any,
      multiselect: async (options) => {
        calls.push(["multiselect", options]);
        return ["tasks:read", "tasks:write"] as any;
      },
      confirm: async () => true,
      text: async () => "",
      note() {},
      cancel() {},
      isCancel() {
        return false;
      },
    } satisfies ClackPromptsLike,
  });

  const values = await session.multiselect({
    message: "Choose scopes",
    defaultValues: ["tasks:read"],
    required: false,
    choices: [
      { value: "tasks:read", label: "tasks:read", hint: "Read tasks" },
      { value: "tasks:write", label: "tasks:write", hint: "Write tasks" },
    ],
  });

  assert.deepEqual(values, ["tasks:read", "tasks:write"]);
  assert.equal(calls[0][0], "multiselect");
  assert.equal((calls[0][1] as { message: string }).message, "Choose scopes");
  assert.deepEqual((calls[0][1] as { initialValues?: string[] }).initialValues, ["tasks:read"]);
});

test("createPromptSession forwards masked secret prompts to Clack password", async () => {
  const calls: Array<[string, unknown]> = [];
  const session = createPromptSession({
    output: createMemoryWriter(),
    clack: {
      intro() {},
      select: async () => "real" as any,
      multiselect: async () => [],
      confirm: async () => true,
      text: async () => "",
      password: async (options: unknown) => {
        calls.push(["password", options]);
        return "ghp_secret" as any;
      },
      note() {},
      cancel() {},
      isCancel() {
        return false;
      },
    } as any,
  });

  const value = await (session as any).secret({
    message: "GitHub Personal Access Token",
  });

  assert.equal(value, "ghp_secret");
  assert.equal(calls[0][0], "password");
  assert.equal((calls[0][1] as { message: string }).message, "GitHub Personal Access Token");
});

function createMemoryWriter(): Writable & { toString(): string } {
  const chunks: string[] = [];
  const writer = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      callback();
    },
  });

  return Object.assign(writer, {
    toString() {
      return chunks.join("");
    },
  });
}

class ScriptedPromptSession implements PromptSession {
  readonly calls: string[] = [];
  readonly interactions: Array<{ kind: "select" | "multiselect" | "confirm" | "input" | "secret"; message?: string; defaultValue?: string | boolean | string[] }> = [];
  readonly notes: Array<{ title?: string; body: string }> = [];
  readonly messages: string[] = [];
  readonly spinnerEvents: Array<{ kind: "start" | "stop" | "error"; message?: string }> = [];
  readonly #steps: Array<{ kind: "select" | "multiselect" | "confirm" | "input" | "secret"; value: string | boolean | string[] }>;

  constructor(steps: Array<{ kind: "select" | "multiselect" | "confirm" | "input" | "secret"; value: string | boolean | string[] }>) {
    this.#steps = [...steps];
  }

  async select(options: {
    message: string;
    choices: PromptChoice[];
    defaultValue?: string;
  }): Promise<string> {
    this.calls.push("select");
    this.interactions.push({
      kind: "select",
      message: options.message,
      defaultValue: options.defaultValue,
    });
    const step = this.#next("select");
    const values = options.choices.map((choice) => choice.value);
    assert.ok(values.includes(String(step.value)));
    return String(step.value);
  }

  async multiselect(options: {
    message: string;
    choices: PromptChoice[];
    defaultValues?: string[];
    required?: boolean;
  }): Promise<string[]> {
    this.calls.push("multiselect");
    this.interactions.push({
      kind: "multiselect",
      message: options.message,
      defaultValue: options.defaultValues,
    });
    const step = this.#next("multiselect");
    assert.ok(Array.isArray(step.value), `multiselect step value must be an array, got ${typeof step.value}`);
    const values = (step.value as string[]).map(String);
    const allowed = new Set(options.choices.map((choice) => choice.value));
    values.forEach((value) => assert.ok(
      allowed.has(value),
      `invalid multiselect value "${value}", allowed: ${Array.from(allowed).join(", ")}`,
    ));
    return values;
  }

  async confirm(options: { message?: string; defaultValue?: boolean } = {}): Promise<boolean> {
    this.calls.push("confirm");
    this.interactions.push({
      kind: "confirm",
      message: options.message,
      defaultValue: options.defaultValue,
    });
    const step = this.#next("confirm");
    return Boolean(step.value);
  }

  async input(options: { message?: string; defaultValue?: string } = {}): Promise<string> {
    this.calls.push("input");
    this.interactions.push({
      kind: "input",
      message: options.message,
      defaultValue: options.defaultValue,
    });
    const step = this.#next("input");
    return String(step.value);
  }

  async secret(options: { message?: string } = {}): Promise<string> {
    this.calls.push("secret");
    this.interactions.push({
      kind: "secret",
      message: options.message,
    });
    const step = this.#next("secret");
    return String(step.value);
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

  #next(kind: "select" | "multiselect" | "confirm" | "input" | "secret") {
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
  const stub = async () => {
    const next = responses.shift();
    assert.ok(next, "unexpected fetch call");
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

  return stub;
}
