---
name: init
description: "Set up Jolli Memory for the current repository in Codex: verify the plugin hook, enable memory generation through Codex, sign in to Jolli when sharing is requested, and bind the repo to a Jolli Space. Use for first-time setup, repair, enablement, or Space binding."
---

# Jolli Init

Complete the steps in order. Stop when a required step fails.

## 1. Inspect state

Call the Jolli Memory `status` tool. If unavailable, run `"$HOME/.jolli/jollimemory/run-cli" status`.
If the dispatcher is missing, ask the user to start a new Codex session, open
`/hooks`, trust the Jolli SessionStart hook, and retry.

## 2. Enable local memory generation

Run:

```bash
"$HOME/.jolli/jollimemory/run-cli" enable --repo-hooks-only --source-tag codex-plugin
```

This explicit setup records `codex` as the local-agent tool while preserving an
existing paid provider choice. It also registers the Jolli Memory MCP server for
Codex, which Codex picks up at the START of a session — so if the MCP tools were
missing in this session, they appear in the next one. If the command reports that
the repository is manually disabled, explain that an explicit full `jolli enable`
is required to clear the opt-out; do not silently override it.

## 3. Decide whether Jolli sign-in is needed

Local memory generation uses the user's Codex/ChatGPT login and needs no Jolli
account. Jolli sign-in is required to bind and share with a Space.

If the user only wants local memory, skip to Step 5. Otherwise, when status shows
neither a Jolli sign-in nor a Jolli API key, run and wait for:

```bash
"$HOME/.jolli/jollimemory/run-cli" auth login
```

The command opens the browser and waits for a loopback callback. Never ask for a
password, token, or callback URL.

## 4. Bind a Space

Call `list_spaces`. Match a Space named by the user by id, slug, or exact name.
Otherwise present the available Spaces and ask them to choose, offering the default
first when one exists. Call `bind_space` with the selected value. Treat
`already_bound` as success.

If the Space tools are unavailable, run `"$HOME/.jolli/jollimemory/run-cli" spaces --format json`,
present only the returned Spaces, then bind the selected id or slug with
`"$HOME/.jolli/jollimemory/run-cli" bind --space <id-or-slug> --format json`. Never put free-typed
user text directly into this command.

## 5. Verify and report

Call `status` again (or `"$HOME/.jolli/jollimemory/run-cli" status` when the tool is not registered yet).
Report:

- memory generation enabled or the exact remaining problem;
- summaries run through Codex when provider is `local-agent`;
- Jolli sign-in and bound Space when sharing was configured;
- a normal commit captures memory and `git push` publishes to the bound Space;
- when the MCP tools were unavailable this session, that they load on the next one.
