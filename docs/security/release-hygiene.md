# Release Hygiene Checklist

This repository is prepared for a first public Git history under `AGEA-70`.

## Decision

We start public Git history from the current scrubbed workspace rather than
rewriting a legacy history, because this checkout did not contain a `.git`
directory when the release-prep issue started.

Chosen:

- remove live secret material from the working tree before initialization
- ignore all local env variants except `.env.example`
- initialize a clean `main` branch for the first public history

Rejected:

- carrying forward ad hoc local history via copy or import because it increases
  secret-leak risk without adding public product value
- relying on `.gitignore` alone because ignored files can still leak through
  copy/paste or manual staging mistakes before the first repo bootstrap

## Operator Checklist

1. Confirm `.env` contains placeholders only.
2. Keep live credentials in shell-scoped env vars or deployment secrets.
3. Run `npm test`.
4. Initialize Git with `main` as the default branch.
5. Create the remote at `github.com/oxnw/agentrail`.
6. Verify `.env`, `.env.local`, and other `.env.*` files stay untracked.

## Current AGEA-70 Notes

- Local `GITHUB_TOKEN` material was removed from `.env`.
- No pre-existing local Git history was present, so no `git filter-repo` or
  BFG rewrite was required for this checkout.
