import path from "node:path";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

import type { ConnectedRepo, SetupConfigLike } from "./agentrail-home.ts";

type ProviderName = "github" | "circleci" | "linear";

export interface ReadinessCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  category: "auth" | "remote" | "repo" | "policy" | "runtime";
  details: string;
  repoSlug?: string;
  autofixable?: boolean;
  fixKind?: "github_actions_workflow" | "circleci_config";
}

export interface ProviderReadinessReport {
  provider: ProviderName;
  status: "ready" | "blocked";
  summary: string;
  checks: ReadinessCheck[];
}

export async function evaluateProviderReadiness(
  provider: ProviderName,
  config: SetupConfigLike,
  env: Record<string, string>,
  fetchImpl: typeof globalThis.fetch,
): Promise<ProviderReadinessReport> {
  if (provider === "github") {
    return evaluateGitHubReadiness(config, env, fetchImpl);
  }
  if (provider === "circleci") {
    return evaluateCircleCiReadiness(config, env, fetchImpl);
  }
  return evaluateLinearReadiness(config, env, fetchImpl);
}

export async function applyProviderReadinessFixes(
  provider: ProviderName,
  config: SetupConfigLike,
  report: ProviderReadinessReport,
): Promise<{ changed: boolean; applied: string[] }> {
  if (provider === "github") {
    return applyGitHubFixes(config, report);
  }
  if (provider === "circleci") {
    return applyCircleCiFixes(config, report);
  }
  return { changed: false, applied: [] };
}

export function renderReadinessSummary(report: ProviderReadinessReport): string {
  const failures = report.checks.filter((check) => check.status === "fail").length;
  const warnings = report.checks.filter((check) => check.status === "warn").length;
  return `${providerLabel(report.provider)}: ${report.status}${failures > 0 ? `, ${failures} failing` : ""}${warnings > 0 ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}`;
}

export function renderReadinessReport(report: ProviderReadinessReport): string {
  const lines = [
    `${providerLabel(report.provider)} readiness: ${report.status}`,
    report.summary,
    "",
  ];
  for (const check of report.checks) {
    const prefix = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    const scope = check.repoSlug ? ` (${check.repoSlug})` : "";
    lines.push(`- [${prefix}] ${check.label}${scope}: ${check.details}`);
  }
  lines.push("");
  return lines.join("\n");
}

function providerLabel(provider: ProviderName): string {
  if (provider === "github") return "GitHub";
  if (provider === "circleci") return "CircleCI";
  return "Linear";
}

