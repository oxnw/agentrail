# Hybrid Managed Runner Design

Date: 2026-05-12
Status: Draft for implementation planning

## Purpose

AgentRail needs a managed runner flow that is product-grade for local use today and compatible with hosted dispatch later. The current static-recipe runner direction improves lifecycle control, but it can leave the child agent blind to live task state and force it to reason through too much protocol. The old manual API flow gives the agent live AgentRail state, but gives it too much lifecycle responsibility.

This design defines a hybrid managed runner:

- AgentRail owns task ingestion, routing, dispatch, lifecycle transitions, provider mutations, CI/review polling, shipping, rollback, and audit.
- The child agent owns repo-local work: understand the assigned task, edit files, run checks, commit locally, report progress or blockers, and submit a handoff.
- The child agent uses a narrow run-scoped machine API, not broad AgentRail lifecycle/admin APIs.
- Humans use the CLI. Machines use APIs.

## Product Principles

- AgentRail should wake agents automatically after setup. `agentrail agent run` remains a debugging, retry, and benchmark escape hatch.
- AgentRail can run locally as one process by default: API server, provider polling/webhook handling, routing, dispatch, and runner supervision.
- Internal modules should remain separable so hosted AgentRail can split API and dispatcher services later without changing the child-agent contract.
- AgentRail should be API-first for machines. CLI commands are for human setup, inspection, and repair.
- AgentRail should not assume every GitHub or Linear issue is well written. It must represent missing information explicitly.
- AgentRail may use local AI assist for routing/classification, but deterministic AgentRail logic remains the final authority.
- Direct model-provider API keys are out of scope for this phase.

## Architecture

Local AgentRail runs as one runtime process by default:

```text
agentrail server start
  |
  +-- API endpoints
  +-- provider polling/webhook handling
  +-- routing
  +-- dispatcher loop
  +-- runner supervision
```

Internal components:

```text
Component                  Responsibility
-------------------------  --------------------------------------------------
AgentRail runtime          Local process: API, polling, routing, dispatch
Task/router store          Ingests issues, routes tasks, tracks lifecycle state
Dispatcher loop            Finds assigned runnable tasks and wakes agents
Runner adapter             Launches Codex, Claude Code, Cursor, or custom runner
Runtime task card          Compact live task context for the child agent
Run-scoped API             Narrow progress, blocker, task-card, handoff surface
Child agent                Edits code, runs checks, commits locally
Handoff processor          Validates result and continues lifecycle
Provider adapters          Create PRs, poll CI/review, ship, rollback
Audit/event log            Records lifecycle transitions
```

Hosted-aware mapping:

```text
Local Mode                         Hosted Mode
---------------------------------  -------------------------------------------
Local process dispatches runner     Hosted dispatcher schedules remote runner
Local run token                     Hosted short-lived run token
Local filesystem workspace          Remote/container workspace
localhost run API                   Hosted run API
Same task card contract             Same task card contract
Same handoff contract               Same handoff contract
```

## Capability-Based Routing

AgentRail should use the term "capabilities", not "skills", to avoid confusion with executable agent skills in Codex, Claude, and other ecosystems.

```text
Old Term        New Term
--------------  ----------------------
Agent skills    Agent capabilities
Task skills     Required capabilities
Skill matching  Capability matching
```

Agent setup should capture:

```text
Agent Property       Meaning
-------------------  --------------------------------------------------
Capabilities         What work this agent can handle
Ownership areas      Codebase or product areas this agent owns
Repo allowlist       Which repos this agent may work in
Permission level     What AgentRail may do on this agent's behalf
Capacity             Max active real tasks
Fallback behavior    Whether partial matches are allowed
Runner/model         Local runner and model used for task execution
```

Task intake should produce a routing profile:

