import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;

test("Mintlify docs proxy targets the /docs upstream so generated links stay under /docs", () => {
  const routeSource = readFileSync(
    path.join(repoRoot, "landing-next/app/docs/[[...slug]]/route.ts"),
    "utf8",
  );

  assert.match(
    routeSource,
    /https:\/\/agentrail\.mintlify\.dev\/docs/,
    "the /docs proxy must fetch Mintlify's /docs subpath so Mintlify emits /docs links",
  );
  assert.doesNotMatch(
    routeSource,
    /https:\/\/agentrail\.mintlify\.app/,
    "proxying the root mintlify.app site makes Mintlify emit root-relative documentation links",
  );
});
