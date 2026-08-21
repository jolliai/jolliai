---
name: jolli-remote-run
description: Run a Jolli workflow remotely — the Jolli backend executes the workflow server-side; this recipe triggers the run, monitors it to completion, reports the outcome (failed / cancelled / succeeded) with its article, PR, and workflow links, and offers to open any in your browser. Use when the user wants to run a Jolli workflow remotely (on the Jolli backend).
---

# Jolli Remote Run

Run a Jolli **workflow** remotely: the Jolli backend executes the workflow
server-side (it spends Jolli LLM budget, unlike a local run), and this recipe
triggers the run, monitors it to a terminal state, and reports what it produced —
the still-active article URLs, the pull-request URL when the destination is
git-backed, and the workflow/run deep-links — then offers to open any of them.

Drive the steps below in order. Prefer the Jolli MCP tools for the run lifecycle —
the run tools (`run_remote_workflow`, `cancel_remote_workflow`) have **no CLI
mirror** — and shell the `jolli` CLI (via the run-cli entry script the sibling
skills also use) only for the deterministic monitor and the browser-open helper.

Every URL is read **verbatim** off the run report — never construct, guess, or
look one up. A link that is not in the report was withheld on purpose (for
example, a private Jolli-managed destination omits the PR link but keeps the
article URLs); treat its absence as normal, never an error.

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

## Step 1 — identify the workflow to run

Determine which workflow the user wants to run and keep its numeric `id`.

- If the `list_workflows` tool is registered this session (on Claude Code
  `mcp__jollimemory__list_workflows`), call it to list the available workflows and
  present them to the user by `name` (use your host's interactive single-select
  tool if it has one — e.g. AskUserQuestion on Claude Code — otherwise list them as
  text). Keep the chosen workflow's `id`.
- Otherwise, ask the user which workflow to run and get its numeric `id`.

## Step 2 — confirm the run monitor is installed (before triggering)

The run trigger (`run_remote_workflow`) is a Jolli **backend** tool: it creates a
real, budget-spending run **even when the deterministic monitor is not installed**.
The monitor (`workflow run-status`, Step 4) is provided by the
`@jolli.ai/workflow-cli` plugin. So confirm that plugin is present **before**
triggering — otherwise a missing monitor would leave the run you are about to
create orphaned (still running server-side, with no way for this recipe to report
its outcome).

Run the plugin's eligibility helper purely as a presence probe and read its JSON:

```bash
JOLLI_INVOKED_VIA=skill:remote-run "$HOME/.jolli/jollimemory/run-cli" workflow local-run
```

- `{ "type": "workflow_cli_required", "installHint": "..." }` — the workflow-cli
  plugin is **not installed**. Do **not** trigger the run. Tell the user to install
  it (run the `installHint`) and stop:

  ```bash
  npm i -g @jolli.ai/cli @jolli.ai/workflow-cli
  ```

- **any other result** (`workflows`, `space_cli_required`, or `error`) — the plugin
  **is** installed (only its stub ever emits `workflow_cli_required`), so the monitor
  is available. Ignore the rest of this probe's output — it reports *local*-run
  eligibility, which does not gate a remote run — and proceed to Step 3.

## Step 3 — trigger the remote run

Call the `run_remote_workflow` tool (on Claude Code
`mcp__jollimemory__run_remote_workflow`) with the chosen workflow's id, passed as
an **unquoted number**: `{ "id": <workflow id> }` (add `templateVariables` only if
the workflow needs them). Capture `runId` from its result (`{ "runId": "..." }`) —
that handle drives the monitor in Step 4.

## Step 4 — monitor the run to completion

Shell the deterministic monitor with the captured `runId`:

```bash
JOLLI_INVOKED_VIA=skill:remote-run "$HOME/.jolli/jollimemory/run-cli" workflow run-status <runId>
```

It polls the run to a terminal state (with backoff, so you do not drive the poll
loop yourself) and prints exactly one JSON line — the run report. Parse it:

