# Recovered Slice Ledger

Status: reconstructed from local Codex session logs, checked-in docs, and live
GitHub issue/PR history on 2026-05-18.

Purpose: recover the slice sequence, deferred items, and remaining work after
session-memory loss and context compaction.

Current use: historical recovery record plus dated status notes. Do not treat
the 2026-05-18 failures or planned slices below as current until checking the
2026-05-19 update.

## Evidence Sources

- local recovery note in `AGENTS.md`
- checked-in architecture docs under `docs/architecture/`
- live GitHub issues and pull requests on `oxnw/agentrail`
- merged PR descriptions from the managed-runner and lifecycle work

This file separates facts from inference. Items are grouped as `confirmed`,
`probable`, or `unverified`.

## 2026-05-19 Status Update

The 2026-05-18 recovery ledger is partially superseded by later fixes and live
E2E runs.

### Current Verified Full Lifecycle

On 2026-05-19, a real GitHub-origin task with CircleCI-backed CI completed the
managed lifecycle end to end:

- sandbox issue `oxnw/agentrail-e2e-sandbox#93` was created
- AgentRail imported the issue and routed it to
  `agt_codex_codex_benchmark_agent_15d6fb3a`
- the managed Codex runner woke automatically and completed the task
- AgentRail opened PR `oxnw/agentrail-e2e-sandbox#94`
- GitHub checks passed
- CircleCI status `ci/circleci: verify` passed
- AgentRail review feedback reported approval was not required
- AgentRail `/ship` merged PR `#94`
- issue `#93` closed
- the AgentRail task ended `done` with `availableActions: ["rollback"]`

This proves the happy-path lifecycle for:

- GitHub issue intake
- deterministic routing
- managed local runner wakeup
- run-scoped managed Codex execution
- AgentRail-owned PR submission
- CircleCI-backed CI projection
- review-not-required ship readiness
- AgentRail-owned merge/ship

### Superseded 2026-05-18 Failures

These 2026-05-18 findings are no longer current for the GitHub-origin happy
path:

- fresh GitHub issue routing to `triage_default` with `no_route`
- local managed-runner supervisor crashing with `EADDRINUSE 127.0.0.1:3000`
- managed runner failing to wake/start automatically
- happy-path review feedback disagreeing with ship readiness
- CircleCI only being connected but not actively observed on a task

### Still Open After 2026-05-19

The following are still not fully proven by the latest run:

- Linear-origin full lifecycle
- review changes requested -> agent wakes -> fix -> green CI -> ship
- CircleCI failure/recovery handling, beyond successful CircleCI-backed CI
- stale run / reclaimability policy

### Current Slice Status

- Slice A, fresh GitHub intake routing: verified complete by issue `#93`.
- Slice B, local managed-runner boot / wake reliability: verified complete by
  the automatic run for issue `#93`.
- Slice C, review feedback / ship readiness consistency: happy-path
  `not_required` review state is verified complete; changes-requested recovery
  remains open.
- Slice D, real Linear-origin E2E: still open.
- Slice E, real CircleCI-backed E2E: successful CI projection and ship are
  verified through GitHub-origin PRs `#92` and `#94`; CircleCI failure/recovery
  behavior remains open.

## Confirmed Completed Slices

### Provider Intake And Routing Foundation

- Issue `#21` closed: route imported provider tasks through the routing engine.
- The provider-import/routing gap was closed before the managed-runner E2E
  lifecycle work.

### User-Needed Fast-Follows Track

This track has its own explicit plan in
`docs/architecture/user-needed-fast-follows.md`.

Confirmed shipped PRs:

- PR `#37`: awaiting-user blocker lifecycle
- PR `#38`: desktop notifications for awaiting-user actions
- PR `#40`: AgentRail event subscriptions

### Managed Runner / Lifecycle Reliability Track

Confirmed shipped PR chain:

- PR `#42`: harden managed runner event lifecycle
- PR `#43`: add AI-assisted task routing
- PR `#44`: keep managed local agents awake
- PR `#45`: add run-scoped managed agent context
- PR `#46`: enforce managed runner policy
- PR `#48`: fix managed runner commit ownership
- PR `#49`: normalize retry lifecycle actions to `fix`
- PR `#50`: harden managed runner lifecycle through ship

This chain is the main product path that took AgentRail from:

- issue intake and routing
- to managed runner wakeup
- to handoff/commit ownership
- to CI/review freshness
- to live `/ship`
- to persisted `done` plus rollback availability

## Confirmed Outstanding Work At Recovery Time

### Issue `#47`: Real E2E lifecycle: GitHub, Linear, CircleCI managed agent flow

Issue `#47` is the open umbrella for real end-to-end validation.

Confirmed goal from the issue body:

- prove real provider intake
- prove routing to the correct local agent
- prove automatic agent wakeup
- prove run-scoped context delivery
- prove code change plus AgentRail reporting
- prove PR lifecycle through AgentRail
- prove CI observation and summary
- prove review feedback wakeup
- prove ship/merge readiness and path

