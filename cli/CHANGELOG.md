# Changelog

<!-- Last synced commit: d53654bc | 2026-05-13 -->

## 0.99.1

- Bug fixes

## 0.99.0

- **Three new AI agents supported** — Cursor IDE (Composer), GitHub Copilot CLI, and VS Code Copilot Chat. Conversations from all three are now folded into your commit summaries automatically, no hook installation needed.
- **`jolli search`** — two-phase search across every branch's memories from the terminal. Phase 1 returns a catalog of matches (hash + branch + date + recap + topic titles); Phase 2 (via `--hashes`) returns full topic bodies.
- **`/jolli-search` agent skill** — same search, available from inside Claude Code or any agent that loads the skill. The skill template now requires verbatim-quote rules to wrap complete clauses (not snippets), so quoted material always survives review without context loss.
- **`/jolli-recall` agent skill** — the recall skill template now favors section structure over a strict word ceiling, so long branches with many decisions stop being truncated mid-thought.
- **`jolli recall --format json`** — now returns a structured `RecallPayload` (plans, notes, summaries, and stats) instead of a pre-rendered markdown blob. The agent skill consumes the structured fields directly and runs its own grounded synthesis, which removes the previous tendency to paraphrase. Token-budget trimming is applied to the structured payload so very long branches stay within the configured budget.
- **AI Summary Provider tracking** — a new optional `aiProvider` config field (`"anthropic"` | `"jolli"`) lets you pin which provider to use; when unset, the dispatcher falls back to the legacy precedence (`apiKey` > `ANTHROPIC_API_KEY` > `jolliApiKey`) so existing configs keep working. Each generated summary now records which credential source produced it (`anthropic-config` / `anthropic-env` / `jolli-proxy`) in its `LlmCallMetadata.source` field.
- **`pushAction` config retired** — the legacy `pushAction` config key and the corresponding `LocalPusher` runtime are fully removed. Memory Bank already dual-writes a Markdown copy of every memory on every commit, so the manual "Push to Jolli & Local" mode is no longer needed.
- **Site generator: `jolli new` / `build` / `start` / `dev`** — generate a documentation site from a folder of Markdown plus OpenAPI specs. Two built-in theme packs (Forge and Atlas), header / footer customization, and a `jolli dev` hot-reload server. See [`docs/site-json-reference.md`](docs/site-json-reference.md) and [`examples/`](examples/) for runnable configurations.
- **Memory Bank** — every repo now gets a plain-Markdown copy of every memory on disk. The first time hooks run on a repo with existing memories, they migrate automatically; from then on, every new memory is written to **both** the git orphan branch (the source of truth) and the Memory Bank folder.
- **Better recap quality** — prompts, summarization, and regeneration are all tighter. Squashing commits no longer loses decision details from the originals.
- **`jolli auth` hardened** — sign-in now uses an authorization-code exchange with CSRF protection (RFC 6749), so credentials never appear in browser URLs.
- **Smaller install footprint** — sourcemaps removed from production builds.
- Bug fixes

## 0.98.0

- **Breaking: requires Node 22.5+** — the CLI now requires Node 22.5 or newer (previously Node 18+). OpenCode session discovery relies on Node's built-in `node:sqlite`, which first ships in Node 22.5. Node 18 and 20 users should upgrade before running `npm install -g @jolli.ai/cli`; the `engines` field will refuse installation on older runtimes.
- **OpenCode integration** — sessions from [OpenCode](https://opencode.ai) are now discovered automatically at commit time. Jolli Memory reads the global OpenCode SQLite database at `~/.local/share/opencode/opencode.db` (or `$XDG_DATA_HOME/opencode/opencode.db`) and picks up any session whose `directory` matches the current project. No hook installation needed — same pattern as Codex. Toggle with `jolli configure --set openCodeEnabled=true|false`.
- **`jolli auth` commands**: Added `jolli auth login`, `jolli auth logout`, `jolli auth status` for browser-based OAuth authentication.
- **Updated `jolli enable` flow**: Now offers Sign up / Sign in as the primary option alongside manual API key entry.

## 0.97.3

- **`jolli export` command** — export every memory on the current branch as Markdown files to `~/Documents/jollimemory/` with one command
- **Global config only** — the Project/Global scope switch is gone; settings are always read from `~/.jolli/jollimemory/config.json` and shared across every project
- **Scoped npm package** — the CLI is now published as `@jolli.ai/cli`; install with `npm install -g @jolli.ai/cli`
- **Smoother install** — `enable`/`disable` are more reliable on re-runs, CLI file permissions are fixed on macOS and Linux, and a post-install step ensures hooks are ready to go out of the box
- Bug fixes

## 0.97.2

- Initial CLI support for Jolli Memory — `enable`, `disable`, `status`, `view`, and `recall` commands run independently of the VS Code extension
