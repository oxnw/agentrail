# TypeScript Source of Truth

AgentRail now treats checked-in TypeScript as the canonical implementation source. Native Node TypeScript execution runs the service and tests directly from `.ts` files, while SDK package consumers continue to use generated JavaScript from `sdk/typescript/dist`.

## Decision

- Use `src/server.ts` as the service entrypoint for `npm start`.
- Keep root `tsconfig.json` focused on TypeScript only; JavaScript tests may remain as test harnesses, but they import implementation modules through `.ts` paths.
- Author the TypeScript SDK source with `.ts` relative imports and use `rewriteRelativeImportExtensions` so `npm --prefix sdk/typescript run build` emits package-safe `.js` imports in `dist`.
- Reject side-by-side checked-in JavaScript shims beside TypeScript sources. They made runtime ownership ambiguous and let stale JS survive after a TypeScript migration.

## Side-by-side inventory removed in [AGEA-108](/AGEA/issues/AGEA-108)

Runtime source duplicates removed from `src/`:

- `agent-auth-store.js` / `agent-auth-store.ts`
- `agent-task-queue.js` / `agent-task-queue.ts`
- `app.js` / `app.ts`
- `circleci-status-adapter.js` / `circleci-status-adapter.ts`
- `event-delivery-worker.js` / `event-delivery-worker.ts`
- `event-subscription-store.js` / `event-subscription-store.ts`
- `github-actions-ci-adapter.js` / `github-actions-ci-adapter.ts`
- `github-issue-intake-adapter.js` / `github-issue-intake-adapter.ts`
- `github-review-feedback-adapter.js` / `github-review-feedback-adapter.ts`
- `github-rollback-adapter.js` / `github-rollback-adapter.ts`
- `github-submit-adapter.js` / `github-submit-adapter.ts`
- `intake-store.js` / `intake-store.ts`
- `multi-ci-status-adapter.js` / `multi-ci-status-adapter.ts`
- `server.js` / `server.ts`
- `structured-logger.js` / `structured-logger.ts`
- `task-event-store.js` / `task-event-store.ts`
- `task-lifecycle-errors.js` / `task-lifecycle-errors.ts`
- `task-store.js` / `task-store.ts`
- `waitlist-store.js` / `waitlist-store.ts`

SDK source duplicates removed from `sdk/typescript/src/`:

- `client.js` / `client.ts`
- `errors.js` / `errors.ts`
- `types.js` / `types.ts`
- `webhooks.js` / `webhooks.ts`

Duplicate migrated test files removed:

- `test/github-issue-intake-adapter.test.js` / `test/github-issue-intake-adapter.test.ts`
- `test/server-runtime-mode.test.js` / `test/server-runtime-mode.test.ts`

## Still-needed JavaScript

- JavaScript test files without TypeScript counterparts remain as harnesses, not implementation sources. They now import `../src/*.ts`.
- `test/mock-github-server.js` and `test/fixtures/circleci-fixtures.js` remain JavaScript fixtures because they have no side-by-side TypeScript duplicate.
- `scripts/*.mjs` remain Node scripts for packaging, smoke, and release workflows.
- SDK JavaScript belongs in generated `sdk/typescript/dist`, not beside `sdk/typescript/src`.

## External sandbox compatibility

The AgentRail live-provider sandbox at `https://github.com/oxnw/agentrail-e2e-sandbox` was inspected at HEAD `0dcc2ce5e0d5534c56155491d5b88d793c8dfa2c` on 2026-05-05 after the TypeScript cleanup review comment.

Current finding: the sandbox repository contains only `README.md`. It has no package scripts, source imports, GitHub Actions workflows, SDK source references, or checked-in JavaScript paths that depend on the removed side-by-side `src/*.js` or `sdk/typescript/src/*.js` files.

Future sandbox validation should consume AgentRail through documented runtime/package entrypoints:

- Service startup: `npm start`, backed by `src/server.ts`.
- SDK consumers: generated package output from `sdk/typescript/dist`, not SDK source shims.
- Live provider fixtures: sandbox repository data and GitHub API state, not checked-in AgentRail implementation files.
