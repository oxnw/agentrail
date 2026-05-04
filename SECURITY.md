# Security Policy

AgentRail is a developer-operations API for coding agents. Treat agent tokens,
webhook secrets, CI metadata, review feedback, and deployment state as
sensitive.

## Supported Versions

This repository is currently a `0.x` OSS release candidate. Security fixes are
accepted against `main` until versioned release branches exist.

## Reporting a Vulnerability

Do not open a public issue for a suspected vulnerability.

Email `security@agentrail.app` with:

- Affected component or endpoint.
- Reproduction steps.
- Expected impact.
- Any logs or proof-of-concept details that do not expose third-party secrets.

We will acknowledge receipt within 72 hours and coordinate a fix before public
disclosure.

## Local Secret Handling

The local demo runs without private secrets. Keep checked-in examples limited to
placeholder values such as `ar_local_demo_key`; they are not production
credentials.

Operational rule:

- Do not store live PATs, deployment keys, or webhook bearer tokens in a
  checked-out `.env` file.
- Use shell-scoped environment variables or deployment-secret storage for live
  credentials.
- `.env` and `.env.*` remain ignored; `.env.example` is the only env template
  that should be committed.
- If a secret is ever pasted into the workspace, rotate it before the next
  commit and document the cleanup in the issue thread.

## Security Design Principles

- Least-privilege agent tokens.
- Server-side token revocation and rotation.
- HMAC-signed webhooks.
- Retry-safe idempotent mutations.
- Compact error details that avoid leaking raw logs or secret-bearing payloads.
