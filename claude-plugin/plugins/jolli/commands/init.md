---
description: Set up Jolli for this project — sign in if needed, enable memory generation, and bind the repo to a Jolli Space. Use when the user wants to initialize / set up Jolli, or bind this repo to a Space.
argument-hint: "[space id|slug|name]"
---

# Jolli Init

One-shot setup for the current repository: make sure the user is signed in,
enable Jolli's memory generation for this repo, then bind the repo to a Jolli
**Space** so the branch's memories can be pushed and shared.

`$ARGUMENTS` is an OPTIONAL Space id, slug, or name to bind to. When present,
skip the interactive Space picker in Step 4 and bind to it directly.

Work through the steps in order. Stop and report if a step fails — later steps
depend on earlier ones.

## Step 1: Check current state

Call the `status` tool and read `account.signedIn`,
`account.jolliApiKeyConfigured`, and `account.anthropicKeyConfigured`. This tells
you whether Step 2 (sign-in) is needed.

If the `status` MCP tool is unavailable (an older Jolli), fall back to the
bundled CLI through its stable dispatch script and read its output:

```bash
JOLLI_DIST_PREFER_SOURCE=claude-plugin "$HOME/.jolli/jollimemory/run-cli" status
```

If `run-cli` does not exist, the plugin's session bootstrap has not run yet — ask
the user to fully restart the app (Cmd+Q) so the plugin installs itself, then
re-run `/jolli:init`.

## Step 2: Sign in (only if needed)

**Memory generation itself needs no sign-in** — the plugin defaults to the
`local-agent` provider, generating summaries through the user's local Claude
subscription. Signing in is required only to **bind and share a Space** (Step 4),
and Space binding authenticates with a **Jolli** credential specifically (a Jolli
sign-in or a Jolli API key); an Anthropic key does nothing for it. So run the
login flow now whenever Step 1 shows the user is **not** signed in AND has **no
Jolli API key** (`account.jolliApiKeyConfigured` is false) — regardless of whether
an Anthropic key is present, since an Anthropic key can't bind a Space. If they
already have a Jolli sign-in or a Jolli API key, skip this step. The login flow
opens the browser and waits on a loopback callback:

```bash
JOLLI_DIST_PREFER_SOURCE=claude-plugin "$HOME/.jolli/jollimemory/run-cli" auth login
```

This is interactive and can take up to a minute — wait for it to return, do not
background it. Never ask the user for passwords, tokens, or callback URLs. If it
fails, surface the reason and stop (the later steps need auth). If the user
already has a Jolli sign-in or a Jolli API key, skip this step.

## Step 3: Enable memory generation for this repo

Install Jolli's git hooks into the active repo (idempotent — safe to re-run; the
plugin's SessionStart also does this, so it is usually already done). The plugin's
SessionStart also seeds the AI provider to `local-agent` (local Claude
subscription) when the user has made no explicit choice, so generation works with
no API key. Silent on success:

```bash
JOLLI_DIST_PREFER_SOURCE=claude-plugin "$HOME/.jolli/jollimemory/run-cli" enable --repo-hooks-only --source-tag claude-plugin
```

## Step 4: Bind the repo to a Jolli Space

**Preferred — MCP tools.**

1. Call `list_spaces` to get the available `spaces` and `defaultSpaceId`.
2. Choose the target Space:
   - If `$ARGUMENTS` is non-empty, match it (id / slug / name) against the list.
   - Otherwise present the spaces and let the user pick — use an interactive
     single-select if your host provides one (for example AskUserQuestion in
     Claude Code); otherwise list them and ask. If the user has no preference and
     `defaultSpaceId` is set, offer that one.
3. Call `bind_space` with `{ "space": "<id|slug|name>" }` for the chosen Space.
   - If it reports the repo is **already bound**, say so and treat Step 4 as done
     (do not re-bind).

**Fallback — bundled CLI** (only if the MCP tools are unavailable). List with
`... run-cli spaces --format json`, then bind with the id/slug the user picked
from that list (never free-typed text):

```bash
JOLLI_DIST_PREFER_SOURCE=claude-plugin "$HOME/.jolli/jollimemory/run-cli" bind --space <id|slug> --format json
```

Handle the JSON `type`: `bound` → success; `already_bound` → already set up;
`error` → surface `message` (if it mentions auth, point back to Step 2).

## Step 5: Report and hand off

Summarize what happened: signed in (or already were), memory generation enabled
(running locally via the Claude subscription — no API key), and the Space now
bound (name + id). Then reassure the user they are all set:
from here on a normal **commit & `git push`** automatically publishes this
branch's memories to the bound Space for teammates — the pre-push hook does it,
nothing extra to run. They can recall prior context anytime with `/jolli:recall`.
