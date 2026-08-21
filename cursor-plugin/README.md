# Jolli Memory for Cursor

Jolli Memory builds a durable memory of your work from your git commits, and makes
prior decisions, unfinished work, and branch history recallable — right inside
Cursor.

## What the plugin includes

- **Skills** — twelve, all shipped with the plugin, all available from the moment you
  install, in any window, whether or not a repository is open.
  - **`/jolli`** — the front door. Start here; it reads how things stand and routes you.
  - **Eleven more**: `/jolli-recall`, `/jolli-search`, `/jolli-timeline`,
    `/jolli-push`, `/jolli-dashboard`, `/jolli-status`, `/jolli-init`,
    `/jolli-login`, `/jolli-logout`, `/jolli-local-run`, `/jolli-remote-run`.
  - If you also use Jolli with Claude Code or Codex in the same repository, four of
    these (`/jolli-recall`, `/jolli-search`, `/jolli-local-run`, `/jolli-remote-run`)
    will appear **twice** in the slash menu — once from this plugin, once from the
    cross-platform copy those tools read. The two are the same instructions; Cursor
    pools every skill source into one flat menu and cannot merge them. Either entry
    works.
- **MCP tools** — `recall`, `search`, `get_decision_timeline`, `list_branches`,
  `get_pr_description`, `queue_status`, `status`, plus the Jolli Space tools.
  Registered into a repository when you set it up; enabling the server takes one
  click, see below.
- **Hooks** — one `sessionStart` bootstrap. **It does not set up your repositories
  for you.** It installs the `run-cli` dispatcher, and for repositories you have
  already set up it keeps them current and injects a branch briefing. Setting a
  repository up — git hooks and MCP — happens when you ask for it, through `/jolli` or
  `/jolli-init`. The skills need none of this: they ship with the plugin and work from
  the moment it is installed.
- **A self-contained runtime** — no global `jolli` CLI installation required.
  Jolli's CLI is still reachable at `~/.jolli/jollimemory/run-cli` (a bash script —
  on Windows run it from Git Bash), which takes the same arguments as `jolli` itself,
  for the few things below that are not a `/jolli-*` skill.

## Install

Add `<marketplace-source>` as a marketplace in Cursor, then install **Jolli Memory**
from **Customize** in the sidebar and choose the project or user scope.

Then run **`/jolli`** in any chat. All twelve skills are there as soon as the plugin
is installed — you do not have to restart or open a repository first.

**One thing does need a full restart, and it is worth doing straight away.** The
plugin's `sessionStart` hook is what writes `~/.jolli/jollimemory/run-cli`, the
dispatcher the skills fall back on when the MCP server is not reachable yet — and
Cursor does not register a freshly installed plugin's hooks until it is **completely
restarted**. Reloading the window is not enough, and neither is starting another chat.
So after installing: **quit Cursor (⌘Q), reopen it, and start a new chat.**

If you skip that, the skills are all present but `/jolli` will tell you the dispatcher
is missing and ask you to do exactly this.

### Upgrading from 1.0.0: remove and re-add the marketplace once

**If you installed Jolli Memory for Cursor at version 1.0.0, a normal update will not
reach you, and Cursor will not tell you so.** The marketplace was renamed in 1.0.1
(from `jolli-cursor-marketplace` to `jolli-cursor`, so the section header in Customize
reads **Jolli Cursor** rather than **Jolli Cursor Marketplace**). That name is how
Cursor identifies a marketplace, not a label on it, so the old entry keeps pointing at
the old identity and simply reports that you are up to date.

To pick up 1.0.1 and later — which is where all twelve bundled skills live:

1. In **Customize**, remove the **Jolli Cursor Marketplace** entry.
2. Add `<marketplace-source>` again. It now appears as **Jolli Cursor**.
3. Install **Jolli Memory** from it, then quit Cursor (⌘Q) and reopen, as above.

Nothing of yours is lost: your memories live in your repositories, and your settings in
`~/.jolli/`. Afterwards the old cache directory
`~/.cursor/plugins/cache/jolli-cursor-marketplace/` is orphaned and safe to delete.

This is a one-time step. It does not apply to a fresh install, and no future upgrade
needs it.

