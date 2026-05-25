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
timeline for a fix and keep you updated through the advisory. Our target is to ship a fix or
documented mitigation within 90 days of triage; complex issues may extend this by mutual
agreement with the reporter, recorded in the advisory.

## Supported versions

Security fixes ship on the **latest published minor** of each channel below. Older minors are
not patched — upgrade to the latest minor on the same channel before reporting issues against
prior versions.

| Artifact | Channel | Supported version |
| --- | --- | --- |
| `@jolli.ai/cli` | npm | latest published minor |
| Jolli Memory (VS Code extension) | VS Code Marketplace, Open VSX | latest published minor |
| Jolli Memory (IntelliJ plugin) | JetBrains Marketplace | latest published minor |

## Disclosure

We follow coordinated disclosure. Once a fix is available we will:

1. Publish patched releases on the affected channels.
2. Issue a GitHub Security Advisory describing the issue, fixed versions, and credits.
3. Request a CVE where applicable.

Reporters are credited in the advisory by default. Let us know if you prefer to remain anonymous.

## Operational guidance

`@jolli.ai/cli` discovers plugins by walking `node_modules/` upward from the current working directory, bounded by the nearest `.git` ancestor (the project root) or — if no `.git` is found — the user's home directory. It also consults the npm global root. The walk never crosses out of those boundaries, so a `jolli` invocation from outside any project (and outside `$HOME`) skips the local walk entirely and only the npm global root is consulted. Within each discovered root, the loader scans only a small set of trusted npm scopes (currently `@jolli.ai/`) and loads only packages whose `package.json` declares a `jolliPluginId` that appears in a small built-in allow-list of opaque IDs.

The IDs themselves are **not** secrets — they ship in the published plugin's `package.json` and are visible to anyone who installs it. They exist to let plugin names change without re-shipping the host, not to act as a capability token. The actual security boundary is npm scope ownership: any package outside the trusted scopes is ignored regardless of which ID it declares, so an attacker who would want to slip a malicious plugin past the loader must first take control of one of the trusted npm scopes (or the user's local `node_modules`, at which point arbitrary-code execution is already possible by other means). When two packages inside the same trusted scope and root declare the same ID — usually a misconfigured rename — the loader picks the lexicographically first one deterministically and warns about the collision so it can be cleaned up.

Symlinks under a trusted scope (`node_modules/@jolli.ai/<name>` pointing at a checkout elsewhere on disk) are followed — `npm link`, yarn workspaces, and pnpm's non-isolated layouts all rely on this. The loader records a `debug` line whenever a symlink's target resolves outside the originally-walked roots so the indirection is auditable from `debug.log`, but it does **not** refuse to load such plugins: a user who can place a symlink under their own `@jolli.ai/` scope already has the write privilege required to drop a real package there. Treating symlinks as a separate threat would block legitimate dev workflows without raising the bar against an attacker who already holds local write access.

Plugins inside the trusted scope are treated as **co-maintainers of the command namespace**, not as a sandbox. The loader's collision interception during `register()` is an ergonomics gate that lets a plugin survive a name overlap with a host builtin; it does not restrict what a plugin can do to commands that already exist. An allow-listed plugin can attach sub-subcommands, replace action handlers, or add aliases on any builtin via `ctx.program.commands[]`, by design — the trust anchor is the npm scope ownership rule above, not a runtime privilege boundary.

For the strongest isolation:

- Run `jolli` from inside your project directory. The boundary check above already prevents the local walk from picking up packages outside `$HOME`, but invoking from the project root is the cleanest configuration.
- Avoid running it as root, or in a session where another user controls your `$HOME` or your npm global prefix.
- If you need to disable plugin discovery entirely (e.g. on a hardened CI runner), set `JOLLI_NO_PLUGINS=1`.

## Out of scope

The following are **not** considered security vulnerabilities under this policy:

- Reports generated solely by automated scanners without a working proof-of-concept.
- Issues in third-party dependencies that have not yet been disclosed upstream — please report
  those to the dependency's own maintainers first.
- Self-XSS, clickjacking on pages without sensitive actions, or missing security headers on
  static documentation sites.
- Vulnerabilities that require physical access to a developer's machine, or root/admin on the
  same machine — Jolli Memory is a local-first tool and trusts the host it runs on.
