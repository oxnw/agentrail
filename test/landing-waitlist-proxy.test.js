import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const routePath = path.join(repoRoot, "landing-next/app/waitlist/route.ts");
const comparePath = path.join(repoRoot, "landing-next/components/Compare.tsx");

test("landing waitlist route proxies same-origin submissions to the AgentRail API", () => {
  assert.ok(
    existsSync(routePath),
    "Vercel landing app must expose /waitlist because the form posts same-origin",
  );

  const routeSource = readFileSync(routePath, "utf8");
  assert.match(routeSource, /https:\/\/api\.agentrail\.app\/waitlist/);
  assert.match(routeSource, /export async function POST/);
  assert.match(routeSource, /cache:\s*["']no-store["']/);
});

test("landing waitlist form does not report HTML/API errors as network failures", () => {
  const compareSource = readFileSync(comparePath, "utf8");
  assert.doesNotMatch(compareSource, /const data = await res\.json\(\);/);
  assert.match(compareSource, /await res\.text\(\)/);
  assert.match(compareSource, /JSON\.parse/);
});

test("landing waitlist success copy does not promise a confirmation email", () => {
  const compareSource = readFileSync(comparePath, "utf8");
  assert.doesNotMatch(compareSource, /check your inbox/i);
  assert.match(compareSource, /We'll reach out when Cloud opens/);
});
