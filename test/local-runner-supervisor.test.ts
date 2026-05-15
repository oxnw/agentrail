import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLocalRunnerSupervisor } from "../src/cli/local-runner-supervisor.ts";

class FakeChild extends EventEmitter {
  killed = false;
  killSignal: NodeJS.Signals | string | null = null;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killSignal = typeof signal === "number" ? String(signal) : signal ?? "SIGTERM";
    this.emit("exit", null, this.killSignal);
    return true;
  }
}

function createMemoryWriter() {
  let text = "";
  return {
    write(chunk: string | Uint8Array) {
      text += String(chunk);
      return true;
    },
    toString() {
      return text;
    },
  };
}

test("local runner supervisor starts one managed agent run child per valid env file", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-supervisor-repo-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-supervisor-home-"));
  await mkdir(path.join(homePath, "agents"), { recursive: true });
  await writeFile(path.join(homePath, "agents", "agt_builder.env"), [
    "AGENTRAIL_BASE_URL=http://127.0.0.1:3000",
    "AGENTRAIL_API_KEY=ar_live_builder",
    "AGENTRAIL_AGENT_ID=agt_builder",
    "AGENTRAIL_AGENT_RUNNER=codex",
    "AGENTRAIL_REPO_ALLOWLIST=oxnw/agentrail",
    "",
  ].join("\n"));
  await writeFile(path.join(homePath, "agents", "agt_reviewer.env"), [
    "AGENTRAIL_BASE_URL=http://127.0.0.1:3000",
    "AGENTRAIL_API_KEY=ar_live_reviewer",
    "AGENTRAIL_AGENT_ID=agt_reviewer",
    "AGENTRAIL_AGENT_RUNNER=codex",
    "AGENTRAIL_REPO_ALLOWLIST=oxnw/agentrail",
    "",
  ].join("\n"));
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const launches: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
  const children: FakeChild[] = [];

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
  });

  const supervisor = createLocalRunnerSupervisor({
    homePath,
    cwd: repoRoot,
    stdout,
    stderr,
    cliEntrypoint: "/tmp/current-agentrail-cli.mjs",
    spawnChild: (command, args, options) => {
      const child = new FakeChild();
      children.push(child);
      launches.push({ command, args, cwd: String(options.cwd), env: options.env ?? {} });
      return child;
    },
    restartDelayMs: 50,
  });

  assert.ok(supervisor);
  await supervisor.start();

  assert.equal(launches.length, 2);
  assert.equal(launches[0]?.command, process.execPath);
  assert.deepEqual(launches[0]?.args, [
    "/tmp/current-agentrail-cli.mjs",
    "agent",
    "run",
    "--env-file",
    path.join(homePath, "agents", "agt_builder.env"),
  ]);
  assert.equal(launches[0]?.cwd, repoRoot);
  assert.equal(launches[0]?.env.AGENTRAIL_HOME, homePath);
  assert.match(stdout.toString(), /Started local runner agt_builder/);
  assert.equal(stderr.toString(), "");

  await supervisor.stop();
  assert.equal(children.every((child) => child.killed), true);
});

test("local runner supervisor skips incomplete env files and keeps valid agents running", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-supervisor-skip-repo-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-supervisor-skip-home-"));
  await mkdir(path.join(homePath, "agents"), { recursive: true });
  await writeFile(path.join(homePath, "agents", "agt_valid.env"), [
    "AGENTRAIL_BASE_URL=http://127.0.0.1:3000",
    "AGENTRAIL_API_KEY=ar_live_valid",
    "AGENTRAIL_AGENT_ID=agt_valid",
    "",
  ].join("\n"));
  await writeFile(path.join(homePath, "agents", "agt_missing_key.env"), [
    "AGENTRAIL_BASE_URL=http://127.0.0.1:3000",
    "AGENTRAIL_AGENT_ID=agt_missing_key",
    "",
  ].join("\n"));
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const launches: string[] = [];

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
  });

  const supervisor = createLocalRunnerSupervisor({
    homePath,
    cwd: repoRoot,
    stdout,
    stderr,
    cliEntrypoint: "/tmp/current-agentrail-cli.mjs",
    spawnChild: (_command, args) => {
      launches.push(args.join(" "));
      return new FakeChild();
    },
    restartDelayMs: 50,
  });

  assert.ok(supervisor);
  await supervisor.start();

  assert.equal(launches.length, 1);
  assert.match(launches[0] ?? "", /agt_valid\.env/);
  assert.doesNotMatch(launches[0] ?? "", /agt_missing_key/);
  assert.match(stderr.toString(), /Skipping local runner env .*agt_missing_key\.env.*AGENTRAIL_API_KEY/);

  await supervisor.stop();
});

