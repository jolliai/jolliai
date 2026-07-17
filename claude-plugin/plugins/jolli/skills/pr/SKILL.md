---
name: pr
description: Open or update a pull request for the current branch with a memory-rich description built from its commit history. Use when the user wants to create, open, or refresh a PR — even without naming Jolli.
---

# Jolli PR

Build a PR title + body from the current branch's Jolli commit memories, then
open or update the PR with `gh`.

## Step 1: Make sure memories are ready

Call the `queue_status` tool with `{ "wait": true }` so freshly-committed
summaries are included before building the description. Do not proceed while it
reports generation still in progress.

## Step 2: Build the description

Call the `get_pr_description` tool (defaults to the current branch, range
`base..HEAD`). It returns a title + memory-rich body with idempotent update
markers.

## Step 3: Open or update the PR

Detect whether the branch already has an open PR:

```bash
gh pr view --json number,url >/dev/null 2>&1 && echo EXISTS || echo NONE
```

Write the returned title and body to temp files with the **Write tool** (exact
bytes). Do NOT interpolate them into the shell command or pass them through
`echo`/`printf` — a backtick or `$(...)` in a PR body (ordinary in markdown
code spans) would otherwise be executed by the shell. Then pass the body via
`--body-file` and read the title through a command substitution (whose output
is never re-evaluated, so it is safe for `` ` `` / `$`):

```bash
# body -> /tmp/jolli-pr-body.md, title -> /tmp/jolli-pr-title.txt (via Write tool)
gh pr create --title "$(cat /tmp/jolli-pr-title.txt)" --body-file /tmp/jolli-pr-body.md   # NONE
gh pr edit   --title "$(cat /tmp/jolli-pr-title.txt)" --body-file /tmp/jolli-pr-body.md   # EXISTS
```

Show the user the resulting PR URL. Never invent commits or decisions — use
only what `get_pr_description` returned.
