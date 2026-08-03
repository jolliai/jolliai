# Jolli Memory for Codex

Jolli Memory captures development context from git commits and makes prior
decisions, unfinished work, and branch history recallable in Codex.

## What the plugin includes

- Eleven skills covering setup, login/logout, status, recall, search, decision
  timelines, Space publishing, and local/remote workflow runs.
- The complete Jolli Memory MCP tool set, registered with Codex by the bootstrap
  below and available from your second session onward.
- A SessionStart bootstrap that installs the repository's git hooks, registers the
  MCP server, sets Codex as the default local summarization agent when none is
  configured yet, and injects a branch briefing.
- A self-contained runtime; a global `jolli` CLI installation is not required.

## Install from a marketplace

Add the marketplace and install the plugin:

```text
codex plugin marketplace add <marketplace-source>
codex plugin add jolli@jolli-marketplace
```

Start a new Codex session after installation.

## Trust the SessionStart hook

Codex requires every new or changed non-managed command hook to be reviewed
before it runs. Open `/hooks`, review the Jolli SessionStart hook, and trust it.
Then start a new session.

Until the hook is trusted, the bundled skills still appear but cannot do anything:
git-hook installation, MCP registration, provider setup, and the branch briefing
all run from the bootstrap, and so does the `~/.jolli/jollimemory/run-cli`
dispatcher the skills use as their fallback. With neither the MCP tools nor the
dispatcher present, every skill — `$jolli:init` included — can only tell you to
trust the hook and start a new session.

From the first trusted session onward the dispatcher exists, so the skills' CLI
fallback works immediately. The MCP tools arrive one session later: Codex reads
its MCP registrations at session start, and the registration is written by the
bootstrap of the session that is already running.

## First-time setup

Invoke `$jolli:init`. It:

1. checks the current repository state;
2. enables memory capture, records Codex as the local summarization agent, and
   registers the Jolli Memory MCP server (its tools load in your next session);
3. optionally signs in to Jolli in the browser;
4. binds the repository to a Jolli Space for team sharing.

Memory generation uses the local Codex/ChatGPT login by default and does not
require a Jolli account or API key. Jolli sign-in is required only for Space
binding and sharing.

If local generation reports an authentication failure, run:

```text
codex login
```

## Main skills

- `$jolli` — state-aware front door.
- `$jolli:init` — setup and Space binding.
- `$jolli:login` / `$jolli:logout` — Jolli account credentials.
- `$jolli:status` — installation and generation health.
- `$jolli:recall` / `$jolli:search` / `$jolli:timeline` — read memory.
- `$jolli:push` — publish memories to a Space.
- `$jolli:local-run` / `$jolli:remote-run` — run Jolli workflows.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for architecture, build prerequisites,
local acceptance testing, publishing, versioning, and the release checklist.

From the monorepo root:

```bash
npm run build:codex-plugin
bash codex-plugin/scripts/publish-local.sh
```

Reinstall the local plugin after publishing because Codex caches plugin
versions under `~/.codex/plugins/cache/`.

## Requirements

- Node.js must be available on `PATH`, or recorded by a supported Jolli IDE
  integration.
- Codex must be installed and signed in for the default local-agent provider.

Apache-2.0.
