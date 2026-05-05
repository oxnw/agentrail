import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../src/cli/index.ts";
import {
  createPromptSession,
  PromptCancelledError,
  type ClackPromptsLike,
} from "../src/cli/prompt.ts";
import type { DetectedRepoContext } from "../src/cli/setup-config.ts";
import type { PromptChoice, PromptSession } from "../src/cli/prompt.ts";

const detectedRepo: DetectedRepoContext = {
  repoPath: "/tmp/agentrail",
  remoteSlug: "oxnw/agentrail",
  defaultBranch: "main",
  gitIgnoreHasAgentrail: true,
};

test("runCli starts the guided setup wizard in TTY mode by default", async () => {
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const writes: Array<{ repoRoot: string; config: { targetRepo: { path: string; allowlist: string[]; defaultBranch: string }; server: { baseUrl: string } } }> = [];
  const prompt = new ScriptedPromptSession([
    { kind: "input", value: "/tmp/custom-agentrail" },
    { kind: "input", value: "custom/agentrail" },
    { kind: "input", value: "develop" },
    { kind: "input", value: "http://127.0.0.1:4100" },
    { kind: "select", value: "demo" },
    { kind: "confirm", value: false },
    { kind: "confirm", value: true },
  ]);

  const exitCode = await runCli(["init"], {
    cwd: detectedRepo.repoPath,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stdout,
    stderr,
    detectRepoContext: async () => detectedRepo,
    createPrompt: () => prompt,
    writeSetupFiles: async ({ repoRoot, config }) => {
      writes.push({ repoRoot, config });
      return {
        writtenPaths: [
          `${repoRoot}/.agentrail/config.json`,
          `${repoRoot}/.agentrail/agent.env.example`,
          `${repoRoot}/.agentrail/README.md`,
        ],
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(prompt.calls, ["input", "input", "input", "input", "select", "confirm", "confirm"]);
  assert.equal(prompt.notes[0]?.title, "What these settings do");
  assert.match(prompt.notes[0]?.body ?? "", /Target GitHub repo/);
  assert.match(prompt.notes[0]?.body ?? "", /GitHub remote/);
  assert.equal(prompt.messages[0], "Local git repo detected: /tmp/agentrail");
  assert.equal(prompt.notes[1]?.title, "Before you confirm");
  assert.match(prompt.notes[1]?.body ?? "", /Review setup plan:/);
  assert.match(prompt.notes[1]?.body ?? "", /Write \.agentrail\/config\.json/);
  assert.match(prompt.notes[1]?.body ?? "", /Leave \.agentrail\/agent\.env for the later registration step only/);
  assert.equal(prompt.interactions[0]?.message, "Target GitHub repo");
  assert.equal(prompt.interactions[1]?.message, "GitHub remote (owner/repo)");
  assert.doesNotMatch(stdout.toString(), /AgentRail local setup/i);
  assert.doesNotMatch(stdout.toString(), /Local git repo detected:/);
  assert.doesNotMatch(stdout.toString(), /Review setup plan/i);
  assert.doesNotMatch(stdout.toString(), /Detected:/);
  assert.match(stdout.toString(), /Wrote setup files:/);
  assert.doesNotMatch(stdout.toString(), /Equivalent command:/);
  assert.equal(stderr.toString(), "");
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.repoRoot, "/tmp/custom-agentrail");
  assert.deepEqual(writes[0]?.config.targetRepo.allowlist, ["custom/agentrail"]);
  assert.equal(writes[0]?.config.targetRepo.defaultBranch, "develop");
  assert.equal(writes[0]?.config.server.baseUrl, "http://127.0.0.1:4100");
});

test("runCli lets the user cancel instead of writing files at the final confirmation step", async () => {
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const prompt = new ScriptedPromptSession([
    { kind: "input", value: detectedRepo.repoPath },
    { kind: "input", value: detectedRepo.remoteSlug ?? detectedRepo.repoPath },
    { kind: "input", value: detectedRepo.defaultBranch },
    { kind: "input", value: "http://127.0.0.1:3000" },
    { kind: "select", value: "demo" },
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

  assert.equal(exitCode, 1);
  assert.equal(didWrite, false);
  assert.match(stderr.toString(), /Setup cancelled\./);
});

test("runCli requires explicit flags in non-TTY mode", async () => {
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

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /non-tty setup requires explicit flags or --yes/i);
  assert.match(stderr.toString(), /--mode demo/i);
  assert.match(stderr.toString(), /--repo \/tmp\/agentrail/i);
});

test("runCli rejects unsafe --yes defaults", async () => {
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

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /--yes is only allowed for safe local defaults/i);
  assert.match(stderr.toString(), /provider mode/i);
});

test("createPromptSession wraps Clack with AgentRail branding", async () => {
  const calls: Array<[string, unknown]> = [];
  const session = createPromptSession({
    output: createMemoryWriter() as never,
    clack: {
      intro(title) {
        calls.push(["intro", title]);
      },
      select: async (options) => {
        calls.push(["select", options]);
        return "demo";
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

  const value = await session.select({
    message: "Setup mode",
    defaultValue: "demo",
    choices: [
      { value: "demo", label: "Demo, no provider tokens" },
      { value: "server", label: "Self-hosted with real GitHub/CI providers" },
    ],
  });

  assert.equal(value, "demo");
  assert.equal(calls[0][0], "intro");
  assert.match(String(calls[0][1]), /Local setup wizard/i);
  assert.match(String(calls[0][1]), /\n/);
  assert.equal(calls[1][0], "select");
  assert.equal((calls[1][1] as { message: string }).message, "Setup mode");
});

test("createPromptSession forwards explanatory notes to Clack", async () => {
  const calls: Array<[string, unknown, unknown]> = [];
  const session = createPromptSession({
    output: createMemoryWriter() as never,
    clack: {
      intro() {},
      select: async () => "demo",
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
    output: createMemoryWriter() as never,
    clack: {
      intro() {},
      select: async () => "demo",
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
    output: createMemoryWriter() as never,
    clack: {
      intro() {},
      select: async () => "demo",
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
    output: createMemoryWriter() as never,
    clack: {
      intro() {},
      select: async () => cancelToken,
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
      message: "Setup mode",
      choices: [{ value: "demo", label: "Demo" }],
    }),
    PromptCancelledError,
  );

  assert.equal(calls[0][0], "cancel");
  assert.match(String(calls[0][1]), /cancelled/i);
});

function createMemoryWriter() {
  const chunks: string[] = [];

  return {
    write(value: string | Uint8Array) {
      chunks.push(typeof value === "string" ? value : Buffer.from(value).toString("utf8"));
      return true;
    },
    toString() {
      return chunks.join("");
    },
  };
}

class ScriptedPromptSession implements PromptSession {
  readonly calls: string[] = [];
  readonly interactions: Array<{ kind: "select" | "confirm" | "input"; message?: string; defaultValue?: string | boolean }> = [];
  readonly notes: Array<{ title?: string; body: string }> = [];
  readonly messages: string[] = [];
  readonly #steps: Array<{ kind: "select" | "confirm" | "input"; value: string | boolean }>;

  constructor(steps: Array<{ kind: "select" | "confirm" | "input"; value: string | boolean }>) {
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

  async note(options: { title?: string; body: string }): Promise<void> {
    this.notes.push(options);
  }

  async message(body: string): Promise<void> {
    this.messages.push(body);
  }

  async close(): Promise<void> {
    assert.equal(this.#steps.length, 0);
  }

  #next(kind: "select" | "confirm" | "input") {
    const step = this.#steps.shift();
    assert.ok(step, `expected scripted ${kind} step`);
    assert.equal(step.kind, kind);
    return step;
  }
}