```json
{
  "taskType": "bugfix",
  "requiredCapabilities": ["typescript", "github-actions"],
  "optionalCapabilities": ["task-lifecycle"],
  "ownershipHints": ["packages/task-engine"],
  "missingInfo": [],
  "confidence": 0.86,
  "evidence": [
    "Issue mentions sparse GitHub issue update handling",
    "Scope references packages/task-engine"
  ]
}
```

The classifier does not choose the agent:

```text
Classifier Decides              Routing Engine Decides
------------------------------  -----------------------------------
Required capabilities           Which agents are eligible
Optional capabilities           Capacity fit
Task type                       Ownership match
Missing information             Permission fit
Confidence                      Final assign vs triage
Evidence                        Fallback assignment policy
```

The classifier should use the global capability taxonomy, not only capabilities currently represented by active agents. It should also receive a compact active-agent capability inventory so AgentRail can explain missing coverage.

Routing outcomes:

```text
Condition                                  Outcome
-----------------------------------------  -----------------------------------------
Exact capable agent exists                 Assign
Multiple capable agents                    Deterministic tiebreak
No exact match but safe fallback exists    Assign with warning, if fallback allowed
No capable agent                           Triage with setup suggestion
Low classifier confidence                  Triage or clarification required
Missing critical info                      Investigation or clarification phase
```

## Local AI Assist Classification

AgentRail supports two routing modes in this phase:

```text
Routing Mode     Behavior
---------------  ------------------------------------------------------------
Rules only       Deterministic routing from repo, labels, projects, ownership
AI assist        Rules first, then local runner classifies unclear tasks
```

Out of scope for this phase:

- OpenAI API keys
- Anthropic API keys
- Gemini API keys
- Hosted model calls
- Billing or model-provider cost budgets
- Direct provider model configuration

AI assist uses the same local runner family as task execution:

```text
Local Classifier Runner
-----------------------
Codex
Claude Code
Cursor
Custom command
```

`agentrail init` should ask:

```text
Routing mode:
1. Rules only
2. AI assist

If AI assist:
- Choose classifier runner: Codex, Claude Code, Cursor, or custom
- Choose classifier model: runner default, specific model, or runner profile
- Choose confidence threshold
- Choose fallback: triage or human approval
```

`agentrail agent create` should ask:

```text
- Choose task runner: Codex, Claude Code, Cursor, or custom
- Choose task runner model: runner default, specific model, or runner profile
- Choose capabilities
- Choose repo allowlist
- Choose permissions
- Choose capacity
```

Classifier runner constraints:

```text
Constraint                 Reason
-------------------------  --------------------------------------------------
Read-only/no repo writes    Classification should not edit anything
Short timeout               Prevent routing queue stalls
Schema-bound JSON           Avoid ambiguous output
No lifecycle token          Classifier cannot mutate AgentRail state
Fallback on failure         Bad classifier run should not block all routing
```

Routing classifier config:

```json
{
  "routing": {
    "mode": "ai_assist",
    "classifier": {
      "kind": "local_runner",
      "runner": "codex",
      "model": "gpt-5.4-mini",
      "profile": null,
      "confidenceThreshold": 0.75,
      "fallback": "triage",
      "timeoutMs": 60000
    }
  }
}
```

Agent profile config:

```json
{
  "agentId": "agt_backend",
  "runner": {
    "kind": "codex",
    "model": "gpt-5.4",
    "profile": null
  },
  "capabilities": ["typescript", "nodejs", "postgres"],
  "repoAllowlist": ["oxnw/app"],
  "maxConcurrentTasks": 2,
  "permissionPreset": "read_write"
}
```

## Task Quality Phases

AgentRail should classify both what work is required and whether the task is ready to run.

```text
Phase                    Meaning
-----------------------  ----------------------------------------------------
implementation_ready     Clear enough to assign to a coding agent
investigation_needed     Agent can inspect repo/context before deciding
clarification_needed     Human/provider issue needs more info before coding
triage_needed            No safe route or unclear ownership/capabilities
```

Examples:

