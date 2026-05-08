/**
 * Structured observability logger for AgentRail dogfood operations.
 */

export interface LogFields {
  operation?: string;
  title?: string;
  message?: string;
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

export type OperatorNoticeKind = "info" | "success" | "warning" | "error";

export function createOperationTimer(fields: LogFields): Timer {
  const start = Date.now();

  return {
    finish(extra: LogFields = {}) {
      const durationMs = Date.now() - start;
      emit({ level: "info", ...fields, ...extra, durationMs });
    },
    error(extra: LogFields = {}) {
      const durationMs = Date.now() - start;
      emit({ level: "error", ...fields, ...extra, durationMs });
    }
  };
}

export function logEvent(fields: LogFields): void {
  emit({ level: "info", ...fields });
}

/**
 * Emits a human-readable narrative log line in text mode and a structured JSON
 * record in JSON mode. Prefer this for operator-facing "title: message" output;
 * use logEvent/emit for machine-oriented structured events.
 */
export function logNarrative({ title, message, ...fields }: LogFields & { title: string; message: string }): void {
  if (getFormat() === "json") {
    emit({ level: "info", title, message, ...fields });
    return;
  }
  if (!isEnabled()) return;
  const ts = new Date().toISOString();
  const sentence = ensureSentence(message);
  const base = sentence ? `${title}: ${sentence}` : title;
  const extras = formatTextFields(fields);
  process.stderr.write(`${ts} [info] ${base}${extras ? ` ${extras}` : ""}\n`);
}

export function logOperatorNotice({
  title,
  message,
  kind = "info",
}: {
  title: string;
  message?: string;
  kind?: OperatorNoticeKind;
}): void {
  if (isEnabled()) return;
  const icon = iconForKind(kind);
  const sentence = ensureSentence(message ?? "");
  const body = sentence ? `${title}: ${sentence}` : title;
  process.stdout.write(`${icon} ${body}\n`);
}

interface LogRecord extends LogFields {
  ts: string;
  level: string;
  durationMs?: number;
}

function emit(entry: Partial<LogRecord>): void {
  if (!isEnabled()) return;
  const ts = new Date().toISOString();
  const record: LogRecord = { ts, level: "info", ...entry };

  if (getFormat() === "json") {
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

function isEnabled(): boolean {
  return (process.env.AGENTRAIL_OBSERVABILITY ?? "true").toLowerCase() !== "false";
}

function iconForKind(kind: OperatorNoticeKind): string {
  switch (kind) {
    case "success":
      return "✓";
    case "warning":
      return "!";
    case "error":
      return "×";
    default:
      return "•";
  }
}

function ensureSentence(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

function formatTextFields(fields: LogFields): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${formatTextValue(value)}`)
    .join(" ");
}

function formatTextValue(value: unknown): string {
  if (typeof value === "string") {
    return /[\s"'=\\]/u.test(value) ? JSON.stringify(value) : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value);
}

let warnedAboutLogFormat = false;

function getFormat(): "json" | "text" {
  const raw = (process.env.AGENTRAIL_LOG_FORMAT ?? "text").toLowerCase();
  if (raw === "json" || raw === "text") {
    return raw;
  }
  if (!warnedAboutLogFormat) {
    warnedAboutLogFormat = true;
    process.stderr.write(`[structured-logger] Unknown AGENTRAIL_LOG_FORMAT "${raw}", defaulting to "text"\n`);
  }
  return "text";
}