async function evaluateGitHubReadiness(
  config: SetupConfigLike,
  env: Record<string, string>,
  fetchImpl: typeof globalThis.fetch,
): Promise<ProviderReadinessReport> {
  const checks: ReadinessCheck[] = [];
  const provider = config.providers?.github;
  if (provider?.mode !== "real") {
    checks.push(fail("github_connected", "GitHub connected", "GitHub is not connected yet. Run `agentrail provider connect github`.", "auth"));
    return blockedReport("github", checks);
  }

  const tokenEnv = provider.tokenEnv ?? "GITHUB_TOKEN";
  const token = resolveConfiguredValue(tokenEnv, env);
  if (!token) {
    checks.push(fail("github_token", "GitHub token available", `${tokenEnv} is not available in ~/.agentrail/provider.env or the current shell.`, "auth"));
    return blockedReport("github", checks);
  }
  checks.push(pass("github_token", "GitHub token available", `${tokenEnv} is available.`, "auth"));

  try {
    await verifyGitHubViewer(token, fetchImpl);
    checks.push(pass("github_auth_remote", "GitHub token accepted", "GitHub accepted the configured token.", "remote"));
  } catch (error) {
    checks.push(fail("github_auth_remote", "GitHub token accepted", errorMessage(error), "remote"));
    return blockedReport("github", checks);
  }

  const repos = configuredGitHubRepos(config.repos);
  for (const repo of repos) {
    try {
      await verifyGitHubRepo(token, repo.slug, fetchImpl);
      checks.push(pass(`github_repo_access:${repo.slug}`, "Repository access", "AgentRail can access the repository.", "remote", repo.slug));
    } catch (error) {
      checks.push(fail(`github_repo_access:${repo.slug}`, "Repository access", errorMessage(error), "remote", repo.slug));
      continue;
    }

    if (repo.circleciProjectSlug) {
      checks.push(pass(`github_ci_external:${repo.slug}`, "CI provider mapping", `Repo is mapped to CircleCI (${repo.circleciProjectSlug}); GitHub Actions workflow readiness is not required for this repo.`, "repo", repo.slug));
      continue;
    }

    const localWorkflowFiles = await listGitHubWorkflowFiles(repo.path);
    if (localWorkflowFiles.length === 0) {
      checks.push(fail(
        `github_actions_files:${repo.slug}`,
        "GitHub Actions workflow files",
        "No workflow files were found under `.github/workflows`. AgentRail cannot verify GitHub-based CI for PRs without a workflow.",
        "repo",
        repo.slug,
        true,
        "github_actions_workflow",
      ));
    } else {
      checks.push(pass(
        `github_actions_files:${repo.slug}`,
        "GitHub Actions workflow files",
        `Found ${localWorkflowFiles.length} workflow file${localWorkflowFiles.length === 1 ? "" : "s"} in the local repo checkout.`,
        "repo",
        repo.slug,
      ));
      const relevantWorkflow = await hasRelevantGitHubWorkflow(repo.path, localWorkflowFiles);
      if (!relevantWorkflow) {
        checks.push(fail(
          `github_actions_triggers:${repo.slug}`,
          "PR or branch CI trigger",
          "No local workflow advertises a `pull_request` or `push` trigger. AgentRail PRs need at least one relevant CI trigger.",
          "runtime",
          repo.slug,
        ));
      } else {
        checks.push(pass(
          `github_actions_triggers:${repo.slug}`,
          "PR or branch CI trigger",
          "At least one local workflow includes a PR or push trigger.",
          "runtime",
          repo.slug,
        ));
      }
    }

    try {
      const workflows = await listRemoteGitHubWorkflows(token, repo.slug, fetchImpl);
      const active = workflows.filter((workflow) => workflow.state === "active");
      if (active.length === 0) {
        checks.push(fail(
          `github_actions_remote:${repo.slug}`,
          "GitHub Actions enabled workflows",
          "GitHub does not report any active workflows for the repository default branch.",
          "remote",
          repo.slug,
        ));
      } else {
        checks.push(pass(
          `github_actions_remote:${repo.slug}`,
          "GitHub Actions enabled workflows",
          `GitHub reports ${active.length} active workflow${active.length === 1 ? "" : "s"}.`,
          "remote",
          repo.slug,
        ));
      }
    } catch (error) {
      checks.push(fail(
        `github_actions_remote:${repo.slug}`,
        "GitHub Actions enabled workflows",
        errorMessage(error),
        "remote",
        repo.slug,
      ));
    }
  }

  return finalizeReport("github", checks);
}

async function evaluateCircleCiReadiness(
  config: SetupConfigLike,
  env: Record<string, string>,
  fetchImpl: typeof globalThis.fetch,
): Promise<ProviderReadinessReport> {
  const checks: ReadinessCheck[] = [];
  const provider = config.providers?.circleci;
  if (provider?.mode !== "real") {
    checks.push(fail("circleci_connected", "CircleCI connected", "CircleCI is not connected yet. Run `agentrail provider connect circleci`.", "auth"));
    return blockedReport("circleci", checks);
  }

  const tokenEnv = provider.tokenEnv ?? "CIRCLECI_TOKEN";
  const token = resolveConfiguredValue(tokenEnv, env);
  if (!token) {
    checks.push(fail("circleci_token", "CircleCI token available", `${tokenEnv} is not available in ~/.agentrail/provider.env or the current shell.`, "auth"));
    return blockedReport("circleci", checks);
  }
  checks.push(pass("circleci_token", "CircleCI token available", `${tokenEnv} is available.`, "auth"));

  const repos = configuredCircleCiRepos(config.repos);
  if (repos.length === 0) {
    checks.push(fail("circleci_project_slug", "CircleCI project slug", "No connected repo has a stored CircleCI project slug.", "repo"));
    return blockedReport("circleci", checks);
  }

  for (const repo of repos) {
    try {
      await verifyCircleCiProject(token, repo.circleciProjectSlug!, repo.defaultBranch, fetchImpl);
      checks.push(pass(
        `circleci_project:${repo.slug}`,
        "CircleCI project slug access",
        `CircleCI project slug ${repo.circleciProjectSlug} is accessible.`,
        "remote",
        repo.slug,
      ));
    } catch (error) {
      checks.push(fail(
        `circleci_project:${repo.slug}`,
        "CircleCI project slug access",
        errorMessage(error),
        "remote",
        repo.slug,
      ));
      continue;
    }

    const configPath = path.join(repo.path, ".circleci", "config.yml");
    if (await fileExists(configPath)) {
      checks.push(pass(
        `circleci_config:${repo.slug}`,
        "Local CircleCI config",
        "Found `.circleci/config.yml` in the local repo checkout.",
        "repo",
        repo.slug,
      ));
    } else {
      checks.push(fail(
        `circleci_config:${repo.slug}`,
        "Local CircleCI config",
        "`.circleci/config.yml` is missing from the local repo checkout. If this project uses the standard same-repo config source, CircleCI pipelines will fail until that file exists.",
        "repo",
        repo.slug,
        true,
        "circleci_config",
      ));
    }
  }

  return finalizeReport("circleci", checks);
}