```text
Issue Quality                          Phase
-------------------------------------  -------------------------
Clear bug plus repro and expected result implementation_ready
Clear area but vague failure            investigation_needed
"Login broken" with no details          clarification_needed
No matching capability                  triage_needed
Conflicting labels/routes               triage_needed
```

Classifier output should include readiness:

```json
{
  "taskType": "bugfix",
  "readiness": "investigation_needed",
  "requiredCapabilities": ["typescript", "auth"],
  "optionalCapabilities": ["postgres"],
  "missingInfo": [
    "No reproduction steps provided",
    "No expected behavior stated"
  ],
  "confidence": 0.72,
  "evidence": [
    "Issue title mentions login failure",
    "No stack trace or environment is provided"
  ]
}
```

Routing behavior by readiness:

```text
Readiness                 AgentRail Action
------------------------  --------------------------------------------------
implementation_ready      Assign to capable agent
investigation_needed      Assign if agent supports investigation
clarification_needed      Send to triage or ask user/provider for info
triage_needed             Keep in triage with reason and suggested fixes
```

Clarification modes:

```text
Clarification Mode       Behavior
-----------------------  ------------------------------------------------
Manual                   Show suggested clarification to user
Comment with approval    Ask user before posting provider comment
Auto-comment             Post clarification request automatically
```

Default clarification mode should be manual or comment-with-approval. Auto-commenting can feel noisy and should be opt-in.

## Runtime Task Card

The managed child agent should receive a compact live task card. The task card should distinguish observed facts from inferred or missing information.

```text
Task Card Field             Purpose
--------------------------  --------------------------------------------------
taskId                      Stable AgentRail task id
taskIdentifier              Provider/source identifier
title                       Human task title
observed                    Facts AgentRail knows from provider/state
instructions                Compact task text copied or extracted from issue
acceptanceCriteria          Parsed if present, otherwise empty
missingInfo                 Explicit gaps
confidence                  ready, partial, or insufficient
repo                        Repo slug and local path
branch                      Required local branch name
status                      Current lifecycle state
phase                       implementation, investigation, fix_ci, fix_review
nextAction                  Exact expected local action
allowedActions              Small set of child-local actions
stopCondition               When the child should stop
handoffTemplate             Pre-shaped result payload
blockedTemplate             Pre-shaped blocker payload
```

Example:

```json
{
  "taskId": "tsk_123",
  "taskIdentifier": "github:oxnw/repo:issues/19",
  "title": "Preserve sparse issue context",
  "observed": {
    "source": "GitHub issue #19",
    "repo": "oxnw/repo",
    "labels": ["bug"],
    "assignees": []
  },
  "instructions": "Implement sparse GitHub issue update handling in packages/task-engine.",
  "acceptanceCriteria": [
    "Sparse updates keep labels when labels are omitted",
    "Sparse updates keep assignee metadata when omitted",
    "Tests cover open and closed issue states"
  ],
  "missingInfo": [],
  "confidence": "ready",
  "repo": {
    "slug": "oxnw/repo",
    "path": "/Users/onyeka/.agentrail/runs/run_123/repo"
  },
  "branch": "agentrail/agt_codex/tsk_123",
  "status": "in_progress",
  "phase": "implementation",
  "nextAction": "Edit the repository, run checks, commit locally, then submit handoff.",
  "allowedActions": [
    "report_progress",
    "report_blocked",
    "submit_handoff"
  ],
  "stopCondition": "Stop after submit_handoff succeeds.",
  "handoffTemplate": {
    "version": 1,
    "target": "agentrail",
    "summary": "",
    "commitSha": "",
    "checks": [],
    "artifacts": []
  },
  "blockedTemplate": {
    "version": 1,
    "target": "user",
    "summary": "",
    "reason": "",
    "actionRequired": "",
    "resumeInstructions": ""
  }
}
```

The child should see local actions, not provider/lifecycle actions:

```text
AgentRail lifecycle actions        Parent/runtime owns
---------------------------------  ---------------------------------
start_task                         AgentRail runtime
submit_task / create PR            AgentRail runtime
poll CI/review                     AgentRail runtime
ship / rollback                    AgentRail runtime

Child-local actions                Child agent owns
---------------------------------  ---------------------------------
report_progress                    yes
report_blocked                     yes
submit_handoff                     yes
read_current_task_card             yes
read_scoped_fix_context            only when AgentRail asks for fix cycle
```

Task-card next actions by phase:

```text
Phase                 Next Action
--------------------  --------------------------------------------------
implementation        Edit repo, run checks, commit, submit handoff
investigation         Inspect repo/context, report findings or blocker
fix_ci                Read scoped CI failure, fix, run checks, commit, handoff
fix_review            Read scoped review feedback, address comments, handoff
clarification_needed  Report blocked with clarification request; do not code
```

## Run-Scoped Machine API

Machines use APIs. Humans use CLI.

The child agent should get a short-lived run token with access only to the current run.

```text
Endpoint                         Used By       Purpose
-------------------------------  ------------  -------------------------------------
GET /runs/{runId}/task-card      child agent   Read compact task context
GET /runs/{runId}/next-action    child agent   Read exact expected local action
POST /runs/{runId}/progress      child agent   Append progress event
POST /runs/{runId}/blocked       child agent   Report blocker and requested action
POST /runs/{runId}/handoff       child agent   Submit commit/check result to AgentRail
```

Run token scope:

```text
Credential           Scope
-------------------  ------------------------------------------------
Run token            One run only
Task id              Bound to one task
Repo/worktree        Bound to one repo
Expiry               Short-lived
Permissions          read_card, report_progress, report_blocked, submit_handoff
```

The run token must not allow:

- all-task listing
- routing/config/admin access
- raw provider credential access
- direct PR creation
- direct ship/merge/rollback

CLI remains the human/operator surface:

```text
CLI Command                      Used By       Purpose
-------------------------------  ------------  -------------------------------------
agentrail init                   human         Configure local AgentRail
agentrail server start           human         Start local runtime
agentrail provider connect       human         Connect providers
agentrail agent create           human         Register agent profile
agentrail repo add               human         Register repo mapping
agentrail run list               human         Inspect runs
agentrail run inspect <id>       human         Debug run
agentrail run retry <id>         human         Retry run
```

## Wake-Up and Dispatch Flow

Normal product UX:

```text
Start AgentRail once. AgentRail wakes agents when work arrives.
```

Dispatch flow:

```text
Step  Event
----  ------------------------------------------------------------------
1     GitHub/Linear issue arrives
2     AgentRail ingests provider event
3     AgentRail extracts observed facts
4     Rules route directly or local classifier enriches capabilities
5     Routing engine selects eligible agent or triage
6     Dispatcher sees assigned runnable task
7     Dispatcher creates run record and run-scoped token
8     Dispatcher prepares isolated run workspace
9     Dispatcher launches configured runner
10    Child agent calls run-scoped API for task card and next action
11    Child edits, tests, commits
12    Child POSTs /runs/{runId}/handoff
13    AgentRail validates handoff
14    AgentRail pushes branch, creates PR, or continues lifecycle
```

Runnable task definition:

```text
A task is runnable when:
- status is todo or ready_for_agent
- assigned agent exists
- agent has capacity
- repo mapping is valid
- no active run already exists for the task
- required provider credentials are available
- task phase is supported by that agent/runner
```

Run lifecycle:

```text
Run State           Meaning
------------------  --------------------------------------------------
queued              Task selected for agent execution
starting            Workspace and prompt being prepared
running             Child agent process active
handoff_received    Child submitted result
succeeded           AgentRail accepted handoff and continued lifecycle
blocked             Child requested user/action intervention
failed              Runner/tooling failure
cancelled           Stopped by user/system
```

