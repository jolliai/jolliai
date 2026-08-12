---
name: jolli-local-run
description: Run a Jolli workflow locally — your own agent executes the workflow's recipe (no Jolli LLM budget) and its file writes land in a git-backed Jolli Space via a branch and pull request that space-cli opens on this machine. Use when the user wants to run a Jolli workflow locally.
metadata:
  version: "dev"
  revision: 5
  vendor: "jolli.ai"
---

# Jolli Local Run

Run a Jolli **workflow** locally: *your* agent executes the workflow's recipe on
this machine (so it spends no Jolli LLM budget), Jolli supplies the recipe and
tracks the run, and the workflow's file writes are published to a git-backed
Jolli Space through an agent branch + pull request that space-cli commits and
pushes locally.

A workflow can be run locally only when its destination Space is **git-backed**
AND already **cloned** on this machine. Before starting, the user is told whether
the resulting PR will **auto-merge** or **open for team review**.

Drive the steps below in order. Prefer the Jolli MCP tools for the run lifecycle;
the eligibility check and the git operations go through the `jolli` CLI (via the
run-cli entry script the sibling skills also use).

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

## Step 1 — discover the runnable workflows

Run the eligibility helper and read its JSON:

```bash
"$HOME/.jolli/jollimemory/run-cli" workflow local-run
```

- `{ "type": "workflows", "workflows": [ { "id": 7, "name": "Impact Analysis", "autoMerges": true|false }, ... ] }`
  — the workflows runnable right now. **Offer only these.** Present each one to
  the user by its `name` (fall back to the `id` when `name` is absent), and tell
  them up front whether it will **auto-merge** the PR (`autoMerges: true`) or
  **open the PR for team review** (`autoMerges: false`). If the array is empty,
  tell the user there are no locally-runnable workflows (a workflow's destination
  must be a git-backed, already-cloned Space) and stop.
- `{ "type": "workflow_cli_required", "installHint": "..." }` — the workflow-cli
  plugin is missing. Tell the user to install it (run the `installHint`) and stop:

  ```bash
  npm i -g @jolli.ai/cli @jolli.ai/workflow-cli
  ```

- `{ "type": "space_cli_required", ... }` — the space-cli plugin is missing. Tell
  the user to install it and stop:

  ```bash
  npm i -g @jolli.ai/cli @jolli.ai/space-cli
  ```

- `{ "type": "error", "message": "..." }` — report the message and stop.

Have the user pick one workflow — list them by `name` (use your host's
interactive single-select tool if it has one — e.g. AskUserQuestion on Claude
Code — otherwise list them as text). Keep the chosen workflow's `id` for Step 2.

## Step 2 — start the run

Call the `start_local_run` tool (on Claude Code
`mcp__jollimemory__start_local_run`) with the chosen workflow's id, passed
**exactly as the helper returned it** — the backend's id is a number, so it stays
an unquoted number: `{ "id": <workflow id> }` (a string id/slug stays quoted).
Capture from its result:

- `runId` — the run handle for every later call.
- `plan` — the recipe steps your agent will execute.
- `writeTarget` — carries the server-derived `workBranch`, the destination Space,
  and the destination folder. Refer to the destination in user-facing prose by its
  **Space name / folder** only. Do **not** announce a backing repo `owner/name`, and
  do **not** present the `workBranch` as "the write target" — those are internal
  plumbing, not the destination's identity. The `workBranch` is passed verbatim to
  `docs pull --branch` in Step 3, but keep it framed as an internal detail. Do not
  inspect the clone's git remotes to name the destination. `writeTarget.repo` may be
  **empty** for a private Jolli-managed destination — that is normal, never an error,
  and never something to look up or narrate.

## Step 3 — check out the agent branch

Pull the destination clone onto the server-derived work branch:

```bash
"$HOME/.jolli/jollimemory/run-cli" docs pull --branch <writeTarget.workBranch>
```

**Always `--branch`. NEVER `--agent`.** The `--agent` mode runs a destructive
`git clean -fdx` that wipes untracked files; `--branch` checks out the
server-derived branch without cleaning. Do not substitute `--agent` under any
circumstances. `docs pull` fetches the destination write token internally — you
do **not** fetch or handle any token yourself.

## Step 4 — write the workflow's output

Execute the workflow's `plan` from Step 2, writing the output files under the
destination folder from `writeTarget`, inside the checked-out clone.

## Step 5 — local review gate (with heartbeats)

Nothing is committed or pushed until the human explicitly approves.

1. Send a heartbeat so the run's lease stays alive while the human reviews: call
   `report_local_run_progress` (on Claude Code
   `mcp__jollimemory__report_local_run_progress`) with `{ "runId": "<runId>" }`.
2. Show the working-tree diff of what the workflow wrote, and ask the user to
   review, edit if needed, and **explicitly approve** (or cancel).
3. When the user answers, send `report_local_run_progress` again.

Send the heartbeat **immediately before** asking and **immediately after** the
answer. Your turn is blocked while you wait for the human, so you cannot
heartbeat *during* the review — bracketing the approval prompt keeps the lease
fresh across the wait.

## Step 6 — on approval: publish and complete

