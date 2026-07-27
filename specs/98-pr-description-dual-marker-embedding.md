# 98. PR Description Dual-Marker Embedding

## Topic Statement

Embed a commit-summary or branch-aggregated summary block into a GitHub pull request's description between two HTML-comment markers, so subsequent updates regex-replace the block in place idempotently and never duplicate or interleave content with what the user wrote outside the markers.

## Scope

**In scope:**

- The exact marker syntax and the regex that locates the block.
- The two write modes: first-time (no markers found in the existing body) and subsequent (markers already present).
- The two block-content modes: single-commit summary and branch-aggregated multi-commit summary, including how the branch case enumerates commits.
- The structural sections inside the embedded block (commits directory, plans/notes, recap, e2e, topics, footer, footnotes).
- The GitHub PR body size limit and the truncation it forces.
- Idempotency — that re-running a write with the same input produces the same body.
- Literal insertion of the block: the replacement text is inserted verbatim, and no character sequence inside it is ever interpreted as a substitution directive.

**Out of scope (boundaries):**

- The `gh` CLI commands used to read and write the PR body; see **PR Creation and Update via gh**.
- Cross-branch detection (whether the memory's commit is reachable from the current `HEAD`); see **PR Creation and Update via gh**.
- The push to the Jolli backend and any document URLs that appear inside the rendered block; see **Summary Push to Jolli Space**.
- The user-edited form. After the form is shown to the user, this spec does not re-sanitize what the user submits. Whatever the user types between the markers in the textarea is what gets pushed.
- The clipboard / Jolli-document markdown variant of summaries. The block in this spec is the **GitHub PR-description** variant and uses GitHub-flavored HTML. It is not portable.

## Data Contracts

### Markers

| Marker | Literal text                                |
| ------ | ------------------------------------------- |
| Start  | `<!-- jollimemory-summary-start -->`        |
| End    | `<!-- jollimemory-summary-end -->`          |

The locator regex matches `start`, then any (possibly empty, possibly multiline) content, then `end`, non-greedy. Exactly one block is recognized per body.

### Block envelope

A block is the start marker, a single newline, the rendered markdown, a single newline, and the end marker. There are no other adornments — no surrounding `<details>`, no horizontal rule attached to the markers themselves.

### Two write modes

| Mode               | Trigger                                        | Effect                                                                                                          |
| ------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| First-time append  | The locator regex does **not** match the body. | Append two newlines and the new block to the existing body. If the body is empty, the result is the block alone. |
| In-place replace   | The locator regex matches the body.            | Replace the matched region (markers and everything between them) with the new block, **literally**.             |

In both modes the body content **outside** the markers is preserved exactly. No reflow, no whitespace changes outside the matched region.

**The replacement is literal, and that is load-bearing.** The new block is substituted as an opaque string: every character of the rendered summary, including any dollar-sign sequence that a regex-replacement API would otherwise read as a substitution directive (`$&`, `$$`, `` $` ``, `$'`, `$1`…), lands in the body verbatim. A summary that happens to contain such a sequence — a topic quoting a shell snippet, a diff hunk, or a currency amount — must not be able to inject the matched region, the surrounding text, or a capture group into the PR body. Implementations therefore pass a *replacer function* rather than a replacement string where their regex API treats replacement strings as patterns.

### Single-commit block — sections, in order

Emitted by the single-summary builder for a `CommitSummary`:

1. `## Jolli Memory` heading + the document URL, if the summary was pushed.
2. Plans & Notes section (links — published Jolli URL when present, else local stub).
3. `## Quick recap` section (the summary's recap text).
4. `## E2E Test (N)` section: each scenario folded inside `<details>` with a `<summary>` label of the scenario's bold title; body is preconditions / steps / expected results.
5. `## Topic(s) (N)` section (singular when N == 1): each topic folded inside `<details>`. Body has Why / Decisions / What / optional Future Enhancements / optional Files. Wrapper-tag injection is escaped on free-text fields.
6. Footer.

### Aggregated block — sections, in order

Emitted by the multi-commit aggregating builder when `summaries.length >= 2`:

1. `## Commits in this PR (M)` (or `(M of T)` when some commits had no summary): a numbered list of commit message + 7-character short hash + optional `[Memory]` link to each commit's pushed Jolli URL.
2. Merged Plans & Notes (deduplicated across all commits — by Jolli URL when present, else by `slug:` / `id:` prefix).
3. `## Quick recap (N)` per-commit recap blocks: one `### Commit i of M: <message> (<shortHash>)` heading per commit that has a non-empty recap.
4. `## E2E Test (N)`: scenarios from all commits, each prefixed by `[<sourceShortHash>]` in the fold label.
5. `## Topic(s) (N)`: topics from all commits, each prefixed by `[<sourceShortHash>]` in the fold label.
6. Optional `> Note: K commit(s) without summary were skipped.` footnote when `missingCount > 0`.
7. Footer.

When more than one commit `base..HEAD` lacks a recorded summary, those commits contribute to `missingCount` and are reported in the directory header (`M of T`) and in the trailing note.

### Body size limit and truncation

GitHub caps the PR body at 65536 characters. The aggregating builder uses these soft limits, set so the wrapped block (markers + footer + per-section omitted-footnotes) stays safely under the cap:

| Section          | Soft limit (characters of accumulated `lines.join("\n")` measured before adding the next block) |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| Recap blocks     | 50000                                                                                            |
| E2E scenarios    | 60000                                                                                            |
| Topics (overall) | 64500                                                                                            |

The single-summary builder uses a single overall topic-section limit of 65000 characters.

When a section would push past its soft limit, the builder stops adding entries to that section and emits a per-section omitted-footnote: `> ⚠️ <K> more <thing>(s) omitted due to GitHub PR body size limit.` The block is still well-formed; the markers still wrap it; downstream replace is still idempotent.

### Branch enumeration

The aggregating block reads commits from `<mainBranch>..HEAD` in **chronological** order (oldest commit at the top of the directory, most recent at the bottom). The loader is permissive about per-commit failures: a transient lookup failure for one commit becomes a `missingCount` increment with a warn log instead of failing the whole load.

### Idempotency

Re-running the embed with the **same** input produces the **same** body. Specifically:

- First-time append + identical body content + identical block content = body grows once (the second time around, the block is already there, so it is replaced in place — same length, same content).
- In-place replace, called twice with the same `newMarkdown`, is a fixed point.

The locator regex matches exactly one block per body; if a malicious or human-edited body somehow contains two start markers, only the first start...first end region (non-greedy) is replaced.

## Behavior

### Wrap markdown into a block

1. Take the rendered markdown.
2. Prepend the start marker and a newline; append a newline and the end marker.

### Replace or append in body

1. Build the wrapped block as above.
2. Run the locator regex against the existing body.
3. If the regex matches, replace the matched region with the wrapped block, inserting it literally (see "The replacement is literal" above).
4. Otherwise, if the existing body is non-empty, append `\n\n` and the wrapped block. If the existing body is empty, return the wrapped block alone.

### Build the single-summary block

1. Collect topics from the summary in display order.
2. Push, in order: optional `## Jolli Memory` heading + URL; plans/notes section; recap section; e2e section; topics section (folding each topic inside `<details>`, stopping when adding the next topic would exceed 65000 characters of accumulated body and recording the omitted count); footer.
3. Free-text fields inside the body are sanitized so user-generated `<details>` / `</details>` / `<blockquote>` / `</blockquote>` tags cannot prematurely close the wrapper. Other HTML and markdown formatting are preserved. File paths are wrapped in backticks (a code span where HTML is not parsed) so they need no escape.

### Build the aggregated block

1. Require at least 2 summaries (the single-summary builder is used for 1).
2. Push, in order: commits directory; merged plans & notes (deduplicated); per-commit recap (each block prefixed by commit index and short hash, truncated when the running length passes the recap soft limit, with a per-section omitted-footnote when truncated); aggregated e2e (scenarios from all commits in commit-chronological order, each prefixed by `[shortHash]`, truncated at the e2e soft limit); aggregated topics (similar, at the overall topics soft limit); optional `> Note: <K> commit(s) without summary were skipped.` line; footer.
3. Same wrapper-tag escaping for free-text fields. Backtick-stripping is applied to commit messages emitted as `\`<shortHash>\`` neighbors so the inline code span is not broken.

### Compose with the existing PR body

1. Load the current PR body (from a prior read of the PR).
2. Run replace-or-append.
3. The result is the new PR body. Updating the PR with this new body is the responsibility of **PR Creation and Update via gh**.

## State Transitions

The marker block in a PR body has three states:

- **Absent.** No start marker is present. The body has whatever the user (or `gh pr create`) initialized it with.
- **Present.** Both markers are present, with content between them.
- **Stale.** Markers are present but content is from an earlier version of the summary. (This is the same as **Present** for matching purposes — replace-in-place upgrades stale to current.)

Allowed transitions:

- Absent → Present: first-time append.
- Present → Present (content updated): in-place replace.
- Present → Present (content unchanged): in-place replace with identical input — fixed point, idempotent.

There is no "Removed" transition; this spec never removes a block. Removing markers is a manual operation by the user editing the PR body directly.

## Notable Behavior

- **Two markers, not one.** Both a start and an end. A single sentinel would not let regex isolate "exactly the previous block" without also eating user content. (Notable.)
- **The block is HTML-comment-wrapped on each end.** GitHub renders HTML comments as nothing visible, so the markers are invisible to PR readers but trivially machine-locatable. (Notable.)
- **First-time write appends with two newlines of separation.** It does not insert at the top, does not insert at a heading, and does not modify any user-written content. (Notable.)
- **Replace is non-greedy.** A body with two start markers (which should not happen but might if a user manually edits) is replaced from the first start to the **first** matching end — not the last. (Notable.)
- **The single-summary path uses a single soft cap on the topics section.** The aggregating path uses three soft caps, one per section, because per-commit recap blocks are larger than per-topic folds. (Notable.)
- **Per-section omitted-footnotes are part of the contract.** When a section truncates, the footnote tells the reader "there is more, but it would not fit". This keeps the block well-formed and tells PR reviewers the truth. (Notable.)
- **The aggregating path requires `summaries.length >= 2`.** Calling it with 1 throws — the single-summary builder must be used for the 1-commit case. The two paths produce different output and are not interchangeable. (Surprising; intentional.)
- **The aggregating path reads commits chronologically.** Newest-first source order is reversed before iteration so the body reads as a story (first commit at the top of the directory). (Notable.)
- **Plan/note dedupe key is URL when published, else `slug:`/`id:` prefix.** The prefix avoids accidental collision with URL strings. Published-and-unpublished entries with the same slug/id collapse to one row, but two unpublished plans with different slugs do not. (Notable.)
- **Commit messages with backticks are stripped before being inlined next to a backtick code span.** Otherwise the message's backtick would break out of the `\`<shortHash>\`` code span on the same line. Other characters are HTML-escaped via the same pipeline as the rest of the rendered block. (Notable; defensive.)
- **Wrapper-tag escaping protects only `<details>` and `<blockquote>`.** Other HTML inside the rendered free-text (e.g. `<code>`, `<br>`, `<img>`) is preserved. The two protected tags are the ones the block uses as wrappers, and a stray closing tag in user-generated content would otherwise prematurely break the fold. (Notable; defensive.)
- **A dollar sign in the summary must not be able to corrupt the body.** The in-place replace is the one place where the whole rendered block is handed to a regex-replacement API, and those APIs conventionally read `$&` / `$$` / `` $` `` / `$'` / `$n` in a replacement *string* as directives — so a summary containing one of those sequences would silently duplicate the previous block, splice in the text around it, or drop a capture group into the PR body. Passing a replacer *function* instead makes the block opaque. This is why the three implementations of this write differ in form: two now use a function replacer, and the third's regex-replacement API already takes a lambda and was immune from the start. Form differs; behavior agrees. (Surprising; intentional — the failure only shows up on the subset of summaries that happen to contain such a sequence, which is exactly why it must be structural rather than tested-for.)
- **Idempotency holds on the markers, not on the inner content.** Re-rendering with new data updates the inner content; that update is itself idempotent against the same data. (Notable.)
- **The block uses GitHub-flavored HTML (`<details>` + `<blockquote>`).** This output is **not portable** to other markdown renderers. Clipboard / Jolli-doc rendering uses a different markdown builder. (Surprising; intentional separation.)

## Shared Behavior

- The `gh` CLI commands that read the existing PR body and write the new body are defined by **PR Creation and Update via gh**.
- The cross-branch detection (whether the memory's commit is reachable from `HEAD`) that decides which branch's PR to update is defined by **PR Creation and Update via gh**.
- The Jolli document URLs that may appear inside the rendered block are produced by **Summary Push to Jolli Space**.
- The footer text emitted at the end of every block, and the plans/notes section markdown shared with the clipboard / Jolli-doc builder, are defined by the summary-markdown shared helpers spec.
