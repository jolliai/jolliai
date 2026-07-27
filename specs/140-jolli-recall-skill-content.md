# 140 — `jolli-recall` Skill Content

## Topic Statement

The instruction document of the recall skill describes a one-step context load that prefers an in-process tool and falls back to a shell here-doc, followed by a `type`-tagged dispatch into a two-part forced-fact-plus-synthesis report, a semantic-matching catalog branch, or a verbatim error surface.

## Scope

**In scope.** The skill name, the frontmatter field values specific to the recall skill, the body's structural sections (title, tagline, Step 1, Step 2), the preferred in-process-tool invocation and the shell here-doc fallback embedded in Step 1, the fallback message for a missing dispatch entry point, the three result-type branches in Step 2, and the instructions the host LLM must follow for each.

**Out of scope.** The file path, version-guard logic, frontmatter machinery, and legacy-directory cleanup — those are all owned by spec 48. The runtime behavior of the underlying recall flow that the skill invokes. The orphan-branch / memory-bank storage layout that backs the recall data (spec 7 and related). The in-process tool surface that the preferred path calls (spec 148).

## Data Contracts

### Skill name

`jolli-recall`. This value is used as the skill directory name and appears in the frontmatter `name` field. The same byte-identical document is written into both a Claude-Code-specific skills directory and a cross-platform agent-skills directory (see spec 48). The name is fixed; changing it must be treated as a breaking change with an accompanying legacy-cleanup entry in spec 48.

### Frontmatter values

The frontmatter is spec-compliant only — it carries `name`, `description`, and a nested `metadata` block (a version string and a vendor string). It carries **no** Claude-private fields (no `argument-hint`, no `user-invocable`), so the same file validates and runs on every host.

| Field | Value |
|---|---|
| `name` | `jolli-recall` |
| `description` | `Recall prior development context from Jolli for the current branch. Use when the user wants to recall, remember, or resume prior work on a branch.` |
| `metadata.version` | set to the bundled version at write time (spec 48) |
| `metadata.vendor` | `jolli.ai` |

### Body structure

The body immediately follows the frontmatter closing delimiter and contains:

1. **Title line** — the product-branded skill heading.
2. **Tagline line** — a short brand tagline rendered as a blockquote.
3. **A short purpose paragraph** — what the skill loads and synthesizes.
4. **"Step 1: Load the recall result" section** — a preferred in-process-tool path and a shell here-doc fallback path, plus the fallback message when the dispatch entry point is missing.
5. **"Step 2: Handle the result by `type`" section** — how to dispatch on the result's `type` field, then detailed rendering / matching / error instructions for each value.

The body's exact wording is part of the on-disk contract and must be preserved across releases except for the bundled-version field value. Editing the body text without bumping the package version will not trigger a rewrite of already-installed documents; the version sentinel is the sole rewrite trigger.

### Preferred in-process-tool path (Step 1)

The skill instructs the host LLM to prefer an in-process recall tool when one is available, calling it with a branch argument object (and omitting the branch when the user supplied no argument, which targets the current branch). The tool returns the same `type`-tagged object the shell fallback returns, so Step 2 handles both identically.

### Shell here-doc fallback path (Step 1)

When no in-process tool is available, the skill instructs the host LLM to invoke the dispatch entry point through a POSIX bash here-doc with **standard-input argument passing**, not argv interpolation:

