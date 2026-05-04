import http from "node:http";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { WaitlistStore, WaitlistValidationError } from "../src/waitlist-store.js";
import { createServer } from "../src/app.js";

describe("WaitlistStore", () => {
  it("adds an entry with valid email", () => {
    const store = new WaitlistStore();
    const result = store.addEntry({ email: "test@example.com", name: "Test User" });
    assert.equal(result.alreadyExists, false);
    assert.equal(result.entry.email, "test@example.com");
    assert.equal(result.entry.name, "Test User");
    assert.ok(result.entry.id.startsWith("wl_"));
  });

  it("normalizes email to lowercase", () => {
    const store = new WaitlistStore();
    const result = store.addEntry({ email: "Test@Example.COM" });
    assert.equal(result.entry.email, "test@example.com");
  });

  it("returns alreadyExists for duplicate email", () => {
    const store = new WaitlistStore();
    store.addEntry({ email: "dup@example.com" });
    const result = store.addEntry({ email: "dup@example.com" });
    assert.equal(result.alreadyExists, true);
  });

  it("rejects missing email", () => {
    const store = new WaitlistStore();
    assert.throws(() => store.addEntry({}), WaitlistValidationError);
  });

  it("rejects invalid email format", () => {
    const store = new WaitlistStore();
    assert.throws(() => store.addEntry({ email: "notanemail" }), WaitlistValidationError);
  });

  it("respects idempotency key", () => {
    const store = new WaitlistStore();
    const r1 = store.addEntry({ email: "idem@example.com" }, "key-1");
    const r2 = store.addEntry({ email: "other@example.com" }, "key-1");
    assert.equal(r1.entry.id, r2.entry.id);
  });

  it("lists all entries", () => {
    const store = new WaitlistStore();
    store.addEntry({ email: "a@b.com" });
    store.addEntry({ email: "c@d.com" });
    const list = store.listEntries();
    assert.equal(list.total, 2);
    assert.equal(list.entries.length, 2);
  });
});

describe("POST /waitlist endpoint", () => {
  let server;
  let baseUrl;

  before(async () => {
    const { TaskEventStore } = await import("../src/task-event-store.js");
    server = createServer({ store: new TaskEventStore() });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("accepts a valid signup", async () => {
    const res = await fetch(`${baseUrl}/waitlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "agent-team@company.io", name: "Agent Builder" })
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.alreadyExists, false);
    assert.ok(body.id.startsWith("wl_"));
    assert.equal(body.confirmationEmail, "skipped");
  });

  it("returns 200 for duplicate signup", async () => {
    await fetch(`${baseUrl}/waitlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dup-test@company.io" })
    });
    const res = await fetch(`${baseUrl}/waitlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dup-test@company.io" })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.alreadyExists, true);
  });

  it("returns 400 for invalid email", async () => {
    const res = await fetch(`${baseUrl}/waitlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "bad" })
    });
    assert.equal(res.status, 400);
  });

  it("serves landing page at /", async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("AgentRail"));
    assert.ok(text.includes("waitlist"));
  });
});

describe("POST /waitlist email webhook", () => {
  let agentRailServer;
  let baseUrl;
  let webhookServer;
  let webhookUrl;
  let lastWebhookRequest;
  let webhookStatusCode;

  before(async () => {
    const { TaskEventStore } = await import("../src/task-event-store.js");

    // Minimal webhook receiver — captures the last POST body and returns webhookStatusCode.
    webhookServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try { lastWebhookRequest = { headers: req.headers, body: JSON.parse(body) }; } catch { lastWebhookRequest = null; }
        res.writeHead(webhookStatusCode, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise((resolve) => webhookServer.listen(0, "127.0.0.1", resolve));
    webhookUrl = `http://127.0.0.1:${webhookServer.address().port}`;

    agentRailServer = createServer({
      store: new TaskEventStore(),
      emailWebhookUrl: webhookUrl,
      emailWebhookToken: "test-token-abc"
    });
    await new Promise((resolve) => agentRailServer.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${agentRailServer.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => agentRailServer.close(resolve));
    await new Promise((resolve) => webhookServer.close(resolve));
  });

  it("returns confirmationEmail: sent when webhook returns 2xx", async () => {
    webhookStatusCode = 200;
    lastWebhookRequest = null;
    const res = await fetch(`${baseUrl}/waitlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "webhook-ok@example.com", name: "Webhook Test" })
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.confirmationEmail, "sent");
    assert.ok(lastWebhookRequest, "webhook must have been called");
    assert.equal(lastWebhookRequest.body.email, "webhook-ok@example.com");
    assert.equal(lastWebhookRequest.headers["authorization"], "Bearer test-token-abc");
  });

  it("returns confirmationEmail: failed when webhook returns non-2xx", async () => {
    webhookStatusCode = 500;
    const res = await fetch(`${baseUrl}/waitlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "webhook-fail@example.com" })
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.confirmationEmail, "failed");
  });

  it("skips webhook for duplicate signups", async () => {
    webhookStatusCode = 200;
    await fetch(`${baseUrl}/waitlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dup-webhook@example.com" })
    });
    lastWebhookRequest = null;
    const res = await fetch(`${baseUrl}/waitlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dup-webhook@example.com" })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.alreadyExists, true);
    assert.equal(body.confirmationEmail, "skipped");
    assert.equal(lastWebhookRequest, null, "webhook must not be called for duplicates");
  });
});
