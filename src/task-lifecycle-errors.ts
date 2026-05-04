export class TaskLifecycleError extends Error {
  statusCode: number;
  code: string;
  details: Record<string, unknown>;

  constructor(statusCode: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "TaskLifecycleError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}
