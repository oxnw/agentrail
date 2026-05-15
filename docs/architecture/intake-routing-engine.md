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

The source-available runtime supports two setup modes:

- rules-only routing, where deterministic metadata such as repo, labels,
  project, issue type, and priority must be enough to route or triage work;
- AI routing, where AgentRail can use AI to route tasks to the right agents when
  deterministic rules do not give a clear answer.

Routing rules are configurable. Repo ownership, label mappings, GitHub assignee
mappings, project ownership, issue type routing, priority handling, and
capability tags should live in versioned rule-set configuration, not in
per-customer code branches. Operators must be able to change those rules through
the admin API or a config-file import path without redeploying AgentRail.

The routing engine itself is code-owned. Supported predicates, tie-breaking
semantics, classifier threshold enforcement, permission checks, assignment side
effects, audit writes, and wake behavior are not arbitrary user scripts. Adding
a new predicate family or side effect is a product/API change and should go
through normal code review.

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

Hard-coded routing tables in application code were rejected. They are simple for
the first deployment, but they force code changes for ordinary ownership
updates, make emergency triage changes too slow, and hide routing history from
operators. The safer split is configurable rule data plus a constrained,
reviewed routing engine.

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

`AgentProfileStore` persists routable agent metadata used by the engine:
capabilities, ownership tags, repo allowlists, provider identity mappings,
capacity limits, and active/paused status.

`TriageQueue` receives conflicting, low-confidence, or unassigned decisions.
Triage is an AgentRail queue, not a worker-agent inbox.

## Data Model

`ProviderIssueSnapshot`

- `provider`: `github`, later `linear`, `jira`, or `gitlab`.
- `providerIssueId`, `repository`, `title`, `bodyDigest`, `labels`,
  `project`, `issueType`, `priority`.
- `bodyPreview`: a bounded plain-text preview used only for routing
  classification. It must be truncated before it reaches the classifier.
- `ownershipTags` and `capabilityTags` derived from provider metadata or repo
  config.
- `sourceVersion` for idempotent webhook/sync replay.

`RoutingRuleSet`

- `id`, `version`, `status`, `source`, `sourceRef`, `createdBy`, `createdAt`.
- Ordered `rules`, where each rule has `conditions`, `target`, `priority`,
  `confidence`, and an operator-facing explanation template.
- `classifier` config: enabled flag, local runner alias, model/profile,
  confidence threshold, timeout, maximum candidates, and fallback queue. The
  local runner timeout defaults to 180 seconds and is capped at 600 seconds so
  slow classifiers do not block intake indefinitely.

`AgentProfile`

- `agentId`, `role`, `capabilityTags`, `ownershipTags`, `repoAllowlist`,
  `maxConcurrentTasks`, and `status`.
- Profiles are operator-managed and separate from the worker task API.
- Profiles are created or updated by authorized control-plane operators during
  agent creation, hiring, skill assignment, or ownership changes. The likely
  writers are CEO/manager/CTO admin flows and infrastructure sync jobs, not
  worker agents and not GitHub.
- Worker agents may expose facts that help an operator choose capabilities, but
  they cannot make those facts authoritative for routing. Self-reported profile
  changes must land as suggestions or review items, not direct writes.

`RoutingDecision`

- `id`, `taskId`, `inputDigest`, `ruleSetVersion`, `outcome`, `target`,
  `confidence`, `matchedRules`, `classifierResult`, `alternatives`,
  `conflictReasons`, `createdAt`.
- `routingReason`: compact summary stored on the task for audit/debugging.

`TaskAssignment`

- `assigneeAgentId` or `triageQueueId`.
- `assignmentSource`: `deterministic_rule`, `classifier`,
  `classifier_best_effort`, or `manual_triage`.
- `assignedAt`, `assignedBy`, `routingDecisionId`.

## Routing Order

1. Normalize the provider issue snapshot and compute `inputDigest`.
2. Load the active rule set and eligible agent profiles.
3. Evaluate deterministic rules in order:
   repo, labels, project, issue type, and priority.
4. If exactly one deterministic target wins, assign with that rule's
   confidence.