Confirmed note from the issue comments:

- the 2026-05-16 real E2E run passed through provider auth, issue intake,
  routing, wakeup, repo edit, and validation
- it failed before full submit/PR/ship because the managed Codex sandbox could
  not write AgentRail run files or git metadata
- those failures were later addressed by the shipped PR chain above

### Stale Run / Reclaimability Policy

This remains the one clearly deferred item in
`docs/architecture/user-needed-fast-follows.md`.

Confirmed still outstanding:

- stale `starting` / `running` run policy
- reclaimability semantics
- zombie-run cleanup without losing unresolved user action

No merged PR in the recovered history clearly closes this planned item.

Status as of 2026-05-19: still believed open.

## Confirmed Earlier Breakages That Were Fixed Later

These were found during real E2E or manual managed-run tests and then addressed
by later slices:

- managed Codex sandbox could not write report/handoff files
- managed Codex sandbox could not create git worktree metadata locks
- AgentRail depended on child-created commits in situations where the parent
  should own commit/push/submit
- wakeups could be missed around event-stream timing and review-change events
- retry action naming was ambiguous after an existing submission
- stale CI/review observations could incorrectly affect the latest fix
- live `/ship` path was not fully wired through the runtime and queue

## Probable Remaining Work Under Issue `#47` At Recovery Time

These items are strongly implied by the issue body and recovered run history,
but are not yet proven complete from the recovered evidence:

- full real lifecycle proof for a Linear-originated task
- full real lifecycle proof for a CircleCI-backed CI path
- confirmation that review-change -> wake -> fix -> green CI -> ship works on
  those non-GitHub-only paths as well

Status as of 2026-05-19:

- Linear-origin lifecycle is still open.
- CircleCI-backed success path is verified through GitHub-origin PRs `#92` and
  `#94`.
- review-change -> wake -> fix -> green CI -> ship remains open.

Reason for `probable` instead of `confirmed`:

- issue `#47` explicitly names GitHub, Linear, and CircleCI
- the recovered 2026-05-16 issue comment says CircleCI was configured but not
  actually exercised in that run
- the recovered shipped PR chain proves the GitHub managed lifecycle path, but
  does not itself prove equivalent real E2E coverage for Linear and CircleCI

## Unverified

These items should not be treated as facts until proven:

- whether issue `#47` was intended to split into more numbered slices after PR
  `#50`
- whether there was a separate private/local planning file outside the evidence
  recovered here
- whether the `real-lifecycle-e2e` worktree contains additional unmerged notes
  that change the remaining scope

## Working Conclusion At Recovery Time

The recovered ledger supports these conclusions:

1. The managed-runner / lifecycle reliability slice chain was real and is not
   lost.
2. The main remaining umbrella is issue `#47`.
3. One clearly deferred separate policy slice still exists: stale-run /
   reclaimability.
4. The most likely missing proof work is full real E2E validation for Linear
   and CircleCI paths, not a hidden unrecovered architecture initiative.

## Next Recommended Use

Use this file as a historical recovery note plus dated status tracker for:

- choosing the next implementation slice
- deciding which E2E paths still need proof
- avoiding future reliance on chat/session memory for roadmap state

Before choosing new work from this file, check the latest dated status section
near the top. Older sections intentionally preserve historical findings that
may now be fixed.

## 2026-05-18 Real E2E Findings

This section records the next live validation pass that was run after the
ledger was reconstructed.

### Live Setup Used

- local AgentRail server from this checkout
- persisted AgentRail config under `~/.agentrail/config.json`
- real provider credentials for GitHub, CircleCI, and Linear
- active local agent `agt_codex_codex_benchmark_agent_15d6fb3a`
- active deterministic repo-wide routing rule for
  `oxnw/agentrail-e2e-sandbox`

### Paths Exercised

- `provider test github`
- `provider test circleci`
- `provider test linear`
- fresh GitHub issue intake
- blocked-task resolution
- managed runner wake/start path
- existing in-review PR task ship/review/CI checks
- task/routing store verification

### Confirmed Passes

- provider connectivity passed for GitHub, CircleCI, and Linear
- blocked-task recovery worked: task `#55` moved from `blocked` to `todo`
  with `availableActions: ["start"]`
- `/ship` correctly refused to merge an in-review PR that still required
  approval
- CI projection for the in-review PR task was healthy

### Confirmed Failures And Regressions

Status as of 2026-05-19: these were real failures on 2026-05-18, but they are
superseded for the GitHub-origin happy path by the issue `#93` -> PR `#94`
live E2E run. Keep them as history, not current blockers.

- fresh GitHub issue `#70` was sent to `triage_default` with routing outcome
  `no_route`
- this happened even though the active deterministic rule and agent repo
  allowlist still match `oxnw/agentrail-e2e-sandbox`
