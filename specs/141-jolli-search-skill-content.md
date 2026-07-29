# 141 — `jolli-search` Skill Content

## Topic Statement

The instruction document of the search skill describes a single-phase invocation where the host LLM parses a query, requests a lightweight relevance-ranked hit list — preferring an in-process tool and falling back to a shell here-doc — then renders the hits to the user under a fixed set of output principles.

## Scope

**In scope.** The skill name, the frontmatter field values specific to the search skill, the body's structural sections (purpose paragraph, when-to-use / when-not-to-use guidance, three numbered steps), the preferred in-process-tool invocation and the shell here-doc fallback, the missing-dispatch-entry-point and stale-CLI detection messages, the inline hit-field documentation that is part of the on-disk contract, and the seven rendering principles.

**Out of scope.** The file path, version-guard logic, frontmatter machinery, and legacy-directory cleanup — those are all owned by spec 48. The search command and pipeline behavior the skill's invocations exercise (specs 137 and 138). The in-process tool surface the preferred path calls (spec 148). Skill installation mechanics for non-Claude agents.

## Data Contracts

### Skill name

`jolli-search`. This value is used as the skill directory name and appears in the frontmatter `name` field. The document is written into the single cross-platform agent-skills directory (see spec 48); the Claude-Code slot is the Claude Code plugin's territory and receives no unnamespaced copy.

### Frontmatter values

The frontmatter is spec-compliant only — `name`, `description`, and a nested `metadata` block (version string, content-revision integer, and vendor string). It carries no Claude-private fields.

| Field | Value |
|---|---|
| `name` | `jolli-search` |
| `description` | `Search structured commit memories across all branches — decisions, topics, files. Use when the user wants to find prior decisions, related commits, or how a topic was handled before.` |
| `metadata.version` | set to the bundled version at write time (spec 48) |
| `metadata.revision` | `2` |
| `metadata.vendor` | `jolli.ai` |

### Body structure

The body immediately follows the frontmatter closing delimiter and contains:

1. **Title and purpose paragraph** — describes the skill as a lightweight relevance search across every branch, returning ranked hits with no two-phase scan, and points to `jolli-recall` for full branch context.
2. **"When to use" section** — example queries this skill fits.
3. **"When NOT to use" section** — redirects to `jolli-recall` for full branch context or deep rationale, and to direct file inspection for current-code questions.
4. **Step 1: Parse the query** — extract a natural-language query and an optional limit; an explicit note that time-window and budget filters are not supported on the search path.
5. **Step 2: Get hits** — a preferred in-process-tool invocation and a shell here-doc fallback, plus failure handling.
6. **Step 3: Render** — inline hit-field documentation followed by the seven universal rendering principles and empty-result handling.

The body's exact wording (including the inline field descriptions) is part of the on-disk contract. The **sole** rewrite trigger is the `metadata.revision` integer, not the bundled release version: editing the body without raising that integer ships nothing to any existing install, and the repository guards against that omission at build time (spec 48).

### Query parsing (Step 1)

The host LLM extracts a natural-language query (any human language) and an optional integer limit (documented default 20). The skill explicitly states that recency (`--since`) and token-budget (`--budget`) filters are **not** supported on the search path, redirecting users who need depth or a time window to `jolli-recall`.

### Preferred in-process-tool path (Step 2)

When the in-process search tool from the memory server is available, the skill instructs the host LLM to call it with a query and an optional limit, receiving a `{ hits }` object whose entries are relevance-ranked. The skill notes the ranking is relevance-based (BM25).

The document is explicit that the tool must be matched **by what it does, not by one host's spelling of its name**, and it names both forms it expects to encounter:

- On Claude Code the tool is surfaced under a **prefixed** name, `mcp__jollimemory__search`.
- On Codex the same tool is surfaced as a **bare** `search` **inside** the `mcp__jollimemory` namespace, and that host loads MCP tools **lazily** — so an empty first look is explicitly **not** proof the tool is absent.

### Shell here-doc fallback path (Step 2)

The fallback gate is deliberately strict: it is **not** "no such tool is available", but **only** when the memory server is not registered at all — *not* merely because one spelling of the tool name is missing from the visible tool list.

The document additionally gives a **performance** reason to prefer the tool path: in a sandboxed agent the shell path cannot write its search-index cache, so it rebuilds the whole index on **every** call.

When the stricter fallback condition does hold, the skill instructs the host LLM to invoke the dispatch entry point through a POSIX bash here-doc with **standard-input argument passing**, not argv interpolation:

- The search subcommand is invoked with a standard-input flag and a structured-output flag.
- The query is fed on standard input between a here-doc delimiter whose token the LLM **generates freshly per invocation** as a random 16-character hex string; the single-quoted delimiter form suppresses every shell metacharacter, and the per-invocation high-entropy delimiter defeats pre-computed prompt-injection payloads. The LLM is told to regenerate the delimiter if the query contains the closing line.
- The same Windows-shell pinning (Git Bash only) and the same STOP-rather-than-interpolate rule the other Jolli skills use apply.

The skill states the fallback returns the same `{ hits }` envelope as the in-process tool, so Step 3 proceeds identically regardless of path.

### Inline hit-field documentation (Step 3)

The skill document contains inline field-by-field documentation of a single hit shape so the host LLM can render correctly without a separate schema lookup. Each hit carries:

- `type` — `"commit"` or `"topic"`.
- `title` — a one-sentence label.
- `snippet` — a short excerpt from the matching content.
- `branch` — the branch the hit belongs to.
- `commitDate` — an ISO 8601 date.
- `slug` — a human-readable identifier (meaningful for topic hits).
- `hash` — the 8-character short identifier (meaningful for commit hits).
- `score` — a relevance score marked **internal**, which the LLM is told not to surface to the user.