test("local runner supervisor skips duplicate agent ids to avoid orphaned child processes", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-supervisor-duplicate-repo-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-supervisor-duplicate-home-"));
  await mkdir(path.join(homePath, "agents"), { recursive: true });
  await writeFile(path.join(homePath, "agents", "agt_duplicate_a.env"), [
    "AGENTRAIL_BASE_URL=http://127.0.0.1:3000",
    "AGENTRAIL_API_KEY=ar_live_first",
    "AGENTRAIL_AGENT_ID=agt_duplicate",
    "",
  ].join("\n"));
  await writeFile(path.join(homePath, "agents", "agt_duplicate_b.env"), [
    "AGENTRAIL_BASE_URL=http://127.0.0.1:3000",
    "AGENTRAIL_API_KEY=ar_live_second",
    "AGENTRAIL_AGENT_ID=agt_duplicate",
    "",
  ].join("\n"));
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const children: FakeChild[] = [];

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
  });

  const supervisor = createLocalRunnerSupervisor({
    homePath,
    cwd: repoRoot,
    stdout,
    stderr,
    cliEntrypoint: "/tmp/current-agentrail-cli.mjs",
    spawnChild: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });

  await supervisor.start();
  assert.equal(children.length, 1);
  assert.match(stderr.toString(), /duplicate AGENTRAIL_AGENT_ID agt_duplicate/);

  await supervisor.stop();
  assert.equal(children.every((child) => child.killed), true);
});

test("local runner supervisor restarts exited runners until stopped", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-supervisor-restart-repo-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-supervisor-restart-home-"));
  await mkdir(path.join(homePath, "agents"), { recursive: true });
  await writeFile(path.join(homePath, "agents", "agt_restart.env"), [
    "AGENTRAIL_BASE_URL=http://127.0.0.1:3000",
    "AGENTRAIL_API_KEY=ar_live_restart",
    "AGENTRAIL_AGENT_ID=agt_restart",
    "",
  ].join("\n"));
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const children: FakeChild[] = [];
  const timers: Array<() => void> = [];

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
  });

  const supervisor = createLocalRunnerSupervisor({
    homePath,
    cwd: repoRoot,
    stdout,
    stderr,
    cliEntrypoint: "/tmp/current-agentrail-cli.mjs",
    spawnChild: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    restartDelayMs: 10,
    setTimer: (callback) => {
      timers.push(callback);
      return { hasRef: () => false } as NodeJS.Timeout;
    },
    clearTimer: () => {},
  });

  await supervisor.start();
  assert.equal(children.length, 1);

  children[0]?.emit("exit", 1, null);
  assert.match(stderr.toString(), /Local runner agt_restart stopped with exit code 1; restarting/);
  assert.equal(timers.length, 1);

  timers[0]?.();
  assert.equal(children.length, 2);

  await supervisor.stop();
  children[1]?.emit("exit", 1, null);
  assert.equal(timers.length, 1);
});

test("local runner supervisor restarts when child spawn emits an error", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-supervisor-error-repo-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-supervisor-error-home-"));
  await mkdir(path.join(homePath, "agents"), { recursive: true });
  await writeFile(path.join(homePath, "agents", "agt_error.env"), [
    "AGENTRAIL_BASE_URL=http://127.0.0.1:3000",
    "AGENTRAIL_API_KEY=ar_live_error",
    "AGENTRAIL_AGENT_ID=agt_error",
    "",
  ].join("\n"));
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  const children: FakeChild[] = [];
  const timers: Array<() => void> = [];

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
  });

  const supervisor = createLocalRunnerSupervisor({
    homePath,
    cwd: repoRoot,
    stdout,
    stderr,
    cliEntrypoint: "/tmp/current-agentrail-cli.mjs",
    spawnChild: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    restartDelayMs: 10,
    setTimer: (callback) => {
      timers.push(callback);
      return { hasRef: () => false } as NodeJS.Timeout;
    },
    clearTimer: () => {},
  });

  await supervisor.start();
  assert.equal(children.length, 1);

  children[0]?.emit("error", new Error("spawn failed"));
  children[0]?.emit("exit", 1, null);
  assert.match(stderr.toString(), /Local runner agt_error stopped with error spawn failed; restarting/);
  assert.equal(timers.length, 1);

  timers[0]?.();
  assert.equal(children.length, 2);

  await supervisor.stop();
});

test("local runner supervisor does not start anything when no managed agent env files exist", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-supervisor-empty-repo-"));
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-supervisor-empty-home-"));
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();
  let launched = false;

  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homePath, { recursive: true, force: true });
  });

  const supervisor = createLocalRunnerSupervisor({
    homePath,
    cwd: repoRoot,
    stdout,
    stderr,
    cliEntrypoint: "/tmp/current-agentrail-cli.mjs",
    spawnChild: () => {
      launched = true;
      return new FakeChild();
    },
  });

  await supervisor.start();
  assert.equal(launched, false);
  assert.match(stdout.toString(), /No managed local agents found/);
  assert.equal(stderr.toString(), "");
});
