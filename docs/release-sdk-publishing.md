# SDK Publishing Setup

This document covers the operator steps for publishing the AgentRail SDKs from
GitHub Actions.

## Decision

Chosen:

- keep `NPM_TOKEN` as a GitHub Actions repository secret because npm publishing
  still requires registry authentication from CI
- publish the TypeScript SDK as `@agentrail-core/sdk`; the original
  `@agentrail/sdk` name is blocked because npm denied the `agentrail`
  organization/scope
- use PyPI Trusted Publishing for `agentrail`, which removes the need to store a
  long-lived `PYPI_API_TOKEN` in GitHub

Rejected:

- keeping a long-lived `PYPI_API_TOKEN` in GitHub because PyPI supports a
  stronger OIDC-based path for GitHub Actions
- manual local publishing because it bypasses the release workflow's version
  checks, smoke tests, and artifact trail
- reusing the existing `v0.1.0` tag after the npm package rename because PyPI
  has already published `agentrail==0.1.0`

## GitHub Secret Location

For `NPM_TOKEN`, open the GitHub repository and go to:

`Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`

Create this secret:

- `NPM_TOKEN`

Repository-level storage is sufficient for the current
[release workflow](../.github/workflows/release.yml).

## Where `NPM_TOKEN` Comes From

Generate it in npm for an account that can publish the `@agentrail-core/sdk`
package:

`npmjs.com` -> profile menu -> `Access Tokens` -> `Generate New Token`

Use a granular token with:

- read and write package permissions
- access limited to the `@agentrail-core` scope or `@agentrail-core/sdk`
  package
- bypass 2FA for write actions if the publishing account enforces 2FA on writes

Copy the token once at creation time and paste it into the GitHub `NPM_TOKEN`
secret.

## PyPI Setup

No GitHub secret is needed for PyPI.

Configure PyPI to trust this repository's GitHub Actions workflow instead.

### If `agentrail` already exists on PyPI

1. Open `pypi.org` and sign in as a maintainer or owner of the `agentrail`
   project.
2. Go to:

`Your projects` -> `agentrail` -> `Manage` -> `Publishing`

3. In the GitHub Actions publisher section, add a trusted publisher with:

- Owner: `oxnw`
- Repository name: `agentrail`
- Workflow filename: `release.yml`
- Environment name: leave blank

### If `agentrail` does not exist on PyPI yet

1. Open `pypi.org` and sign in as the account that should own the first
   `agentrail` release.
2. Go to:

account sidebar -> `Publishing`

3. Add a pending GitHub Actions publisher with:

- PyPI project name: `agentrail`
- Owner: `oxnw`
- Repository name: `agentrail`
- Workflow filename: `release.yml`
- Environment name: leave blank

The first successful release will create the project and convert the pending
publisher into a normal one.

PyPI's workflow filename field expects only `release.yml`, not the full
`.github/workflows/release.yml` path.

## Release Trigger

After the npm token exists and PyPI trusted publishing is configured, push the
release tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The workflow will:

- verify the tag matches both SDK versions
- build both SDK distributions
- smoke-test clean installs from the built artifacts
- publish `@agentrail-core/sdk` to npm
- publish `agentrail` to PyPI via OIDC

### npm-only Recovery for `0.1.0`

PyPI `agentrail==0.1.0` is already live. To publish the renamed TypeScript SDK
without trying to republish duplicate PyPI files, use the manual GitHub Actions
workflow:

1. Open GitHub Actions -> `Release` -> `Run workflow`.
2. Use `main`.
3. Set `version` to `0.1.0`.
4. Run the workflow.

Manual dispatch validates and publishes only the TypeScript SDK package.

## npm 2FA Publish Failure

If the npm publish job fails with:

`Two-factor authentication or granular access token with bypass 2fa enabled is required`

replace the `NPM_TOKEN` GitHub secret with a granular npm token that has package
publish access and bypasses 2FA for write actions. Then rerun only the failed
GitHub Actions jobs for the release run. Do not rerun the full workflow after
PyPI has already published the same version, because PyPI rejects duplicate
files for an existing release.

## npm Scope Publish Failure

If the npm publish job fails with:

`404 Not Found - PUT https://registry.npmjs.org/@agentrail-core%2fsdk`

confirm that the `agentrail-core` scope exists on npm as either a user scope or
an npm organization, and that the token owner can publish packages to that scope.
For an organization-scoped package, npm requires the organization to exist
before publishing packages under `@agentrail-core/*`.

For a first publish where `@agentrail-core/sdk` does not exist yet, create the
granular token with access to the `@agentrail-core` scope or organization rather
than access to only a pre-existing package.

### Package Name vs Scope Ownership

`@agentrail-core/sdk` has two parts:

- `agentrail-core` is the npm scope, which must map to an npm user or
  organization we control.
- `sdk` is the package name inside that scope.

An unpublished package can still be blocked if the scope is unavailable. In this
case, `@agentrail-core/sdk` is not live on npm, but publishing it still requires
control of the `agentrail-core` npm user or organization scope.

npm documents this model in its [scope documentation][npm-scope-docs]: each npm
user or organization has a matching scope, and only that account can add
packages in that scope.

## npm Scope Creation Denied

The original planned package was `@agentrail/sdk`. npm denied creation of the
`agentrail` organization, so that package cannot be published until the scope is
available to an account we control. This is a naming/ownership blocker, not a CI
or token blocker.

Do not switch the package name inside the existing `v0.1.0` release. PyPI has
already published `agentrail==0.1.0`, and retagging or republishing a different
npm package under the same release would make the release artifact trail
ambiguous.

Available paths:

- keep the pivot to `@agentrail-core/sdk`, then configure the npm
  `agentrail-core` scope and token
- appeal the npm organization denial if we later want to reserve
  `@agentrail/sdk`

Do not use the unscoped `agentrail` npm name unless ownership is transferred to
AgentRail. The public npm registry already has an `agentrail` package owned by
someone else.

[npm-scope-docs]: https://docs.npmjs.com/about-scopes/
