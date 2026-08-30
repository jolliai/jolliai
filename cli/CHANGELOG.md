# Changelog

<!-- Last synced commit: e3287ce7 | 2026-08-31 -->

## 0.99.17

- **Ready for Jolli's new web addresses** — signing in and syncing now work with Jolli's new domains, so keys issued there are accepted.
- Bug fixes.

## 0.99.16

- **Hermes Agent is supported** — conversations from Hermes Agent turn into memories automatically, just like your other agents. That makes twelve agents in all.
- **See where each repo syncs to** — Settings now shows which Jolli Space a repository is connected to, and signing in works more smoothly.
- **A snappier dashboard on big repos** — pages load faster and slow spots are easier to spot, so `jolli doctor` can point them out when something drags.
- **Decisions on the dashboard are accurate again** — the Decisions card now shows the right entries.
- Bug fixes.

## 0.99.15

- **Cursor work is captured right away** — Cursor conversations are recorded as they finish, so they show up even when you don't commit or open the dashboard.
- **A much faster dashboard** — the Journeys, stats, and standup pages load far quicker now, especially on large repositories.
- **See your MCP tool usage** — the dashboard shows which MCP tools your agents use.
- **Turning an agent off now applies everywhere** — switch a source off in Settings and it stops showing up across the dashboard too, not just the sidebar.
- Bug fixes.

## 0.99.14

- **See which agent did the work** — memories now record which AI tool each conversation, commit, and skill came from — Claude Code, Codex, Cursor, Copilot, Cline, Antigravity, Kimi Code — and the dashboard breaks your work down by agent.
- **A coaching view of your journeys** — the dashboard's **Journeys** page shows plan-first share, top skill, cost, and recall for the window you pick, with your smoothest and hardest journeys called out.
- **Skill usage has its own page** — see which agent used which skill, and the **Daily Standup** is now a week-at-a-time view instead of one long list.
- **`jolli repair-memory` reattaches a lost memory** — when an amend, rebase, or squash rewrites a commit, its memory can end up stuck on the old hash while the new commit shows nothing. `jolli doctor` now flags this, and `jolli repair-memory` puts it back (`--status` to preview first). Safe to run twice, and it backs up anything it replaces.
- **Pick a model per local agent** — `localAgentModel` now applies per tool, so Claude Code and Codex each keep their own default and choices.
- **Cleaner conversation history** — empty conversations no longer clutter your archives, conversations that grow after import are picked back up, and Codex transcripts parse more reliably.
- **SSH host aliases are recognised** — a repo cloned through a `~/.ssh/config` alias now binds to the same identity as one cloned by its real host.
- Bug fixes.

## 0.99.13

- **Breaking: `jolli dashboard` stays in your terminal** — it serves the dashboard until you press **Ctrl+C** instead of leaving a background server behind, so `jolli dashboard --stop` is gone with it. Run it again and it replaces the dashboard already running, so you always get a fresh one at the address you expect. A background server left over from the old version is taken over automatically; an unrelated service on port 1818 is still left alone.
- **`jolli` finishes by opening your dashboard** — every run in a terminal now ends there, after the status line, your memory count and "Next steps" are on screen, and keeps serving until you press Ctrl+C. `jolli` in a script or pipe is unchanged.
- **The knowledge wiki and graph rebuild when you ask** — they no longer rebuild in the background after every commit, so commits stay fast and nothing spends AI credits unprompted. The dashboard shows how far behind they are ("N updates behind · rebuilt X ago") and rebuilds them on one click. To keep the old behaviour: `jolli configure --set wikiRebuild=auto`.
- **A clearer dashboard** — accurate spend figures and a tidier layout, decisions and MCP usage trimmed to what you can act on, a standup that covers committed work only, and a repo picker in place of the old Repositories page. A list you opened with **Show more** now survives the 30-second refresh instead of snapping shut.
- **Your dashboard finds more conversations** — it now looks through your agents' own session history from the last 7 days, not just what was already recorded, and tells you in one line what it picked up.
- **Pushes stop promising memories that were never yours** — after a rebase, the pre-push check counted other people's commits that were already on the remote and then reported their memories as "still generating" on every push for a week. It now counts only what your push actually adds.
- **MCP tools answer for the right repository** — when the MCP server is started outside a project (some editors do this), the tools that need a repository are hidden from your agent instead of answering with an empty result that reads as "no memories here". Listing your Jolli Spaces and your workspace's own platform tools still work from anywhere, since they don't depend on which repo you are in.
- Bug fixes.

