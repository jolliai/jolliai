---
name: jolli-memory-recall
description: Recall prior development context from Jolli Memory for the current branch
argument-hint: "[branch or keyword]"
user-invocable: true
jollimemory-version: 0.99.0
---

# Jolli Memory Context Recall

> Every commit deserves a Memory. Every memory deserves a Recall.

## Step 1: Load Context

Run this Bash command to load Jolli Memory context data:

```
node "$("$HOME/.jolli/jollimemory/resolve-dist-path")/Cli.js" recall ${ARGUMENTS} --budget 30000 --format json
```

If the file `~/.jolli/jollimemory/resolve-dist-path` does not exist, tell the user:
"Jolli Memory not installed. Please install via `npm install -g @jolli.ai/jollimemory && jollimemory enable` or install the Jolli Memory VS Code extension."
Do not attempt further processing.

## Step 2: Process the Result

The command output is JSON with a "type" field. Handle each case:

### type: "recall" — Full context loaded successfully
Generate the loading report:

**Part 1: Loading Confirmation & Statistics**
- Time span, commit count, file change statistics
- Total context size (tokens) and percentage of context window used
- Breakdown by content type: N topics (~X tokens), N plans (~Y tokens), N decisions (~Z tokens)

**Part 2: Understanding Summary**
In your own words, summarize what you understood:
- What this branch is implementing (one sentence)
- Key technical decisions and why they were made
- What was last worked on
- Main files involved

This section is critical for building user trust — the user needs to see that
you accurately understand the prior work.

**Part 3: Next Steps**
Ask: "What would you like to work on next?"

### type: "catalog" — Branch lookup needed
The CLI returned a catalog because no exact branch match was found.
If a "query" field is present, use semantic matching against the catalog's
branch names and commit messages:
- Match across languages: e.g. CJK keywords should match English branch names/messages
- Match by time: e.g. "last week" or date-related queries should match by date range
- One match: load it with Bash: `node "$("$HOME/.jolli/jollimemory/resolve-dist-path")/Cli.js" recall "<branch>" --budget 30000 --format json`, then output the full report above
- Multiple matches: show candidates, ask user to choose
- No matches: show full catalog, ask user to clarify

If no "query" field (user ran without arguments and current branch has no records):
- Show the branch catalog in a friendly format
- Ask which branch they want to recall
