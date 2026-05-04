import test from "node:test";
import assert from "node:assert/strict";
import { createMockGitHubServer } from "./mock-github-server.js";

test("mock server records requests and returns fixture PRs", async () => {
  const server = createMockGitHubServer({ port: 9998 });
  await server.start();

  const res = await fetch("http://localhost:9998/repos/acme/webapp/pulls", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Test", head: "feat/x", base: "main" }),
  });

  assert.equal(res.status, 201);
  const json = await res.json();
  assert.equal(json.number, 42);
  assert.equal(json.html_url, "https://github.com/acme/webapp/pull/42");

  const requests = server.getRequests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");

  await server.stop();
});