async function evaluateLinearReadiness(
  config: SetupConfigLike,
  env: Record<string, string>,
  fetchImpl: typeof globalThis.fetch,
): Promise<ProviderReadinessReport> {
  const checks: ReadinessCheck[] = [];
  const provider = config.providers?.linear;
  if (provider?.mode !== "real") {
    checks.push(fail("linear_connected", "Linear connected", "Linear is not connected yet. Run `agentrail provider connect linear`.", "auth"));
    return blockedReport("linear", checks);
  }

  const tokenEnv = provider.tokenEnv ?? "LINEAR_API_KEY";
  const token = resolveConfiguredValue(tokenEnv, env);
  if (!token) {
    checks.push(fail("linear_token", "Linear API key available", `${tokenEnv} is not available in ~/.agentrail/provider.env or the current shell.`, "auth"));
    return blockedReport("linear", checks);
  }
  checks.push(pass("linear_token", "Linear API key available", `${tokenEnv} is available.`, "auth"));

  try {
    const teams = await queryLinearTeams(token, fetchImpl);
    checks.push(pass("linear_workspace", "Linear workspace access", "Linear accepted the configured API key.", "remote"));
    if (teams.length === 0) {
      checks.push(warn("linear_teams", "Linear teams visible", "Linear returned no visible teams for the API key. Issue import may still be blocked by workspace configuration.", "remote"));
    } else {
      checks.push(pass("linear_teams", "Linear teams visible", `Linear returned ${teams.length} visible team${teams.length === 1 ? "" : "s"}.`, "remote"));
    }
  } catch (error) {
    checks.push(fail("linear_workspace", "Linear workspace access", errorMessage(error), "remote"));
  }

  return finalizeReport("linear", checks);
}

async function applyGitHubFixes(
  config: SetupConfigLike,
  report: ProviderReadinessReport,
): Promise<{ changed: boolean; applied: string[] }> {
  const fixes = report.checks.filter((check) => check.status === "fail" && check.autofixable && check.fixKind === "github_actions_workflow");
  if (fixes.length === 0) {
    return { changed: false, applied: [] };
  }
  const applied: string[] = [];
  for (const check of fixes) {
    const repo = (config.repos ?? []).find((candidate) => candidate.slug === check.repoSlug);
    if (!repo) continue;
    const packageScripts = await readPackageScripts(repo.path);
    const workflowPath = path.join(repo.path, ".github", "workflows", "agentrail-ci.yml");
    await mkdir(path.dirname(workflowPath), { recursive: true });
    await writeFile(workflowPath, buildGitHubActionsWorkflow(packageScripts), "utf8");
    applied.push(`${repo.slug}: created .github/workflows/agentrail-ci.yml`);
  }
  return { changed: applied.length > 0, applied };
}

