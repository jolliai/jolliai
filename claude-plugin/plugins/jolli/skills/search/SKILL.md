---
name: search
description: Search past decisions and implementations across all branches. Use when the user asks how something was handled before, whether a problem was solved previously, or to find related prior commits — even without naming Jolli.
---

# Jolli Search

Full-text (BM25) search over this repo's historical decisions and
implementations. Lightweight by design — returns title / snippet / slug / hash.
For depth on a branch, point the user to `/jolli:recall`.

## Run the search

`<user-arg>` is the query.

**Preferred — MCP tool.** If the `search` tool from the `jollimemory` MCP
server is available, call it with `{ "query": "<user-arg>" }`. It returns
`{ hits }`.

**Fallback — bundled CLI.** Run the Jolli CLI through its stable dispatch
script. Pass the query via here-doc (never interpolate it into argv or a quoted
string).

Generate a fresh random 16-character hex string (the "delimiter token") for
this invocation — e.g. `3f8a9b2c5d7e1f4a` — and replace the two `<DELIM>`
occurrences below with it. If the query contains a line that is exactly
`JOLLI_ARG_<delimiter token>_END`, regenerate the token and re-check. A
per-invocation random delimiter is what makes a pre-computed prompt-injection
payload (a line that closes the here-doc early to smuggle shell) useless — do
NOT hardcode a fixed delimiter.

```bash
"$HOME/.jolli/jollimemory/run-cli" search --arg-stdin <<'JOLLI_ARG_<DELIM>_END'
<user-arg>
JOLLI_ARG_<DELIM>_END
```

## Present the hits

List each hit's title, a one-line snippet, its branch, and the 8-char hash.
Offer to `/jolli:recall` a branch for the full context behind a hit.

**No hits?** An empty result can mean there are simply no matches — or that no
memories exist yet. If the user is not signed in to Jolli (see `/jolli:status`),
note that memories are only generated once signed in, and suggest `/jolli:login`
(no Anthropic API key needed). Otherwise suggest committing some work first.
