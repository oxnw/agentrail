import test from "node:test";
import assert from "node:assert/strict";

import { logEvent, logNarrative, logOperatorNotice } from "../src/structured-logger.ts";

async function withStderrCapture(
  env: Record<string, string>,
  fn: () => void | Promise<void>,
): Promise<string> {
  const originalWrite = process.stderr.write.bind(process.stderr);
  const originalEnv = new Map(
    Object.keys(env).map((key) => [key, process.env[key]] as const),
  );
  let output = "";

  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
  process.stderr.write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    if (typeof chunk === "string") {
      output += chunk;
    } else if (typeof encodingOrCallback === "string") {
      output += Buffer.from(chunk).toString(encodingOrCallback);
    } else {
      output += Buffer.from(chunk).toString("utf8");
    }
    const resolvedCallback = typeof encodingOrCallback === "function"
      ? encodingOrCallback
      : callback;
    resolvedCallback?.(null);
    return true;
  }) as typeof process.stderr.write;

  try {
    await fn();
  } finally {
    process.stderr.write = originalWrite;
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  return output;
}

async function withStdoutCapture(
  env: Record<string, string>,
  fn: () => void | Promise<void>,
): Promise<string> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalEnv = new Map(
    Object.keys(env).map((key) => [key, process.env[key]] as const),
  );
  let output = "";

  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
  process.stdout.write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    if (typeof chunk === "string") {
      output += chunk;
    } else if (typeof encodingOrCallback === "string") {
      output += Buffer.from(chunk).toString(encodingOrCallback);
    } else {
      output += Buffer.from(chunk).toString("utf8");
    }
    const resolvedCallback = typeof encodingOrCallback === "function"
      ? encodingOrCallback
      : callback;
    resolvedCallback?.(null);
    return true;
  }) as typeof process.stdout.write;

  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  return output;
}

test("logNarrative renders human-readable text output in text mode", async () => {
  const output = await withStderrCapture(
    { AGENTRAIL_LOG_FORMAT: "text", AGENTRAIL_OBSERVABILITY: "true" },
    () => {
      logNarrative({
        title: "Poll Results",
        message: "Found GitHub issue oxnw/agentrail#42 and assigned it to Maya",
        operation: "delivery_poll_notable",
        provider: "github",
      });
    },
  );

  assert.match(output, /^\d{4}-\d{2}-\d{2}T.* \[info\] Poll Results: Found GitHub issue oxnw\/agentrail#42 and assigned it to Maya\. operation=delivery_poll_notable provider=github\n$/u);
});

test("logNarrative does not double-punctuate text messages", async () => {
  const output = await withStderrCapture(
    { AGENTRAIL_LOG_FORMAT: "text", AGENTRAIL_OBSERVABILITY: "true" },
    () => logNarrative({ title: "Done", message: "Task completed." }),
  );

  assert.match(output, /^\d{4}-\d{2}-\d{2}T.* \[info\] Done: Task completed\.\n$/u);
});

test("logNarrative omits colon and sentence when message is empty", async () => {
  const output = await withStderrCapture(
    { AGENTRAIL_LOG_FORMAT: "text", AGENTRAIL_OBSERVABILITY: "true" },
    () => logNarrative({ title: "Heartbeat", message: " " }),
  );

  assert.match(output, /^\d{4}-\d{2}-\d{2}T.* \[info\] Heartbeat\n$/u);
});

test("logNarrative quotes unsafe text field values in text mode", async () => {
  const output = await withStderrCapture(
    { AGENTRAIL_LOG_FORMAT: "text", AGENTRAIL_OBSERVABILITY: "true" },
    () => {
      logNarrative({
        title: "Retry Deferred",
        message: "Waiting for operator input",
        operation: "delivery_retry",
        reason: "user cancelled",
      });
    },
  );

  assert.match(output, /reason="user cancelled"/u);
});

test("logNarrative respects disabled observability", async () => {
  const output = await withStderrCapture(
    { AGENTRAIL_LOG_FORMAT: "text", AGENTRAIL_OBSERVABILITY: "false" },
    () => {
      logNarrative({
        title: "Should Not Log",
        message: "This should not appear",
        operation: "test_operation",
      });
    },
  );

  assert.equal(output, "");
});

test("logOperatorNotice prints clean status only when observability is disabled", async () => {
  const output = await withStdoutCapture(
    { AGENTRAIL_LOG_FORMAT: "text", AGENTRAIL_OBSERVABILITY: "false" },
    () => {
      logOperatorNotice({
        title: "GitHub poll",
        message: "checked 1 issue and created 1 task",
        kind: "success",
      });
    },
  );

  assert.equal(output, "✓ GitHub poll: checked 1 issue and created 1 task.\n");
});

test("logOperatorNotice stays silent when structured observability is enabled", async () => {
  const output = await withStdoutCapture(
    { AGENTRAIL_LOG_FORMAT: "text", AGENTRAIL_OBSERVABILITY: "true" },
    () => {
      logOperatorNotice({
        title: "GitHub poll",
        message: "checked 1 issue",
      });
    },
  );

  assert.equal(output, "");
});

test("logNarrative preserves machine-readable JSON mode", async () => {
  const output = await withStderrCapture(
    { AGENTRAIL_LOG_FORMAT: "json", AGENTRAIL_OBSERVABILITY: "true" },
    () => {
      logNarrative({
        title: "CI Failed",
        message: "Task ENG-123 is blocked by CircleCI",
        operation: "task_ci_failed",
        provider: "circleci",
      });
    },
  );

  const lines = output.trim().split(/\r?\n/u).filter(Boolean);
  assert.ok(lines.length > 0, "expected logNarrative to write to stderr");
  const firstLine = lines[0];
  assert.ok(firstLine, "expected first log line");
  const record = JSON.parse(firstLine) as Record<string, unknown>;
  assert.equal(record.title, "CI Failed");
  assert.equal(record.message, "Task ENG-123 is blocked by CircleCI");
  assert.equal(record.operation, "task_ci_failed");
  assert.equal(record.provider, "circleci");
});

test("logEvent text mode emits operation/provider and omits title/message fields", async () => {
  const output = await withStderrCapture(
    { AGENTRAIL_LOG_FORMAT: "text", AGENTRAIL_OBSERVABILITY: "true" },
    () => {
      logEvent({
        title: "Webhook Received",
        message: "GitHub delivery received",
        operation: "github_webhook_receipt",
        provider: "github",
      });
    },
  );

  assert.match(output, /github_webhook_receipt/u);
  assert.match(output, /provider=github/u);
  assert.doesNotMatch(output, /Webhook Received/u);
  assert.doesNotMatch(output, /GitHub delivery received/u);
});

test("logEvent respects disabled observability", async () => {
  const output = await withStderrCapture(
    { AGENTRAIL_LOG_FORMAT: "text", AGENTRAIL_OBSERVABILITY: "false" },
    () => {
      logEvent({
        operation: "github_webhook_receipt",
        provider: "github",
      });
    },
  );

  assert.equal(output, "");
});
