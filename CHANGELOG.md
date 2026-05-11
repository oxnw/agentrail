# Changelog

## Unreleased

### Added

- Added desktop notifications for awaiting-user blockers.
- Added `agentrail init --desktop-notifications` and `agentrail init --no-desktop-notifications`.

### Changed

- Awaiting-user desktop notifications now use blocker-specific copy and AgentRail branding.
- Server startup now prefers the selected `AGENTRAIL_HOME` env files over incidental cwd `.env` values while preserving explicit process environment overrides.

## 0.1.3

### Added

- Initial local AgentRail CLI/server MVP: setup, local API server, agent authentication, task lifecycle APIs, provider and routing foundations, managed agent runs, and file-backed local stores.
