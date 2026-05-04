export class TaskLifecycleError extends Error {
  constructor(statusCode, code, message, details = {}) {
    super(message);
    this.name = "TaskLifecycleError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}
