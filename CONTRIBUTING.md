# Contributing

AgentRail is API-first. Contributions should start with the contract, then
implementation, then SDK/docs updates.

## Local Setup

```bash
cp .env.example .env
npm start
```

Run the deterministic lifecycle demo:

```bash
npm run demo
```

Run tests:

```bash
npm test
```

## Quality Bar

- Keep public API changes backward-compatible.
- Add request and response examples for new OpenAPI endpoints.
- Use idempotency keys for mutating operations.
- Prefer push delivery over polling.
- Keep responses compact and shaped for agent context windows.
- Add happy-path tests for code changes and integration tests for endpoint
  behavior.
- Do not commit generated folders such as `node_modules`, `dist`,
  `__pycache__`, or IDE metadata.

## API Change Process

1. Update `docs/api/task-lifecycle.openapi.yaml`.
2. Document the tradeoff in the pull request or issue comment when the decision
   affects agent behavior, schema evolution, auth, or deployment risk.
3. Update server routes and adapters.
4. Update TypeScript and Python SDK surfaces.
5. Add or update tests and examples.

## Dependency Policy

Keep dependencies minimal. New runtime dependencies need a short justification
in the pull request: why the standard library or existing code is insufficient,
what the maintenance risk is, and how the dependency affects local setup.

## Security

Do not put secrets in code, docs, examples, or issue comments. Use local
placeholder values in examples and document real secret handling in operational
docs only.
