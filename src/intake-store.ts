import type { AgentTaskQueue } from "./agent-task-queue.js";
import type { TaskRecord } from "./task-store.js";
import type { TaskEvent } from "./task-event-store.js";

/**
 * IntakeStore contract.
 *
 * Mirrors the AgentTaskQueue surface that intake adapters need:
 * - create / upsert / update / delete tasks
 * - emit a structured event after successful intake for downstream
 *   webhook + SSE delivery.
 *
 * In production this is satisfied by AgentTaskQueue (backed by TaskStore +
 * optional TaskEventStore).  In tests it can be mocked.
 */
export interface IntakeStore {
  createTask(partial: Parameters<AgentTaskQueue["createTask"]>[0]): TaskRecord;
  updateTask(taskId: string, patch: Parameters<AgentTaskQueue["updateTask"]>[1]): TaskRecord | null;
  deleteTask(taskId: string): boolean;
  getRawTask(taskId: string): TaskRecord | null;
  upsertTask(record: TaskRecord): TaskRecord;
  appendEvent?(event: TaskEvent): Promise<void> | void;
}
