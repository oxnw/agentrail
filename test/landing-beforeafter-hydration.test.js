import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const beforeAfterPath = path.join(repoRoot, "landing-next/components/BeforeAfter.tsx");

test("BeforeAfter SVG path strings are rounded for stable hydration", () => {
  const source = readFileSync(beforeAfterPath, "utf8");
  assert.match(source, /function fmt\(/);
  assert.match(source, /function svgPathPoint\(/);
  assert.match(source, /svgPathPoint\(from\)/);
  assert.match(source, /svgPathPoint\(c1\)/);
  assert.match(source, /svgPathPoint\(c2\)/);
  assert.match(source, /svgPathPoint\(to\)/);
  assert.match(source, /toFixed\(2\)}s/);
  assert.doesNotMatch(source, /`M \$\{from\[0\]\} \$\{from\[1\]\} C/);
  assert.doesNotMatch(source, /dur=\{`\$\{3\+r\(seed\)\*2\}s`\}/);
});
