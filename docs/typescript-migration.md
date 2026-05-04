# TypeScript Migration Guide

This document covers the incremental migration of the AgentRail root service from JavaScript to TypeScript. See [AGEA-68](/AGEA/issues/AGEA-68) for the approved plan.

## Phase Status

| Phase | Scope | Status |
|-------|-------|--------|
| 0 – Tooling baseline | `tsconfig.json`, `npm run typecheck`, CI gate | ✅ Done |
| 1 – Shared utilities | `task-event-store`, `structured-logger`, `task-lifecycle-errors`, `multi-ci-status-adapter` | 🔜 [AGEA-77](/AGEA/issues/AGEA-77) |
| 2 – Stateful stores | `waitlist-store`, `task-webhook-store`, `task-webhook-delivery-worker`, `agent-auth-store` | 🔜 [AGEA-78](/AGEA/issues/AGEA-78) |
| 3 – Provider adapters | `github-*-adapter`, `circleci-status-adapter`, `agent-ship-cycle-demo` | 🔜 [AGEA-79](/AGEA/issues/AGEA-79) |
| 4 – HTTP boundary | `app.js`, `server.js`, endpoint tests | 🔜 Blocked on Phases 1–3 |
| 5 – Runtime finalization | `tsc` compile to `dist/`, final CI cleanup | 🔜 Blocked on Phase 4 |

## Current `// @ts-nocheck` suppressions

Files suppressed in Phase 0 (to be cleaned up in the phases above):

**src/**
- `src/agent-auth-store.js` → Phase 2
- `src/agent-ship-cycle-demo.js` → Phase 3
- `src/server.js` → Phase 4
- `src/task-event-store.js` → Phase 1
- `src/task-webhook-store.js` → Phase 2

**test/**
- `test/ci-status-endpoint.test.js` → Phase 4
- `test/circleci-status-adapter.test.js` → Phase 3
- `test/github-actions-ci-adapter.test.js` → Phase 3
- `test/github-review-feedback-adapter.test.js` → Phase 3
- `test/github-review-feedback-adapter.test.js` → Phase 3
- `test/github-submit-adapter.test.js` → Phase 3
- `test/github-submit-integration.test.js` → Phase 4
- `test/mock-github-server.js` → Phase 3
- `test/multi-ci-status-adapter.test.js` → Phase 1
- `test/repo-cleanup.test.js` → Phase 4
- `test/task-event-store.test.js` → Phase 1
- `test/task-webhook-delivery-worker.test.js` → Phase 2
- `test/task-webhook-subscriptions.test.js` → Phase 2
- `test/waitlist.test.js` → Phase 2

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

- Do not add a TypeScript loader (`ts-node`, `tsx`, `esbuild-register`) until Phase 5 when the runtime path is decided.
- Do not add a bundler.
- Do not add type packages for third-party libraries unless a specific module conversion in Phase 1–4 requires them.

## `tsconfig.json` settings

The root `tsconfig.json` is deliberately lenient for the migration period:

- `"strict": false` — will be tightened incrementally after each phase
- `"allowJs": true` / `"checkJs": true` — enables checking JS files without renaming them
- `"noEmit": true` — Phase 0 adds no build step; this changes in Phase 5

Do not tighten `strict` or remove `allowJs`/`checkJs` without a separate plan review.
