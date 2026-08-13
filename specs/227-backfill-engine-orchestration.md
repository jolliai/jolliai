# Back-fill Engine Orchestration

## Topic Statement

Run the end-to-end historical back-fill for a list of candidate commits: drop the ones that already have a memory, build the offline transcript and commit indexes, attribute conversation slices to commits, then for each still-missing commit either generate and store a memory (reusing the live summary-generation and storage paths) or, in dry-run, preview the attribution. After a real batch that produced at least one memory, trigger a single repo-wide knowledge ingest. Every per-commit failure is isolated so a batch always finishes.

**Not to be confused with the database repository back-fill** (cross-ref 350), an unrelated feature of the same name that reconciles already-existing facts into the local memory database and never calls a model. This engine is the one that generates memories for historical commits and therefore spends model budget.

## Scope

**In scope:**
- The ordered run pipeline (drop-existing → index → attribute → generate/store or preview).
- The cursor-candidate gathering that feeds the attributor a superset of the emit set.
- The generate-and-store step, including the diff-only path, the fields stamped on a back-filled memory, when a transcript artifact is attached, and the per-session display title resolved into that artifact at write time.
- The own-author commit filter (email OR name, literal matching) shared by every entry point.
- The single post-batch ingest trigger.
- Error isolation and the no-credentials outcome.
- The default minimum confidence tier.

**Out of scope (boundaries):**
- Building the two indexes and attributing slices (owned by **Back-fill Commit Target Index**, **Back-fill Raw Transcript Scanning**, **Back-fill Commit Attribution Algorithm**).
- The summary-generation model call itself and the storage write protocol (owned by the summarizer and storage specs — reused here unchanged).
- The ingest trigger's cooldown/force semantics and the worker that drains it (owned by **Topic-KB Ingest Trigger and Cooldown** and the queue-worker spec).
- The CLI command surface (owned by **CLI Back-fill Command**) and the VS Code cold-start card (owned by **VS Code Cold-start Back-fill Card**).
- The cheap read-only signal queries (has-any-memory, count-missing, list-missing) — owned by **Back-fill Cold-start Signal Queries**.

## Data Contracts

### Run inputs

