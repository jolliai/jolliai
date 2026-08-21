---
name: jolli-init
description: "Set up Jolli Memory for the current repository in Cursor: verify the plugin hook, enable memory generation through Cursor, sign in to Jolli when sharing is requested, and bind the repo to a Jolli Space. Use for first-time setup, repair, enablement, or Space binding."
---

# Jolli Init

Complete the steps in order. Stop when a required step fails.

### Shell prerequisite

This block requires a POSIX bash shell. On Linux/macOS the system bash works.
**On Windows, use Git Bash** (the bash bundled with Git for Windows). Other
Windows "bash" options — `C:\Windows\System32\bash.exe`, the WindowsApps
alias, or any WSL bash — see a separate Linux home directory and will not
find the Jolli entry script that lives under `%USERPROFILE%`.

If Git Bash is not available on Windows, STOP and tell the user:
"Jolli skill needs Git Bash on Windows. Install Git for Windows from
https://git-scm.com/download/win and retry."

Do NOT fall back to `npm run`, `npx`, `node` directly, PowerShell-native
commands, WSL bash, or any workspace-local script — those bypass the
security recipe and the dist resolver and will not produce valid output.

## 1. Inspect state

Call the Jolli Memory `status` tool. If unavailable, run `JOLLI_INVOKED_VIA=skill:init "$HOME/.jolli/jollimemory/run-cli" status`.

If `$HOME/.jolli/jollimemory/run-cli` does not exist, the plugin's `sessionStart`
hook has not run on this machine yet — that hook is what writes it. Ask the user to
**quit Cursor completely (⌘Q) and reopen it, then start a new chat**, and retry. A
freshly installed plugin's hooks are not registered until the app has been fully
restarted, so **Developer: Reload Window** or another chat is not enough (measured).

## 2. Enable local memory generation

Run:

```bash
JOLLI_INVOKED_VIA=skill:init "$HOME/.jolli/jollimemory/run-cli" enable --repo-hooks-only --source-tag cursor-plugin
```

This explicit setup records `cursor-agent` as the local-agent tool only when none
is configured yet — an agent tool and a paid provider already on disk are both left
exactly as they are. What it writes is this repository's git hooks and this
workspace's `.cursor/mcp.json`. It writes **no skills**: every Jolli skill ships
with the plugin, so there is nothing here to place or repair — do not report
skill files as an outcome of this step.

Cursor notices `.cursor/mcp.json` within a second — no reload needed —
but registers the server **disconnected**, so tell the user to open **Customize** in
the sidebar and enable `jollimemory` to get the MCP tools. Everything below works
without them either way. If the command reports that the repository is manually
disabled, explain that an explicit full `jolli enable` is required to clear the
opt-out; do not silently override it.

## 3. Decide whether Jolli sign-in is needed

Local memory generation uses the user's Cursor login and needs no Jolli account.
Jolli sign-in is required to bind and share with a Space.

If the user only wants local memory, skip to Step 5. Otherwise, when status shows
neither a Jolli sign-in nor a Jolli API key, run and wait for:

```bash
JOLLI_INVOKED_VIA=skill:init "$HOME/.jolli/jollimemory/run-cli" auth login
```

The command opens the browser and waits for a loopback callback. Never ask for a
password, token, or callback URL.

## 4. Bind a Space

Call `list_spaces`. Match a Space named by the user by id, slug, or exact name.
Otherwise present the available Spaces and ask them to choose, offering the default
first when one exists. Call `bind_space` with the selected value. Treat
`already_bound` as success.

If the Space tools are unavailable, run `JOLLI_INVOKED_VIA=skill:init "$HOME/.jolli/jollimemory/run-cli" spaces --format json`,
present only the returned Spaces, then bind the selected id or slug with
`JOLLI_INVOKED_VIA=skill:init "$HOME/.jolli/jollimemory/run-cli" bind --space <id-or-slug> --format json`. Never put free-typed
user text directly into this command.

## 5. Verify and report

Call `status` again (or `JOLLI_INVOKED_VIA=skill:init "$HOME/.jolli/jollimemory/run-cli" status` when the tool is not registered yet).
Report:

- memory generation enabled or the exact remaining problem;
- which agent generates summaries when provider is `local-agent` — name
  `localAgentTool` from `status` rather than assuming Cursor, since a tool that
  was already configured is left alone;
- Jolli sign-in and bound Space when sharing was configured;
- a normal commit captures memory and `git push` publishes to the bound Space;
- when the MCP tools were unavailable, that enabling `jollimemory` in **Customize**
  turns them on (a reload is not required).