The skill explicitly notes the hits are lightweight — no full decisions or recap per hit — and tells the LLM to point users at `jolli-recall` when they need the full rationale behind a hit. This inline documentation is part of the on-disk contract and must be preserved.

### Failure handling (Step 2)

Two failure conditions are described for the shell fallback:

- **Missing dispatch entry point**: the host LLM must display the message "Jolli not installed. Please install via `npm install -g @jolli.ai/cli && jolli enable` or install the Jolli VS Code extension." and perform no further processing.
- **Stale CLI** (command output starts with `error:` or contains the string `unknown command 'search'`): the host LLM must display the message "Your installed Jolli CLI is older than this skill — please run `npm update -g @jolli.ai/cli` (or update your VS Code extension), then retry." and perform no further processing. There is no retry on stale-CLI detection.

## Behavior

The following describes what the skill instructs the host LLM to do at runtime, in step order.

### Step 1: Parse the query

Extract the natural-language query and the optional limit. Do not attempt to pass a recency or budget filter — they are unsupported on this path.

### Step 2: Get hits

Prefer the in-process search tool, matching it by capability across both host spellings and searching the available tools before concluding it is absent. Drop to the shell here-doc fallback only when the memory server is not registered at all. Handle the missing-entry-point and stale-CLI conditions as described above. Both paths yield the same `{ hits }` shape; proceed to Step 3 regardless of which path was used.

### Step 3: Render

Output shape is the LLM's call — prose, compact list, timeline, per-theme sections, whatever serves the query. The following seven principles apply regardless of shape:

1. **Lead with the answer.** No analysis or "found N commits" preamble.
2. **Ground every concrete claim** to a hash (commit hits) or a slug-plus-branch (topic hits); hashes are written in the short 8-character form.
3. **Synthesize but include short verbatim quotes.** Fold content into coherent prose or bullets; when a phrase from a hit's snippet captures the answer compactly, quote it verbatim in bold (a complete 10–30-word clause, with attribution). Bold means "verbatim from stored data" and must not be used for general emphasis; bare strung-together quotes are the wall-of-fragments failure mode.
4. **Reply in the user's language.** The template is English; user-visible output matches the user.
5. **Do not expose machinery.** No mention of the ranking engine, the hit shape, the hits array, the score, or internal field names such as the slug.
6. **Output shape is entirely the LLM's call**, with the constraint that every concrete claim be groundable to a hash or branch.
7. **If the user needs the full decisions / rationale behind a hit**, tell them to run `jolli-recall` on that hit's branch.

**Empty hits** — tell the user nothing matched and suggest broader keywords or a different phrasing, without mentioning the ranking engine or index internals.

## Notable Behavior

- **Single-phase, no catalog and no hash round-trip.** The current document has no Phase 1 / Phase 2 split, no `--hashes` flag, no semantic-pick step over a catalog, and no truncation-retry-with-bigger-budget loop. It is one query in, one ranked hit list out. (Notable; a prior two-phase design has been retired.)
- **The skill prefers an in-process tool and falls back to a shell here-doc.** Both paths return the same `{ hits }` envelope. The shell fallback uses standard-input argument passing through a single-quoted, freshly-randomized here-doc delimiter — not argv interpolation — as the shell-injection defense. (Notable; load-bearing.)
- **Tool discovery is capability-based and host-aware; the fallback gate is server-level, not name-level.** The document names two spellings of the same tool (prefixed on Claude Code, bare inside the namespace on Codex) and warns that one host loads MCP tools lazily, so a first look that finds nothing is not evidence of absence. The fallback is therefore gated on "the memory server is not registered at all" rather than "this name is not in my tool list". (Notable; load-bearing.)
- **Preferring the tool path is a performance rule here, not only an ergonomic one.** The document states outright that in a sandboxed agent the shell path cannot write its search-index cache and so rebuilds the entire index on every call — which makes a name-level fallback gate actively expensive, not merely redundant. (Notable; this reason is stated in the search recipe and not in the recall recipe.)
- **Hits are lightweight by design.** Each hit carries only a title, snippet, identity fields, and an internal score — no full decisions or recap. The skill repeatedly redirects depth-seeking users to `jolli-recall`. (Notable.)
- **The score is internal and must not be surfaced.** The skill explicitly forbids exposing the relevance score or any other machinery to the user. (Notable.)
- **Free-form rendering with seven guardrails is intentional.** The search use case varies widely by user intent; the guardrails are the minimal set that prevents known bad outputs. (Notable.)
- **Stale-CLI detection has no retry.** Detecting an out-of-date CLI ends the run with a guidance message rather than attempting a fallback. (Notable.)
- **Inline field documentation is on-disk contract.** The field descriptions in Step 3 are written once at install time and reach an already-installed document only when the document's `metadata.revision` integer is raised — a release-version bump alone reaches nothing (spec 48). (Notable.)

## Shared Behavior

- Spec 48 owns the file path(s), the frontmatter schema, the revision-guard (including the build-time fingerprint that fails a body edit made without a revision bump), the bundled-version interpolation, the single cross-platform write target, and the legacy-directory cleanup. This spec owns only the content written inside that file.
- The dispatch entry-point pattern is described in spec 48's Shared Behavior section and is common to all skill invocations.
- Specs 137 and 138 own the command and pipeline behavior the skill's invocations exercise — the single-phase dispatch, the required-query guard, and the `{ hits }` shape.
- Spec 148 owns the in-process search tool that the preferred Step-2 path calls.
- Worktree-awareness is inherited from spec 48: each worktree has its own copy of this skill document.
