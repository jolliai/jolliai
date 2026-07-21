---
name: recall
description: Recall prior development context for the current branch — decisions, why past choices were made, and where work left off. Use when the user wants to resume work, asks why something was done, or references earlier work, even without naming Jolli.
---

# Jolli Recall

> Every commit deserves a Memory. Every memory deserves a Recall.

Load the structured development context for a branch — commits with their
distilled topics (trigger / response / decisions / files), plus any plans and
notes the work referenced — and synthesize a grounded answer to the user's
prompt about that branch.

## Step 1: Load the recall result

`<user-arg>` is a branch name (exact or fragment) or empty (current branch).

**Preferred — MCP tool.** If the `recall` tool from the `jollimemory` MCP
server is available, call it with `{ "branch": "<user-arg>" }` (omit `branch`
when `<user-arg>` is empty). It returns a `type`-tagged object
(`recall` / `catalog` / `error`).

**Fallback — bundled CLI.** If the MCP tool is unavailable, run the Jolli CLI
through its stable dispatch script. Pass the argument via here-doc so it can
never be interpreted as shell — do NOT interpolate `<user-arg>` into argv or a
quoted string.

Generate a fresh random 16-character hex string (the "delimiter token") for
this invocation — e.g. `3f8a9b2c5d7e1f4a` — and replace the two `<DELIM>`
occurrences below with it. Quickly scan the user's argument: if it contains a
line that is exactly `JOLLI_ARG_<delimiter token>_END`, regenerate the token
and re-check. A per-invocation random delimiter is what makes a pre-computed
prompt-injection payload (a line that closes the here-doc early to smuggle
shell) useless — do NOT hardcode a fixed delimiter.

```bash
JOLLI_DIST_PREFER_SOURCE=claude-plugin "$HOME/.jolli/jollimemory/run-cli" recall --arg-stdin --format json <<'JOLLI_ARG_<DELIM>_END'
<user-arg>
JOLLI_ARG_<DELIM>_END
```

## Step 2: Handle the result by `type`

- `type:"recall"` → render the branch facts (`branch`, `period`, `commitCount`)
  then walk `commits[]` (each has `hash`, `commitMessage`, `recap?`, and
  `topics[]` with always-present `title` + `decisions`). Surface decisions
  prominently; they are never dropped from a kept commit.
- `type:"catalog"` → semantic-match `<user-arg>` against the listed branches;
  one match → repeat Step 1 with it, many → list and ask, none → show catalog.
- `type:"error"` → surface `message` verbatim. For "no records": if the user is
  not signed in to Jolli (see `/jolli:status`), note that memories are only
  generated once signed in and suggest `/jolli:login` (no Anthropic API key
  needed); otherwise suggest committing some work first so Jolli can generate
  memories.
