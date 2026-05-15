import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInitCommand,
  createSetupConfig,
  validateSafeDefaults,
  type DetectedRepoContext,
} from "../src/cli/setup-config.ts";
import { normalizeSetupConfigLike } from "../src/cli/agentrail-home.ts";

const detectedRepo: DetectedRepoContext = {
  repoPath: "/tmp/agentrail",
  remoteSlug: "oxnw/agentrail",
  defaultBranch: "main",
  gitIgnoreHasAgentrail: true,
};

test("createSetupConfig derives server defaults from repo detection", () => {
  const config = createSetupConfig({
    cwd: detectedRepo.repoPath,
    detectedRepo,
    interactionMode: "interactive",
    acceptedDefaults: true,
  });

  assert.equal(config.mode, "server");
  assert.equal(config.server.host, "127.0.0.1");
  assert.equal(config.server.port, 3000);
  assert.equal(config.server.baseUrl, "http://127.0.0.1:3000");
  assert.equal(config.persistence.kind, "file");
  assert.equal(config.persistence.engine, "file");
  assert.equal(config.persistence.authStorePath, "stores/agent-auth.json");
  assert.equal(config.persistence.agentRunStorePath, "stores/agent-runs.json");
  assert.equal(config.persistence.providerCursorStorePath, "stores/provider-cursors.json");
  assert.equal(config.persistence.eventSubscriptionStorePath, "stores/event-subscriptions.json");
  assert.equal(config.persistence.eventDeliveryStorePath, "stores/event-deliveries.json");
  assert.equal(config.providers.github.mode, "real");
  assert.equal(config.providers.github.importMode, "from_now");
  assert.equal(config.providers.circleci.mode, "real");
  assert.equal(config.providers.linear.mode, "real");
  assert.equal(config.providers.github.deliveryMode, "polling");
  assert.equal(config.providers.circleci.deliveryMode, "polling");
  assert.equal(config.providers.linear.deliveryMode, "polling");
  assert.equal(config.routing.mode, "rules_only");
  assert.equal(config.routing.classifier.runner, "codex");
  assert.equal(config.routing.classifier.model, null);
  assert.equal(config.routing.classifier.confidenceThreshold, 0.8);
  assert.equal(config.routing.classifier.fallbackBehavior, "require_suitable_agent");
  assert.equal(config.routing.classifier.timeoutMs, 180_000);
  assert.deepEqual(config.repos.map((repo) => repo.slug), ["oxnw/agentrail"]);
  assert.equal(config.repos[0].defaultBranch, "main");
  assert.equal(config.exports.markdown.enabled, false);
});

test("createSetupConfig supports ai-assisted routing options", () => {
  const config = createSetupConfig({
    cwd: detectedRepo.repoPath,
    detectedRepo,
    interactionMode: "interactive",
    acceptedDefaults: false,
    routingMode: "ai_assist",
    routingClassifierRunner: "claude-code",
    routingClassifierModel: "sonnet",
    routingConfidenceThreshold: 0.7,
    routingFallbackBehavior: "assign_closest_match",
  });

  assert.equal(config.routing.mode, "ai_assist");
  assert.equal(config.routing.classifier.runner, "claude-code");
  assert.equal(config.routing.classifier.model, "sonnet");
  assert.equal(config.routing.classifier.confidenceThreshold, 0.7);
  assert.equal(config.routing.classifier.fallbackBehavior, "assign_closest_match");
  assert.equal(config.routing.classifier.timeoutMs, 180_000);
  assert.match(buildInitCommand(config), /--routing-no-suitable-agent assign-closest-match/);
});

test("normalizeSetupConfigLike maps legacy AI routing fallback values to require suitable agent", () => {
  const config = normalizeSetupConfigLike({
    version: 2,
    routing: {
      mode: "ai_assist",
      classifier: {
        kind: "local_runner",
        runner: "codex",
        model: null,
        confidenceThreshold: 0.8,
        fallbackBehavior: "triage",
        timeoutMs: 30_000,
      },
    },
    providers: {},
    repos: [],
  });

  assert.ok(config);
  assert.equal(config.routing?.classifier?.fallbackBehavior, "require_suitable_agent");
  assert.equal(config.routing?.classifier?.timeoutMs, 30_000);
});

test("normalizeSetupConfigLike fills missing AI routing timeout with the local runner default", () => {
  const config = normalizeSetupConfigLike({
    version: 2,
    routing: {
      mode: "ai_assist",
      classifier: {
        kind: "local_runner",
        runner: "codex",
        model: null,
        confidenceThreshold: 0.8,
        fallbackBehavior: "require_suitable_agent",
      },
    },
    providers: {},
    repos: [],
  });

  assert.ok(config);
  assert.equal(config.routing?.classifier?.timeoutMs, 180_000);
});

test("normalizeSetupConfigLike fills agent run store path for older file configs", () => {
  const config = normalizeSetupConfigLike({
    version: 2,
    server: {
      baseUrl: "http://127.0.0.1:3000",
    },
    persistence: {
      kind: "file",
    },
    providers: {},
    repos: [{
      path: "/tmp/agentrail",
      slug: "oxnw/agentrail",
      defaultBranch: "main",
    }],
  });

  assert.ok(config);
  assert.ok(config.persistence);
  assert.equal(config.persistence.agentRunStorePath, "stores/agent-runs.json");
  assert.equal(config.persistence.providerCursorStorePath, "stores/provider-cursors.json");
  assert.equal(config.persistence.eventSubscriptionStorePath, "stores/event-subscriptions.json");
  assert.equal(config.persistence.eventDeliveryStorePath, "stores/event-deliveries.json");
});

