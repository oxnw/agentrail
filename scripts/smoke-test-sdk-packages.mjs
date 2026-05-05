#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const runTypescript = args.size === 0 || args.has("--typescript") || args.has("--all");
const runPython = args.size === 0 || args.has("--python") || args.has("--all");

if (!runTypescript && !runPython) {
  console.error("Usage: node scripts/smoke-test-sdk-packages.mjs [--typescript] [--python] [--all]");
  process.exit(1);
}

const tempDir = await mkdtemp(path.join(tmpdir(), "agentrail-sdk-packages-"));

try {
  if (runTypescript) {
    await smokeTypescriptSdk(tempDir);
  }
  if (runPython) {
    await smokePythonSdk(tempDir);
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

async function smokeTypescriptSdk(tempDir) {
  const packDir = path.join(tempDir, "typescript");
  await mkdir(packDir, { recursive: true });
  execFileSync("npm", ["ci"], {
    cwd: path.join(repoRoot, "sdk", "typescript"),
    stdio: "inherit",
  });
  execFileSync("npm", ["run", "build"], {
    cwd: path.join(repoRoot, "sdk", "typescript"),
    stdio: "inherit",
  });
  execFileSync("npm", ["pack", "--pack-destination", packDir], {
    cwd: path.join(repoRoot, "sdk", "typescript"),
    stdio: "inherit",
  });

  const packed = (await readdir(packDir)).find((name) => name.endsWith(".tgz"));
  if (!packed) {
    throw new Error("TypeScript SDK pack did not produce a .tgz file.");
  }

  execFileSync(
    process.execPath,
    ["scripts/smoke-test-typescript-sdk.mjs", path.join(packDir, packed)],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );
}

async function smokePythonSdk(tempDir) {
  const python = findPython();
  const wheelDir = path.join(tempDir, "python");
  await mkdir(wheelDir, { recursive: true });

  execFileSync(
    python,
    ["-m", "pip", "wheel", "--no-deps", "--wheel-dir", wheelDir, "sdk/python"],
    {
      cwd: repoRoot,
      env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: "1" },
      stdio: "inherit",
    },
  );

  const wheel = (await readdir(wheelDir)).find((name) => name.endsWith(".whl"));
  if (!wheel) {
    throw new Error("Python SDK wheel build did not produce a .whl file.");
  }

  execFileSync("scripts/smoke-test-python-sdk.sh", [path.join(wheelDir, wheel)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PYTHON_BIN: python,
    },
    stdio: "inherit",
  });
}

function findPython() {
  const candidates = ["python3.12", "python3.11", "python3.10", "python3", "python"];
  for (const candidate of candidates) {
    try {
      const resolved = execFileSync("sh", ["-c", `command -v ${candidate}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (resolved) {
        return resolved;
      }
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error("python3.10+ is required for the Python SDK smoke.");
}
