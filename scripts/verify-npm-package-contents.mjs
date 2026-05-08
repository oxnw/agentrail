#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FORBIDDEN_SEGMENTS = new Set([".idea", ".vscode", "browser-artifacts"]);
const FORBIDDEN_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".tgz"];

export function findForbiddenPackageFiles(files) {
  return files
    .map((filePath) => String(filePath).replace(/\\/gu, "/"))
    .filter((filePath) => {
      const segments = filePath.split("/");
      const basename = segments.at(-1) ?? filePath;

      if (basename === ".env" || (basename.startsWith(".env.") && basename !== ".env.example")) {
        return true;
      }
      if (FORBIDDEN_EXTENSIONS.some((extension) => basename.toLowerCase().endsWith(extension))) {
        return true;
      }
      return segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment));
    })
    .sort();
}

function packageFilesFromDryRun() {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_cache: process.env.npm_config_cache ?? path.join(os.tmpdir(), "agentrail-npm-cache"),
    },
  });
  const packages = parseJsonOutput(output);
  return packages.flatMap((entry) => Array.isArray(entry.files) ? entry.files.map((file) => file.path) : []);
}

function parseJsonOutput(output) {
  try {
    return JSON.parse(output);
  } catch {
    const start = output.indexOf("[");
    const end = output.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error(`npm pack did not return parseable JSON output:\n${output}`);
    }
    return JSON.parse(output.slice(start, end + 1));
  }
}

function main() {
  const files = packageFilesFromDryRun();
  const forbidden = findForbiddenPackageFiles(files);
  if (forbidden.length > 0) {
    console.error("Refusing to pack @agentrail-core/cli because forbidden files would be published:");
    for (const filePath of forbidden) {
      console.error(`- ${filePath}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`npm package content guard passed (${files.length} files checked).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
