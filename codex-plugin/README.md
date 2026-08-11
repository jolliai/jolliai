# Jolli Memory for Codex

Jolli Memory builds a durable memory of your work from your git commits, and makes
prior decisions, unfinished work, and branch history recallable — right inside
Codex.

## What the plugin includes

- **Skills** — eleven `$jolli:*` entry points covering setup, sign-in, status,
  recall, search, decision timelines, Space publishing, and local/remote workflow
  runs, plus a bare `$jolli` front door that ships in the bundle.
- **MCP tools** — `recall`, `search`, `get_decision_timeline`, `list_branches`,
  `get_pr_description`, `queue_status`, `status`, plus the Jolli Space tools. The
  bootstrap registers them with Codex, so they load from your **second** session
  onward.
- **Hooks** — one `SessionStart` bootstrap that installs Jolli's git hooks into the
  active repository (idempotent), registers the MCP server, records Codex as the
  local summarization agent when no provider is configured yet, and injects a branch
  briefing. Those git hooks are what generate the memory everything else surfaces.
- **A self-contained runtime** — no global `jolli` CLI installation required.

## Install

```text
codex plugin marketplace add <marketplace-source>
codex plugin add jolli@jolli-marketplace
```

The marketplace's own manifest names it `jolli-marketplace`, which is why the
install target is `jolli@jolli-marketplace`. Start a new Codex session after
installing.

## Trust the Jolli hook

Codex will not run a new or changed non-managed command hook until you review it.
Trust is recorded per hook entry — keyed by the hook file and the event type — so it
is not one global switch: a plugin upgrade puts the hook under a new version-stamped
path and Codex asks again. Jolli registers exactly one hook, a `SessionStart`
bootstrap. Open `/hooks`, review it, trust it, then start a new session.

Until it is trusted the bundled skills still appear but cannot do anything: git-hook
installation, MCP registration, provider setup, and the branch briefing all run from
the bootstrap, and so does the `~/.jolli/jollimemory/run-cli` dispatcher the skills
use as their fallback. With neither the MCP tools nor the dispatcher present, every
skill — `$jolli:init` included — can only tell you to trust the hook and start a new
session.

From the first trusted session onward the dispatcher exists, so the skills' CLI
fallback works immediately. The MCP tools arrive one session later: Codex reads its
MCP registrations at session start, and the registration is written by the bootstrap
of the session that is already running.

## First-time setup

Start with **`$jolli`**. It reads how Jolli is set up in this repository and, on a
fresh repo, leads with setup — routing into `$jolli:init`, which:

1. checks the current repository state;
2. enables memory capture, records Codex as the local summarization agent, and
   registers the Jolli Memory MCP server (its tools load in your next session);
3. optionally signs you in to Jolli in the browser;
4. binds the repository to a Jolli Space for team sharing.

`$jolli` stays the entry point afterwards: once setup is complete it shows a status
snapshot and routes you to recall, search, a PR description, or a Space. Invoke
`$jolli:init` directly when you want to re-run setup or change the bound Space.

## Memory generation works out of the box

**You do not need to sign in, and you do not need an API key.** On its first session
the plugin writes `local-agent` as the provider into the machine-global config
(`~/.jolli/jollimemory/config.json`) and drives your already-signed-in `codex` CLI to
write the memories. Commit as usual and the summaries appear. Because that config is
shared, the choice also becomes the default for the Jolli CLI and the other Jolli
integrations on this machine.

That default is only seeded when you have expressed no provider preference. If you
ever signed in to Jolli from the CLI or an IDE integration, or pinned `aiProvider`
explicitly, that choice is respected here too, so you will need whichever credential
it implies.

If generation reports an authentication failure, sign the CLI in again:

```text
codex login
```

That login is **separate** from the ChatGPT app — the app stays signed in on its
own, so "authentication expired" can be true here while the app looks fine.

> **Prefer your own model API key?** Setting a provider key alone is not enough once
> `local-agent` has been seeded, because the provider choice is resolved before any
> key is consulted. Switch deliberately instead:
> `jolli configure --set aiProvider=anthropic --set apiKey=sk-ant-...`. You need
> neither this nor a Jolli login for generation to work.

## Sign in (optional, for sharing to a Jolli Space)

Signing in is about **sharing** memories to a Jolli Space, so teammates and your
other devices can recall them. It is not required to generate them.

```text
$jolli:login
```

This opens your browser and, on success, saves a Jolli API Key. Run `$jolli:logout`
to sign out. **`$jolli:init`** does all of it in one pass: it signs you in if
needed, enables the repository, and binds it to a Space — and `$jolli` routes there
on its own whenever setup is incomplete.

## What you can invoke

- `$jolli` — state-aware front door.
- `$jolli:init` — setup and Space binding.
- `$jolli:login` / `$jolli:logout` — Jolli account credentials.
- `$jolli:status` — installation and generation health.
- `$jolli:recall` / `$jolli:search` / `$jolli:timeline` — read memory.
- `$jolli:push` — publish memories to a Space.
- `$jolli:local-run` / `$jolli:remote-run` — run Jolli workflows.

## Requirements

- **Node.js 22.13 or newer**, on your `PATH` or recorded by a supported Jolli IDE
  integration — the MCP server and every hook run under it. The plugin bundles its
  own runtime code, but not Node itself. 22.13 is a hard floor rather than a
  recommendation: the bundled runtime uses `node:sqlite`, which throws on import
  below it unless Node is started with `--experimental-sqlite`, and the git-hook
  dispatchers are deliberately flag-free.
- Codex must be installed and signed in for the default `local-agent` provider.

## Telemetry

Jolli Memory collects anonymous, content-free usage data — never your code, your
paths, or the contents of your memories — and it is **on by default**. Turn it off
with `jolli telemetry off`, or by setting `DO_NOT_TRACK` to any non-empty value
other than `0`. Exactly what is collected is listed at
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
