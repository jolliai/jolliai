# 190. CLI Heal-Folder Command

## Topic Statement

Re-emit the visible-layer Markdown copies that the manifest tracks but the filesystem no longer contains, from a single explicit terminal invocation scoped to one project directory.

## Scope

**In scope:**
- The single invocation form of the command (one project, one pass, no scheduling, no watcher).
- Resolution of the project directory the heal pass operates on.
- Resolution of the repository's cutover routing state, and the one state in which this command permits destructive manifest cleanup.
- The gating that decides whether a heal pass is even attempted (a capability check on the constructed storage layer, which passes only when that layer has a visible layer to heal).
- The flag passed to the heal pass that decides whether manifest rows whose hidden source is also missing may be dropped, and the routing state that decides its value.
- The shape of the result the heal pass returns and how each field steers operator-facing output.
- The classification and formatting of every terminal-output branch (no-op, partial success, full success, recoverable-error, abort).
- Exit-code contract.
- Logging of the pass start and the pass outcome to the project's debug log.
- Error containment: every read or storage failure that could otherwise escape as an uncaught rejection is converted into the same error-output branch with the same exit code.

**Out of scope (boundaries):**
- The selection, comparison, and regeneration rules that the heal pass itself applies per manifest entry (which file gets re-emitted, what hidden source is consulted, how path drift is detected, what the per-entry success / skip / fail criteria are). This command consumes the heal pass's result record only; the heal pass is specified by the folder-storage topic.
- The on-disk structure of the visible-layer per-branch folders, the manifest file, and the hidden per-entry source files. Covered by the folder-based summary storage topic.
- The deletion-only sweep that removes visible Markdown for hoisted (non-head) entries. That sweep is a separate operation specified by the stale-child-markdown-cleanup topic.
- The dual-write layer's choice of which side (durable-ref-store vs. folder-mirror) actually owns the heal capability and how it forwards. The command treats the active storage as an opaque provider exposing one optional heal method.
- The reconciliation operation that resolves manifest-vs-on-disk path drift; this command only reports drifted entries and points the operator to that other command by name.
- The pre-populate command (`enable`) that can re-source manifest rows from the durable-ref-store; this command only points the operator to it when manifest rows were dropped.
- The diagnostic command (`doctor`) that the operator is told to run when the storage layer fails to open; this command only references it by name.
- How the routing state is derived: the two witnesses behind it (a per-clone freeze marker and a database row), their precedence, and the rest of the state table. Covered by the cutover-routing-state topic; this command consumes exactly one bit of it — is the repository still in the pre-cutover state?
- The user-global configuration. This command reads none of it; the storage layer it constructs does its own reading, including of the retired storage-mode key.
- Concurrent invocations or coordination with any sync engine, vault write lock, or queue worker. This command takes no lock of its own and assumes the heal pass is internally re-entrant or self-locking.

## Data Contracts

### Inputs

- A single optional flag specifying the project directory to operate on. When absent, the directory defaults to the auto-detected version-control top-level of the current working directory; when no version-controlled enclosing directory exists, it defaults to the current working directory.
- The repository's cutover routing state, resolved for that project directory. Only one distinction matters here: whether the state is the pre-cutover one (the durable-ref-store is still the system of record) or anything else. Any failure to resolve the state at all is treated as "not pre-cutover".

### Heal result record (consumed only)

A structured record with the following fields:

- `healed`: integer count of visible Markdown files that were re-emitted this pass.
- `skipped`: integer count of manifest entries that did not need re-emission. This count combines two semantically distinct cases the command does not distinguish: (a) the visible file was already on disk; (b) the manifest's recorded path drifted from the path the heal pass would have computed, and the pass refused to overwrite it.
- `failed`: integer count of manifest entries that could not be re-emitted (hidden source missing, hidden source unreadable for transient reasons, hidden source malformed, or the per-entry regenerate step refused).
- `droppedIds`: optional ordered list of manifest-entry identifiers that were removed from the manifest because their hidden source was also missing. Empty list or absent when nothing was dropped.
- `error`: optional human-readable error string. Present when the heal pass aborted partway through; in that case all numeric counts are explicitly partial and MUST NOT be treated as a no-op.

### Outputs

