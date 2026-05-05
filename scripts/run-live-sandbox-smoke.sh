#!/usr/bin/env bash
# Live sandbox smoke runner for AgentRail.
# Usage: Copy to run-live-sandbox-smoke.sh, fill in the token, and run.
set -euo pipefail
cd "$(dirname "$0")/.."

# DO NOT commit this file with a real token.
# Set these in your environment or secret manager:
#   export GITHUB_TOKEN="..."         # fine-grained PAT with repo, workflow scope for oxnw/agentrail-e2e-sandbox
#   export AGENTRAIL_SANDBOX_OWNER="oxnw"
#   export AGENTRAIL_SANDBOX_REPO="agentrail-e2e-sandbox"
#   export AGENTRAIL_SANDBOX_ISSUE_NUMBER="2"
#   export AGENTRAIL_SANDBOX_HEAD_BRANCH="agentrail-live-e2e-20260504192023"
#   export AGENTRAIL_SANDBOX_BASE_BRANCH="main"
#   export AGENTRAIL_SANDBOX_PULL_NUMBER="3"
#   export AGENTRAIL_SANDBOX_HEAD_SHA="2b6ac22e49c804bdd8d2c714ff14892d2ff8cea9"
# Optional:
#   export AGENTRAIL_SANDBOX_ALLOW_SHIP=true   # only for disposable PRs

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "GITHUB_TOKEN is required. Set it in the environment or secret manager."
  exit 1
fi

export AGENTRAIL_SANDBOX_OWNER="${AGENTRAIL_SANDBOX_OWNER:-oxnw}"
export AGENTRAIL_SANDBOX_REPO="${AGENTRAIL_SANDBOX_REPO:-agentrail-e2e-sandbox}"
export AGENTRAIL_SANDBOX_BASE_BRANCH="${AGENTRAIL_SANDBOX_BASE_BRANCH:-main}"

npm run smoke:sandbox:live
