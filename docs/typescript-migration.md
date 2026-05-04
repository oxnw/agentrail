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

## SDK runtime contract

### TypeScript SDK (`sdk/typescript/`)

The TypeScript SDK has a **compiled distribution** model distinct from the service's source-native runtime.

| Concern | Contract |
|---------|----------|
| Source import | ✅ Supported via `.js` shim re-exports. `node --input-type=module -e 'import("./sdk/typescript/src/index.ts")'` passes on Node ≥22.6 because each `.ts` module has a corresponding `.js` shim (`export * from "./client.ts"`) that Node resolves. |
| Compiled import | ✅ Supported. `npm run build` emits `dist/` from `src/`. Consumers import via the `exports` field in `package.json` (`. → dist/index.js`). |
| Tested import paths | Both source and compiled paths are exercised in CI. |

Tradeoff note for review: adding `.js` shims in `sdk/typescript/src/` is necessary for Node native type-stripping to resolve `.js`-extensioned imports from `.ts` sources. The alternative — switching imports to `.ts` extensions — would break `tsc` compilation for consumers. This shim approach is the minimal, no-dependency solution.

### Python SDK (`sdk/python/`)

| Concern | Contract |
|---------|----------|
| `base_url` | **Required** — no implicit default. `AgentRailClient(api_key="...")` raises a TypeError. |
| `DEFAULT_BASE_URL` | Removed from `agentrail.__all__`. It still exists as an internal constant in `client.py` but is not part of the public package surface. |
| Export surface | `agentrail.__all__` lists only the intentionally public symbols. |

### Why `baseUrl` / `base_url` are required

Both SDKs treat the base URL as an explicit, fail-fast configuration:

- Production consumers must pass `https://api.agentrail.dev/v1` (or their self-hosted URL).
- Local development consumers must pass `http://127.0.0.1:3000` explicitly.
- There is no silent fallback to `http://127.0.0.1:3000` at runtime.

This prevents "works on my machine" bugs where a deployed agent accidentally hits a local default.

### Verification commands

```bash
# TypeScript SDK typecheck
npm --prefix sdk/typescript test

# TypeScript SDK build
npm --prefix sdk/typescript run build

# Direct source import (Node native TS)
node --input-type=module -e 'import("./sdk/typescript/src/index.ts")'

# Service tests (root, includes TS SDK build step)
npm test

# Python SDK import / model sanity check
cd sdk/python && python -c "from agentrail import AgentRailClient; print('ok')"
```

### Known limitations

- SDK tests live in `sdk/typescript/test/` and are excluded from the root `node --test` glob. Run them directly: `node --test sdk/typescript/test/webhooks.test.ts`.
- The Python SDK does not yet have an automated test suite in CI. Manual import/model checks are the current verification path.
- `sdk/typescript/src/*.js` shims are load-bearing for source-level execution. Do not delete them; any new `.ts` file in `src/` needs a matching `.js` shim if it is imported via `.js` extension from sibling modules.