- Operator-facing lines on standard output (success / no-op / partial-success branches) or standard error (recoverable-error / abort branches), shaped as described in the Behavior section.
- A process exit code: `0` on every non-error branch (including the partial-success branch where some entries failed but the pass itself completed); non-zero on every error branch (storage-open failure, heal-pass thrown error, heal-pass surfaced-error).
- Debug-log entries: one at start naming the command, one at end summarizing either the final counts or the error message, plus a warning line when the routing state could not be resolved.

## Behavior

### Project-directory resolution

The optional flag value (or its default — the auto-detected version-control top-level, falling back to the current working directory) is used as the project root for everything that follows: the debug log directory, the active-storage construction, and any path the heal pass derives.

### Drop-permission resolution

Before anything else — before the storage layer is even constructed — the repository's cutover routing state is resolved for the project directory, and the answer is reduced to a single boolean: manifest rows whose hidden source is also missing may be dropped **only** in the pre-cutover state.

- Pre-cutover: dropping is permitted. The durable-ref-store is still the system of record, so a row that has lost its hidden source can be re-sourced later by a separate `enable` operation.
- Every other state (the repository's durable ref is frozen, or the switch to the database has been recorded): dropping is refused. The frozen ref cannot repopulate anything, and no re-projection from the database back into the visible folder exists, so a drop would be permanent data loss presented as a repair.
- Resolution failed for any reason: dropping is refused, and a warning is recorded in the debug log. A stale row costs one `failed` count in this command's own report; a wrong drop costs the memory.

Because this runs first, it is resolved even on the branches that never invoke the heal pass at all (storage construction failed, or the constructed layer has nothing to heal).

The command never refuses to run because the routing state is unavailable; recovery commands must remain usable on a repository whose state cannot be read.

### Active-storage construction

The active storage layer is constructed for the resolved project directory. Construction is also where an unroutable repository — one whose durable ref is frozen and whose database cannot answer — surfaces, as a throw naming that condition. If construction throws:
- A two-line abort message is written to standard error: a first line "Heal aborted: cannot open Memory Bank storage." with the underlying error's message appended, and a second line directing the operator to run the diagnostic command by its CLI name (`jolli doctor`) to investigate the underlying configuration or storage issue.
- The exit code is set to `1`.
- An error-level debug-log line records the construction failure.
- The command returns.

### Heal-capability check

The constructed storage layer is inspected for the optional heal-missing-visible-markdown capability. If the capability is not present, the layer has no visible Markdown to heal, and a single informational line is printed to standard output: "Heal not available: this repo has no visible Memory Bank folder to heal (orphan-only storage, or a fenced/cut-over repo not yet paired with the folder layer). Run `jolli doctor` to check this repo's storage state." The exit code is `0` (this is not a failure; the operator simply asked for an operation that does not apply). The command returns.

Both spellings the message offers are reachable, and both arise the same way — the visible folder side was dropped at construction because the project directory was refused by the Memory Bank write boundary. In the pre-cutover state that leaves the durable-ref-store alone; in a fenced or cut-over state it leaves the database-backed layer alone. Neither has a visible layer, so both land here.

### Heal-pass invocation

A progress line is printed to standard output: "Scanning Memory Bank manifest for missing visible Markdown files...".

The heal pass is then invoked with the single drop-permission option resolved above. A refused permission does not suppress reporting: the pass still counts unrecoverable rows as `failed` for visibility, it simply never deletes them.

The invocation is wrapped in a single error guard that catches any synchronous or asynchronous throw:
- If a throw escapes the heal pass, the abort path is taken: two lines on standard error, the first prefixed "Heal errored:" with (when the underlying error carries an errno-style code) the bracketed code inserted immediately before the message; the second instructing the operator to resolve the underlying error (storage permissions, disk space) and re-run. The exit code is `1`. An error-level debug-log line records the throw with code and message. The command returns.

  **This guard is unreachable at HEAD.** The only storage layer that can reach the heal call from this command is the dual-write composite, and that composite catches its own delegated failure and reports it through the result record's `error` field instead of throwing. The guard is a live defence against a future single-layer provider that does not self-catch, but no construction this command performs produces one.
- If no throw escapes, the returned result record proceeds to the result-classification step below.

### Result classification

The result record is dispatched into one of four output branches, tested in this order:

1. **Surfaced error (recoverable-error branch).** When the `error` field is present — the case when the active storage layer self-catches a delegated heal failure and surfaces it via the result rather than throwing, which at HEAD is the *only* way a failed pass reaches the operator — three lines are written to standard error. The surfaced message already carries the bracketed errno-style code when the underlying failure had one; this command prints it verbatim rather than re-deriving it. The three lines are: "Heal errored:" with the surfaced message; a "Counts may be partial:" line echoing all three numeric fields; and the same "resolve and re-run" instruction. The exit code is `1`. An error-level debug-log line records the surfaced error. This branch is taken even when all three counts are zero; the operator explicitly ran a recovery command and MUST NOT be told "no heal needed" when the pass actually aborted partway through.

2. **No-op, empty manifest.** When `healed`, `failed`, and `skipped` are all zero, a single line "Manifest is empty — nothing to heal." is printed to standard output. The exit code is `0`. An informational debug-log line records the no-op outcome.

3. **No-op, fully consistent.** When `healed` and `failed` are zero but `skipped` is non-zero, a single line is printed to standard output: "No heal needed." followed by "Skipped:" with the skipped count and the word "existing file(s)". The exit code is `0`. An informational debug-log line records the no-op outcome with the skipped count.

4. **Partial or full success.** When `healed` or `failed` is non-zero, an operator-facing block is printed to standard output in this exact order, with each line omitted when the corresponding count is zero:

   - A "Healed:" line with the count and the phrase "visible .md file(s) regenerated from hidden JSON" — printed only when `healed > 0`.
   - A "Skipped:" line with the count and the disambiguation phrase "already on disk or path-drifted — run `jolli reconcile` to resolve drift" — printed only when `skipped > 0`. The phrase explicitly references the separate reconcile command by its CLI name because the `skipped` count conflates the path-drift case (which the operator can resolve only by running reconcile) with the already-on-disk case (which needs no action).
   - A "Failed:" line with the count and the phrase "(hidden JSON missing, malformed, or read-blocked)" — printed only when `failed > 0`. Beneath the failed line, a continuation block is printed whose contents depend on whether `droppedIds` is non-empty AND, when it is empty, on the drop permission resolved at the top of the run:
       - **Dropped-IDs non-empty.** A "Dropped from manifest:" continuation line with the count, followed by an indented preview line listing the first five identifiers truncated to their first eight characters separated by ", ". When the dropped count exceeds five, ", ..." is appended after the last truncated identifier. A final continuation line reads "Re-run `jolli enable` to repopulate from the orphan branch."
       - **Dropped-IDs empty AND dropping was refused.** Two continuation lines: "Manifest entries kept (no truth source to repopulate from)." and one instructing the operator to inspect the manifest file (named verbatim as `.jolli/manifest.json`) and either restore the hidden source or remove the row manually. This is the branch a fenced repository, a cut-over repository, and a repository whose routing state could not be resolved all take.
       - **Dropped-IDs empty AND dropping was permitted.** A single continuation line "Manifest entries kept (transient read error). Re-run later." pointing the operator at retry rather than at a manual fix. Only a pre-cutover repository reaches it — the pass was allowed to drop and declined to, so every failure it saw was something other than a missing hidden source.

   The block ends with a trailing blank line. The exit code is `0` even when `failed` is non-zero — the pass itself completed; the failures are reported but not promoted to an exit-code failure. An informational debug-log line records all three counts.

### Exit-code summary

- `0` on every non-error branch: heal-capability-absent, empty manifest, no heal needed, partial success, full success (including pure-failed-but-completed).
- `1` on every error branch: active-storage construction threw, heal pass threw and the guard caught it, heal pass surfaced an error via the result record.

### Debug-log emission

A start-of-command informational line is emitted unconditionally, ahead of both the drop-permission resolution and storage construction. A warning line follows it whenever the routing state could not be resolved, naming the underlying reason and stating that no manifest entries will be dropped. An end-of-command line is emitted on every terminal branch — informational on success branches (carrying either the skipped count for no-ops or all three counts for success branches), error on every abort branch (carrying the error message and, when present, the errno-style code).

## State Transitions

The command itself owns no persistent state. State mutation is delegated entirely to the heal pass invoked through the active storage layer:

- The visible-layer Markdown files re-emitted by the pass are a per-entry side effect counted in `healed`.
- The manifest file may be rewritten by the pass to drop unrecoverable rows when (and only when) the repository is in the pre-cutover routing state; the rewritten rows are returned in `droppedIds`.
- The debug log gains a start line and an end line per invocation, plus an error line when an error branch is taken, plus a warning line when the routing state could not be resolved.

The routing state and the user-global configuration are read-only for this command; it writes neither.

## Notable Behavior

- **The destructive half of this command is gated on the routing state, deliberately and explicitly not on the retired storage-mode configuration key.** That key is ignored on the write side, so reading it here answered "both layers active" for every repository — including the fenced and cut-over ones whose durable ref can no longer repopulate anything, which are exactly the repositories the gate exists to protect. The drop it would then have authorised is unrecoverable, so this is the one place where reading the retired key was not merely inert but destructive. (Notable; intentional.)
- **An unresolvable routing state does not stop the run; it only removes drop permission.** The operator can still heal a repository whose state cannot be read — the pass runs, re-emits what it can, and reports every unrecoverable row as `failed` while deleting nothing. Failing closed on the state read would lock the operator out of the recovery path that exists precisely for a repository in trouble. (Intentional.)
- **The pre-cutover state is the only state in which any row is dropped.** A frozen repository, a cut-over repository, and a repository whose state is unknown all keep every manifest row, no matter how many of them have lost their hidden source. There is no re-projection from the database back into the visible folder, so a drop past the freeze is unrecoverable. (Notable; intentional.)
- **The exit code is `0` on the pure-failed branch.** When some entries failed but the pass itself completed, the exit code remains `0`. The failures are visible in the per-line block, but the command does not promote them to a process-level failure. Only an aborted pass (thrown or surfaced error) returns `1`. (Notable; intentional.)
- **Surfaced error always wins over the no-op branches.** Even when all three counts are zero, a present `error` field routes to the "Heal errored" branch with exit `1`, never to "Manifest is empty" or "No heal needed". The operator explicitly invoked a recovery command and MUST NOT be told the pass was a no-op when it actually aborted. (Notable; intentional.)
- **The `skipped` counter is intentionally ambiguous between "file already on disk" and "manifest path drifted".** The command does not distinguish them in output beyond the single disambiguation phrase pointing at the reconcile command. Rationale captured from source: heal explicitly refuses to silently rewrite a manifest's recorded path, because doing so would orphan whatever visible artifact the user has been navigating to; the reconcile command owns drift resolution. (Notable; intentional.)
- **The dropped-IDs preview is capped at five and always truncated to the first eight characters.** When more than five rows were dropped, the preview ends with ", ..." rather than expanding to a long block. The cap is intentional: a heavy manifest cleanup could otherwise dump hundreds of identifiers into the operator's terminal. The eight-character truncation matches the convention used elsewhere in operator-facing output. (Notable; intentional.)
- **The output classification refuses to collapse zero-zero into "Manifest is empty" when `skipped` is non-zero.** A pass that skipped every entry (all files were on disk) is the "No heal needed" branch, not the "Manifest is empty" branch. Telling the operator the manifest is empty when it actually contains entries would mislead later diagnostic work. (Notable; intentional.)
- **The errno-style code reaches the operator in square brackets ahead of the message — but only via the surfaced-error branch at HEAD.** A bare error message often lacks the code (`EACCES` vs. `ENOSPC` vs. `EBUSY`) that drives the operator's next step, so the bracketed code is inserted immediately before the message. The same formatting is specified in two places — on this command's own throw guard and in the storage layer that composes the surfaced message — and because the guard is unreachable, the one that actually runs is the storage layer's, which has already applied it by the time this command prints. (Notable; intentional, stated twice.)
- **The "transient read error. Re-run later." continuation line is printed even when the underlying cause was not transient.** The active storage layer does not (and cannot, without re-reading) distinguish a transient lock from a permanent corruption among the `failed` rows; the command defers diagnosis to the operator. (Notable.)
- **The throw guard around the heal pass is unreachable at HEAD.** Every storage layer this command can construct that has anything to heal is the dual-write composite, which self-catches and reports through the result record. The guard, its distinct wording, and its own errno formatting exist for a single-layer provider that does not self-catch — which this command never constructs. (Unreachable; retained as a defence.)
- **The command takes no lock of its own and coordinates with no other writer.** A concurrent sync engine, vault-side commit operation, or queue-worker pass against the same manifest could observe an interleaved state. Per-storage-layer atomicity is the heal pass's responsibility; this command relies on it. (Notable.)
- **The capability check is the only mechanism that gates a layer with no visible folder, and there is no flag to override it.** A storage layer without the heal capability reaches construction, then short-circuits with an informational message and exit `0`. (Notable; intentional.)
- **What actually lands on that branch is a refused Memory Bank write boundary, and the message names two storage shapes rather than the real blocker.** Construction drops the folder side when the write boundary refuses the resolved project directory (covered by the memory-bank write-boundary and effective-state-reporting topic), leaving a layer with nothing to heal. The printed line offers "orphan-only storage, or a fenced/cut-over repo not yet paired with the folder layer" — neither of which is the cause; the cause is the project directory or the folder's placement, which the line never mentions. Its "Run `jolli doctor`" pointer is what closes the gap, since the Memory Bank row of the status report names the blocker. The exit code is still `0`. (Surprising; observable gap, partly mitigated by the pointer.)
- **Every terminal branch ends with a blank line on whichever stream it wrote to**, separating the output from any subsequent shell prompt. The success block ends with an explicit empty write after its last count line; every other branch gets the same effect from a trailing newline inside its own last line. (Notable.)
- **The `--cwd` flag is the only flag.** There is no dry-run mode, no all-projects scope, no verbose flag, no JSON-output flag, no force-drop flag. The one behaviour toggle (dropping vs. keeping manifest rows) is driven by the repository's routing state, not by command-line arguments, so an operator who wants a row dropped on a fenced repository has no way to ask for it. (Notable.)

## Shared Behavior

- **Folder-based summary storage** — covered by the folder-based-summary-storage topic. Owns the heal-missing-visible-markdown pass itself: the per-entry rules that decide whether each manifest row is healed, skipped, or failed; the manifest-vs-computed-path drift check; the batch-drop step; and the persisted shapes of the manifest, the per-entry hidden source files, and the per-branch visible folders.
- **Dual-write summary storage** — covered by the dual-write-summary-storage topic. Decides which side of the dual-write pair receives the heal call and how delegated failures are self-caught (surfaced through the result record) versus propagated. Its own default for the drop-orphaned-manifest-entries option at that seam is permissive, but this command always passes the option explicitly, so that default is never exercised from here.
- **Cutover routing state table** — covered by the cutover-routing-state topic (344), with the freeze marker and the recorded switch behind it covered by (345). Owns the two witnesses, their precedence and the full state table; this command is one of its listed consumers, and consumes only the pre-cutover-or-not distinction.
- **Memory-bank folder layout** — covered by the memory-bank-folder-layout topic. Defines the visible-layer per-branch directory structure, the branch-name-to-folder-name transcoding, and the manifest registry the heal pass reads.
- **Stale-child markdown cleanup** — covered by the stale-child-markdown-cleanup topic. A different recovery pass that *deletes* visible Markdown for non-head entries. This command never invokes that sweep and has no interaction with it beyond sharing the same visible-layer storage.
- **Manifest path-drift reconciliation** — pointed at by the operator-facing "run `jolli reconcile` to resolve drift" hint. The reconciliation command is the only place that may rewrite a manifest's recorded path; heal explicitly refuses to.
- **Manifest re-population from the durable-ref-store** — pointed at by the operator-facing "Re-run `jolli enable` to repopulate from the orphan branch." hint. That command can re-source dropped manifest rows from the durable-ref-store — which is why the drop is only permitted while that store is still the system of record.
- **Diagnostic command** — pointed at by the operator-facing "Run `jolli doctor` to diagnose…" hint on the storage-construction failure branch. The diagnostic command's own behavior is outside this topic; this command only references it by name.
