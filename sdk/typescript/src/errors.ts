import type { ErrorDetail } from "./types.js";

export class AgentRailError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly availableActions: string[];

  constructor(statusCode: number, body: ErrorDetail) {
    super(body.message);
    this.name = "AgentRailError";
    this.statusCode = statusCode;
    this.code = body.code;
    this.details = body.details;
    this.availableActions =
      (body.details?.availableActions as string[] | undefined) ?? [];
  }

  get retryable(): boolean {
    return this.statusCode === 429 || this.statusCode >= 500;
  }
}

export class ValidationError extends AgentRailError {
  constructor(body: ErrorDetail) {
    super(400, body);
    this.name = "ValidationError";
  }
}

export class UnauthorizedError extends AgentRailError {
  constructor(body: ErrorDetail) {
    super(401, body);
    this.name = "UnauthorizedError";
  }
}

export class InsufficientScopeError extends AgentRailError {
  constructor(body: ErrorDetail) {
    super(403, body);
    this.name = "InsufficientScopeError";
  }
}

export class NotFoundError extends AgentRailError {
  constructor(body: ErrorDetail) {
    super(404, body);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AgentRailError {
  constructor(body: ErrorDetail) {
    super(409, body);
    this.name = "ConflictError";
  }

  override get retryable(): boolean {
    return false;
  }
}

export class RateLimitError extends AgentRailError {
  readonly retryAfterSeconds: number | null;

  constructor(body: ErrorDetail, retryAfter: string | null) {
    super(429, body);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : null;
  }
}

export function parseErrorResponse(
  statusCode: number,
  body: { error: ErrorDetail },
  headers?: Headers,
): AgentRailError {
  const detail = body.error;
  switch (statusCode) {
    case 400:
      return new ValidationError(detail);
    case 401:
      return new UnauthorizedError(detail);
    case 403:
      return new InsufficientScopeError(detail);
    case 404:
      return new NotFoundError(detail);
    case 409:
      return new ConflictError(detail);
    case 429:
      return new RateLimitError(
        detail,
        headers?.get("retry-after") ?? null,
      );
    default:
      return new AgentRailError(statusCode, detail);
  }
}
