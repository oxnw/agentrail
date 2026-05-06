import assert from "node:assert/strict";
import test from "node:test";

import { parseDefaultBranch } from "../src/cli/repo-detection.ts";

test("parseDefaultBranch strips only the remote prefix", () => {
  assert.equal(parseDefaultBranch("origin/main"), "main");
  assert.equal(parseDefaultBranch("origin/release/2026"), "release/2026");
  assert.equal(parseDefaultBranch("upstream/hotfix/auth/token"), "hotfix/auth/token");
  assert.equal(parseDefaultBranch("main"), "main");
  assert.equal(parseDefaultBranch(null), null);
});
