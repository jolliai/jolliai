# Development Context Recall

## Topic Statement

A token-budgeted compilation of stored commit summaries for a named branch — combining decisions, plans, notes, and per-commit summaries into a single rendered artifact suitable for re-injection as context to an AI agent — produced in one of five output modes (short text, full markdown to stdout, full markdown to file, machine-readable structured payload, branch catalog).

## Command Surface

The recall capability is exposed as the canonical sub-command `recall`. A second sub-command name, `context`, is registered as an alias and dispatches to the same code path with identical arguments, defaults, and output behavior. Both names accept the same positional branch/keyword argument, the same option set, and produce byte-identical output. Documentation, help text, and skill bridges refer to `recall`; the alias exists for historical compatibility and discoverability.

## Scope

**In scope:**
- Inputs: branch identifier, optional depth limit, optional token budget, optional toggles for plans/notes/transcripts.
- Command surface: a canonical sub-command name and a registered alias that share one code path.
- Output mode dispatch: short text (default), full markdown to stdout, full markdown written to a file, machine-readable structured payload (the JSON output mode emitting branch, period, per-commit projection, plans, notes, optional user knowledge, stats), branch catalog (text or machine-readable).
- Token estimation across CJK and ASCII text.
- Section budget allocation and truncation strategy when over budget.
- Branch resolution: exact match versus catalog fallback for semantic matching by an upstream agent.
- Ordering of summaries, decisions, plans, notes within the rendered artifact.
- The "machine-readable catalog output is never truncated" guarantee.
- The "20-entry cap on text catalog output" rule.

**Out of scope:**
- The summary payloads themselves (covered by the summary-tree topic).
- The lookup-index mechanics (covered by the summary-index topic).
- Transcript ingestion and storage (covered by the transcript-storage topic).
- Plan / note authoring (covered by the plans-and-notes topic).

## Data Contracts

### Compiler input

A small structured record with:

- **branch** (required, string): the branch whose memory is recalled.
- **depth** (optional, positive integer): cap on the number of root-level summaries to load. When omitted, all root summaries on the branch are loaded.
- **token-budget** (optional, positive integer): target token count for the rendered artifact. When omitted, an implementation-defined default applies.
- **include-transcripts** (optional, boolean): reserved flag; not yet load-bearing in current behavior.
- **include-plans** (optional, boolean, default true): when false, plans are excluded from compilation entirely.
- **include-notes** (optional, boolean, default = include-plans): when false, notes are excluded from compilation entirely.

### Compiled context

A structured value carrying the raw inputs to rendering:

- **branch** (string): echoed input.
- **period** (object with start and end ISO timestamps): the display-date range across the loaded summaries.
- **commit count** (integer): number of root summaries successfully loaded.
- **total files changed, total insertions, total deletions** (integers): horizontal sum of each loaded summary's resolved diff stats.
- **summaries** (ordered list): the loaded root summaries.
- **plans** (ordered list of {slug, title, content}): deduplicated plans referenced by the summaries, with their full markdown body.
- **notes** (ordered list of {id, title, content}): deduplicated notes referenced by the summaries.
- **key decisions** (ordered list of {text, commit hash}): every non-empty "decisions" string from every topic across every summary.
- **stats** (object): per-section token counts and total — see "Stats payload" below.

### Stats payload

A flat object with: topic-count, plan-count, note-count, decision-count, topic-tokens, plan-tokens, note-tokens, decision-tokens, transcript-tokens, total-tokens. Each "tokens" field is computed by the token estimator (see Behavior). Total-tokens equals the sum of the four section token counts; transcript-tokens is currently always zero.

### Catalog output

A structured value with:

- **type** (constant: "catalog"): output discriminator.
- **query** (optional, string): when populated, the user-supplied identifier that did not exactly match any branch.
- **branches** (ordered list): catalog entries.

Each catalog entry:

- **branch** (string): branch name.
- **commit count** (integer): number of root summaries on that branch.
- **period** (object with start and end ISO timestamps).
- **commit messages** (ordered list of strings): the commit messages of all root summaries on that branch, in chronological order.

### Machine-readable recall output

A structured value with:

- **type** (constant: "recall"): output discriminator.
- **stats** (the stats payload).
- **rendered markdown** (string): the rendered full artifact.

### Constants

