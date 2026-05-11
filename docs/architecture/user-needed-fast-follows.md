# User-Needed Fast Follows

This note preserves the follow-up plan from the managed agent runner work so it
can survive context compaction and be implemented as separate pull requests.

## Immediate Follow-Ups

- Add a first-class user-visible blocked state and naming pass, likely
  `awaiting_user`.
- Add durable CLI surfacing for user-needed tasks in `agentrail agent status`
  and startup/shutdown summaries.
- Add one-shot desktop notifications for tasks that transition to user-needed
  state.
- Add optional webhook notifications for user-needed state transitions.
- Add stale-run / reclaimability policy so abandoned runs do not leave zombie
  tasks behind.
- Add richer resume metadata for user-needed tasks, including explicit action
  required and resume instructions.

## PR Split

### PR 1: User-Needed State Foundation

Group these together:

- First-class user-visible blocked state: `awaiting_user`.
- Structured user-action metadata: reason, action required, resume
  instructions, timestamp, and source.
- Durable CLI surfacing in `agentrail agent status`.
- Startup and shutdown summaries that call out runs waiting on the user.

These belong in one PR because useful CLI surfacing depends on a canonical
state and structured metadata.

There is no production compatibility requirement yet. PR 1 should hard-migrate
the local model and tests to `awaiting_user` rather than preserving
`waiting_for_human`.

#### PR 1 Decisions

- `awaiting_user` is canonical for `AgentRunStatus`.
- `Task.status` remains lifecycle-oriented and uses `blocked`.
- `Task.blocker.kind = "awaiting_user"` explains why the task is blocked and
  who must act.
- Blocked tasks remain visible in `/tasks/mine` so the assigned agent keeps full
  context.
- `agentrail agent run` must not treat blocked tasks as runnable.
- Blocked reports require structured metadata through CLI flags:
  `--reason`, `--action-required`, and `--resume-instructions`.
- Missing blocked-report metadata is a validation error. AgentRail should not
  infer the action required from `--summary`.
- Add `POST /tasks/{taskId}/resolve-blocker`.
- Add `agentrail task resolve-blocker --task-id <id> --resolution-summary <text>`.
- Resolving a blocker requires `tasks:write` and an `Idempotency-Key`.
- Resolving is valid only for `status = blocked` and
  `blocker.kind = "awaiting_user"`.
- Resolving clears `task.blocker`, sets `status = "todo"`, and sets
  `availableActions = ["start"]`.
- The historical run remains `awaiting_user`; the next attempt creates a new
  run.
- Resolving appends a generic `task.updated` event with changed fields
  `status`, `availableActions`, `blocker`, and `updatedAt`.
- `--resolution-summary` is persisted in that `task.updated` event payload as
  `resolutionSummary`; AgentRail does not add a separate task history field in
  PR 1.

#### PR 1 Data Shape

Tasks should expose compact blocker metadata. `Task.blocker` is nullable:
non-blocked tasks use `null`, and resolving a blocker clears it back to `null`.

```ts
type TaskBlockerState = TaskBlocker | null;

interface TaskBlocker {
  kind: "awaiting_user";
  sourceRunId: string;
  sourceAgentId: string;
  reason: string;
  actionRequired: string;
  resumeInstructions: string;
  createdAt: string;
}
```

Runs should mirror the user-action payload so `agentrail agent status` can
explain what needs attention without fetching task details:

```ts
interface AgentRunUserAction {
  kind: "awaiting_user";
  taskId: string;
  reason: string;
  actionRequired: string;
  resumeInstructions: string;
  createdAt: string;
}
```

### PR 2: Desktop Notifications

Add one-shot local desktop notifications when a run transitions to
`awaiting_user`.

This should depend on PR 1 so notifications can use the canonical state and
structured user-action metadata instead of parsing free-text summaries.

### PR 3: Webhook Notifications

Add optional webhook notifications for user-needed state transitions.

This should follow desktop notifications because it needs more configuration,
delivery, retry, and dedupe decisions. It should use the same canonical
transition event as desktop notifications.

### PR 4: Stale Run And Reclaimability Policy

Define how AgentRail handles abandoned `starting` / `running` runs:

- when a run becomes stale;
- whether its status becomes `awaiting_user`, `failed`, or `cancelled`;
- whether it gets an orthogonal `reclaimable: true | false` flag;
- when another runner may safely reclaim the task;
- how to avoid zombie tasks without hiding unresolved user action.

Example combined semantics: `status = "awaiting_user"` and
`reclaimable = false` preserves unresolved user action; `status = "failed"` and
`reclaimable = true` allows another runner to pick up work abandoned by a dead
process.

Keep this separate because it is a policy-heavy change and should not be mixed
with the state/metadata foundation.

## Recommended Order

1. Implement PR 1 first. It creates the model and UX foundation.
2. Implement desktop notifications next as the smallest useful interruption
   channel.
3. Implement webhook notifications after local notifications prove the event
   shape.
4. Implement stale-run / reclaimability policy last, after `awaiting_user` and
   resume metadata exist.
