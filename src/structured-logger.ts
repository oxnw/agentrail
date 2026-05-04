/**
 * Structured observability logger for AgentRail dogfood operations.
 */

const format = (process.env.AGENTRAIL_LOG_FORMAT ?? "text").toLowerCase();
const enabled = (process.env.AGENTRAIL_OBSERVABILITY ?? "true") !== "false";

export interface LogFields {
  operation?: string;
  agentId?: string;
  taskId?: string;
  provider?: string;
  idempotencyKey?: string;
  estimatedTokens?: number;
  retryCount?: number;
  fallbackUsed?: boolean;
  errorClass?: string;
  statusCode?: number;
  [key: string]: unknown;
}

export interface Timer {
  finish(extra?: LogFields): void;
  error(extra?: LogFields): void;
}

export function createOperationTimer(fields: LogFields): Timer {
  const start = Date.now();

  return {
    finish(extra: LogFields = {}) {
      if (!enabled) return;
      const durationMs = Date.now() - start;
      emit({ level: "info", ...fields, ...extra, durationMs });
    },
    error(extra: LogFields = {}) {
      if (!enabled) return;
      const durationMs = Date.now() - start;
      emit({ level: "error", ...fields, ...extra, durationMs });
    }
  };
}

export function logEvent(fields: LogFields): void {
  if (!enabled) return;
  emit({ level: "info", ...fields });
}

interface LogRecord extends LogFields {
  ts: string;
  level: string;
  durationMs?: number;
}

function emit(entry: Partial<LogRecord>): void {
  const ts = new Date().toISOString();
  const record: LogRecord = { ts, level: "info", ...entry };

  if (format === "json") {
    process.stderr.write(JSON.stringify(record) + "\n");
    return;
  }

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
