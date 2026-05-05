import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

test("TypeScript SDK exposes adapter-managed submit without caller-supplied artifacts", () => {
  assert.doesNotThrow(() => {
    execFileSync(
      "npx",
      [
        "tsc",
        "--noEmit",
        "--ignoreConfig",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--strict",
        "--types",
        "node",
        "test/fixtures/sdk-submit-contract.ts",
      ],
      { cwd: new URL("..", import.meta.url), stdio: "pipe" },
    );
  });
});

test("OpenAPI TaskSubmitRequest supports adapter-managed submit and keeps artifact mode optional", () => {
  const spec = readFileSync(new URL("../docs/api/task-lifecycle.openapi.yaml", import.meta.url), "utf8");
  const schemaStart = spec.indexOf("    TaskSubmitRequest:");
  const schemaEnd = spec.indexOf("    TaskSubmissionResponse:", schemaStart);
  assert.notEqual(schemaStart, -1, "TaskSubmitRequest schema should exist");
  assert.notEqual(schemaEnd, -1, "TaskSubmissionResponse schema should follow TaskSubmitRequest");

  const schema = spec.slice(schemaStart, schemaEnd);
  assert.match(schema, /required:\s*\[summary\]/);
  assert.match(schema, /mode:/);
  assert.match(schema, /enum:\s*\[adapter_managed,\s*artifact\]/);
  assert.match(schema, /pullRequest:/);
  assert.match(schema, /artifacts:/);
});
