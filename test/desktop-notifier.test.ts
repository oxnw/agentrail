import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildAwaitingUserNotificationOptions, parseDesktopNotificationsEnabled } from "../src/desktop-notifier.ts";

test("awaiting-user desktop notifications clearly identify blocked work and include AgentRail artwork", () => {
  const options = buildAwaitingUserNotificationOptions({
    runId: "run_notify",
    taskId: "tsk_notify",
    taskIdentifier: "AGEA-123",
    reason: "Missing GitHub token",
    actionRequired: "Add a GitHub token before the agent can continue",
    resumeInstructions: "Retry the agent after adding the token.",
  });

  assert.equal(options.title, "AgentRail blocked: user action needed");
  assert.equal(options.subtitle, "AGEA-123 is awaiting you");
  // The OS notification intentionally stays concise: it renders the task
  // identity and required action, while runId/taskId/reason/resume details
  // remain available through AgentRail's task/run records.
  assert.equal(options.message, "Blocked: Add a GitHub token before the agent can continue");
  assert.equal(options.sound, true);
  assert.equal(options.wait, false);
  assert.equal(options.timeout, 10);
  assert.ok(options.icon);
  assert.equal(path.basename(options.icon), "agentrail-notification.svg");
});

test("parseDesktopNotificationsEnabled handles explicit truthy and falsy values", () => {
  assert.equal(parseDesktopNotificationsEnabled("1"), true);
  assert.equal(parseDesktopNotificationsEnabled("true"), true);
  assert.equal(parseDesktopNotificationsEnabled(" yes "), true);
  assert.equal(parseDesktopNotificationsEnabled("on"), true);
  assert.equal(parseDesktopNotificationsEnabled("0"), false);
  assert.equal(parseDesktopNotificationsEnabled("false"), false);
  assert.equal(parseDesktopNotificationsEnabled(" no "), false);
  assert.equal(parseDesktopNotificationsEnabled("off"), false);
  assert.equal(parseDesktopNotificationsEnabled("unexpected"), false);
  assert.equal(parseDesktopNotificationsEnabled(null), false);
  assert.equal(parseDesktopNotificationsEnabled(undefined), false);
});