`agentrail agent run` remains an escape hatch for:

- manual debugging
- benchmark deterministic one-shot runs
- retrying a specific run
- development and testing

## Workspace, Sandbox, and Storage

The child agent should fail because the task is hard, not because the runner workspace is malformed.

Use clone-per-run semantics for sandbox correctness, but back them with cache and retention to avoid unbounded local storage growth.

Storage-aware layout:

```text
~/.agentrail/
  repo-cache/
    github.com/owner/repo.git/        # shared bare/mirror cache
  runs/
    run_abc123/
      repo/                           # per-run working checkout
      task-card.json
      prompt.md
      recipe.md
      runner.log
      handoff.json
      reports.jsonl
      summary.json
```

Workspace strategy:

- Use clone-per-run semantics so each run has isolated writable `.git` metadata.
- Seed clones from the shared repo cache to avoid repeated full network clones.
- Avoid git worktrees as the default Codex workspace mechanism.
- Keep run artifacts after completion, but prune heavy `repo/` directories.

Retention defaults:

```text
Successful completed runs:
- keep repo checkout for 3 days or last 20 runs

Failed/blocked runs:
- keep repo checkout for 14 days or last 50 runs

Always keep:
- task-card.json
- handoff.json
- runner.log
- summary.json
- reports.jsonl
```

Storage guardrails:

- Track total AgentRail storage usage.
- Warn or pause dispatch when usage exceeds configured budget.
- Provide `agentrail storage status`.
- Provide `agentrail storage prune`.
- Allow pinning runs to prevent cleanup.

Repo validation must happen at `agentrail repo add`.

Validation checks:

```text
Check                         Required?
----------------------------  ----------------------------------------------
Path exists                   yes
Path is git repo              yes
Remote matches repo slug      yes, or explicit advanced override
Default branch exists         yes
Working tree safe to clone    yes
Package/tooling detectable    warning only
```

Setup and verification tasks should not consume real work capacity:

```text
Task Type                  Counts Against maxConcurrentTasks?
-------------------------  ----------------------------------
setup verification          no
triage/admin maintenance    no, unless configured
real assigned task          yes
active run                  yes
terminal task               no
```

Sandbox policy:

```text
Mode                Use Case
------------------  --------------------------------------------------
workspace-write     Product default once workspace layout is safe
danger-full-access  Benchmarks, disposable repos, local dev override
read-only           Not valid for coding tasks
```

## Handoff and Lifecycle Continuation

The child agent's job ends at a structured handoff. AgentRail continues the lifecycle.

```text
Child agent produces verified local work.
AgentRail validates, publishes, and moves lifecycle forward.
```

Handoff endpoint:

```text
POST /runs/{runId}/handoff
```

Successful handoff:

```json
{
  "version": 1,
  "target": "agentrail",
  "summary": "Implemented sparse issue update merge behavior.",
  "commitSha": "abc123",
  "checks": [
    {
      "name": "npm test",
      "status": "passed",
      "summary": "15 tests passed, 0 failed"
    }
  ],
  "artifacts": [
    {
      "type": "changed_paths",
      "paths": [
        "packages/task-engine/src/index.ts",
        "packages/task-engine/test/index.test.ts"
      ]
    }
  ]
}
```

Blocked handoff:

```json
{
  "version": 1,
  "target": "user",
  "summary": "Cannot reproduce the reported login failure.",
  "reason": "missing_reproduction",
  "actionRequired": "Add reproduction steps and expected behavior to the issue.",
  "resumeInstructions": "Rerun the task after the issue is updated."
}
```

Handoff validation:

```text
Validation
----------------------------------------------------------------
Commit SHA exists in run repo
Commit SHA is reachable from HEAD
Changed files are inside allowed repo
Required checks were run or explicitly missing
Handoff schema is valid
Task/run id matches current assignment
No forbidden instruction files were changed unless explicitly allowed
```

