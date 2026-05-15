import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parseSimpleEnv } from "../env-file.ts";

interface Writer {
  write(chunk: string | Uint8Array): boolean;
}

interface ManagedAgentEnv {
  agentId: string;
  envPath: string;
}

interface RunnerChild {
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: "ignore" | "inherit";
}

export interface LocalRunnerSupervisorOptions {
  homePath: string;
  cwd: string;
  stdout: Writer;
  stderr: Writer;
  cliEntrypoint?: string;
  restartDelayMs?: number;
  spawnChild?: (command: string, args: string[], options: SpawnOptions) => RunnerChild;
  setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

interface ManagedRunnerProcess {
  agentId: string;
  envPath: string;
  child: RunnerChild;
  restartTimer: NodeJS.Timeout | null;
}

const DEFAULT_RESTART_DELAY_MS = 5_000;

export function createLocalRunnerSupervisor(options: LocalRunnerSupervisorOptions): LocalRunnerSupervisor {
  return new LocalRunnerSupervisor(options);
}

export class LocalRunnerSupervisor {
  private readonly processes = new Map<string, ManagedRunnerProcess>();
  private stopped = false;
  private started = false;
  private readonly options: LocalRunnerSupervisorOptions;
  private readonly restartDelayMs: number;
  private readonly spawnChild: (command: string, args: string[], options: SpawnOptions) => RunnerChild;
  private readonly setTimer: (callback: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;

  constructor(options: LocalRunnerSupervisorOptions) {
    this.options = options;
    this.restartDelayMs = options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
    this.spawnChild = options.spawnChild ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    const agents = await discoverManagedAgentEnvs(this.options.homePath, this.options.stderr);
    if (this.stopped) return;
    if (agents.length === 0) {
      this.options.stdout.write("No managed local agents found; server will process provider events without local runner wake processes.\n");
      return;
    }
    for (const agent of agents) {
      this.launch(agent);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    for (const processRecord of this.processes.values()) {
      if (processRecord.restartTimer) {
        this.clearTimer(processRecord.restartTimer);
        processRecord.restartTimer = null;
      }
      processRecord.child.kill("SIGTERM");
    }
    this.processes.clear();
  }

  private launch(agent: ManagedAgentEnv): void {
    if (this.stopped) return;
    const args = [
      this.options.cliEntrypoint ?? process.argv[1] ?? "agentrail",
      "agent",
      "run",
      "--env-file",
      agent.envPath,
    ];
    const child = this.spawnChild(process.execPath, args, {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        AGENTRAIL_HOME: this.options.homePath,
      },
      stdio: "inherit",
    });
    const processRecord: ManagedRunnerProcess = {
      agentId: agent.agentId,
      envPath: agent.envPath,
      child,
      restartTimer: null,
    };
    this.processes.set(agent.agentId, processRecord);
    this.options.stdout.write(`Started local runner ${agent.agentId} from ${agent.envPath}.\n`);
    let handledStop = false;
    const handleStop = (reason: string) => {
      if (handledStop) return;
      handledStop = true;
      this.processes.delete(agent.agentId);
      if (this.stopped) return;
      this.options.stderr.write(`Local runner ${agent.agentId} stopped with ${reason}; restarting in ${Math.round(this.restartDelayMs / 1000)}s.\n`);
      processRecord.restartTimer = this.setTimer(() => {
        processRecord.restartTimer = null;
        if (!this.stopped) {
          this.launch(agent);
        }
      }, this.restartDelayMs);
    };
    child.on("exit", (code, signal) => {
      handleStop(signal ? `signal ${String(signal)}` : `exit code ${String(code)}`);
    });
    child.on("error", (error) => {
      handleStop(`error ${error.message}`);
    });
  }
}

async function discoverManagedAgentEnvs(homePath: string, stderr: Writer): Promise<ManagedAgentEnv[]> {
  const agentsDir = path.join(homePath, "agents");
  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return [];
    }
    throw error;
  }

  const discovered: ManagedAgentEnv[] = [];
  const seenAgentIds = new Set<string>();
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".env")) continue;
    const envPath = path.join(agentsDir, entry);
    const parsed = parseSimpleEnv(await readFile(envPath, "utf8"));
    const missing = ["AGENTRAIL_BASE_URL", "AGENTRAIL_API_KEY", "AGENTRAIL_AGENT_ID"]
      .filter((key) => !parsed[key]?.trim());
    if (missing.length > 0) {
      stderr.write(`Skipping local runner env ${envPath}; missing ${missing.join(", ")}.\n`);
      continue;
    }
    const agentId = parsed.AGENTRAIL_AGENT_ID.trim();
    if (seenAgentIds.has(agentId)) {
      stderr.write(`Skipping local runner env ${envPath}; duplicate AGENTRAIL_AGENT_ID ${agentId}.\n`);
      continue;
    }
    seenAgentIds.add(agentId);
    discovered.push({
      agentId,
      envPath,
    });
  }
  return discovered;
}
