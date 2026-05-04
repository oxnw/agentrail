import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [, , packageArg] = process.argv;

if (!packageArg) {
  console.error("Usage: node scripts/smoke-test-typescript-sdk.mjs <package.tgz>");
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.resolve(repoRoot, packageArg);
const tempDir = await mkdtemp(path.join(tmpdir(), "agentrail-ts-sdk-"));

try {
  await writeFile(
    path.join(tempDir, "package.json"),
    JSON.stringify(
      {
        name: "agentrail-ts-sdk-smoke",
        private: true,
        type: "module",
      },
      null,
      2,
    ),
  );

  execFileSync("npm", ["install", "--no-package-lock", packagePath], {
    cwd: tempDir,
    stdio: "inherit",
  });

  await writeFile(
    path.join(tempDir, "smoke.mjs"),
    [
      'import { AgentRailClient, DEFAULT_BASE_URL } from "@agentrail-core/sdk";',
      "",
      'const client = new AgentRailClient({ baseUrl: "http://127.0.0.1:3000", apiKey: "smoke-test-key" });',
      'if (!(client instanceof AgentRailClient)) throw new Error("Client export missing");',
      'if (DEFAULT_BASE_URL !== "http://127.0.0.1:3000") throw new Error("Default base URL mismatch");',
      'console.log("TypeScript SDK smoke test passed.");',
      "",
    ].join("\n"),
  );

  execFileSync("node", ["smoke.mjs"], {
    cwd: tempDir,
    stdio: "inherit",
  });
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