- **Default token budget**: an implementation-defined large constant in the tens of thousands.
- **Catalog text limit**: 20 entries (only applies to text rendering of the catalog).
- **CJK density**: ~1.5 tokens per CJK character.
- **ASCII density**: ~0.25 tokens per non-CJK character.
- **Plans-plus-notes share**: 25% of the post-decisions remaining budget.
- **Top-level recall command's terminal-mode "key decisions" shown count**: 3.

## Behavior

### Top-level recall dispatch

Given the user-provided arguments and the working directory:

1. If a free-text argument is present, validate it against the safe-argument character class; on rejection, emit an error in the requested format and return.
2. If catalog mode is explicitly requested, load the catalog and emit it in the requested format. Done.
3. Otherwise, resolve the branch:
   - If the user provided a free-text argument, treat it as the candidate branch name.
   - If not, try to read the current branch from source control. On any failure, leave the branch unset.
4. Load the catalog once for use in subsequent dispatch paths.
5. If the candidate branch is set:
   - If the catalog contains an exact match, run "compile and emit" for that branch in the requested format.
   - Otherwise, emit the catalog with the candidate as the **query** field — this signals to upstream agents that the user's input did not exactly match and a semantic match should be attempted client-side.
6. If the branch is unset:
   - If the catalog is empty, emit a "no records found, run enable to start recording" error.
   - Otherwise, emit the catalog without a query field.

All errors and outputs go through the same format selector: machine-readable when machine-readable output was requested, otherwise human-readable.

### Output mode selection (when an exact branch is matched)

Priority order:

1. **Output-to-file mode**: when a file path is supplied, render full markdown at the requested budget, ensure the parent directory exists (mkdir-p semantics), write the file, and emit a one-line confirmation showing the byte/token cost and commit count.
2. **Machine-readable mode**: when machine-readable output was requested, render full markdown at the requested budget, wrap it together with the stats payload as the recall output, and emit it serialized.
3. **Full-markdown stdout mode**: when explicitly requested (full flag, or machine-format = markdown), render full markdown at the requested budget and emit it directly.
4. **Default short-text mode**: emit a terminal-friendly multi-line summary (see "Short summary rendering").

When the compiled context has zero commits, an "no records found for branch X" message is emitted in the requested format and no rendering occurs.

### Catalog construction

1. Load the lookup index. If absent, return a catalog with an empty branches list.
2. Filter to root entries (parent link explicitly null or absent).
3. Group root entries by branch.
4. For each group, sort entries by display-date ascending; the entry's display-date is "the more recent of commit-date and generated-at." Build the catalog entry: branch name; entry count; period from the first and last entries' display-dates; commit-messages list in chronological order.
5. Sort the resulting branch catalog by the period-end timestamp, descending.

### Catalog rendering — text mode

When the catalog is rendered for the terminal:

1. If a query was supplied, prepend a "no exact match for query" line; otherwise prepend a "no records for the current branch" line.
2. Add a "recorded branches (most recent first)" header.
3. Take the first 20 entries (the catalog text limit). For each, render one indented line: branch name, commit count (singular/plural), and either the period dates joined or a single date if start equals end.
4. If more than 20 entries existed, append a "... and N more (use machine-readable for the full list)" line.
5. Append a "run: jolli recall <branch-name>" guidance line.

### Catalog rendering — machine-readable mode

The catalog structure is emitted verbatim with no truncation. This is the mechanism by which an upstream agent receives the full set of recorded branches and can perform its own semantic matching against the user's free-text query.

### Compilation algorithm (exact-branch path)

1. Load the lookup index. If absent, return an empty compiled context.
2. Filter root entries to those whose branch field equals the requested branch.
3. Sort by display-date ascending (chronological narrative order).
4. If a depth limit was supplied and exceeds the count, take the last N (most recent N).
5. If no entries remain, return an empty compiled context.
6. For each surviving entry, load the full root summary payload. Skip entries whose payload fails to load (warn-and-continue).
7. If no payloads loaded successfully, return an empty compiled context.
8. Build the **key decisions** list: for every payload, walk all topics in its tree; for each topic with a non-empty decisions string, append {text, source-commit-hash}. No deduplication, no truncation.
9. Build the **plans** list (when plans are included):
   1. From each summary's plan references, collect candidate {slug, title, source-commit-hash, commit-date, generated-at} records.
   2. Deduplicate by base-slug (see "Plan slug deduplication").
   3. For each surviving plan, load its content from the durable store. Drop silently if missing (warn).
