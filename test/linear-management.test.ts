import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { runCli } from "../src/cli/index.ts";
import { ensureLocalOperatorBootstrap } from "../src/cli/local-bootstrap.ts";
import { createSetupConfig, type DetectedRepoContext } from "../src/cli/setup-config.ts";
import { writeSetupFiles } from "../src/cli/setup-files.ts";
import { createMemoryWriter } from "./helpers/memory-writer.ts";

const detectedRepo: DetectedRepoContext = {
  repoPath: "", // Replaced by the per-test temp repo path.
  remoteSlug: "oxnw/agentrail",
  defaultBranch: "main",
  gitIgnoreHasAgentrail: true,
};

test("agentrail linear import imports one issue through the local provider route", { timeout: 30_000 }, async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentrail-linear-repo-"));
  t.after(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });
  const homePath = await mkdtemp(path.join(os.tmpdir(), "agentrail-linear-home-"));
  t.after(async () => {
    await rm(homePath, { recursive: true, force: true });
  });
  const previousHome = process.env.AGENTRAIL_HOME;
  const originalFetch = typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : undefined;
  const stdout = createMemoryWriter();
  const stderr = createMemoryWriter();

  t.after(() => {
    if (originalFetch === undefined) {
      delete globalThis.fetch;
    } else {
      globalThis.fetch = originalFetch;
    }
    if (previousHome === undefined) delete process.env.AGENTRAIL_HOME;
    else process.env.AGENTRAIL_HOME = previousHome;
  });

  process.env.AGENTRAIL_HOME = homePath;
  const config = createSetupConfig({
    cwd: repoRoot,
    detectedRepo: { ...detectedRepo, repoPath: repoRoot },
    interactionMode: "non_interactive",
    acceptedDefaults: true,
  });
  config.providers.linear.mode = "real";
  config.providers.linear.deliveryMode = "polling";

  await writeSetupFiles({ homePath, repoRoot, config });
  await ensureLocalOperatorBootstrap({ homePath, repoRoot, config });
  await writeFile(path.join(homePath, "provider.env"), 'LINEAR_API_KEY="lin_api_key_test"\n', { mode: 0o600 });

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://api.linear.app/graphql") {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { id?: string };
      };
      assert.equal(headers.get("authorization"), "lin_api_key_test");
      assert.equal(body.variables?.id, "ENG-901");
      return new Response(JSON.stringify({
        data: {
          issue: {
            id: "lin_issue_901",
            identifier: "ENG-901",
            url: "https://linear.app/agentrail/issue/ENG-901/cli-import",
            title: "CLI import path",
            description: "Imported through the CLI route.",
            state: { id: "state_backlog", name: "Backlog", type: "backlog" },
            team: { id: "team_01", key: "ENG", name: "Engineering" },
            assignee: { id: "user_01", name: "CLI Importer" },
            labels: { nodes: [{ name: "cli" }] },
            organization: { id: "workspace_01", urlKey: "agentrail" },
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (!originalFetch) {
      throw new Error(`No fetch implementation available for URL: ${url}`);
    }
    return originalFetch(input, init);
  };

  const exitCode = await runCli(["linear", "import", "ENG-901"], {
    cwd: repoRoot,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0, stderr.toString());
  const output = stdout.toString();
  assert.match(output, /✓ Imported ENG-901 from Linear\./);
  assert.match(output, /Created AgentRail task tsk_/);
  assert.equal(stderr.toString().trim(), "");
});