### If the marketplace appears but lists no plugins

Cursor resolves a marketplace imported from GitHub through its own backend, against
your team. On an account with no team we have seen that come back **empty, with no
error**: the marketplace shows up in the filter, offers nothing, and nothing is written
to disk. The tell-tale is the entry's title — if it is named after the repository
instead of **Jolli Cursor**, its manifest was never read.

Importing from a local clone takes a different, entirely local route and is not
affected. Clone the repository, then use **Add Marketplace → Import from Disk** and
point it at the clone:

```bash
git clone https://github.com/<marketplace-source>.git
```

The clone is a snapshot, not a live link, so to move to a newer release you pull in the
clone and then remove and re-import the marketplace in Cursor.

### If you also use Jolli in Claude Code, you will see two Jolli marketplaces

Cursor automatically imports the marketplaces you have added in Claude Code, so a
machine with both will list **two** entries offering a plugin called `jolli`:

| In Customize | Where it came from | Use it? |
|---|---|---|
| **Jolli Cursor** | this plugin, added by you | **Yes** |
| **Jolli Marketplace** | your Claude Code setup, imported automatically | No |

Install from the one with **Cursor** in its name. Both offer a plugin card reading
**Jolli Memory**, so the marketplace title above the card is the only thing telling
them apart; if you are unsure which one you installed, check where it landed: this
plugin caches under `~/.cursor/plugins/cache/jolli-cursor/`, the imported Claude one
under `~/.cursor/plugins/cache/jolli-marketplace/`. They are different builds of the
same product, and the Claude Code one does not work here. Cursor does translate its
hook configuration and does run it — but that hook resolves the repository from its
own working directory, which under Cursor is the plugin's folder rather than yours, so
it finds no repository and does nothing. **Nothing captures memory**, while the skills
and the MCP server still appear perfectly healthy. Its MCP server also starts before
Cursor knows which folder is open, so it answers about your home directory instead of
your repository: every recall and search succeeds and comes back empty.

Leaving it in the list is harmless as long as you do not install it. Removing it from
inside Cursor does not stick — the import runs again on the next window reload. If you
want it gone, remove it on the Claude Code side, which also removes it from Claude Code:

```bash
claude plugin marketplace remove jolli-marketplace
```

## Your repositories are not touched until you say so

Installing the plugin changes nothing in any repository. Jolli captures memory through
git hooks, and writing hooks into a repository is a change to your working copy — so
it waits for you to ask, per repository. A repository you merely opened, or browsed
once from the sidebar, stays exactly as it was. **That is the intended state, not a
fault**, and there is nothing to repair when you see it.

The `sessionStart` hook, which Cursor fires when a **new conversation starts** (not on
opening a folder, not on switching windows, not on typing `/` in an existing chat —
and not at all until Cursor has been fully restarted once after the install), does two
things and no more:

- installs the `~/.jolli/jollimemory/run-cli` dispatcher the skills fall back on when
  MCP is not reachable;
- for a repository you have **already** set up: keeps it current — re-pointing its
  git hooks and MCP entry after a plugin upgrade — and injects a short briefing for
  the current branch.

## Setting a repository up

Run **`/jolli`** in a chat with that repository open. It reads how things stand and
walks you through what is missing; `/jolli-init` does the same thing directly if you
prefer to skip the menu. Either one:

- installs the repository's git hooks (that is what captures memory on commit);
- writes `.cursor/mcp.json` so the Jolli Memory MCP tools are available;
- records Cursor as the local summarization agent if no provider is configured yet;
- signs you in and binds a Jolli Space, if you want to share memories.

Commits you made **before** setting up are not lost — `run-cli backfill --all` writes
memories for the history that is already there.

Note what is NOT in that list: the skills. They ship with the plugin and work before
any of this — setup is what makes them have something to recall.

Everything it writes is added to `.git/info/exclude`, so none of it shows up in
`git status`.

The MCP tools need one click the first time. Cursor notices the freshly written
`.cursor/mcp.json` within a second — no reload — but registers the server
**disconnected**, so open **Customize** in the sidebar and enable `jollimemory`. The
skills work either way: each one names a CLI fallback.