5. If deterministic rules conflict, send to triage with conflict reasons.
6. If no deterministic target meets coverage and classifier routing is enabled,
   call the local classifier runner with bounded fields only: title,
   body preview, labels, repo, project, issue type, priority, allowed
   capability values, and active eligible agent descriptors.
7. The classifier returns task type, required capabilities, optional
   capabilities, ownership hints, missing information, confidence, and evidence.
8. The deterministic routing engine scores active candidates against that
   classifier output. Hard constraints still apply: repo allowlist, active
   status, and capacity.
9. If classifier confidence is at or above threshold and one capable candidate
   wins, assign with `assignmentSource: "classifier"`.
10. If confidence is low, required information is missing, no capable agent
    exists, or candidates are unsafe to distinguish, send to triage.
11. Persist the decision and routing explanation before emitting task updates.

## Classifier Boundary

The classifier is a bounded helper, not the router. It does not pick an
authoritative agent by itself, and it does not receive provider tokens, full
repository contents, logs, private comments, or arbitrary secrets.

The classifier's job is to translate under-described issue text into routing
signals:

- required capabilities, such as `backend`, `frontend`, `tests`, `docs`,
  `infra`, `security`, or `api`;
- optional capabilities that improve ranking but should not block assignment;
- ownership hints, such as `billing`, `auth`, `ci`, or `integrations`;
- missing information that should force triage rather than a bad assignment.

The routing engine remains deterministic after classification. It validates
classifier output against the configured agent capability inventory, drops
unknown values, applies confidence thresholds, scores active profiles, and
records the final explanation.

This keeps setup forgiving without pretending every GitHub or Linear issue is
perfectly written. If the issue does not contain enough information, AI routing
should make that visible and triage it; it should not fabricate certainty.

## Follow-Up: Role, Skills, And Ownership Semantics

This is a follow-up note for the next routing-engine pass. The current data
model already has `role`, `capabilityTags`, and `ownershipTags`, but the
meaning of those fields should be tightened so setup, audit, and routing all
use the same mental model.

Current behavior:

- local source-available routing uses hard constraints plus deterministic rule conditions
  such as repo, labels, project, issue type, and priority;
- `role`, `capabilityTags`, and `ownershipTags` exist on profiles, but they are
  not yet modeled as a separate soft-scoring phase;
- local source-available AgentRail no longer uses provider-assignee mapping as a routing
  signal.

Planned behavior:

- keep hard constraints such as `repoAllowlist`, permissions, status, and
  capacity as blocking checks;
- use `role`, `capabilityTags`, and `ownershipTags` as soft routing signals
  that improve ranking and explanation before triage, rather than as brittle
  blockers.

Use the fields this way:

- `role`: the agent's broad operating lane. This should be narrow and stable
  over time, and answer "what kind of agent is this?" Examples:
  `coding_agent`, `review_agent`, `docs_agent`, `infra_devops_agent`, and
  `release_agent`.
- `capabilityTags`: the kinds of work the agent can usually handle well. These
  are soft capability signals such as `frontend`, `backend`, `api`, `tests`,
  `docs`, `infra`, `devops`, `security`, `data`, `mobile`, `review`, and
  `release`.
- `ownershipTags`: the domain or surface area where this agent should be
  preferred when several agents could do the work. These are things like
  `billing`, `auth`, `integrations`, `deployments`, `ci`, `web`, or `api`.

The routing engine should not treat `role`, `capabilityTags`, and
`ownershipTags` as brittle blockers in the common case. They should usually
improve ranking and explanation, not prevent assignment outright.

The intended routing split is:

- hard constraints:
  `repoAllowlist`, permissions, agent status, and capacity;
- soft routing signals:
  `role`, `capabilityTags`, `ownershipTags`, and later historical performance
  if the product adds it.

The intended fallback behavior is:

1. Prefer exact or strong matches first.
2. Allow acceptable near-matches when no better agent exists.
3. Escalate to triage when no candidate clears a minimum confidence threshold.

Example:

- a billing task should strongly prefer an agent with `ownershipTags` including
  `billing`;
