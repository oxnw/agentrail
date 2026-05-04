import test from "node:test";
import assert from "node:assert/strict";

const [nodeMajor, nodeMinor] = process.versions.node
  .split(".")
  .map((part) => Number.parseInt(part, 10));
const supportsNativeTypeScript = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6);

test("TypeScript SDK source entrypoint imports under native Node TypeScript execution", {
  skip: supportsNativeTypeScript ? false : "requires Node >=22.6 native TypeScript execution",
}, async () => {
  const sdk = await import("../sdk/typescript/src/index.ts");

  assert.equal(typeof sdk.AgentRailClient, "function");
  assert.equal(sdk.DEFAULT_BASE_URL, "http://127.0.0.1:3000");
});

test("compiled TypeScript SDK fails fast when baseUrl is omitted", async () => {
  const distEntrypoint = new URL("../sdk/typescript/dist/index.js", import.meta.url).href;
  const { AgentRailClient } = await import(distEntrypoint);

  assert.throws(
    () => new AgentRailClient({ apiKey: "ar_probe" }),
    /baseUrl/i,
  );
});