- The recall subcommand is invoked with a standard-input flag and a structured-output flag.
- The user's argument is fed on standard input between a here-doc delimiter whose token the LLM **generates freshly per invocation** as a random 16-character hex string. The single-quoted here-doc delimiter form suppresses every shell metacharacter; the per-invocation high-entropy delimiter defeats prompt-injection payloads that try to pre-compute the delimiter. The LLM is told to scan the argument and regenerate the delimiter if the argument happens to contain the closing line.
- The skill pins the shell on Windows to Git Bash specifically (because the dispatch entry point lives under the Windows user-profile home that only Git Bash's home aligns with) and instructs the LLM to STOP rather than fall back to any argv interpolation, `npm`/`npx`/`node`-direct, PowerShell, WSL bash, or workspace-local script if it cannot follow the here-doc recipe.

### Fallback message in Step 1

When the dispatch entry point file does not exist, the skill instructs the host LLM to display the following message verbatim and perform no further processing:

> Jolli not installed. Please install via `npm install -g @jolli.ai/cli && jolli enable` or install the Jolli VS Code extension.

### Result types in Step 2

The result (from either the in-process tool or the shell fallback) carries a `type` field. The skill specifies handling for three values:

- `recall` — full context loaded successfully.
- `catalog` — a branch catalog was returned because no exact branch match was found.
- `error` — a hard error string was returned.

## Behavior

The following describes what the skill instructs the host LLM to do at runtime. It is not a description of the recall flow's internals.

### `type: "recall"` branch — two-part report

When the result type is `recall`, the LLM has a full recall payload and must render in two parts, in order:

**Part A — Forced fact opener.** Render the loaded confirmation as a heading plus a bullet block (not a prose line) carrying facts only — period range with day span, commit count with insertion/deletion/file totals, and a captured-content tally (topics, key decisions, plans, notes). The skill mandates the heading-plus-bullet shape and explicitly forbids interpretation in this part: a single prose line would blend into the synthesis and the user would lose the visual anchor for verification.

**Part B — Free-form synthesis.** The LLM picks whatever shape best serves the user's prompt (prose, timeline, decision-focused bullets, per-theme sections, comparison, mixed), preferring per-theme `###` sections when multiple distinct themes emerge. The synthesis is governed by a set of universal principles: lead with the answer (no analysis-preamble); ground every concrete claim to a hash and/or file; synthesize rather than dump but use verbatim quotes (complete 10–30-word clauses, in bold, with attribution) drawn from stored decisions / recap / plan-body / note-body text, with bold reserved exclusively for verbatim quotes; reply in the user's language; never expose machinery (no payload/field-name leakage); and stay brief by default while favoring section structure over compression.

The payload the LLM works from carries branch-level facts, a per-commit projection (identity fields always present, optional commit-type / ticket, optional diff stats, optional recap, and a topics list whose `title` and `decisions` are always present while `trigger` / `response` / `todo` / `filesAffected` / `category` / `importance` may be absent), plan and note reference stubs on commits, top-level deduplicated plan and note bodies, and aggregate stats with an estimated-token count and an optional truncation flag. The skill documents the field-specific trimming behavior (response is policy-trimmed unconditionally past a commit-count threshold; trigger is budget-trimmed oldest-first and recoverable by a larger budget; decisions is never trimmed from a kept commit — instead the whole commit is dropped). It also instructs the LLM to quote plan/note bodies only when the matching top-level entry still carries content, and to use only the stub title as an anchor when the body was trimmed away — never fabricating a quote from an absent body.

For empty results, the LLM tells the user no records were found and suggests enabling Jolli. When the payload is marked truncated, the LLM mentions trimming with a one-liner only if the user asks for deeper detail.

### `type: "catalog"` branch — semantic matching

When the result type is `catalog`, no exact branch match was found and a branch catalog was returned. The catalog carries a branches array (each with a branch name, commit count, period, commit messages, and optional topic titles) and may carry a `query` field.

When a `query` field is present, the LLM applies semantic matching of the query against the catalog entries using branch names, commit messages, and topic titles, with topic titles weighted as the highest-signal source. The matching must support cross-language matching and time-relative queries. Based on the outcome:

- **One match** — repeat Step 1 with the chosen branch as the argument, then render the `recall` two-part report.
- **Multiple matches** — list the candidates and ask the user to choose.
- **Zero matches** — show the catalog and ask the user to clarify.

When no `query` field is present (the user ran the skill without an argument and the current branch has no stored records), the LLM shows the catalog and asks which branch to recall.

### `type: "error"` branch — verbatim surface

When the result type is `error`, the LLM surfaces the error's message string verbatim (translated into the user's language if non-English) and does not retry or fabricate a recall payload. For a "no records in this repo" message specifically, it suggests enabling Jolli if records were expected.

## Notable Behavior

- **The skill prefers an in-process tool and falls back to a shell here-doc.** Both paths return the same `type`-tagged object, so Step 2 dispatches identically regardless of which path produced the result. The shell fallback uses standard-input argument passing through a single-quoted, freshly-randomized here-doc delimiter — not argv interpolation — as the shell-injection defense. (Notable; load-bearing.)
- **Three result types, not two.** The current document handles `recall`, `catalog`, **and** `error`; the error branch surfaces the message verbatim rather than fabricating a result. (Notable.)
- **The render is two parts (forced facts, then free-form synthesis), not a fixed three-part report.** Part A is a mandated heading-plus-bullet fact block with interpretation explicitly deferred to Part B; Part B is free-form under universal principles. (Notable.)
- **The fallback message is part of the on-disk contract.** Changing its text without a version bump will not update already-installed documents. (Notable.)
- **The semantic-matching instructions in the catalog branch are instructions to the host LLM, not to the underlying flow.** The catalog is returned without pre-filtering; the LLM performs the semantic selection. (Notable.)
- **Step 1 and Step 2 are the literal heading names used in the document.** They are load-bearing structural anchors. (Notable.)
- **Bold means "verbatim from stored data."** The skill forbids using bold for general emphasis, so the user can trust that any bold span is a quote. (Notable.)

## Shared Behavior

- Spec 48 owns the file path(s), the frontmatter schema, the version-guard, the bundled-version sentinel, the dual write into the Claude-Code and cross-platform skills directories, and the legacy-directory cleanup. This spec owns only the content written inside that file.
- The dispatch entry-point pattern is described in spec 48's Shared Behavior section and is common to all skill invocations.
- Spec 7 covers the recall flow at runtime — what actually happens when the skill's invocation executes.
- Spec 148 owns the in-process recall tool that the preferred Step-1 path calls.
- Worktree-awareness is inherited from spec 48: each worktree has its own copy of this skill document.
