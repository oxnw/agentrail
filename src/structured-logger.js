/**
 * Structured observability logger for AgentRail dogfood operations.
 *
 * Emits one JSON line per operation when AGENTRAIL_LOG_FORMAT=json.
 * Falls back to a human-readable line when AGENTRAIL_LOG_FORMAT is absent or "text".
 *
 * Log entry shape (all fields optional except operation and durationMs):
 *   { ts, level, operation, agentId, taskId, provider, idempotencyKey,
 *     estimatedTokens, durationMs, retryCount, fallbackUsed, errorClass, statusCode }
 */

const format = (process.env.AGENTRAIL_LOG_FORMAT ?? "text").toLowerCase();
const enabled = (process.env.AGENTRAIL_OBSERVABILITY ?? "true") !== "false";

export function createOperationTimer(fields) {
  const start = Date.now();

  return {
    finish(extra = {}) {
      if (!enabled) return;
      const durationMs = Date.now() - start;
      emit({ level: "info", ...fields, ...extra, durationMs });
    },
    error(extra = {}) {
      if (!enabled) return;
      const durationMs = Date.now() - start;
      emit({ level: "error", ...fields, ...extra, durationMs });
    }
  };
}

export function logEvent(fields) {
  if (!enabled) return;
  emit({ level: "info", ...fields });
}

function emit(entry) {
  const ts = new Date().toISOString();
  const record = { ts, ...entry };

  if (format === "json") {
    process.stderr.write(JSON.stringify(record) + "\n");
    return;
  }

  // Human-readable fallback
  const parts = [
    ts,
    `[${record.level ?? "info"}]`,
    record.operation ?? "unknown",
    record.agentId ? `agent=${record.agentId}` : null,
    record.taskId ? `task=${record.taskId}` : null,
    record.provider ? `provider=${record.provider}` : null,
    record.estimatedTokens != null ? `tokens=${record.estimatedTokens}` : null,
    record.durationMs != null ? `${record.durationMs}ms` : null,
    record.retryCount != null ? `retries=${record.retryCount}` : null,
    record.fallbackUsed ? "fallback=true" : null,
    record.errorClass ? `err=${record.errorClass}` : null,
    record.statusCode != null ? `status=${record.statusCode}` : null
  ].filter(Boolean);

  process.stderr.write(parts.join(" ") + "\n");
}
