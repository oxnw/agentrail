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
  const prompt = new ScriptedPromptSession([
    { kind: "select", value: "demo" },
    { kind: "confirm", value: false },
    { kind: "select", value: "print_only" },
  ]);

  const exitCode = await runCli(["init"], {
    cwd: detectedRepo.repoPath,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stdout,
    stderr,
    detectRepoContext: async () => detectedRepo,
    createPrompt: () => prompt,
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(prompt.calls, ["select", "confirm", "select"]);
  assert.match(stdout.toString(), /AgentRail local setup/i);
  assert.match(stdout.toString(), /Review setup plan/i);
  assert.match(stdout.toString(), /agentrail init --mode demo/);
  assert.equal(stderr.toString(), "");
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
  assert.match(String(calls[0][1]), /AgentRail/i);
  assert.equal(calls[1][0], "select");
  assert.equal((calls[1][1] as { message: string }).message, "Setup mode");
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
    const step = this.#next("select");
    const values = options.choices.map((choice) => choice.value);
    assert.ok(values.includes(String(step.value)));
    return String(step.value);
  }

  async confirm(): Promise<boolean> {
    this.calls.push("confirm");
    const step = this.#next("confirm");
    return Boolean(step.value);
  }

  async input(): Promise<string> {
    this.calls.push("input");
    const step = this.#next("input");
    return String(step.value);
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