test("normalizeSetupConfigLike preserves explicit agent run store paths", () => {
  const config = normalizeSetupConfigLike({
    version: 2,
    persistence: {
      kind: "file",
      agentRunStorePath: "custom/runs.json",
    },
    providers: {},
    repos: [],
  });

  assert.ok(config);
  assert.ok(config.persistence);
  assert.equal(config.persistence.agentRunStorePath, "custom/runs.json");
});

test("normalizeSetupConfigLike treats whitespace-only agent run store paths as missing", () => {
  const config = normalizeSetupConfigLike({
    version: 2,
    persistence: {
      kind: "file",
      agentRunStorePath: "   ",
    },
    providers: {},
    repos: [],
  });

  assert.ok(config);
  assert.ok(config.persistence);
  assert.equal(config.persistence.agentRunStorePath, "stores/agent-runs.json");
});

test("normalizeSetupConfigLike treats mixed whitespace agent run store paths as missing", () => {
  const config = normalizeSetupConfigLike({
    version: 2,
    persistence: {
      kind: "file",
      agentRunStorePath: "\t\n ",
    },
    providers: {},
    repos: [],
  });

  assert.ok(config);
  assert.ok(config.persistence);
  assert.equal(config.persistence.agentRunStorePath, "stores/agent-runs.json");
});

test("normalizeSetupConfigLike treats empty string agent run store paths as missing", () => {
  const config = normalizeSetupConfigLike({
    version: 2,
    persistence: {
      kind: "file",
      agentRunStorePath: "",
    },
    providers: {},
    repos: [],
  });

  assert.ok(config);
  assert.ok(config.persistence);
  assert.equal(config.persistence.agentRunStorePath, "stores/agent-runs.json");
});

test("normalizeSetupConfigLike trims explicit agent run store paths", () => {
  const config = normalizeSetupConfigLike({
    version: 2,
    persistence: {
      kind: "file",
      agentRunStorePath: "  custom/runs.json  ",
    },
    providers: {},
    repos: [],
  });

  assert.ok(config);
  assert.ok(config.persistence);
  assert.equal(config.persistence.agentRunStorePath, "custom/runs.json");
});

test("normalizeSetupConfigLike does not add file defaults to memory persistence", () => {
  const config = normalizeSetupConfigLike({
    version: 2,
    persistence: {
      kind: "memory",
    },
    providers: {},
    repos: [],
  });

  assert.ok(config);
  assert.ok(config.persistence);
  assert.equal(config.persistence.agentRunStorePath, undefined);
  assert.equal(config.persistence.eventSubscriptionStorePath, undefined);
  assert.equal(config.persistence.eventDeliveryStorePath, undefined);
  assert.equal(config.persistence.providerCursorStorePath, undefined);
});

test("normalizeSetupConfigLike fills GitHub import mode for older provider configs", () => {
  const config = normalizeSetupConfigLike({
    version: 2,
    persistence: {
      kind: "file",
    },
    providers: {
      github: {
        mode: "real",
        deliveryMode: "polling",
      },
    },
    repos: [],
  });

  assert.ok(config);
  assert.equal(config.providers?.github?.importMode, "from_now");
});

test("--yes safety validation rejects non-local or live defaults", () => {
  const safeConfig = createSetupConfig({
    cwd: detectedRepo.repoPath,
    detectedRepo,
    interactionMode: "non_interactive",
    acceptedDefaults: true,
    providerMode: "disabled",
  });

  assert.deepEqual(validateSafeDefaults(safeConfig, detectedRepo), {
    ok: true,
    reasons: [],
  });

  const unsafeConfig = createSetupConfig({
    cwd: detectedRepo.repoPath,
    detectedRepo: {
      ...detectedRepo,
      gitIgnoreHasAgentrail: false,
    },
    interactionMode: "non_interactive",
    acceptedDefaults: true,
    mode: "server",
    host: "0.0.0.0",
    baseUrl: "http://0.0.0.0:3000",
  });

  const validation = validateSafeDefaults(unsafeConfig, {
    ...detectedRepo,
    gitIgnoreHasAgentrail: false,
  });

  assert.equal(validation.ok, false);
  assert.match(validation.reasons.join("\n"), /local bind/i);
  assert.match(validation.reasons.join("\n"), /live.*provider/i);
  assert.match(validation.reasons.join("\n"), /github/i);
  assert.match(validation.reasons.join("\n"), /circleci/i);
  assert.match(validation.reasons.join("\n"), /linear/i);
});

test("buildInitCommand renders an equivalent non-interactive command", () => {
  const config = createSetupConfig({
    cwd: detectedRepo.repoPath,
    detectedRepo,
    interactionMode: "interactive",
    acceptedDefaults: false,
    markdownExport: true,
  });

  const command = buildInitCommand(config);

  assert.match(command, /^agentrail init /);
  assert.match(command, /--mode server/);
  assert.match(command, /--base-url http:\/\/127\.0\.0\.1:3000/);
  assert.match(command, /--repo '\/tmp\/agentrail'/);
  assert.match(command, /--repo-allowlist oxnw\/agentrail/);
  assert.match(command, /--markdown-export/);
  assert.doesNotMatch(command, /--provider-mode/);
});
