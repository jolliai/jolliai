# 209. PR Description Generation

## Topic Statement

Generate a pull-request title and body for the current branch by enumerating the branch's commits, loading the recorded memory for each, choosing a title from the commit messages, and assembling the body from one of two markdown builders depending on how many commits carry memory.

## Scope

**In scope:**

- The single shared engine that produces the title + body and is consumed identically by the command-line surface and by the programmatic tool surface.
- The commit range it describes (always the current branch against a base), and why the base defaults to the repository's actual default branch rather than a hardcoded name.
- Loading the per-commit memory for the range, in chronological order, while counting commits that have no recorded memory.
- The three-tier title selection rule.
- The two-way body dispatch (single-commit builder vs. multi-commit aggregating builder) and the missing-commit footnote appended in the single-commit case.
- The optional wrapping of the body in idempotent update markers.
- The empty-result error and its message.
- The structured result object that both surfaces return.

**Out of scope (boundaries):**

- The exact marker syntax, the locator regex, and the replace-or-append rule that lets a later update rewrite the block in place; see **PR Description Dual-Marker Embedding** (spec 98). This spec only states *that* the body may be marker-wrapped and *that* the marker text is the same one spec 98 defines.
- The internal section layout of the single-commit and multi-commit markdown blocks (commits directory, plans/notes, recap, e2e, topics, footer, per-section size truncation). Those are defined by **PR Description Dual-Marker Embedding** (spec 98); this spec treats the two builders as opaque producers of a markdown string.
- Actually creating or editing the GitHub PR (probes, branch reachability, temp-file body delivery); see **PR Creation and Update via gh** (spec 99). This spec produces the title + body; it never talks to a PR host.
- The command-line flags, validation, output formatting, and exit codes around the engine; see **CLI pr-description Command** (spec 210).
- Whatever an agent or user does with the produced title and body afterwards — pushing the branch and opening the PR. No product-installed skill wraps this engine any more: the dedicated PR skill was retired (see **jolli-pr Skill Content (Retired)**, spec 211), so callers reach the engine directly through the programmatic tool or the command-line surface (spec 210) and then open the PR themselves.
- The programmatic tool registration and its result-envelope wrapping; that tool surface is owned elsewhere and only appears here as a co-consumer.
- How per-commit memory is recorded and stored, and the branch enumeration's base-resolution and merged-branch fallbacks; this spec consumes those as black-box inputs.

## Data Contracts

### Inputs

The engine takes the project working directory plus two options:

| Option | Default | Meaning |
| --- | --- | --- |
| Base branch | The repository's resolved **default branch** (the remote's head, e.g. `origin/HEAD`), **not** a literal `main` | The branch the commit range is computed against. |
| Include-markers flag | `true` | Whether the returned body is wrapped in the idempotent update markers. |

There is **no** option to describe an arbitrary branch. The commit range is always the *current* branch's history; describing another branch would require checking it out. (Notable.)

### Result object

On success the engine returns:

| Field | Meaning |
| --- | --- |
| Type tag | A constant string identifying this as a PR-description result. |
| Branch | The current branch name. |
| Base branch | The base branch the range was computed against (after default resolution). |
| Title | The chosen PR title (a commit message). |
| Body | The assembled markdown body, marker-wrapped iff the include-markers flag was set. |
| Commit count | Total commits in the range = commits with memory + commits without. |
| Summary count | Commits in the range that had recorded memory. |
| Missing count | Commits in the range that had **no** recorded memory. |
| Queue active | Backstop: the count of still-pending (non-ingest) summary-queue entries, read once just before returning. |
| Worker blocking | Backstop: whether a summary is still being written (the worker is blocking-busy), read from the same queue-status read. |

The last two are populated from a single **queue-status read** taken right before the result is assembled, so one call to the engine reveals whether summary generation is still in progress without a separate probe. This result carries **no** `drained` field (unlike the standalone queue-status surface), so a consumer relying only on these two backstop fields derives "generation in progress" as `queueActive > 0 || workerBlocking`. See **Shared Behavior** for the queue-status computation cross-reference.

### Empty-result error

When the range yields **zero** commits with recorded memory, the engine throws an error whose message names the current branch and the base branch and tells the user to commit memory before creating a PR. Concretely: `No JolliMemory summaries found on branch "<branch>" (base "<base>"). Commit memory before creating a PR.` The caller surfaces this; the engine does not return a partial result in this case.

## Behavior (execution order)

### 1. Resolve the branch and base

1. Read the current branch name.
2. If a base branch was supplied, use it; otherwise resolve the repository's actual default branch and use that. (The hardcoded-`main` alternative is deliberately avoided: a repository whose default branch is `master` / `develop` / `trunk` would otherwise produce an empty merge-base and spuriously report "no summaries". Notable; this is the load-bearing reason for default resolution.)
3. Decide whether to wrap with markers from the include-markers flag (default on).

### 2. Load branch memory in chronological order

1. Enumerate the commit hashes in the range `base..currentHead`. (The enumeration is newest-first; see boundary note — base resolution and merged-branch fallbacks belong to the enumerator.)
2. If the range is empty, treat it as zero summaries and zero missing.
3. Reverse the hashes to **chronological** order (oldest first).
4. Load the recorded memory for every hash concurrently, tolerating per-commit failures: settle all loads, and for each one —
   - if it resolved to a memory, append it to the summaries list (preserving chronological order);
   - if it failed **or** resolved to nothing, increment the missing count.