- `status` — one of `"succeeded"`, `"failed"`, `"cancelled"`, `"running"`.
- `openableUrls` — an array of `{ "kind": "workflow" | "run" | "article" | "pr", "url": "...", "label": "..." }`.
  Only openable URLs appear here (active articles with a non-null url, a PR only
  when the payload carried one) — present exactly these, nothing more.
- `cancel` (cancelled runs) — `{ "by": "...", "at": "..." }` when known.
- `troubleshooting` (failed runs) — the actionable error detail.
- `timedOut` — `true` when the monitor stopped polling before the run reached a
  terminal state (see the "still running" case below).

If the command instead prints `{ "type": "error", "message": "..." }` (the run
could not be reached — platform tools off, or a transport failure), tell the user
the run status could not be retrieved and stop. That is a degraded outcome, not a
crash — the run may still be progressing server-side.

If instead the command exits non-zero and prints a prose install hint naming
`@jolli.ai/workflow-cli` (rather than a JSON report line), the workflow-cli plugin
is not installed. Tell the user to install it and stop:

```bash
npm i -g @jolli.ai/cli @jolli.ai/workflow-cli
```

## Step 5 — report the outcome

Report based on `status`:

- **succeeded** (`status: "succeeded"`): the run finished. Present the `article`
  URLs from `openableUrls` (each by its `label`), the `pr` URL if one is present,
  and the `workflow` and `run` deep-links. Never surface a link that is not in
  `openableUrls` — a missing PR link means the destination withheld it (a private
  Jolli-managed destination), which is normal.
- **failed** (`status: "failed"`): the run failed. Present the `troubleshooting`
  detail (the actionable error) and the `workflow` URL.
- **cancelled** (`status: "cancelled"`): the run was cancelled. Report who
  (`cancel.by`) and when (`cancel.at`) when present, plus the `workflow` URL.
- **still running** (`status: "running"` with `timedOut: true`): the monitor
  stopped polling before the run reached a terminal state — the run is **still
  running server-side**, not failed. Tell the user it is still in progress, present
  the `workflow` URL so they can watch it, and note they can re-check later by
  re-running `workflow run-status <runId>`.

## Step 6 — offer to open any reported URL

Offer to open any URL from the report in the user's default browser. For each URL
the user chooses, shell:

```bash
JOLLI_INVOKED_VIA=skill:remote-run "$HOME/.jolli/jollimemory/run-cli" open-url <url>
```

It prints one JSON line `{ "opened": true|false, "url": "..." }`. When `opened` is
`false` (headless / no browser available) the URL is printed for the user to copy
instead — that is normal, not a failure. Only `https` URLs are accepted. A URL whose
origin is off Jolli's allowlist is refused (never launched) and printed instead — the
result carries `"refused": true`; surface that URL for the user to open manually, not
as an error.

## Cancelling an in-flight run

While a remote run is still in progress, the user can stop it: call
`cancel_remote_workflow` (on Claude Code
`mcp__jollimemory__cancel_remote_workflow`) with the workflow's numeric id —
`{ "id": <workflow id> }`. After cancelling, re-run `workflow run-status <runId>`
to report the cancelled outcome (who/when + workflow URL).

## If the Jolli CLI dispatcher is missing (Cursor)

`$HOME/.jolli/jollimemory/run-cli` is written by this plugin's `sessionStart` hook,
and a freshly installed plugin's hooks are not registered until Cursor has been fully
restarted — a window reload or another chat is not enough (measured). So when that file
does not exist, the fix is to **quit Cursor completely (⌘Q) and reopen it, then start
a new chat**, and retry.

This REPLACES any instruction above to report Jolli as not installed, or to install
`@jolli.ai/cli` globally or the Jolli VS Code extension. You are running inside the
Jolli plugin, so Jolli IS installed, and neither of those is the fix on this host.
