import { ErrorResponse } from "./types";

export class AgentRailError extends Error {
  readonly status: number;
  readonly code: string;
  readonly availableActions: string[];

  constructor(status: number, body: ErrorResponse) {
    super(body.error);
    this.name = "AgentRailError";
    this.status = status;
    this.code = body.code;
    this.availableActions = body.availableActions;
  }
}

export class NetworkError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "NetworkError";
    this.cause = cause;
  }
}

export class TimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

export function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}