## 0.99.12

- **Lighter with several AI sessions open** — sessions now share one MCP server per checkout instead of each starting its own.
- **More in the dashboard** — `jolli dashboard` gains a **Settings** screen, a browsable **Knowledge** view of your wiki, and the knowledge **Graph** in-page. Tool usage now breaks down by agent.
- **Three more places your references come from** — **Vercel** deployments, **Figma** design files, and **Sentry** issues now show up on your memories. Fifteen sources in total.
- **Daily backups run on their own schedule** — instead of only when a commit or the dashboard happened to wake Jolli up.
- **`jolli doctor --schema-log` / `--mark-migration`** — inspect your memory database's schema history, or repair it when a migration record went missing.
- **AI sessions start faster** — the hook that runs when a session opens no longer waits on `git`.
- **Per-branch token and cost figures stay put** — each memory now records the branch it was made on, so the numbers stop shifting.
- Bug fixes.

## 0.99.11

- **Breaking: requires Node 22.13+** — the CLI now requires Node 22.13 or newer (previously Node 22.5+). `node:sqlite` first ships in 22.5, but until 22.13 it only loads with `--experimental-sqlite`, and two surfaces cannot pass a Node flag at all: the VS Code extension host, and the git hooks, which run `node <Hook>.js` deliberately flag-free. Node 22.5–22.12 users should upgrade before running `npm install -g @jolli.ai/cli`; the `engines` field will refuse installation on older runtimes.
- **Kimi Code conversations become memories** — sessions from **Kimi Code CLI** (Moonshot's `@kimi-code/cli`) are now discovered automatically and folded into your memories, complete with references and skill usage — no hook to install. MCP registration also covers Kimi Code now, making eleven hosts in total.
- **Skills are shared alongside the memory** — when you push a memory or a branch to a Jolli Space, the skills used by the change go along as separate articles, next to plans, notes, and references.
- **Squash memories keep the working context** — plans, notes, and references you activated during a session are now archived into squash and merge memories instead of being abandoned in the working area.
- **A local dashboard in your browser** — `jolli dashboard` starts a private web server on your machine and opens a dashboard with your memories, per-repo stats, and a standup summary — everything served locally and never uploaded. Reopen it any time with the same command and stop it with `jolli dashboard --stop`.
- **Your memories can move to a local database** — with `jolli cutover` a repository's storage switches from the git branch to a local SQLite database, the new source of truth. This is a one-way switch: it freezes the repo's git branch, and `jolli enable` will not unfreeze it. Run `jolli cutover --status` first to see where the current repo stands, and `jolli cutover --probe` afterwards to check the frozen branch for drift.
- Bug fixes.

## 0.99.10

- **Skills used now show up in memory** — Jolli now saves which agent skills were used for a change, alongside plans, notes, and references. On some hosts this is exact, and on others it is best-effort.
- **Choose per repo whether memory is synced out** — the new `jolli push-control` command lets you turn syncing to Jolli on or off for one repo. Local capture keeps running either way, and anything kept while sync was off is sent when you turn it back on.
- **More local agents are supported** — `local-agent` can now use **Claude Code**, **Codex**, **Cursor**, **OpenCode**, or **Kimi Code** (Moonshot's `@kimi-code/cli`) to generate memories.
- **MCP setup now covers more hosts** — Jolli can now register its MCP server in **Cline**, **Devin CLI**, and **Antigravity**, in addition to the hosts already supported.
- **Jolli lookups are part of the record** — `recall`, `search`, and timeline lookups now appear as references on the memory, so it's clearer what context was used.
- **Every memory gets a short `JM-...` ID** — you can quote that ID in a PR, issue, or message.
- **Memories match the commit more closely** — relevance is now based more on what actually changed, not just which files changed.
- Bug fixes.

## 0.99.9

- **Four more AI agents supported** — conversations from **Cline** (both the standalone CLI and the VS Code extension), **Devin CLI**, **Antigravity**, and the **Cursor CLI** (`cursor-agent`) are now folded into your memories automatically, no hook to install — each is discovered by scanning its own on-disk session store. Toggle them with `jolli configure --set clineEnabled=… / devinEnabled=… / antigravityEnabled=…`; the Cursor CLI shares the existing `cursorEnabled` switch with Cursor's Composer IDE.
- **Install Jolli as a Claude Code plugin** — a new Claude Code plugin packages Jolli's git hooks, MCP server, and `/jolli` skills, so you can add it from the plugin marketplace instead of wiring things up by hand (`jolli enable --repo-hooks-only` installs just the repo hooks the plugin needs). Install surfaces — CLI, VS Code, and the plugin — now compete on version instead of a hard pin, so whichever is newest wins.
- **Run Jolli workflows and see the results** — the `/jolli-local-run` and new `/jolli-remote-run` skills run a workflow on your own machine or in the cloud, then report the resulting article, PR, and workflow-run links and offer to open them in your browser; a run-history action lists a workflow's past runs. Workflow commands now live in the separate `@jolli.ai/workflow-cli` plugin (`npm install -g @jolli.ai/workflow-cli`); `jolli --help` still lists them under **Jolli Workflows** with a one-line install hint when it's missing.
- **More references** — Slack threads mentioned in **Codex** conversations are now captured (previously Claude-only), and **context7** library-documentation lookups are recorded as references alongside Linear, Jira, GitHub, Notion, Slack, Zoom, Confluence, Asana, and monday.com.
- **A smoother first run** — bare `jolli` / `jolli enable` now auto-detects a working Claude Code install and skips the setup menu, offers an optional sign-in nudge rather than a permanent dismissal, and shares one repair ladder across the enable and guided flows so a missing key is fixed the same way everywhere.
- **The `/jolli-pr` skill has been removed** — PR authoring no longer ships as a standalone skill. Turning a branch's memories into a PR title and body is still fully supported through the `get_pr_description` MCP tool and the `jolli pr-description` command — your agent can call either and open the PR with `gh` — so only the `/jolli-pr` skill itself, its entry in the `/jolli` menu, and its hint in the global agent-instructions block are gone. Upgrading removes any previously-installed `jolli-pr` skill file for you.
- **Clearer agent memory guidance** — the "prefer Jolli" note written into your machine-global AI instruction files now describes recall/search by intent instead of hard-coding skill IDs, so plugin (`jolli:recall`) and CLI (`jolli-recall`) installs both resolve to whatever recall/search skill or `mcp__jollimemory__` tool is registered, and your agent reaches for memory proactively on why/how/prior-art/resume questions.
- **Sharper knowledge graph** — topics that change together are now linked by co-change edges, and a knowledge unit can carry more than one kind label, so the graph reflects cross-cutting work more faithfully. The exported graph viewer also shows a dismissible notice when it loads a graph built by an older schema, so you know to regenerate it for full fidelity.
- **Sessions in subdirectories** — sessions started in a project subdirectory are now discovered and attributed to the repo.
- Security fixes and bug fixes.

## 0.99.8

- **Generate memories with your local AI CLI** — a new `local-agent` AI provider drives a locally-installed Claude Code to write your memories, so summarization runs through the agent you already have — no API key and no Jolli proxy call. Turn it on with `jolli configure --set aiProvider=local-agent`; if the binary isn't on your `PATH`, point at it with `jolli configure --set localAgentPath=/path/to/claude`.
- **A guided first run** — type `jolli` on its own in a terminal and it walks you through getting set up: sign in, pick which AI provider generates your memories (and fix a missing key on the spot), bind the repo to a Jolli Space, and offer to back-fill memories for commits you made before Jolli.
- **Run Jolli workflows from your agent** — a new `/jolli-local-run` skill lets your AI agent run a Jolli workflow on your own machine (it executes the recipe itself, so it never spends Jolli AI credits); the results land in a git-backed Jolli Space through a branch and pull request. Remote runs are supported too.
- **A `/jolli` menu** — one front door that lists the Jolli skills (recall, search, PR, run a workflow) plus whatever Jolli tools your agent has, then routes your pick to the right one.
- **Three more places your references come from** — issues, pages, tasks, and items from **Confluence, Asana, and monday.com** mentioned in your AI conversations now show up in your memories, PR descriptions, and exports, alongside Linear, Jira, GitHub, Notion, Slack, and Zoom. Slack thread links and more permalink formats are picked up too, and Jira detection from Codex is more reliable.
- **`jolli uninstall`** — a new command that finds and removes Jolli's installs and configuration across your editors and the global CLI, with a preview, interactive selection, `--dry-run`, and `--scope`. Machine-global entries that other repos still rely on (global-scope MCP registrations and instruction blocks) and the generated skill files are deliberately left in place; your memories are never touched.
- **Your agent can reach Jolli platform tools** — the `jolli mcp` server now also surfaces backend-defined platform tools (on by default), so agents can act on your Jolli Space directly. Turn them off with `jolli configure --set mcpPlatformToolsEnabled=false`.
- **Knowledge graph across devices** — graphs now sync between the machines you sign in to with deterministic conflict resolution, and can be embedded on the web.
- **Sharper memory relevance** — the check that decides what belongs in each memory moved from a simple keep/drop list to tier-based ranking, so plans, notes, and references are chosen more precisely.
- **Safer, faster pushing** — memories are pushed in a single synchronous batch on pre-push, and a fix keeps references from being dropped when a conversation is split across a scan boundary.
- Bug fixes

## 0.99.7

- **Slack & Zoom references** — Slack threads and Zoom meetings or docs mentioned in your AI conversations now appear in your memories, PR descriptions, and exports, right alongside Linear, Jira, GitHub, and Notion.
- **Smarter about what goes into a memory** — a relevance check keeps only the plans, notes, and references that actually relate to your commit, so your memories stay on-topic.
- **Agent guidance is now fully opt-in** — Jolli only teaches your AI agent to prefer it once you turn it on (`jolli configure --set globalInstructions=enabled`, or the toggle in the editor). `jolli enable` no longer asks — it just applies whatever you chose.
- **Safer pushing** — a new pre-push step tidies up leftover memory data and retries the sync if a push races with it, so nothing gets left behind.
- **More accurate cost estimates** — each memory is now priced by the model that actually generated it (Opus / Sonnet / Haiku) instead of a flat Sonnet rate.
- Bug fixes

## 0.99.6

- **Jolli asks before changing your AI setup** — `jolli enable` now checks with you first before teaching your AI agent to prefer Jolli. Say no and nothing is changed.
- **See token usage on shared memories** — memories you share now show how many tokens they used and an estimated cost.
- Bug fixes

## 0.99.5

- **Catch up on commits you made before Jolli** — the new `jolli backfill` command creates memories for your existing commit history, so your older work shows up too. (Claude transcripts for now.)
- **Your agent picks the right skill on its own** — after `jolli enable`, your AI agent knows to use Jolli for creating PRs, searching past work, and recalling a branch — no need to spell it out each time.
- Bug fixes

## 0.99.4

- **See your memories as a knowledge graph** — `jolli graph` turns the topics in your knowledge wiki into an interactive map: categories, the decisions/mechanisms/fixes inside each, and the typed links between them (extends, caused-by, supersedes, contradicts, related-to). It exports a single self-contained HTML file you can open in any browser or share — no server needed (`jolli graph --export <dir> --open`). The graph is built automatically right after the wiki on each commit, and updated incrementally (only changed topics are re-distilled), so it stays current without a full rebuild.
- **Turn a branch's memories into a PR description** — a new `get_pr_description` MCP tool and `jolli pr-description` command assemble a ready-to-paste GitHub PR title and body from everything captured on the branch. The `/jolli-pr` skill wires this straight into your agent so it can open the PR for you. The MCP server now exposes five tools (`search`, `recall`, `get_decision_timeline`, `list_branches`, `get_pr_description`).
- **Agent skills now go through the MCP server** — the `/jolli-recall` and `/jolli-search` skills prefer the MCP tools and fall back to the CLI recipe only on hosts without MCP support. MCP registration now reaches seven AI hosts (Claude Code, Cursor, Gemini, Codex, OpenCode, GitHub Copilot CLI, VS Code Copilot Chat).
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