Lifecycle after handoff:

```text
State                 Trigger
--------------------  ------------------------------------------------
handoff_received      Child submits valid handoff
publishing            AgentRail pushing branch or creating PR
in_review             PR exists, waiting CI/review
needs_fix             CI failed or review requested changes
ready_to_ship         CI passed and review policy satisfied
done                  Shipped/merged/closed
blocked               User/provider action required
```

If CI or review needs fixes, AgentRail creates a fix-cycle task card:

```json
{
  "phase": "fix_ci",
  "nextAction": "Fix the failing CI check, run tests, commit, submit handoff.",
  "scopedContext": {
    "ciFailureSummary": "...",
    "failingChecks": ["CI / Unit Tests"]
  }
}
```

The child agent should not poll CI/review during the normal implementation phase. AgentRail parent does that. The child sees CI/review context only when AgentRail creates a fix-cycle run.

## Benchmark Implications

This product design creates two benchmark surfaces:

```text
Benchmark Surface       What It Measures
----------------------  --------------------------------------------------
Child-agent efficiency  Does AgentRail reduce the coding agent's context/load?
System efficiency       Does AgentRail plus classifier plus lifecycle cost less overall?
```

Child-agent metrics:

- input_tokens
- cached_input_tokens
- uncached_input_tokens
- output_tokens
- reasoning_output_tokens
- tool calls
- runtime API calls
- time to handoff
- handoff success rate

System metrics:

- classifier runner tokens
- routing latency
- dispatcher latency
- AgentRail lifecycle API calls
- provider API calls
- CI/review polling cost
- retry/fix-cycle count
- time to PR
- time to ready_to_ship
- time to done

Benchmark modes:

```text
Mode                  Stop Condition
--------------------  --------------------------------------------------
PR-open / handoff     Child stops when handoff is accepted or PR URL exists
Lifecycle             System stops when same terminal lifecycle state is reached
```

Fairness rules:

- Both lanes must have the same stop condition.
- Both lanes must use the same task, repo, and base commit.
- Both lanes must use the same coding runner and model.
- Control must do equivalent lifecycle work if lifecycle mode is measured.
- AgentRail classifier tokens must be reported separately.
- Failed runs are not used for savings claims.
- Sandbox failures are product bugs, not benchmark data.

Claim wording should be segmented:

```text
Bad claim:
AgentRail reduces tokens by 30-40%.

Better claim:
AgentRail reduced coding-agent token usage by X% on benchmarked workflows.
Including classifier and lifecycle overhead, net system token usage changed by Y%.
```

## Success Criteria

Product success:

- AgentRail wakes agents automatically.
- Child sees a live task card and next action.
- Child uses a run-scoped API, not broad AgentRail APIs.
- Handoff is validated and lifecycle continues.
- Bad or vague tasks go to investigation, clarification, or triage.
- Repo/workspace setup does not break agent runs.
- Setup tasks do not consume first real-task capacity.
- Users choose routing mode during init.
- Users choose local runner and model for classifier when AI assist is enabled.
- Users choose local runner and model when creating each agent.

Benchmark success:

- Same stop condition across lanes.
- No sandbox/setup failures in measured runs.
- Separate child-agent and system-token accounting.
- At least 5 pilot paired successes before directional claims.
- At least 24 paired successes before public claims.

## Open Implementation Notes

- Add run-scoped auth and endpoints before replacing the current static handoff-only recipe.
- Update `agentrail init` for routing mode and classifier runner/model selection.
- Update `agentrail agent create` and `agentrail agent update` for task runner model selection and capabilities terminology.
- Add repo validation before dispatch can use a local path.
- Replace default git-worktree execution with cache-backed per-run checkouts, or prove git metadata is writable under workspace-write before keeping worktrees.
- Add storage status/prune commands and retention cleanup.
- Keep direct model-provider API keys for a later spec.
