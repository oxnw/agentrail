# SDK Publishing Setup

This document covers the operator steps for publishing the AgentRail SDKs from
GitHub Actions.

## Decision

Chosen:

- keep `NPM_TOKEN` as a GitHub Actions repository secret because npm publishing
  still requires registry authentication from CI
- use PyPI Trusted Publishing for `agentrail`, which removes the need to store a
  long-lived `PYPI_API_TOKEN` in GitHub

Rejected:

- keeping a long-lived `PYPI_API_TOKEN` in GitHub because PyPI supports a
  stronger OIDC-based path for GitHub Actions
- manual local publishing because it bypasses the release workflow's version
  checks, smoke tests, and artifact trail

## GitHub Secret Location

For `NPM_TOKEN`, open the GitHub repository and go to:

`Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`

Create this secret:

- `NPM_TOKEN`

Repository-level storage is sufficient for the current
[release workflow](../.github/workflows/release.yml).

## Where `NPM_TOKEN` Comes From

Generate it in npm for an account that can publish the `@agentrail/sdk`
package:

`npmjs.com` -> profile menu -> `Access Tokens` -> `Generate New Token`

Use a granular token with:

- read and write package permissions
- access limited to the `@agentrail` scope or `@agentrail/sdk` package
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
- publish `@agentrail/sdk` to npm
- publish `agentrail` to PyPI via OIDC

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

`404 Not Found - PUT https://registry.npmjs.org/@agentrail%2fsdk`

confirm that the `agentrail` scope exists on npm as either a user scope or an
npm organization, and that the token owner can publish packages to that scope.
For an organization-scoped package, npm requires the organization to exist
before publishing packages under `@agentrail/*`.

For a first publish where `@agentrail/sdk` does not exist yet, create the
granular token with access to the `@agentrail` scope or organization rather than
access to only a pre-existing package.

### Package Name vs Scope Ownership

`@agentrail/sdk` has two parts:

- `agentrail` is the npm scope, which must map to an npm user or organization
  we control.
- `sdk` is the package name inside that scope.

An unpublished package can still be blocked if the scope is unavailable. In this
case, `@agentrail/sdk` is not live on npm, but publishing it still requires
control of the `agentrail` npm user or organization scope.

npm documents this model in its [scope documentation][npm-scope-docs]: each npm
user or organization has a matching scope, and only that account can add
packages in that scope.

## npm Scope Creation Denied

If npm denies creation of the `agentrail` organization, the planned
`@agentrail/sdk` package cannot be published until the scope is available to an
account we control. This is a naming/ownership blocker, not a CI or token
blocker.

Do not switch the package name inside the existing `v0.1.0` release. PyPI has
already published `agentrail==0.1.0`, and retagging or republishing a different
npm package under the same release would make the release artifact trail
ambiguous.

Available paths:

- appeal the npm organization denial and keep `@agentrail/sdk`
- choose a controlled npm scope, such as `@oxnw/agentrail`, then update package
  metadata, README examples, release workflow labels, and smoke tests in a new
  release revision

Do not use the unscoped `agentrail` npm name unless ownership is transferred to
AgentRail. The public npm registry already has an `agentrail` package owned by
someone else.

[npm-scope-docs]: https://docs.npmjs.com/about-scopes/