5. Return the chronological summaries list and the missing count.

A transient per-commit load failure therefore degrades to a missing-count increment, never to a whole-range failure. (Notable; permissive.)

### 3. Guard the empty case

If the summaries list is empty (every commit in the range lacked memory, or the range was empty), throw the empty-result error described above and stop.

### 4. Identify the current summary and pick the title

The chronologically-last summary (the one nearest `HEAD`) is the "current" summary. The title is chosen by a three-tier rule:

| Condition | Title source |
| --- | --- |
| Two or more summaries | The commit message of the **most recent** summary (last in chronological order). |
| Exactly one summary | That single summary's commit message. |
| Zero summaries | The current summary's commit message. |

Because step 3 has already thrown on zero summaries, the zero-summary tier is effectively a defensive fallback for the body/title selection invariant and is unreachable in normal operation. (The title selection and body selection share this same three-tier shape so title and body always come from the same source.)

### 5. Build the body

The body builder dispatches on summary count:

| Condition | Body |
| --- | --- |
| Two or more summaries | The **multi-commit aggregating** markdown block built from all summaries plus the missing count. The aggregating builder embeds its own missing-commit note. |
| Exactly one summary | The **single-commit** markdown block for that summary. If the missing count is positive **and** there was at least one summary, a footnote line is appended: `\n\n> Note: <missingCount> commit(s) without summary were skipped.` |

Both builders are opaque here; their internal sections and size-truncation rules are defined by spec 98.

Notable asymmetry: the missing-commit note is added by the aggregating builder *internally* in the multi-commit case, but is appended by *this engine* in the single-commit case. The single-commit footnote is only appended when there is at least one summary present (which, after the step-3 guard, is always true on this path). (Notable.)

### 6. Wrap with markers (conditional)

If the include-markers flag is set (the default), wrap the assembled body markdown between the start and end markers — the same markers spec 98 defines — joined by single newlines. Otherwise the body is returned raw. The marker text is shared with spec 98; see Shared Behavior.

### 7. Read queue status and return the result

Take a single queue-status read to populate the two backstop fields, then assemble and return the result object: type tag, branch, base branch, chosen title, (possibly marker-wrapped) body, commit count (summaries + missing), summary count, missing count, queue-active count, and worker-blocking flag.

## State / Idempotency Notes

- The engine is pure with respect to repository state: it reads branch refs and recorded memory; it writes nothing and creates no PR.
- Re-running the engine on an unchanged branch produces an identical result object. The marker wrapping is what makes a *later PR update* idempotent in the PR body; that replace-in-place behavior is defined by spec 98, not here.
- The chronological ordering of the summaries is the contract relied on by both the title rule (most-recent = last) and the aggregating builder (oldest commit at the top of the directory).

## Notable Behavior

- **The base defaults to the repository's real default branch, not `main`.** Avoiding a hardcoded `main` is the reason a `master`/`develop`/`trunk` repository does not spuriously report "no summaries". (Notable; load-bearing.)
- **No "describe arbitrary branch" option exists.** The range is always the current branch's history because describing another branch would require checking it out. (Notable; intentional limitation.)
- **Per-commit load failures are swallowed into the missing count.** One unreadable commit never fails the whole description; it just counts as a commit without memory. (Notable; permissive.)
- **Title and body selection share the same three-tier shape** so the title and body are always drawn from the same source summary. (Notable.)
- **The empty-summaries guard runs before title/body selection**, making the zero-summary tier of both selectors unreachable in normal flow (defensive). (Surprising; intentional defense.)
- **Missing-commit reporting is placed differently per branch of the dispatch** — internal to the aggregating builder for ≥2 commits, appended by the engine for exactly 1 commit. (Notable.)

## Shared Behavior

- The VS Code Create-PR pane is a **third direct consumer** of the shared PR title and body builders: it calls them directly (with its anchor summary and the full branch summary list), **bypassing** this full orchestrator, and applies its **own** empty short-circuit (zero summaries ⇒ suppress the pane) rather than the thrown empty-result error. See **VS Code Create-PR View** (spec 237).
- The queue-active count and worker-blocking flag are read from the shared queue-status computation (the same read the queue-status surface uses); its definition of "active", "blocking-busy", and "drained" is owned by that topic, not here.
- The start/end marker text, the locator regex, the replace-or-append update semantics, and the internal section layout and size-truncation of both markdown builders are owned by **PR Description Dual-Marker Embedding** (spec 98).
- Creating or editing the actual GitHub PR with the title + body this engine produces — the host probes, the branch-reachability decision, and temp-file body delivery — is owned by **PR Creation and Update via gh** (spec 99).
- The command-line surface that drives this engine (flags, stdin base-branch channel, validation, output formats, exit codes) is owned by **CLI pr-description Command** (spec 210).
- There is no longer a product-installed agent skill that calls this engine and then opens the PR; that skill was retired (see **jolli-pr Skill Content (Retired)**, spec 211). The engine's live consumers are the command-line surface (spec 210), the programmatic tool, and the VS Code Create-PR pane's direct use of the shared builders (spec 237).
- The branch commit enumeration (base resolution preferring remote mainline refs, merged-branch fallback) is a black-box input here and is owned by its own spec.