Once a repository is set up, **`/jolli`** stays the entry point: it shows a status
snapshot and routes you to recall, search, a PR description, or a Space. Run
`/jolli-init` again whenever you want to re-run setup or change the bound Space.

## Memory generation works out of the box

**You do not need to sign in, and you do not need an API key.** When you set a
repository up, the plugin writes `local-agent` as the provider into the machine-global
config (`~/.jolli/jollimemory/config.json`) and drives your already-signed-in
`cursor-agent` CLI to write the memories. Commit as usual and the summaries appear. Because that
config is shared, the choice also becomes the default for the Jolli CLI and the other
Jolli integrations on this machine.

That default is only seeded when you have expressed no provider preference. If you
ever signed in to Jolli from the CLI or an IDE integration, or pinned `aiProvider`
explicitly, that choice is respected here too, so you will need whichever credential
it implies.

If generation reports an authentication failure, sign the CLI in again:

```text
cursor-agent login
```

> **Prefer your own model API key?** Setting a provider key alone is not enough once
> `local-agent` has been seeded, because the provider choice is resolved before any
> key is consulted. Switch deliberately instead:
> `"$HOME/.jolli/jollimemory/run-cli" configure --set aiProvider=anthropic --set apiKey=sk-ant-...`
> (plain `jolli configure …` if you also have the CLI installed globally). You need
> neither this nor a Jolli login for generation to work.

## Sign in (optional, for sharing to a Jolli Space)

Signing in is about **sharing** memories to a Jolli Space, so teammates and your
other devices can recall them. It is not required to generate them.

```text
/jolli-login
```

This opens your browser and, on success, saves a Jolli API Key. Run `/jolli-logout`
to sign out. **`/jolli-init`** does all of it in one pass: it signs you in if needed,
enables the repository, and binds it to a Space.

Until you do, memories stay on your machine: they live in your own repository (a git
orphan branch) and in your local Memory Bank folder. Nothing reaches a Jolli Space
unless you sign in and bind one.

## What you can invoke

- `/jolli` — state-aware front door.
- `/jolli-init` — setup and Space binding.
- `/jolli-login` / `/jolli-logout` — Jolli account credentials.
- `/jolli-status` — installation and generation health.
- `/jolli-dashboard` — open the local dashboard in your browser.
- `/jolli-recall` / `/jolli-search` / `/jolli-timeline` — read memory.
- `/jolli-push` — publish memories to a Space.
- `/jolli-local-run` / `/jolli-remote-run` — run Jolli workflows.

## Requirements

- **Node.js 22.13 or newer**, on your `PATH` or recorded by a supported Jolli IDE
  integration — the MCP server and every hook run under it. The plugin bundles its
  own runtime code, but not Node itself. 22.13 is a hard floor rather than a
  recommendation: the bundled runtime uses `node:sqlite`, which throws on import
  below it unless Node is started with `--experimental-sqlite`, and the git-hook
  dispatchers are deliberately flag-free.
- The `cursor-agent` CLI, installed and signed in, for the default `local-agent`
  provider.

## Telemetry

Jolli Memory collects anonymous, content-free usage data — never your code, your
paths, or the contents of your memories — and it is **on by default**. Turn it off
by setting `DO_NOT_TRACK` to any non-empty value other than `0`, or by running
`"$HOME/.jolli/jollimemory/run-cli" telemetry off` (plain `jolli telemetry off` if
you also have the CLI installed globally). The `telemetry off` form is written to
the machine-global config, so it applies to every Jolli integration on this
machine. Exactly what is collected is listed at
[jolli.ai/telemetry](https://www.jolli.ai/telemetry) and in
[TELEMETRY.md](https://github.com/jolliai/jolliai/blob/main/TELEMETRY.md).

## Support and source

- Product: [jolli.ai](https://jolli.ai)
- Source, issues, and security policy:
  [github.com/jolliai/jolliai](https://github.com/jolliai/jolliai)

This repository is a generated release artifact — the plugin is built from the Jolli
monorepo, so file changes here are overwritten by the next release. Report problems
and send patches to the monorepo instead.

## License

Apache-2.0. See [LICENSE](LICENSE).