async function applyCircleCiFixes(
  config: SetupConfigLike,
  report: ProviderReadinessReport,
): Promise<{ changed: boolean; applied: string[] }> {
  const fixes = report.checks.filter((check) => check.status === "fail" && check.autofixable && check.fixKind === "circleci_config");
  if (fixes.length === 0) {
    return { changed: false, applied: [] };
  }
  const applied: string[] = [];
  for (const check of fixes) {
    const repo = (config.repos ?? []).find((candidate) => candidate.slug === check.repoSlug);
    if (!repo) continue;
    const packageScripts = await readPackageScripts(repo.path);
    const configPath = path.join(repo.path, ".circleci", "config.yml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, buildCircleCiConfig(packageScripts), "utf8");
    applied.push(`${repo.slug}: created .circleci/config.yml`);
  }
  return { changed: applied.length > 0, applied };
}

function configuredGitHubRepos(repos: SetupConfigLike["repos"]): ConnectedRepo[] {
  return (repos ?? []).filter((repo): repo is ConnectedRepo =>
    typeof repo?.slug === "string"
    && /^[^/\s]+\/[^/\s]+$/u.test(repo.slug)
    && typeof repo.path === "string"
    && typeof repo.defaultBranch === "string");
}

function configuredCircleCiRepos(repos: SetupConfigLike["repos"]): Array<ConnectedRepo & { circleciProjectSlug: string }> {
  return (repos ?? []).flatMap((repo) => {
    if (!repo?.circleciProjectSlug || typeof repo.circleciProjectSlug !== "string" || repo.circleciProjectSlug.trim().length === 0) {
      return [];
    }
    return [{
      ...repo,
      circleciProjectSlug: repo.circleciProjectSlug.trim(),
    }];
  });
}

async function listGitHubWorkflowFiles(repoPath: string): Promise<string[]> {
  const workflowsDir = path.join(repoPath, ".github", "workflows");
  try {
    const entries = await readdir(workflowsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.(ya?ml)$/u.test(entry.name))
      .map((entry) => path.join(workflowsDir, entry.name));
  } catch {
    return [];
  }
}

async function hasRelevantGitHubWorkflow(repoPath: string, workflowFiles: string[]): Promise<boolean> {
  for (const workflowPath of workflowFiles) {
    const relative = path.relative(repoPath, workflowPath).replace(/\\/gu, "/");
    const content = await readFile(workflowPath, "utf8").catch(() => "");
    if (!content) continue;
    const normalized = content.toLowerCase();
    if ((/\non:\s*/u.test(normalized) || normalized.startsWith("on:"))
      && (/\bpull_request\s*:/u.test(normalized) || /\bpush\s*:/u.test(normalized))) {
      return true;
    }
    if (relative.endsWith(".yml") || relative.endsWith(".yaml")) {
      if (normalized.includes("pull_request") || normalized.includes("push")) {
        return true;
      }
    }
  }
  return false;
}

async function readPackageScripts(repoPath: string): Promise<string[]> {
  try {
    const packageJson = JSON.parse(await readFile(path.join(repoPath, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    return Object.keys(packageJson.scripts ?? {});
  } catch {
    return [];
  }
}

function buildGitHubActionsWorkflow(packageScripts: string[]): string {
  const hasTypecheck = packageScripts.includes("typecheck");
  const hasTest = packageScripts.includes("test");
  const lines = [
    "name: AgentRail CI",
    "",
    "on:",
    "  pull_request:",
    "  push:",
    "",
    "jobs:",
    "  verify:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 22",
    "          cache: npm",
    "      - run: npm ci",
  ];
  if (hasTypecheck) {
    lines.push("      - run: npm run typecheck");
  }
  if (hasTest) {
    lines.push("      - run: npm test");
  }
  return `${lines.join("\n")}\n`;
}

function buildCircleCiConfig(packageScripts: string[]): string {
  const hasTypecheck = packageScripts.includes("typecheck");
  const hasTest = packageScripts.includes("test");
  const lines = [
    "version: 2.1",
    "",
    "jobs:",
    "  verify:",
    "    docker:",
    "      - image: cimg/node:22.11",
    "    steps:",
    "      - checkout",
    "      - run:",
    "          name: Install dependencies",
    "          command: npm ci",
  ];
  if (hasTypecheck) {
    lines.push(
      "      - run:",
      "          name: Typecheck",
      "          command: npm run typecheck",
    );
  }
  if (hasTest) {
    lines.push(
      "      - run:",
      "          name: Test",
      "          command: npm test",
    );
  }
  lines.push(
    "",
    "workflows:",
    "  version: 2",
    "  ci:",
    "    jobs:",
    "      - verify",
  );
  return `${lines.join("\n")}\n`;
}

async function verifyGitHubViewer(token: string, fetchImpl: typeof globalThis.fetch): Promise<void> {
  const response = await fetchImpl("https://api.github.com/user", { headers: githubHeaders(token) });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      response.status === 401 || response.status === 403
        ? "GitHub rejected the configured token."
        : `GitHub viewer lookup failed: ${response.status} ${text.slice(0, 200)}`.trim(),
    );
  }
}

async function verifyGitHubRepo(token: string, repoSlug: string, fetchImpl: typeof globalThis.fetch): Promise<void> {
  const response = await fetchImpl(`https://api.github.com/repos/${repoSlug}`, { headers: githubHeaders(token) });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      response.status === 401 || response.status === 403
        ? `GitHub rejected the token for ${repoSlug}.`
        : response.status === 404
          ? `GitHub repo ${repoSlug} is not accessible to this token.`
          : `GitHub repo lookup failed for ${repoSlug}: ${response.status} ${text.slice(0, 200)}`.trim(),
    );
  }
}