1. Publish the branch as a pull request and capture the machine-readable result:

   ```bash
   "$HOME/.jolli/jollimemory/run-cli" docs publish --json
   ```

   `--json` prints exactly one JSON object on stdout (all human-readable progress
   goes to stderr) — parse that object; never scrape the human log for a PR number.
2. Verify the pull request landed on the server-derived work branch. `docs publish`
   reports the branch the PR was actually opened on as `headBranch` (present on both
   the public and the private/withheld paths); the run's server work branch is
   `writeTarget.workBranch` from Step 2. **When `pushed` is true, cross-check them
   deterministically** — do not eyeball it yourself:

   ```bash
   "$HOME/.jolli/jollimemory/run-cli" space verify-publish-branch <writeTarget.workBranch> <headBranch>
   ```

   It prints `{ "match": true|false, "expected": "...", "actual": "..." }` and exits
   non-zero when the branches differ or `headBranch` is missing. **If `match` is
   false, STOP** — the PR was opened on the wrong branch (usually because `docs pull
   --branch <workBranch>` in Step 3 was skipped, so space-cli generated its own
   `jolli-<hex>` branch). The backend cannot link the run to that PR, so it will
   **not** auto-merge and the articles will **never** publish. Tell the user the
   run-to-PR link is broken (published on `<actual>` instead of the expected
   `<expected>`) and **do NOT call `complete_local_run` as if the run succeeded** —
   release the run with `abandon_local_run` (Step 7) or ask the user how to proceed.
   Skip this check only when `pushed` is false (nothing was published).
3. Call `complete_local_run` (on Claude Code
   `mcp__jollimemory__complete_local_run`), branching on what the publish JSON
   contained:
   - **PR refs present** (the JSON has a `prNumber` — a user-accessible
     destination): pass them through —
     `{ "runId": "<runId>", "prNumber": <prNumber>, "prUrl": "<prUrl>" }`.
   - **PR refs withheld** (the JSON is `"private": true` with no `prNumber` — a
     private Jolli-managed destination whose backing repo the user cannot access):
     complete WITHOUT a PR reference — `{ "runId": "<runId>" }`. Do not invent,
     guess, or look up a `prNumber`; the run already knows its destination is private.
   - **Nothing published** (`"pushed": false`, e.g. `"reason": "no-changes"`): no PR
     was opened, so there is nothing to complete — tell the user the workflow produced
     no changes and release the run with `abandon_local_run` (Step 7).
4. Read the outcome and its links off `complete_local_run`'s result and report them.
   Every URL is read **verbatim** off the result — never construct, guess, or look up
   one. The result carries `willAutoMerge`, `workflowUrl`, `runUrl`, and (auto-apply
   ON only) a `writtenArticles` list of `{ operation, path, url, active, ... }`.
   - **Auto-apply on** (`willAutoMerge: true`): the destination auto-applies, so the PR
     is **set to auto-merge** and — once it does — the created/edited **articles are the
     artifact**. Treat `willAutoMerge: true` as the destination's *intent*, NOT a
     confirmation that the merge already completed — so do **not** flatly tell the user
     "PR auto-merged". Report what actually published, judged by each article's own state:
     for every `writtenArticles` entry that is still openable (`active: true` **and** a
     non-null `url`), present its URL as a published article. If an article is
     `active: false` or has `url: null`, publishing has **not** completed yet (the
     auto-merge and reindex may still be in progress) — tell the user that article is
     **not yet available**, never invent a URL, and note they can re-check shortly via the
     run URL or by re-running `workflow run-status <runId>`. Then present the workflow URL
     (`workflowUrl`) and the run URL (`runUrl`).
   - **PR left open for team review** (`willAutoMerge: false` — auto-apply off): the
     open **PR is the artifact**. Tell the user "PR left open for team review" and
     present the PR URL (`prUrl`), the workflow URL (`workflowUrl`), and the run URL
     (`runUrl`).
   - **Private Jolli-managed destination** (the result carries no `prUrl`): present the
     **article URLs only** (same `active: true` + non-null `url` rule) plus the workflow
     URL and run URL — never surface a repo or PR link the result did not carry. As with
     any auto-apply run, an article that is not yet `active` / lacks a `url` is **not yet
     available** (publishing still completing), not an error — say it will appear once
     published and offer the run URL to re-check.
5. Offer to open any reported URL in the user's default browser. For each URL the user
   chooses, shell:

   ```bash
   "$HOME/.jolli/jollimemory/run-cli" open-url <url>
   ```

   It prints one JSON line `{ "opened": true|false, "url": "..." }`. When `opened` is
   `false` (headless / no browser available) the URL is printed for the user to copy
   instead — that is normal, not a failure. Only `https` URLs are accepted. A URL
   whose origin is off Jolli's allowlist is refused (never launched) and printed
   instead — the result carries `"refused": true`; surface that URL for the user to
   open manually, not as an error.

## Step 7 — on cancel: abandon

If the user cancels at the review gate (or you must abort), release the run: call
`abandon_local_run` (on Claude Code `mcp__jollimemory__abandon_local_run`) with
`{ "runId": "<runId>" }`.

## If space-cli is missing at any point

Any `docs` command that prints an install hint (or the eligibility helper's
`space_cli_required` result) means the space-cli plugin is not installed. Tell the
user to install it and stop:

```bash
npm i -g @jolli.ai/cli @jolli.ai/space-cli
```