- Working directory of the repo.
- Candidate commit hashes, newest-first (the engine itself drops those already summarized).
- Optional dry-run flag.
- Optional minimum confidence tier — defaults to **low** (window-collect-all: attach every in-window turn within the commit's effective worktree + cursor slice, letting the per-memory badge flag weaker ones honestly). This same default is used by every entry point.
- Optional projects-root override (tests inject a temp dir).
- Optional per-commit progress callback (fires AFTER each commit is processed).
- Optional pre-generation callback (fires immediately BEFORE a commit's generation begins — lets a caller announce work starting on a slow commit; skipped on dry-run).
- Optional cooperative-cancellation signal, checked at each commit boundary (never mid-commit).

### Per-commit outcome

One of: **generated**, **would-generate** (dry-run), **skipped-has-summary**, **error**. Carries, where applicable: commit hash and subject, confidence, method (attribution method or `diff-only`), topic count, attributed-session count, conversation-turn count, and an error message.

### Report

Totals across the batch: total candidates, generated count, skipped count, error count, and the full outcome list.

### Diff-only branch sentinel

When no conversation is attributed, the memory's branch field is stamped with the fixed sentinel label **`backfilled`** — a historical commit's development branch cannot be reliably recovered after the fact, so instead of stamping the run-time branch (wrong) an explicit marker is used. When a conversation **is** attributed, the memory uses the branch captured on the transcript at edit time (reliable).

## Behavior

### Run pipeline (in order)

1. **Resolve storage** for the repo and install it as the active storage backend.
2. **Drop already-summarized.** Read the memory index; any candidate already present becomes a `skipped-has-summary` outcome and is removed from the "missing" list. If nothing is missing, return immediately.
3. **Build offline indexes.** Resolve the repo's worktree roots (the working directory plus every entry from the worktree list), scan the on-disk transcripts scoped to those roots, and build the commit target index.
4. **Gather cursor candidates and attribute.** Compute the cursor-candidate superset (see below), then attribute, passing the minimum tier, the missing set as the emit set, and the worktree roots.
5. **Generate/store or preview.** Load config (LLM credentials, model, provider). For each **missing** commit, in order:
   - **Cancellation check (first thing per commit):** if a cancellation signal is given and already triggered, stop the loop immediately — commits already generated stay stored; the boundary is always between commits.
   - Its attribution is the attributor's result for that hash, or `null` (→ diff-only).
   - **Dry-run:** emit a `would-generate` outcome carrying method, attributed-session count, conversation-turn count, and confidence (when attributed).
   - **No LLM credentials:** emit an `error` outcome ("no LLM credentials configured") — the model is never called.
   - **Otherwise:** outside dry-run, invoke the pre-generation callback with the 1-based index, total, hash, and subject (when known) immediately before generating; then generate and store (see below) inside a try; on success emit `generated` with method, topic count, sessions, turns, and confidence; on failure emit an `error` outcome carrying the error message. A single commit's failure never aborts the batch.
   - Fire the progress callback after each commit.
6. **Post-batch ingest.** When not a dry-run **and** at least one outcome is `generated`, enqueue exactly **one** repo-wide knowledge ingest tagged `manual` with force (bypassing the cooldown), and launch the drain worker. Skipped on dry-run and when nothing was generated.
7. Return the summarized report.

### Cursor-candidate gathering

The attributor needs boundaries beyond the emitted set. Compute the emit set's author-time range from the target index; if no emit commit has an index time, fall back to just the emit set. Otherwise take `[min(emit time) − 7 days, max(emit time)]`, list every **own-authored** commit reachable from `HEAD` with its author time, and add to the emit set every own commit whose author time falls in that range. The back-margin matches the attributor's window cap so a neighbour old enough to still bound a window is present.

### Generate and store

For one commit (with an attribution or `null`):
1. Read the commit info, the commit-vs-parent diff, and the diff stats.
2. Conversation text = the attributed sessions rendered to a single context string, or empty when diff-only.
3. Compute the commit's tree hash (for cross-branch dedup parity with the live pipeline — the same tree on a different branch resolves to this memory).
4. Generate the summary via the **same** generation path the live pipeline uses, passing conversation, diff, commit info, diff stats, and the attributed entry/turn counts (zero when diff-only).
5. Build the stored memory: schema version, commit metadata, branch = attributed branch or the `backfilled` sentinel, generated-at, generation results (entry/turn counts, model info, stats, topics, optional ticket id and recap), the **back-filled flag set true**, method = attribution method or `diff-only`, confidence **only when attributed**, tree hash when available, and a transcript id **only when a conversation was attributed**.
6. Attach a transcript artifact **only when a conversation was attributed**; store the memory through the active storage.
   - Building that artifact is an **asynchronous** step, because each archived session in it also carries a **display title resolved once, here, at write time** — every session in the attribution is resolved in parallel and a resolved title is stamped onto the archived session; a session that resolves to nothing carries no title field at all, so a later reader falls back exactly as it does for an artifact written before the field existed. The artifact otherwise carries each session's identifier, producer, transcript path and archived turns.
   - **Documented caveat:** the title resolution runs long after the commit, so a transcript pruned in the meantime yields no producer-native title and the archived first user message stands instead. That is the honest answer for a file that is gone, and still strictly better than archiving nothing — which left every future reader deriving the title from a path that had already stopped existing.
7. Return the topic count.

**Diff-only path (`null` attribution):** mirrors the live pipeline's no-active-session behaviour — a diff-derived memory is *always* produced; the "never guess" rule governs only whether a *conversation* is attached, not whether a memory exists. No transcript id, no transcript artifact, no confidence field.

### Own-author commit filter

Every commit-listing query the engine runs (cursor candidates; the recent-hashes and list-missing helpers) is scoped to the local user's **own** commits — commits authored by others never have local Claude transcripts, so back-filling them is pointless and would inflate the missing count. The filter matches **either** the configured author email **or** the configured author name (git treats multiple author filters as OR), using **literal / fixed-string** matching — not regex. Fixed-string matching is required because author strings routinely contain characters that are regex metacharacters (a `user+tag@…` email alias, a `J. Doe (Acme)` name); escaping them naively would match nothing. When neither identity is configured, no filter is applied and every commit is a candidate.

### Error isolation and no-credentials

- Per-commit generate/store errors are caught into `error` outcomes; the batch continues.
- When no LLM credential (configured Anthropic key, configured platform key, or the Anthropic key environment variable) is present, **every** missing commit becomes an `error` outcome and the model is never called — but the batch still runs to completion and produces a report.

## State Transitions

- A commit moves `missing → generated` (memory now in the index) or `missing → error` (no memory) or, in dry-run, `missing → would-generate` (no state change on disk).
- The post-batch ingest only fires on the `missing → generated` transition occurring at least once in a non-dry-run batch.
- A cancelled run leaves every commit past the stop point still `missing` (neither generated nor error) — a re-run treats them exactly like any other still-missing candidate.

## Notable Behavior

- **Enable no longer triggers back-fill.** Auto-launching a back-fill worker on enable was removed; back-fill is now entirely user-driven (the CLI command, the VS Code cold-start card, or the Settings "generate missing" button). Enabling never spends LLM budget without an explicit opt-in. (Notable.)
- **Stale, not-live comments still reference a deleted enable-time worker.** Internal docstrings on the default-tier constant and the recent-commit-hashes helper still list "the enable-time background worker" / "the enable-time worker" as callers. No such caller exists; the enable path only recomputes cold-start signals. Treat these mentions as **stale documentation, not live behavior.**
- **Diff-only always produces a memory.** Absence of an attributed conversation withholds only the conversation, never the memory itself. (Notable.)
- **The back-filled flag and method distinguish back-filled memories** from live ones; confidence is present only when a conversation was attributed. (Notable.)
- **A single repo-wide ingest fires once per batch**, never per memory, and only when something was generated — with force so a deliberate back-fill always refreshes the knowledge wiki/graph regardless of the ingest cooldown. (Notable.)
- **Tree hash is computed even for diff-only memories** so cross-branch dedup parity with the live pipeline holds. (Notable.)
- **The archived transcript carries a resolved title per session, and back-fill is the entry point where that resolution is most likely to be degraded.** The same write-time resolution the live pipeline performs runs here, but long after the commit — so a transcript the agent has since pruned yields no producer-native title and the archived first user message stands in for it. Recorded as a known caveat rather than a defect: the alternative is storing no title and leaving every reader to re-derive one from a path that no longer resolves. (Notable.)
- **Author filter is fixed-string, not regex** — a deliberate choice to avoid silently matching zero commits for perfectly ordinary emails/names. (Surprising; intentional.)
- **The candidate/emit split is intentional:** neighbours that are already summarized or out of the requested range are still passed in so they truncate attribution windows, but they never receive a new outcome. (Notable.)
- **A cooperative cancellation signal lets a caller stop between commits without corrupting state** — checked only at the commit boundary; an in-flight commit's generation is never interrupted. The guided front door's cold-start offer uses this for its Ctrl-C handling. (Notable.)

## Unreachable / Not-live

- The "enable-time worker" callers named in internal docstrings are **not live** (see Notable Behavior) — enabling the product does not run back-fill.

## Shared Behavior

- The default minimum tier (**low**) is the single tier every entry point uses; the CLI exposes it as a flag override (see **CLI Back-fill Command**).
- Index building and attribution are owned by **Back-fill Commit Target Index**, **Back-fill Raw Transcript Scanning**, and **Back-fill Commit Attribution Algorithm**.
- Summary generation and storage are the same paths the live post-commit pipeline uses.
- The post-batch ingest uses the `manual` tag with force-cooldown-bypass — see **Topic-KB Ingest Trigger and Cooldown**.
- The own-author filter (email OR name, fixed-string) is shared with the branch commit lister and the read-only signal queries in **Back-fill Cold-start Signal Queries**.
- The cooperative-cancellation signal and the pre-generation callback are consumed today only by the CLI guided front door's cold-start offer.
