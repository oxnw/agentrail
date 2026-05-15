# AI Routing E2E Test Guide

Use this guide for manual end-to-end validation of "Use AI to route tasks to
the right agents" in the source-available runtime. The goal is to prove that
provider issues can become assigned AgentRail tasks without relying on perfectly
labeled issues.

## Preconditions

- `agentrail` resolves to the current checkout, for example through `npm link`.
- At least one local coding runner is installed: `codex`, `claude`, or
  `cursor-agent`.
- GitHub and Linear provider credentials are configured only if testing live
  provider intake.
- The target repo is safe to receive test issues and PRs.

## Setup

Initialize with AI routing:

```bash
agentrail init \
  --routing-mode ai-assist \
  --routing-classifier-runner codex \
  --routing-classifier-model gpt-5.4-mini
```

The generated local classifier timeout is 180 seconds. For slow local runner
machines, edit `routing.classifier.timeoutMs` in `config.json` up to 600000
milliseconds before running provider-intake cases.

Create at least two agents with different capabilities and, if useful,
different model profiles:

```bash
agentrail agent create --runner codex --model gpt-5.4-mini
agentrail agent create --runner codex --model gpt-5.4-mini
```

Run doctor:

```bash
agentrail doctor
```

Expected result:

- health, auth, profile, routing, AI routing, and assigned task visibility pass;
- the AI routing check confirms the configured executable is available;
- no model call is made by doctor.

## Case 1: Deterministic Rule Still Wins

1. Configure a narrow deterministic rule that targets one agent for a known
   label or repo.
2. Create or import an issue that matches the rule and also contains ambiguous
   body text.
3. Wait for intake.

Expected result:

- the task is assigned by `assignmentSource: "deterministic_rule"`;
- AI routing is not required for the assignment;
- the assigned runner wakes for the task.

## Case 2: AI Routing Assigns Work

1. Create or import an issue without a matching deterministic label.
2. Include enough text for AI to route the task, for example a backend API bug
   or CI failure.
3. Ensure at least one active agent profile has matching capability tags.
4. Wait for intake.

Expected result:

- the task is assigned by `assignmentSource: "classifier"`;
- the routing reason explains why that agent was selected;
- the selected agent is repo-eligible, active, and below capacity;
- the runner wakes and can complete the normal start, submit, CI, review, and
  ship lifecycle.

## Case 3: Missing Information Goes To Triage

1. Create or import a vague issue such as "it is broken" with no useful labels,
   body details, project, or issue type.
2. Wait for intake.

Expected result:

- the task is left waiting for more information;
- the routing reason says the task was too vague or low confidence;
- no runner starts against the task.

## Case 4: No Suitable Agent Follows The Configured Policy

1. Create or import an issue whose required capability is not present on any
   active, repo-eligible agent.
2. Wait for intake.

Expected result:

- with "Require a suitable agent", the task is left waiting and the routing
  reason names the missing agent skills or ownership areas;
- after an agent is created or updated with those skills, AgentRail retries the
  waiting task automatically;
- with "Assign the closest match", the task is assigned with
  `assignmentSource: "classifier_best_effort"` and the routing reason records
  that AI routing made a best-effort choice.

## Case 5: Runner Readiness Failure Is Visible

1. Configure AI routing with an unavailable local runner.
2. Run `agentrail doctor`.

Expected result:

- doctor fails at the AI routing check;
- the failure names the missing executable;
- no provider intake test is started until the setup is repaired.

## Evidence To Capture

For each case, record:

- command transcript for `agentrail doctor`;
- provider issue URL or import command;
- task id and `routingReason`;
- assignment source;
- runner wake evidence;
- PR URL and lifecycle result for successful coding tasks.
