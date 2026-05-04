# TypeScript Migration Guide

This document covers the incremental migration of the AgentRail root service from JavaScript to TypeScript. See [AGEA-68](/AGEA/issues/AGEA-68) for the approved plan.

## Phase Status

| Phase | Scope | Status |
|-------|-------|--------|
| 0 – Tooling baseline | `tsconfig.json`, `npm run typecheck`, CI gate | ✅ Done |
| 1 – Shared utilities | `task-event-store`, `structured-logger`, `task-lifecycle-errors`, `multi-ci-status-adapter` | ✅ Done |
| 2 – Stateful stores | `waitlist-store`, `task-webhook-store`, `task-webhook-delivery-worker`, `agent-auth-store` | ✅ Done |
| 3 – Provider adapters | `github-*-adapter`, `circleci-status-adapter`, `agent-ship-cycle-demo` | ✅ Done |
| 4 – HTTP boundary | `app.js`, `server.js`, endpoint tests | ✅ Done |
| 5 – Runtime finalization | Node native TS stripping, CI Node bump, final docs | ✅ Done |

## Remaining `// @ts-nocheck` suppressions

Phases 1–4 are complete. The following files still carry `// @ts-nocheck` and are candidates for a follow-up cleanup pass:

**src/**
- `src/agent-ship-cycle-demo.js` — Phase 3 adapter; a typed `.ts` twin exists alongside it

**test/**
- `test/ci-status-endpoint.test.js`
- `test/circleci-status-adapter.test.js`
- `test/github-actions-ci-adapter.test.js`
- `test/github-review-feedback-adapter.test.js`
- `test/github-submit-adapter.test.js`
- `test/github-submit-integration.test.js`
- `test/mock-github-server.js`
- `test/repo-cleanup.test.js`
- `test/task-webhook-delivery-worker.test.js`
- `test/task-webhook-subscriptions.test.js`
- `test/waitlist.test.js`

**Rule:** When you convert a file to TypeScript, remove the `// @ts-nocheck` comment and fix the type errors before merging.

## Import extension rules

Node ESM requires explicit file extensions on relative imports. This repo already follows this rule for JS files. The rule carries into TypeScript without change:

```ts
// Correct — .js extension on relative imports, even for .ts source files
import { TaskEventStore } from "./task-event-store.js";

// Wrong — omitting the extension breaks Node ESM module resolution
import { TaskEventStore } from "./task-event-store";
```

TypeScript resolves `.ts` source when you import `./foo.js` under `moduleResolution: NodeNext`. Keep `.js` on relative imports even after renaming the source file to `.ts`.

## Rename order

1. Remove `// @ts-nocheck` from the file.
2. Fix all TypeScript errors the checker surfaces.
3. Rename `foo.js` → `foo.ts` only after the file is clean.
4. Update the phase-status table above and remove the file from the suppression list.

Do not rename a file to `.ts` while it still has `// @ts-nocheck` — that defeats the purpose.

## Dependency discipline

The approved dependency set for this migration is:

| Package | Kind | Justification |
|---------|------|---------------|
| `typescript` | devDependency | Compiler |
| `@types/node` | devDependency | Node built-in types |

Any dependency beyond this list requires CTO approval before adding. In particular:

- Do not add a TypeScript loader (`ts-node`, `tsx`, `esbuild-register`). The Phase 5 decision is to rely on Node ≥22.6 native type stripping — no external loader is needed.
- Do not add a bundler.
- Do not add type packages for third-party libraries unless a specific module conversion requires them.

## `tsconfig.json` settings

The root `tsconfig.json` is deliberately lenient for the migration period:

- `"strict": false` — will be tightened incrementally after each phase
- `"allowJs": true` / `"checkJs": true` — enables checking JS files without renaming them
- `"noEmit": true` — no build step; the service runs directly from `src/` via Node native type stripping

Do not tighten `strict` or remove `allowJs`/`checkJs` without a separate plan review.

## Runtime

The service runs directly from `src/` — no separate build or `dist/` directory. Node ≥22.6 strips TypeScript types natively, so `node src/server.js` loads the re-export shim which resolves to `src/server.ts` at runtime.

- `npm start` → `node src/server.js` (works on Node ≥22.6)
- `npm run typecheck` → `tsc --noEmit` (type safety gate, no emit)
- `npm test` → builds the TypeScript SDK then runs `node --test` against `test/*.test.{js,ts}`

The minimum required Node version is **22.6.0**. This is documented in `package.json` `engines`.
