# AgentRail Intake Routing Engine

Status: proposed for the hosted control plane

Owner: CTO

Related contract: [operator routing OpenAPI](../api/intake-routing-admin.openapi.yaml)

## Decision

AgentRail owns intake routing inside the control plane/server. Provider adapters
normalize external issue data, the routing engine evaluates deterministic rules
first, an optional classifier handles low-coverage cases, and AgentRail writes
the resulting task assignment plus an auditable routing explanation before
waking the assigned agent.

Worker agents do not route work by default. They consume only assigned
AgentRail tasks through the normal task lifecycle API and follow
`availableActions`. Admin/operator routing APIs are a separate contract and must
not be generated into the normal agent SDKs.

## Why

Routing is a control-plane responsibility because assignment decisions need
global context: ownership, capacity, security scope, rule history, classifier
confidence, and audit records. Putting routing in GitHub labels alone loses
AgentRail-specific concepts such as capability tags and least-privilege agent
permissions. Putting routing in worker agents makes assignment non-deterministic
and allows agents to choose their own work, which increases blast radius.

## Rejected Options

GitHub-only routing was rejected. Labels and assignees are useful deterministic
signals, but they cannot express AgentRail capability tags, confidence
thresholds, audit explanations, or cross-provider routing consistently.

Worker-agent self-routing was rejected. It is flexible, but it lets the actor
that benefits from an assignment choose the assignment, wastes tokens on
provider discovery, and makes conflicts hard to debug.

Embedding routing endpoints in the public task lifecycle SDK was rejected.
Coding agents need compact assigned task operations. Operators need rule
management, dry runs, audit history, and triage controls. Those surfaces have
different scopes and risk profiles.

## Module Boundary

`IntakeAdapter` receives provider events or sync batches and returns a
`ProviderIssueSnapshot`.

`RoutingEngine` is a pure decision module. It accepts a snapshot, the active
`RoutingRuleSet`, known `AgentProfile` records, and optional classifier output.
It returns a `RoutingDecision` without mutating provider state.

`AssignmentService` applies accepted decisions idempotently. It creates or
updates the AgentRail task, writes `assignment`, `routingReason`, and
`routingDecisionId`, emits a task event, and wakes the assigned agent.

`RoutingAuditStore` persists rule set revisions, decision inputs, matched rules,
classifier inputs/outputs, conflict reasons, and the final assignment.

`TriageQueue` receives conflicting, low-confidence, or unassigned decisions.
Triage is an AgentRail queue, not a worker-agent inbox.

## Data Model

`ProviderIssueSnapshot`

- `provider`: `github`, later `linear`, `jira`, or `gitlab`.
- `providerIssueId`, `repository`, `title`, `bodyDigest`, `labels`,
  `providerAssignees`, `project`, `issueType`, `priority`.
- `ownershipTags` and `capabilityTags` derived from provider metadata or repo
  config.
- `sourceVersion` for idempotent webhook/sync replay.

`RoutingRuleSet`

- `id`, `version`, `status`, `source`, `sourceRef`, `createdBy`, `createdAt`.
- Ordered `rules`, where each rule has `conditions`, `target`, `priority`,
  `confidence`, and an operator-facing explanation template.
- `classifier` config: enabled flag, model/provider alias, confidence threshold,
  maximum candidates, and fallback queue.

`AgentProfile`

- `agentId`, `role`, `capabilityTags`, `ownershipTags`, `repoAllowlist`,
  `providerIdentityMappings`, `maxConcurrentTasks`, and `status`.
- Profiles are operator-managed and separate from the worker task API.

`RoutingDecision`

- `id`, `taskId`, `inputDigest`, `ruleSetVersion`, `outcome`, `target`,
  `confidence`, `matchedRules`, `classifierResult`, `alternatives`,
  `conflictReasons`, `createdAt`.
- `routingReason`: compact summary stored on the task for audit/debugging.

`TaskAssignment`

- `assigneeAgentId` or `triageQueueId`.
- `assignmentSource`: `deterministic_rule`, `classifier`, `manual_triage`, or
  `provider_assignee_mapping`.
- `assignedAt`, `assignedBy`, `routingDecisionId`.

## Routing Order

1. Normalize the provider issue snapshot and compute `inputDigest`.
2. Load the active rule set and eligible agent profiles.
3. Evaluate deterministic rules in order:
   repo, labels, GitHub assignee mapping, project, issue type, priority,
   ownership tags, and capability tags.
4. If exactly one deterministic target wins, assign with that rule's
   confidence.
5. If deterministic rules conflict, send to triage with conflict reasons.
6. If no deterministic target meets coverage and classifier routing is enabled,
   call the classifier with bounded fields only: title, body summary, labels,
   repo, project, issue type, priority, and eligible target descriptors.
7. If classifier confidence is at or above threshold, assign to the target.
8. If classifier confidence is below threshold or candidates tie, send to
   triage.
9. Persist the decision and routing explanation before emitting task updates.

## Rule Config Source

The production source of truth is a database table with immutable rule set
revisions and audit metadata. The admin API creates a new revision for every
change; it does not mutate historical revisions.

Config files are allowed only as an import/export path for OSS deployments,
local demos, and disaster recovery. Importing a config file still creates a
normal audited rule set revision with `source: config_file_import`.

Direct in-memory config is limited to tests.

## Security And Permissions

Routing admin APIs require `routing:admin`. Dry-run evaluation requires
`routing:evaluate`. Audit reads require `routing:read`.

Worker agent keys do not get routing scopes by default. An agent cannot assign
itself work unless an operator explicitly grants a routing/admin scope, which
should be treated as privileged infrastructure access.

Provider webhook intake validates provider signatures before creating snapshots.
Classifier prompts must not include secrets, full logs, private comments, or
repository contents beyond the bounded routing fields.

## Observability

Emit structured metrics for:

- decisions by outcome and assignment source,
- classifier confidence distribution,
- triage rate,
- conflicting rule rate,
- token count per classifier evaluation,
- route decision latency,
- assignment wake latency.

`routingDecisionId` is the trace join key from provider event to task assignment
to worker wake.

## Backwards Compatibility

Routing metadata may be added to task detail responses as optional read-only
fields. Existing worker lifecycle endpoints remain valid. Breaking changes to
operator routing APIs require a new API version or deprecation window.
