# TODO

## AGEA-122 follow-up from CodeRabbit review of `d58d485`

- Fix `src/cli/setup-wizard.ts` so the `Next steps` note only appears after a successful write action, not after cancelled or print-only flows.
- Update the self-hosted bootstrap docs to replace `ar_live_replace_with_bootstrap_secret` placeholders with explicit guidance to use the real `data.apiKey` returned by the bootstrap step. This follow-up should also sweep the related bootstrap/auth examples in `README.md`, `sdk/typescript/README.md`, `sdk/python/README.md`, `docs/agent-recipes.md`, `.env.example`, `compose.yaml`, and `docs/architecture/local-self-hosted-setup-cli-contract.md`.