- if no billing owner exists, a backend coding agent may still be a valid
  lower-confidence fallback;
- if only clearly unrelated candidates remain, the engine should escalate to
  triage instead of forcing a bad assignment.

This means setup metadata should make AgentRail smarter, not more fragile.
Incomplete setup should reduce confidence, not automatically make the system
unusable.

### Follow-Up Implementation Work

- tighten the supported role taxonomy used by setup and routing;
- tighten the supported skill/capability taxonomy used by setup and routing;
- keep domain-specific concepts such as `billing` and `integrations` in
  `ownershipTags`, not in capability tags;
- update scoring so `role`, `capabilityTags`, and `ownershipTags` affect
  ranking and explanation before triage;
- document the confidence threshold that decides when the engine should stop
  guessing and escalate.

## Rule Config Source

The production source of truth is a database table with immutable rule set
revisions and audit metadata. The admin API creates a new revision for every
change; it does not mutate historical revisions.

The database-backed rule set is the normal configuration plane. It is meant for
ownership changes that happen often: repo-to-agent mappings, label conventions,
provider assignee mappings, project ownership, issue type defaults, priority
escalation, and ownership/capability tag mappings.

Config files are allowed only as an import/export path for source-available
deployments, local demos, and disaster recovery. Importing a config file still
creates a normal audited rule set revision with `source: config_file_import`.

Direct in-memory config is limited to tests. Hard-coded production routing data
is not allowed, except for bootstrap defaults that create an auditable initial
rule set revision.

## AgentProfile Ownership

`AgentProfile` is AgentRail control-plane data. It should be seeded when an
agent identity is created or hired, then updated through a routing/admin API or
trusted infrastructure sync. Capability tags can be derived from approved skill
assignments, agent role, and operator-entered ownership. Repo allowlists and
ownership tags come from the operator, not from provider assignment alone.

Only keys with `routing:admin` can write profiles. `routing:read` can inspect
them for audit/debugging. Worker task keys do not include profile write scope.

## AgentRail Agent Identity Mapping

Routing targets use the internal AgentRail `agentId`. That ID is the stable
`AgentIdentity.id` used by agent API keys, task assignees, task event actors,
and `AgentProfile.agentId`.

The mapping is:

- one AgentRail `agentId` represents one routable worker identity inside an
  AgentRail workspace, such as `agt_cto` or `agt_platform_ci`;
- one AgentRail `agentId` can have multiple runtime credentials or external
  runtime identities through the existing agent auth `externalIdentities`
  model, for example Codex local, Claude Code, Cursor, Devin, or Paperclip
  adapter identities;
- each AgentRail API key authenticates as exactly one `agentId`, so a worker
  cannot use a key to read tasks assigned to another agent;
- provider-side assignee data stays in GitHub, Linear, Jira, or GitLab; local
  source-available AgentRail does not maintain provider-to-agent identity
  mappings.

In short: providers and runtimes are aliases; `agentId` is the routing and task
ownership key.

## AgentProfile Creation Plan

The initial implementation should make profile creation explicit instead of
assuming profiles already exist:

1. Add an `AgentProfileStore` table keyed by `agentId`, with audit columns for
   `source`, `sourceRef`, `updatedBy`, `updatedAt`, and `changeReason`.
2. Seed a default profile when an agent identity is created or hired. The
   default can include role and status, but should leave ownership tags and repo
   allowlists empty until an operator or approved sync sets them.
3. Add routing admin endpoints to read and replace a profile:
   `GET /operator/routing/agent-profiles/{agentId}` and
   `PUT /operator/routing/agent-profiles/{agentId}`.
4. Allow trusted sync jobs to update capability tags from approved skill
   assignments, using the same audit path as operator changes.
5. Keep worker-agent writes out of the path. If an agent needs a capability
   change, it should request review; the approved operator action updates the
   profile.
6. Make the routing engine treat missing, disabled, or repo-disallowed profiles
   as ineligible. If no eligible target remains, route to triage with a
   `routingReason` that names the missing/disabled profile condition.

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
