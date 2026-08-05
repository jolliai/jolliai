# Jolli Memory — Claude Code plugin

Jolli Memory's Claude Code integration — MCP tools, a bare `/jolli` menu plus
`/jolli:*` skills and commands, and session hooks — packaged as a single
installable Claude Code plugin.

Jolli builds a durable memory of your work from your git commits and lets you
recall it, search past decisions, and generate memory-rich PR descriptions —
right inside Claude Code. When enabled, the plugin's `SessionStart` hook also
installs Jolli's git hooks into the active repository (idempotent); those git
hooks are what generate the memory that the plugin surfaces let you consume.

## What you get

- **MCP tools** — `recall`, `search`, `get_decision_timeline`, `list_branches`,
  `get_pr_description`, `queue_status`, `status`, plus the Jolli Space tools.
- **Commands** — `/jolli:init`, `/jolli:status`, `/jolli:timeline`,
  `/jolli:login`, `/jolli:logout`.
- **Skills** — `/jolli:recall`, `/jolli:search`, `/jolli:push`.
- **Umbrella** — a bare `/jolli` front door: it reads how Jolli is set up in this
  repo, leads with setup when something is missing, and otherwise shows a status
  snapshot and routes to your pick (written into `.claude/skills/jolli/` on first
  session; a plugin can't expose a bare command itself, so this is a
  project-level skill).
- **Hooks** — one `SessionStart` bootstrap that installs the git hooks and the
  canonical agent hooks, which then build memory
  from your commits, and — until you sign in — remind you to run `/jolli:login`.

## Installation

Install from Jolli's Claude Code marketplace:

```
/plugin marketplace add <marketplace-source>
/plugin install jolli@jolli-marketplace
```

`<marketplace-source>` is the marketplace repo (its `marketplace.json`
names the marketplace `jolli-marketplace`, which is why the install target is
`jolli@jolli-marketplace`).

In the **desktop app**, use **+ → Plugins → Add marketplace** with the same
source, then enable **Jolli Memory** under **Manage plugins**.

After install the MCP tools, `/jolli:*` skills and commands, and the hooks are
all live.

Start with **`/jolli`**. It reads how Jolli is set up in this repository, leads
with setup when something is missing, and otherwise shows a status snapshot and
routes you to recall, search, a PR description, or a Space. In a brand-new repo
the bare `/jolli` may not appear until the plugin has written it during its first
session — **`/jolli:init`** always works directly, and is also what you run to
re-run setup or change the bound Space.

## Memory generation works out of the box

**You do not need to sign in, and you do not need an API key.** On its first
session the plugin writes `local-agent` as the provider into the machine-global
config (`~/.jolli/jollimemory/config.json`) and drives your already-signed-in
`claude` CLI to write memories. Commit as usual and the summaries appear. Because
that config is shared, the choice also becomes the default for the Jolli CLI and
the VS Code extension on this machine.

That default is only seeded when you have expressed no provider preference. If
you ever signed in to Jolli from the CLI or the VS Code extension, or pinned
`aiProvider` explicitly, that choice is respected here too, so you will need
whichever credential it implies.

## Sign in (optional, for sharing to a Jolli Space)

Signing in is about **sharing** memories to a Jolli Space, so teammates and your
other devices can recall them. It is not required to generate them.

```
/jolli:login
```

This opens your browser and, on success, saves a Jolli API Key. Run
`/jolli:logout` to sign out.

**`/jolli:init`** does all of it in one pass: it signs you in if needed, enables
the repo, and binds it to a Space. `/jolli` routes there on its own whenever setup
is incomplete.

> **Prefer your own Anthropic key?** Setting `ANTHROPIC_API_KEY` on its own is not
> enough once the plugin has seeded `local-agent`, because the provider choice is
> resolved before any key is consulted. Switch deliberately instead:
> `jolli configure --set aiProvider=anthropic --set apiKey=sk-ant-...`. You need
> neither this nor a Jolli login for generation to work.

## Requirements

`node` must be on your PATH — the plugin's MCP server (`node dist/Cli.js mcp`)
and its hooks all run under it. This is the same requirement the Jolli CLI and
VS Code extension already have. Claude Code fetches the plugin package itself, so
`npm` is **not** required on PATH; `node` is.

## License

Apache-2.0. See [LICENSE](https://github.com/jolliai/jolliai/blob/main/LICENSE).
