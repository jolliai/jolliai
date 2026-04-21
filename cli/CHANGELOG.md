# Changelog

<!-- Last synced commit: ff796b6a5 | 2026-04-13 -->

## 0.98.0

- **`jolli auth` commands**: Added `jolli auth signup`, `jolli auth login`, `jolli auth logout`, `jolli auth status` for browser-based OAuth authentication.
- **Updated `jolli enable` flow**: Now offers Sign up / Sign in as the primary option alongside manual API key entry.

## 0.97.3

- **`jolli export` command** — export every memory on the current branch as Markdown files to `~/Documents/jollimemory/` with one command
- **Global config only** — the Project/Global scope switch is gone; settings are always read from `~/.jolli/jollimemory/config.json` and shared across every project
- **Scoped npm package** — the CLI is now published as `@jolli/cli`; install with `npm install -g @jolli/cli`
- **Smoother install** — `enable`/`disable` are more reliable on re-runs, CLI file permissions are fixed on macOS and Linux, and a post-install step ensures hooks are ready to go out of the box
- Bug fixes

## 0.97.2

- Initial CLI support for Jolli Memory — `enable`, `disable`, `status`, `view`, and `recall` commands run independently of the VS Code extension