- the local managed-runner supervisor is broken in this checkout: it keeps
  restarting a child runner that crashes with `EADDRINUSE 127.0.0.1:3000`
- a manual `agent run --once` on task `#55` did not make forward progress and
  ended in a failed block/report path
- the review-feedback surface and ship gate disagree on at least one in-review
  task: earlier authenticated results reported review as `not_required`, while
  `/ship` reported that approval was still required

### Confirmed Coverage Gaps

Status as of 2026-05-19: Linear-origin E2E remains a gap. CircleCI successful
status projection is no longer a gap for GitHub-origin tasks, but
failure/recovery behavior is still not proven.

- Linear is configured, but no Linear-origin task was actually exercised in
  this pass
- CircleCI connectivity was exercised, but no active CircleCI-backed task was
  observed during this pass

### Evidence Summary

- `routing-rules.json` still contains the active repo-wide deterministic rule
- `agent-profiles.json` still contains the active agent with repo allowlist
  `oxnw/agentrail-e2e-sandbox`
- `routing-audit.json` for issue `#70` recorded `matchedRules: []` and
  `outcome: "no_route"`
- live server logs showed repeated local-runner restart attempts ending in
  `EADDRINUSE`

## Planned Fix Slices After 2026-05-18 E2E

These slices are sequenced to restore the GitHub product path first, then close
provider-specific proof gaps.

### Slice A: Restore Fresh GitHub Intake Routing

Status as of 2026-05-19: verified complete by sandbox issue `#93`, which routed
to `agt_codex_codex_benchmark_agent_15d6fb3a`.

Goal:

- fix the regression where a fresh GitHub issue can miss an active deterministic
  repo-wide rule and fall into manual triage

Scope:

- reproduce the miss against the current routing engine
- trace why `matchedRules` becomes empty for issue `#70`-style tasks
- fix rule matching for provider-created tasks without weakening existing agent
  eligibility checks
- prove the fix by creating a fresh sandbox GitHub issue and confirming
  automatic assignment plus `availableActions: ["start"]`

Exit criteria:

- a newly created GitHub issue in `oxnw/agentrail-e2e-sandbox` routes to
  `agt_codex_codex_benchmark_agent_15d6fb3a`
- routing audit shows `outcome: "assigned"` and `assignmentSource:
  "deterministic_rule"`

### Slice B: Fix Local Managed-Runner Boot / Wake Reliability

Status as of 2026-05-19: verified complete by sandbox issue `#93`. The local
runner woke automatically, completed the task, and did not crash with
`EADDRINUSE`.

Goal:

- stop the local runner supervisor from spawning a child process that attempts
  to bind the AgentRail server port

Scope:

- trace the managed local-runner launch path
- identify why the child process is booting server behavior instead of
  run-only behavior
- fix the runner launch contract so wakeups start a worker, not another server
- prove the fix with a real assigned task that automatically wakes and starts
  without manual intervention

Exit criteria:

- local runner no longer crashes with `EADDRINUSE`
- a routed GitHub task automatically starts and moves beyond `todo`

### Slice C: Fix Review Feedback / Ship Readiness Consistency

Status as of 2026-05-19: happy path verified by PR `#94`. AgentRail review
feedback reported `not_required`, `ship` was available, and `/ship` succeeded.
The changes-requested recovery loop remains unproven.

Goal:

- make review feedback projection and ship gating derive from the same PR-wide
  truth

Scope:

- reproduce the inconsistent in-review task state
- trace how review-feedback decides `not_required`
- align review projection with the same approval requirements used by `/ship`
- prove the fix on a real or preserved in-review PR task

Exit criteria:

- `review-feedback` and `/ship` agree about whether review approval is still
  required for the latest submission

### Slice D: Real Linear-Origin E2E

Status as of 2026-05-19: still open.

Goal:

- prove the end-to-end lifecycle starting from a real Linear issue

Scope:

- create or import a real Linear issue
- confirm intake, routing, wakeup, code change, AgentRail submit, PR creation,
  CI observation, and downstream lifecycle state
- capture any provider-specific gaps that differ from GitHub-origin tasks

Exit criteria:

- one real Linear-origin task completes the same managed lifecycle expected by
  issue `#47`, or yields concrete product bugs with reproduction steps

### Slice E: Real CircleCI-Backed E2E

Status as of 2026-05-19: partially verified. CircleCI-backed successful CI
projection and ship readiness were proven on GitHub-origin PRs `#92` and `#94`.
CircleCI failure/recovery behavior remains unproven.

Goal:

- prove a task whose CI observation path is actually backed by CircleCI, not
  just provider connectivity

Scope:

- run a task that produces a real CircleCI-backed PR/branch lifecycle
- confirm CI polling, task projection, failure/recovery handling, and ship
  readiness
- capture any CircleCI-specific freshness or summary bugs

Exit criteria:

- one real CircleCI-backed task reaches a verified CI-observed lifecycle state
  through AgentRail, or yields concrete product bugs with reproduction steps