10. Build the **notes** list (when notes are included):
    1. Walk summaries in load order; for each note reference seen for the first time (deduplicate by note id), build a content payload:
       - For inline-snippet notes that carry their content on the reference itself, use that content.
       - For file-backed notes, load the content from the durable store.
    2. Drop silently if missing (warn).
11. Compute horizontal totals across all summaries: each summary contributes its resolved diff stats (the persisted real diff, with legacy fallbacks); sum files-changed, insertions, deletions.
12. Compute the period: display-date of the first summary (start) to display-date of the last (end).
13. Compute per-section token estimates (see "Token estimation"). Total = topics + plans + notes + decisions.

### Plan slug deduplication

A plan reference's slug may take a base form ("base-slug") or an archived form ("base-slug-shortHash") where the trailing hash matches the source commit's short hash.

1. For each candidate, attempt to extract a base-slug:
   - If the slug ends with "-" + the candidate's commit's first-8 hash, strip that suffix.
   - Else if the slug ends with "-" + the candidate's commit's first-7 hash, strip that suffix.
   - Else use the slug verbatim.
2. Group candidates by extracted base-slug; within each group keep the candidate with the most recent display-date.
3. The deduplicated plans list preserves first-encounter order from the per-summary walk (modulo replacement when a later candidate wins on display-date).

### Token estimation

For any string:

1. Iterate code points.
2. For each code point in the CJK range (a fixed multi-block class covering common-CJK, extension-A, compatibility, extension-B, extension-C, hiragana, katakana, hangul-syllables), count it as one CJK character.
3. Otherwise count as one ASCII character.
4. Estimated tokens = ceil(CJK-count × 1.5 + ASCII-count × 0.25).

### Short summary rendering

For terminal default output:

1. Emit a header line with the branch name, commit count (singular/plural), and the period (single date if start equals end, otherwise start dash end).
2. Emit a horizontal rule.
3. Emit "Last:" followed by the most recent summary's commit-message first line.
4. Aggregate topic-category counts across all summaries; if any topics had categories, emit a "Topics:" line listing each "<count> <category>" sorted by count descending, joined by commas.
5. If at least one key decision exists:
   1. Emit a "Key decisions:" header.
   2. Take the first 3 decisions; for each, take the first line, strip a leading list marker (`- ` or `* `), trim, and emit indented.
   3. If more than 3 decisions exist, emit a "(and N more — use full output to see all)" line.
6. Emit a "Files changed:" line with the horizontal total.
7. Emit guidance lines pointing to the full-output flag and to the AI-assisted recall command.

### Full-markdown rendering and budget application

1. Emit a header section: title, branch label, period label, commit-and-changes label.
2. Emit the **Key Decisions** section if any decisions exist: numbered list, each item showing the decision text followed by the short hash in parens.
3. Build (but do not yet emit) the **Plans** section: an H2 header followed by per-plan H3 + content blocks separated by blank lines and a trailing rule.
4. Build (but do not yet emit) the **Notes** section: same shape as plans.
5. Build the **Commit History (chronological)** section: per-summary block (see "Per-summary block").
6. Compute the token cost of the (already finalized) header + decisions text. Subtract from the budget.
7. If the remainder is non-positive, return the header + decisions text plus a footer noting that decisions exceeded budget.
8. Otherwise allocate remaining budget:
   - Plans-and-notes share = floor(remainder × 25%) when either is present, else 0.
   - Summaries share = remainder − plans-and-notes share.
9. Combine the plans text and notes text in that order; if their combined token cost exceeds the plans-and-notes share, truncate the combined text to that budget (see "Section truncation"). The truncation falls within plans first by the concatenation order; the notes section is fully dropped if truncation reaches it.
10. If the summaries text exceeds its share, truncate it to that share.
11. Concatenate: header + decisions + final-plans + final-notes + final-summaries.
12. Append a footer noting the recompiled total token count.

### Per-summary block

For each summary, render:

