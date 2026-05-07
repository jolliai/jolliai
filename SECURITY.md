# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in Jolli Memory, please **do not** file a public issue
or pull request. Public reports give attackers a head start before a fix can ship.

Instead, report privately by opening a GitHub Security Advisory:

<https://github.com/jolliai/jolliai/security/advisories/new>

If you cannot use GitHub Security Advisories, email `security@jolli.ai` instead.

Please include:

- A description of the issue and its impact.
- Steps to reproduce, or a proof-of-concept where possible.
- The affected component (CLI, VS Code extension, or IntelliJ plugin) and version.
  - CLI: `jolli --version`
  - VS Code extension: shown on the marketplace listing or in `Extensions › Jolli Memory`
  - IntelliJ plugin: `Settings › Plugins › Jolli Memory`
- Whether the issue requires authentication, user interaction, or specific configuration.

We aim to acknowledge reports within 5 business days. After triage we will share an indicative
timeline for a fix and keep you updated through the advisory.

## Supported versions

Security fixes are released for the latest published minor of each artifact:

| Artifact | Channel |
| --- | --- |
| `@jolli.ai/cli` | npm |
| Jolli Memory (VS Code extension) | VS Code Marketplace, Open VSX |
| Jolli Memory (IntelliJ plugin) | JetBrains Marketplace |

If you are running an older version, the first step toward a fix is to upgrade to the latest
minor on the same channel.

## Disclosure

We follow coordinated disclosure. Once a fix is available we will:

1. Publish patched releases on the affected channels.
2. Issue a GitHub Security Advisory describing the issue, fixed versions, and credits.
3. Request a CVE where applicable.

Reporters are credited in the advisory by default. Let us know if you prefer to remain anonymous.

## Out of scope

The following are **not** considered security vulnerabilities under this policy:

- Reports generated solely by automated scanners without a working proof-of-concept.
- Issues in third-party dependencies that have not yet been disclosed upstream — please report
  those to the dependency's own maintainers first.
- Self-XSS, clickjacking on pages without sensitive actions, or missing security headers on
  static documentation sites.
- Vulnerabilities that require physical access to a developer's machine, or root/admin on the
  same machine — Jolli Memory is a local-first tool and trusts the host it runs on.
