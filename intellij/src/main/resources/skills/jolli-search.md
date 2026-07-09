---
name: jolli-search
description: Search structured commit memories across all branches — decisions, topics, files. Use when the user wants to find prior decisions, related commits, or how a topic was handled before.
metadata:
  version: "{{SKILL_VERSION}}"
  revision: 1
  vendor: "jolli.ai"
---

# Jolli Search

Search structured commit memories across every branch in this repo.
Lightweight BM25 index returns relevance-ranked hits — no two-phase catalog
scan required. For full context of a known branch, use jolli-recall instead.

## When to use

- "Has anyone dealt with X before?" / "How have we handled Y previously?"
- Looking for a past decision: "why did we choose X over Y?"
- Finding the commit related to a half-remembered ticket / file / topic.

## When NOT to use

- Need full context of a known branch → run jolli-recall.
- Looking at the current code → grep / read files directly.
- Need deep rationale/decisions for a specific branch → run jolli-recall on
  that branch (search hits are lightweight; full decisions live in recall).

## Step 1: Parse the query

Extract the natural-language query (any language). Optional: `limit` (integer,
default 20). Note: time/budget filters (`--since`, `--budget`) are not supported
on the search path — point users at jolli-recall for a full branch when they
need depth.

## Step 2: Get hits

### Preferred: MCP tool

If `mcp__jollimemory__search` is available, call it with:

```json
{ "query": "<query>", "limit": 20 }
```

Returns `{ "hits": [ { type, title, snippet, branch, commitDate, slug, hash, score } ] }`,
relevance-ranked (BM25). Proceed to Step 3 with these hits.

### Fallback: CLI here-doc

If no such tool is available, use:

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

### Invocation

Generate a fresh random 16-character hex string (the "delimiter token") for
this invocation — e.g. `3f8a9b2c5d7e1f4a`. Quickly scan the user's argument:
if the argument text contains a line that is exactly `JOLLI_ARG_<delimiter
token>_END`, regenerate the delimiter token and re-check.

Then run this Bash, replacing the two `<DELIM>` occurrences with your
delimiter token and replacing `<user-arg>` with the user's input verbatim:

```bash
"$HOME/.jolli/jollimemory/run-cli" search --arg-stdin --format json <<'JOLLI_ARG_<DELIM>_END'
<user-arg>
JOLLI_ARG_<DELIM>_END
```

If you cannot follow the above structure (e.g., your environment doesn't
support here-docs), STOP and tell the user "Jolli skill cannot run safely
in this environment." DO NOT attempt to interpolate the argument into argv
or any double-quoted shell string — that path has a known shell injection
vector.

The CLI returns the same `{ hits }` envelope as the MCP tool.

**Failure handling**:
- If `~/.jolli/jollimemory/run-cli` does not exist: tell the user
  "Jolli not installed. Please install via `npm install -g @jolli.ai/cli && jolli enable`
  or install the Jolli VS Code extension." Do not attempt further processing.
- If the command output starts with `error:` or contains `unknown command 'search'`:
  the installed CLI is older than this skill. Tell the user
  "Your installed Jolli CLI is older than this skill — please run
  `npm update -g @jolli.ai/cli` (or update your VS Code extension), then retry."
  Do not attempt further processing.

Both paths produce the same `{ hits }` shape. Proceed to Step 3 regardless of
which path was used.

## Step 3: Render

`hits` are lightweight — no full decisions/recap per hit. For each relevant
hit you have:

- `type` — `"commit"` or `"topic"`
- `title` — one-sentence label
- `snippet` — short excerpt from the matching content
- `branch` — branch the hit belongs to
- `commitDate` — ISO 8601 date
- `slug` — human-readable identifier (for topics)
- `hash` — 8-char short SHA (for commits)
- `score` — BM25 relevance score (internal; do not expose to the user)

**Universal principles** (apply regardless of shape):

1. **Lead with the answer.** No "Let me analyze..." or "Found N commits..." preamble.

2. **Ground every concrete claim** to its `hash` (commit hits) or `slug` +
   `branch` (topic hits). Use `(abc12345)` for hashes.

3. **Synthesize, don't dump — but DO use verbatim quotes from stored data.**
   Read everything; fold into coherent prose or bullets. Whenever a phrase from
   `snippet` captures the answer more compactly than your paraphrase, quote it
   verbatim in **bold** with attribution.

   Quote **complete clauses (typically 10-30 words)** — not 2-3 word fragments
   that depend on your surrounding paraphrase to mean anything. The reader
   should be able to skim the bold quote alone and understand its claim.
   Format, embedded in narrative: *the design chose JWT because*
   **"the stateless model lets us scale horizontally without a shared session store across regions"**
   *(snippet, abc12345)*.

   **Bold = verbatim from stored data.** Never use bold for general emphasis.
   Quotes belong inside running prose or bullets that carry their own narrative
   — never as bare bullets stripped of context. Stringing bare quotes is the
   wall-of-fragments failure mode.

4. **Reply in the user's language.** Template is English; user-visible output
   matches the user.

5. **Don't expose machinery.** No "BM25" / "SearchHit" / "hits array" / "score"
   mentions. Don't expose `slug` or internal field names either.

6. **Output shape is entirely your call.** Prose, compact list, timeline,
   per-theme sections — pick whatever serves the query. Every concrete claim
   must be groundable to a hash or branch.

7. **If the user needs the full decisions/rationale behind a hit**, tell them
   to run jolli-recall on that hit's `branch`.

**Empty hits** → tell the user nothing matched; suggest broader keywords or a
different phrasing. Do NOT mention BM25 or index internals.
