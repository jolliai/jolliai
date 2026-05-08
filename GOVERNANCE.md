# Governance

Jolli Memory is an open-source project sponsored by Jolli AI. This document
describes how decisions are made, who can make them, and how that may evolve
as the contributor base grows.

## Project structure

The repository is a monorepo containing three deliverables that share the
same product model and storage:

- `cli/` — the `@jolli.ai/cli` npm package (the canonical implementation)
- `vscode/` — the VS Code extension (bundles the CLI internally)
- `intellij/` — the IntelliJ plugin (independent Kotlin port)

A single set of issues, pull requests, releases, and security advisories
covers all three artifacts.

## Roles

### Contributor

Anyone who opens an issue, files a pull request, reviews a pull request, or
participates in a Discussion is a contributor. Contributing implies agreement
to the Developer Certificate of Origin (DCO); see [`CONTRIBUTING.md`](CONTRIBUTING.md).

### Maintainer

Maintainers have commit access and review responsibility for some part of the
codebase. The current maintainer teams are listed in
[`.github/CODEOWNERS`](.github/CODEOWNERS):

- `@jolliai/maintainers` — default reviewers for any change
- `@jolliai/release-team` — owners of CI workflows, the release procedure, and
  publishing to npm / VS Code Marketplace / Open VSX / JetBrains Marketplace
- `@jolliai/security` — owners of authentication, API key parsing, and the
  origin allowlist (changes here require coordinated updates across CLI,
  VS Code, and IntelliJ; see CLAUDE.md)
- `@jolliai/admins` — owners of governance files (`CODEOWNERS`,
  `GOVERNANCE.md`, branch rulesets)

Maintainers are responsible for triaging issues, reviewing pull requests,
maintaining the release cadence, and upholding the
[Code of Conduct](CODE_OF_CONDUCT.md).

### Becoming a maintainer

We welcome new maintainers from the contributor community. Typical signals
that someone is ready to be invited:

- Sustained, high-quality contributions over multiple releases.
- Demonstrated understanding of the relevant subsystem(s).
- Constructive participation in code review and issue triage.
- Adherence to the Code of Conduct.

A current maintainer may propose a contributor for maintainer status by
opening a pull request that adds them to the appropriate `CODEOWNERS` entry.
Approval requires sign-off from `@jolliai/admins`.

## Decision making

For day-to-day changes:

1. **Pull requests** are the primary unit of decision. A change merges when
   it has approval from the relevant `CODEOWNERS` and passes required CI
   checks (build + lint + test, signed-off-by, branch-rule constraints
   documented in [`RELEASE.md`](RELEASE.md)).
2. **Disagreements** are resolved on the pull request thread first, then
   in a Discussion if broader input is useful.
3. **Substantial design changes** that affect multiple components, change
   user-facing behavior in non-additive ways, or modify governance are
   proposed via an issue or Discussion before implementation, so reviewers
   and users have a chance to weigh in early.

For changes that affect security, releases, or governance, the
correspondingly scoped team in CODEOWNERS has final approval.

## Releases

The release procedure (branches, tags, signing, marketplace publishing) is
documented in [`RELEASE.md`](RELEASE.md). Releases are triggered by manually
running the relevant publish workflow against a signed tag.

## Code of Conduct

All participants are expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Violations can be reported using the
mechanism described in that document.

## Amendments

Changes to this document are pull requests against `GOVERNANCE.md` and
require approval from `@jolliai/admins` per CODEOWNERS.