async function listRemoteGitHubWorkflows(token: string, repoSlug: string, fetchImpl: typeof globalThis.fetch): Promise<Array<{ state?: string; path?: string }>> {
  const response = await fetchImpl(`https://api.github.com/repos/${repoSlug}/actions/workflows`, {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      response.status === 401 || response.status === 403
        ? `GitHub Actions metadata is not accessible for ${repoSlug}.`
        : `GitHub Actions workflow lookup failed for ${repoSlug}: ${response.status} ${text.slice(0, 200)}`.trim(),
    );
  }
  const body = await response.json().catch(() => ({}));
  return Array.isArray(body?.workflows) ? body.workflows : [];
}

async function verifyCircleCiProject(token: string, projectSlug: string, branch: string, fetchImpl: typeof globalThis.fetch): Promise<void> {
  const response = await fetchImpl(`https://circleci.com/api/v2/project/${encodeCircleCiProjectSlug(projectSlug)}/pipeline?branch=${encodeURIComponent(branch || "main")}`, {
    headers: {
      "Circle-Token": token,
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      response.status === 401 || response.status === 403
        ? `CircleCI rejected the token for project slug ${projectSlug}.`
        : response.status === 404
          ? `CircleCI project slug ${projectSlug} was not found or is not accessible to this token.`
          : `CircleCI project lookup failed for ${projectSlug}: ${response.status} ${text.slice(0, 200)}`.trim(),
    );
  }
}

async function queryLinearTeams(token: string, fetchImpl: typeof globalThis.fetch): Promise<string[]> {
  const response = await fetchImpl("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: token,
    },
    body: JSON.stringify({
      query: "query AgentRailReadiness { viewer { id } teams(first: 10) { nodes { id key name } } }",
    }),
  });
  const text = await response.text().catch(() => "");
  const body = text ? JSON.parse(text) as { data?: { teams?: { nodes?: Array<{ key?: string; name?: string }> } }; errors?: Array<{ message?: string }> } : {};
  if (!response.ok || Array.isArray(body.errors)) {
    const message = Array.isArray(body.errors) && body.errors.length > 0
      ? body.errors.map((error) => error?.message).filter(Boolean).join("; ")
      : text.slice(0, 200);
    throw new Error(
      response.status === 401 || response.status === 403
        ? "Linear rejected the configured API key."
        : `Linear workspace lookup failed: ${message}`.trim(),
    );
  }
  return (body.data?.teams?.nodes ?? []).map((team) => team.key ?? team.name ?? "").filter(Boolean);
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };
}

function resolveConfiguredValue(envName: string, env: Record<string, string>): string | null {
  return env[envName] ?? process.env[envName] ?? null;
}

function encodeCircleCiProjectSlug(projectSlug: string): string {
  return projectSlug.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function finalizeReport(provider: ProviderName, checks: ReadinessCheck[]): ProviderReadinessReport {
  const failing = checks.filter((check) => check.status === "fail");
  const summary = failing.length === 0
    ? `${providerLabel(provider)} is ready for its current setup path.`
    : `${providerLabel(provider)} is blocked by ${failing.length} readiness issue${failing.length === 1 ? "" : "s"}.`;
  return {
    provider,
    status: failing.length === 0 ? "ready" : "blocked",
    summary,
    checks,
  };
}

function blockedReport(provider: ProviderName, checks: ReadinessCheck[]): ProviderReadinessReport {
  return {
    provider,
    status: "blocked",
    summary: `${providerLabel(provider)} is blocked by setup issues.`,
    checks,
  };
}

function pass(id: string, label: string, details: string, category: ReadinessCheck["category"], repoSlug?: string): ReadinessCheck {
  return { id, label, details, category, repoSlug, status: "pass" };
}

function warn(id: string, label: string, details: string, category: ReadinessCheck["category"], repoSlug?: string): ReadinessCheck {
  return { id, label, details, category, repoSlug, status: "warn" };
}

function fail(
  id: string,
  label: string,
  details: string,
  category: ReadinessCheck["category"],
  repoSlug?: string,
  autofixable = false,
  fixKind?: ReadinessCheck["fixKind"],
): ReadinessCheck {
  return { id, label, details, category, repoSlug, status: "fail", autofixable, fixKind };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