- An H3 line carrying optionally a numeric prefix, then the short hash, then an em dash, then the commit message, then the formatted display-date in parens.
- A "Changes:" line with files-changed, +insertions, -deletions.
- A blank line.
- For each topic in the summary's tree:
  - An H4 line with the topic title, an optional category tag in brackets, an optional importance tag in brackets.
  - A "Why:" bullet (the topic's trigger).
  - A "Decisions:" bullet (the topic's decisions).
  - A "What:" bullet (the topic's response).
  - A "Files:" bullet listing the files-affected list joined by commas, when present.
  - A blank line.

### Section truncation

Given a text body and a token budget:

1. Split into lines.
2. Iterate lines: maintain a running token total; if appending the next line would exceed the budget, stop and append a "[... truncated due to token budget]" placeholder line; return the joined accumulated lines.
3. If iteration completes without hitting the budget, return the original text (effectively no-op).

### Empty compiled context

When the compiler has no entries to compile, it returns: empty branch (the requested name), empty period strings, zero counts and totals, empty lists for summaries/plans/notes/key-decisions, zeroed stats payload. The renderer for short text and full markdown both gracefully handle this by either emitting a "no records" message at the dispatch layer (preferred) or by rendering an essentially empty document.

## State Transitions

The compiler is stateless. Each invocation produces a fresh compiled context from the durable store at the moment of the call. Re-invocation reflects any concurrent writes to the index, summary payloads, plans, or notes.

## Notable Behavior

### Machine-readable output is never truncated for the catalog

The 20-entry cap applies only to the text rendering of the catalog. The machine-readable catalog emits every recorded branch. This is intentional: upstream agents perform semantic matching of the user's free-text branch query against the full list. Truncating the list would silently make some branches unrecallable.

### Markdown rendered for the machine-readable recall output is still truncated

The "machine-readable output is never truncated" guarantee applies to the catalog branch listing. The recall output's rendered-markdown payload is produced by the same budget-respecting renderer used for the human-facing full-markdown mode and follows the same truncation rules. The contract is "structured fields are complete; the embedded rendered text honors the budget."

### Decisions are never truncated

The budget application reserves the entire decisions section before allocating any remainder. If decisions alone exceed the budget, plans, notes, and summaries are dropped wholesale and the footer signals the overflow. This reflects the priority that an agent re-injecting context must not lose stated past decisions.

### Summary load is fault-tolerant

Per-summary load failures (parse errors, missing payloads) are logged and skipped, not raised. A partial recall is preferred over no recall.

### Branch resolution treats current-branch lookup failures as "branch unset"

When the user provides no argument and reading the current branch from source control fails (no source-control directory, detached state, error), the dispatcher treats the candidate branch as unset and falls through to the "emit catalog without query" path. It does not raise.

### Diff totals are horizontal, not vertical

Each summary's contribution to the totals is its own resolved diff (real-diff if persisted, else legacy fallback). Container summaries (e.g. squash roots) contribute the merged commit's diff once — they do not aggregate their children's diffs. This matches the storage-layer rule that container roots persist their own real diff during construction.

### CJK characters dominate the budget aggressively

Because the estimator weights CJK at ~6× ASCII per character, a corpus of summaries written in CJK languages reaches the budget threshold roughly 6× sooner than an equivalent ASCII corpus, and the truncation behavior fires accordingly. The estimator does not auto-scale the budget by language.

### The "include-transcripts" toggle is currently inert

It is accepted at the input layer and forwarded into the compiled-context flow. Transcripts are not currently loaded or counted; the transcript-token field in the stats payload is always zero. Reserved for future use.

### Plan and note absences are silent at the renderer

When a plan or note is referenced by a summary but its content cannot be loaded from the durable store, the loader logs a warning and the renderer simply omits that entry. The stats payload reflects only successfully-loaded plans and notes.

### Plan deduplication is purely time-based

When the same logical plan (same base-slug after archival-suffix stripping) appears in multiple summaries, the candidate with the most recent display-date wins. This represents the user's most recent edit/amend of the plan reference. There is no merging of plan content across versions.

### The 20-entry cap is for human readability, not for security

The text catalog cap exists because terminal output beyond ~20 lines becomes unhelpful. It is not a privacy or rate-limiting boundary. The full data is still accessible via the machine-readable mode.

## Shared Behavior

- **Summary index format** — the lookup index whose root entries are filtered, sorted, and grouped to produce the catalog and the per-branch input.
- **Summary tree format** — the per-summary topic walk, the resolved-diff-stats convention, and the display-date convention.
- **Plans and notes** — the slug/id model, archival suffixes, file-backed versus inline-snippet storage.
- **Storage backend** — the read paths used to fetch payloads, plans, and notes by their stable names.
