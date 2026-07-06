# Changelog

<!-- Last synced commit: 38920160 | 2026-07-06 -->

## 0.99.5

- **Catch up on commits you made before Jolli** — the new `jolli backfill` command creates memories for your existing commit history, so your older work shows up too. (Claude transcripts for now.)
- **Your agent picks the right skill on its own** — after `jolli enable`, your AI agent knows to use Jolli for creating PRs, searching past work, and recalling a branch — no need to spell it out each time.
- Bug fixes

## 0.99.4

- **See your memories as a knowledge graph** — `jolli graph` turns the topics in your knowledge wiki into an interactive map: categories, the decisions/mechanisms/fixes inside each, and the typed links between them (extends, caused-by, supersedes, contradicts, related-to). It exports a single self-contained HTML file you can open in any browser or share — no server needed (`jolli graph --export <dir> --open`). The graph is built automatically right after the wiki on each commit, and updated incrementally (only changed topics are re-distilled), so it stays current without a full rebuild.
- **Turn a branch's memories into a PR description** — a new `get_pr_description` MCP tool and `jolli pr-description` command assemble a ready-to-paste GitHub PR title and body from everything captured on the branch. The `/jolli-pr` skill wires this straight into your agent so it can open the PR for you. The MCP server now exposes five tools (`search`, `recall`, `get_decision_timeline`, `list_branches`, `get_pr_description`).
- **Agent skills now go through the MCP server** — the `/jolli-recall` and `/jolli-search` skills prefer the MCP tools and fall back to the CLI recipe only on hosts without MCP support. MCP registration now reaches seven AI hosts (Claude Code, Cursor, Gemini CLI, Codex, OpenCode, GitHub Copilot CLI, VS Code Copilot Chat).
- **Anonymous, opt-out usage telemetry** — to understand which features are used and where the pipeline breaks, Jolli Memory now collects **content-free** usage events (never your code, paths, commit messages, transcripts, or memory content). It's on by default and shares one anonymous machine id across the CLI, VS Code, and IntelliJ. Manage it with `jolli telemetry status` / `on` / `off`, see exactly what's buffered with `jolli telemetry inspect`, or set `DO_NOT_TRACK=1`. Full event list: <https://jolli.ai/telemetry> (and [TELEMETRY.md](../TELEMETRY.md)).
- **Better Linear detection from Codex** — Linear references are now picked up from OpenAI-curated connector tools and the `mcp__claude_ai_Linear__` tool prefix, so more of your issue links survive into memories.
- Bug fixes

## 0.99.3

- **Build a knowledge wiki from your memories** — `jolli compile` gathers the work scattered across many commits and folds it into per-topic pages, building a knowledge base that keeps growing as you go and a browsable `_wiki/` folder in your Memory Bank. It updates on its own after each commit; `jolli compile --rebuild --cwd <dir>` rebuilds a repo's wiki from scratch.
- **Let your AI agent look things up for you** — `jolli mcp` starts a small local server that Claude Code (and other MCP-aware agents) can talk to. Your agent can search the knowledge wiki's topics, recall everything done on a branch, and trace how a particular decision evolved — all from inside the chat, no copy-pasting. It's wired up automatically when you enable Jolli Memory.
- **Faster memory search** — a local search index over the compiled wiki topics keeps the agent's keyword lookups quick. Run `jolli mcp --reindex` any time to rebuild it from scratch.
- **More than just Linear** — issues and pages from **Jira, GitHub, and Notion** (not only Linear) are now picked up from your AI conversations and saved alongside each memory, from both Claude and Codex.
- **The site generator is now a separate add-on** — `jolli new` / `build` / `dev` / `start` / `convert` moved into the `@jolli.ai/site-cli` plugin. Install it with `npm install -g @jolli.ai/site-cli`; `jolli --help` still lists the commands and shows the one-line install hint if it's missing.
- **Update reminders** — the CLI now lets you know when a newer version is available.
- Bug fixes

## 0.99.2

- **New `jolli heal-folder` command** — Accidentally deleted Memory Bank Markdown files? This rebuilds them from the source of truth. No AI call, no cost.
- **Cleaner `jolli recall` output** — Long branches no longer get cut off mid-thought. (The unused `--verbose` flag is gone.)
- **Linear issues in your memories** — When an AI session mentions a Linear issue, it's saved and shown alongside your plans and notes, and follows the commit through squashes and rebases.
- **Faster, smaller site generator** — Sites build more reliably (config is checked up front, themes are cached, `jolli start` now supports React Server Components), and the install is smaller — the `tar` dependency is gone.
- **`jolli auth login` names your device** — Sign-in now labels each session with your hostname and OS, so you can tell them apart in the Jolli web UI instead of seeing anonymous entries.
- **`--arg-stdin` for agent skills** — `jolli recall` / `search` can read long arguments from stdin, so skills can pass multi-line input without quoting headaches.
- **CLI plugins (experimental)** — `@jolli.ai/cli` can now load trusted plugin packages (from the `@jolli.ai/` npm scope) that add their own commands. Set `JOLLI_NO_PLUGINS=1` to turn it off. See [SECURITY.md](../SECURITY.md#operational-guidance).
- **Narrower public API** — `@jolli.ai/cli` and `@jolli.ai/cli/api` are the only supported imports now; deep `dist/*` imports no longer resolve.
- **Memory Bank cross-device sync (new)** — A new bundled sync engine keeps your Memory Bank consistent across the devices you sign in to: it recovers on its own after an interrupted sync, only ever commits recognized Memory Bank files, and won't let a commit-time write collide with a sync in progress. Sync runs on demand — from the terminal with the new `jolli sync-memory-bank` command (handy when you don't keep an editor open, or in CI / scripts), or from the editor plugins' **Sync to Personal Space Now** button (see [`vscode/CHANGELOG.md`](../vscode/CHANGELOG.md)).
- Bug fixes

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
