# Changelog

<!-- Last synced commit: ea9ad050b | 2026-04-23 -->

## 0.98.0

- **Breaking: requires Node 22.5+** — the CLI now requires Node 22.5 or newer (previously Node 18+). OpenCode session discovery relies on Node's built-in `node:sqlite`, which first ships in Node 22.5. Node 18 and 20 users should upgrade before running `npm install -g @jolli.ai/cli`; the `engines` field will refuse installation on older runtimes.
- **OpenCode integration** — sessions from [OpenCode](https://opencode.ai) are now discovered automatically at commit time. Jolli Memory reads the global OpenCode SQLite database at `~/.local/share/opencode/opencode.db` (or `$XDG_DATA_HOME/opencode/opencode.db`) and picks up any session whose `directory` matches the current project. No hook installation needed — same pattern as Codex. Toggle with `jolli configure --set openCodeEnabled=true|false`.
- **`jolli auth` commands**: Added `jolli auth signup`, `jolli auth login`, `jolli auth logout`, `jolli auth status` for browser-based OAuth authentication.
- **Updated `jolli enable` flow**: Now offers Sign up / Sign in as the primary option alongside manual API key entry.

## 0.97.3

- **`jolli export` command** — export every memory on the current branch as Markdown files to `~/Documents/jollimemory/` with one command
- **Global config only** — the Project/Global scope switch is gone; settings are always read from `~/.jolli/jollimemory/config.json` and shared across every project
- **Scoped npm package** — the CLI is now published as `@jolli.ai/cli`; install with `npm install -g @jolli.ai/cli`
- **Smoother install** — `enable`/`disable` are more reliable on re-runs, CLI file permissions are fixed on macOS and Linux, and a post-install step ensures hooks are ready to go out of the box
- Bug fixes

## 0.97.2

- Initial CLI support for Jolli Memory — `enable`, `disable`, `status`, `view`, and `recall` commands run independently of the VS Code extension
