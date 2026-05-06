import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;

test("OpenAPI lint script validates lifecycle and intake routing contracts", () => {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const lintScript = packageJson.scripts?.["lint:openapi"] ?? "";

  assert.match(lintScript, /docs\/api\/task-lifecycle\.openapi\.yaml/, "package.json lint:openapi should include task lifecycle OpenAPI");
  assert.match(lintScript, /docs\/api\/intake-routing-admin\.openapi\.yaml/, "package.json lint:openapi should include intake routing OpenAPI");
});

test("integration guide labels current, legacy, and planned behavior by capability", () => {
  const guide = readFileSync(path.join(repoRoot, "docs/integration-guide.md"), "utf8");
  const requiredCapabilities = [
    "Intake",
    "Routing",
    "Auth",
    "Local/self-hosted setup",
    "Live task store",
    "Submit",
    "CI / review",
    "Ship",
  ];

  for (const capability of requiredCapabilities) {
    const escaped = capability.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const row = new RegExp(
      `\\|\\s*${escaped}\\s*\\|\\s*\\*\\*Current:\\*\\*[\\s\\S]*?\\|\\s*\\*\\*Legacy:\\*\\*[\\s\\S]*?\\|\\s*\\*\\*Planned:\\*\\*`,
    );

    assert.match(guide, row, `${capability} should have Current, Legacy, and Planned labels`);
  }
});

test("local setup CLI contract defines two-phase setup and runner next commands", () => {
  const contract = readFileSync(
    path.join(repoRoot, "docs/architecture/local-self-hosted-setup-cli-contract.md"),
    "utf8",
  );

  for (const requiredText of [
    "agentrail init",
    "agentrail server start",
    "agentrail agent create",
    "agentrail agent connect",
    "agentrail doctor",
    "GET /tasks/mine?status=in_progress&limit=1",
    "source .agentrail/agent.env && cd /path/to/target-repo && codex",
    'claude --append-system-prompt-file "$AGENTRAIL_AGENT_RECIPE_PATH"',
    "cursor /path/to/target-repo",
  ]) {
    assert.match(contract, new RegExp(escapeRegExp(requiredText)), `setup CLI contract should include ${requiredText}`);
  }
});

test("quick-start and integration guide make doctor the onboarding gate and link back to setup rationale issues", () => {
  const quickStart = readFileSync(path.join(repoRoot, "docs/quick-start.md"), "utf8");
  const integrationGuide = readFileSync(path.join(repoRoot, "docs/integration-guide.md"), "utf8");

  assert.match(quickStart, /agentrail doctor/i, "quick-start.md should mention agentrail doctor");
  assert.match(quickStart, /AGEA-95/, "quick-start.md should reference AGEA-95");
  assert.match(quickStart, /AGEA-93/, "quick-start.md should reference AGEA-93");
  assert.match(quickStart, /Advanced Manual Lifecycle Calls/i, "quick-start.md should include Advanced Manual Lifecycle Calls");

  assert.match(integrationGuide, /agentrail init/i, "integration-guide.md should mention agentrail init");
  assert.match(integrationGuide, /agentrail doctor/i, "integration-guide.md should mention agentrail doctor");
  assert.match(integrationGuide, /AGEA-95/, "integration-guide.md should reference AGEA-95");
  assert.match(integrationGuide, /AGEA-93/, "integration-guide.md should reference AGEA-93");
});

test("README docker compose quickstart has a compose file", () => {
  const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const composeFiles = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

  if (/docker compose/i.test(readme)) {
    assert.ok(
      composeFiles.some((file) => existsSync(path.join(repoRoot, file))),
      "README references docker compose, but no compose file exists",
    );
  }
});

test("local markdown links resolve to checked-in files and headings", () => {
  const markdownFiles = listMarkdownFiles(repoRoot);
  const failures = [];

  for (const filePath of markdownFiles) {
    const content = stripCodeFences(readFileSync(filePath, "utf8"));
    const links = content.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g);

    for (const link of links) {
      const target = normalizeMarkdownTarget(link[1]);
      if (!target || shouldSkipTarget(target)) continue;

      const [targetPath, rawHash] = target.split("#", 2);
      const resolvedPath = targetPath
        ? path.resolve(path.dirname(filePath), decodeURIComponent(targetPath))
        : filePath;

      if (!existsSync(resolvedPath)) {
        failures.push(`${relative(filePath)} -> ${target}`);
        continue;
      }

      if (rawHash) {
        const headings = headingAnchors(readFileSync(resolvedPath, "utf8"));
        if (!headings.has(rawHash.toLowerCase())) {
          failures.push(`${relative(filePath)} -> ${target}`);
        }
      }
    }
  }

  assert.deepEqual(failures, []);
});

function listMarkdownFiles(directory) {
  const entries = readdirSync(directory);
  const files = [];

  for (const entry of entries) {
    if (entry === ".git" || entry === "node_modules") continue;

    const filePath = path.join(directory, entry);
    const stats = statSync(filePath);

    if (stats.isDirectory()) {
      files.push(...listMarkdownFiles(filePath));
    } else if (filePath.endsWith(".md")) {
      files.push(filePath);
    }
  }

  return files;
}

function stripCodeFences(content) {
  return content.replace(/```[\s\S]*?```/g, "");
}

function normalizeMarkdownTarget(rawTarget) {
  const trimmed = rawTarget.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1);
  }

  return trimmed.split(/\s+/)[0];
}

function shouldSkipTarget(target) {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(target) ||
    target.startsWith("//") ||
    target.startsWith("mailto:") ||
    /^\/[A-Z0-9]+\/(?:issues|agents|projects|approvals)\//.test(target)
  );
}

function headingAnchors(content) {
  const anchors = new Set();

  for (const match of content.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    anchors.add(slugHeading(match[1]));
  }

  return anchors;
}

function slugHeading(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function relative(filePath) {
  return path.relative(repoRoot, filePath);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
