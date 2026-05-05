// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";

const removedInternalArtifacts = [
  "verify-browser.mjs",
  "verify-waitlist.mjs",
  "verify-waitlist-api.mjs",
  "verify-landing-claims.mjs",
  "benchmarks/landing-page-claims/benchmark-github-review-feedback.mjs",
  "benchmarks/landing-page-claims/results.json",
  "scripts/phase1-dogfood.mjs",
  "scripts/phase2-dogfood.mjs",
  "scripts/phase3-dogfood.mjs",
  "scripts/phase4-dogfood.mjs",
  "scripts/live-e2e.mjs",
  "scripts/test-github-submit.sh",
  "waitlist-server.mjs",
  "openapi/waitlist.yaml",
  "index-light.html",
  "original-index-light.html",
  "docs/dogfood-setup.md",
  "docs/cloud.md",
  "ROADMAP.md",
  "docs/adr/0001-task-lifecycle-api.md",
  "docs/adr/0002-sdk-generation-and-contract-gates.md",
  "docs/adr/0002-task-lifecycle-push-delivery.md",
  "docs/adr/0003-task-lifecycle-sse-replay-buffer.md",
  "docs/adr/0003-task-webhook-worker-implementation.md",
  "docs/adr/0004-github-actions-ci-status-adapter.md",
  "docs/adr/0005-agent-authentication-model.md",
  "docs/adr/0006-waitlist-workflow.md",
  "docs/adr/0007-circleci-ci-adapter.md",
  "docs/superpowers/plans/2026-05-04-github-submit-integration-test.md"
];

const keptPublicArtifacts = [
  "landing/index-light.html",
  "scripts/agentrail-e2e-demo.mjs",
  "docs/demo/agentrail-e2e-demo.md",
  "docs/api/task-lifecycle.openapi.yaml"
];

for (const relativePath of removedInternalArtifacts) {
  test(`public repo excludes ${relativePath}`, async () => {
    await assert.rejects(
      access(relativePath, constants.F_OK),
      (error) => error?.code === "ENOENT"
    );
  });
}

for (const relativePath of keptPublicArtifacts) {
  test(`public repo keeps ${relativePath}`, async () => {
    await access(relativePath, constants.F_OK);
  });
}

test(".gitignore blocks local env files but keeps the public template", async () => {
  const gitignore = await readFile(".gitignore", "utf8");

  assert.match(gitignore, /^AGENTS\.md$/m);
  assert.match(gitignore, /^\.env$/m);
  assert.match(gitignore, /^\.env\.\*$/m);
  assert.match(gitignore, /^!\.env\.example$/m);
});

test("TypeScript source is canonical with no side-by-side JavaScript duplicates", async () => {
  const duplicates = await findSideBySideSourceDuplicates(["src", "test", "sdk/typescript/src"]);

  assert.deepEqual(duplicates, []);
});

test("TypeScript source duplicate guard scans nested directories", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentrail-duplicate-source-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  const nestedDir = path.join(tempDir, "nested", "adapters");
  await mkdir(nestedDir, { recursive: true });
  await writeFile(path.join(nestedDir, "provider.js"), "export const provider = null;\n");
  await writeFile(path.join(nestedDir, "provider.ts"), "export const provider = null;\n");

  assert.deepEqual(await findSideBySideSourceDuplicates([tempDir]), [
    path.join(nestedDir, "provider.js"),
    path.join(nestedDir, "provider.ts"),
  ]);
});

test("runtime scripts execute TypeScript entrypoints directly", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(packageJson.scripts.start, "node src/server.ts");
  assert.equal(
    packageJson.scripts["smoke:sandbox:live"],
    "npm --prefix sdk/typescript ci && npm --prefix sdk/typescript run build && node scripts/agentrail-sandbox-smoke.mjs --mode live",
  );
  assert.match(packageJson.scripts["test:service"], /test\/\*\.test\.ts/);
  assert.doesNotMatch(JSON.stringify(packageJson.scripts), /src\/[^"]+\.js/);

  const tsconfig = JSON.parse(await readFile("tsconfig.json", "utf8"));
  assert.equal(tsconfig.compilerOptions.allowJs, undefined);
  assert.equal(tsconfig.compilerOptions.checkJs, undefined);
});

async function findSideBySideSourceDuplicates(roots) {
  const duplicates = [];

  for (const root of roots) {
    const files = await listSourceFiles(root);
    const stemsByExtension = new Map();

    for (const filePath of files) {
      const match = filePath.match(/^(.*)\.(js|ts)$/);
      if (!match) continue;

      const [, stem, extension] = match;
      const extensions = stemsByExtension.get(stem) ?? new Set();
      extensions.add(extension);
      stemsByExtension.set(stem, extensions);
    }

    for (const [stem, extensions] of stemsByExtension) {
      if (extensions.has("js") && extensions.has("ts")) {
        duplicates.push(`${stem}.js`);
        duplicates.push(`${stem}.ts`);
      }
    }
  }

  return duplicates.sort();
}

async function listSourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(entryPath));
    } else if (entry.isFile() && /\.(js|ts)$/.test(entry.name)) {
      files.push(entryPath);
    }
  }

  return files;
}
