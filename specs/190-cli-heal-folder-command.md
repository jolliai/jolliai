# 190. CLI Heal-Folder Command

## Topic Statement

Re-emit the visible-layer Markdown copies that the manifest tracks but the filesystem no longer contains, from a single explicit terminal invocation scoped to one project directory.

## Scope

**In scope:**
- The single invocation form of the command (one project, one pass, no scheduling, no watcher).
- Resolution of the project directory the heal pass operates on.
- Resolution of the active storage mode the user-global configuration declares for this invocation.
- The gating that decides whether a heal pass is even attempted (storage-mode-dependent capability check on the active storage layer).
- The flag passed to the heal pass that decides whether manifest rows whose hidden source is also missing may be dropped, based on the active storage mode.
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
- The user-global configuration file format. Only the storage-mode field is consulted.
- Concurrent invocations or coordination with any sync engine, vault write lock, or queue worker. This command takes no lock of its own and assumes the heal pass is internally re-entrant or self-locking.

## Data Contracts

### Inputs

- A single optional flag specifying the project directory to operate on. When absent, the directory defaults to the auto-detected version-control top-level of the current working directory; when no version-controlled enclosing directory exists, it defaults to the current working directory.
- The user-global configuration document is consulted (best-effort) for a single field naming the active storage mode. The field's recognized values are: `folder` (visible-layer only), `orphan` (durable-ref-store only, no visible layer), and `dual-write` (both layers active). Any other value, an absent field, or any error opening the configuration is coerced to `dual-write`.

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
- Two debug-log entries per invocation: one at start naming the command, one at end summarizing either the final counts or the error message.

## Behavior

### Project-directory resolution

The optional flag value (or its default — the auto-detected version-control top-level, falling back to the current working directory) is used as the project root for everything that follows: the debug log directory, the active-storage construction, and any path the heal pass derives.

### Storage-mode read

The user-global configuration is opened. If the open succeeds and the storage-mode field is the literal string `folder` or `orphan`, that value is used. In every other case — field absent, field present with any other value, open fails for any reason — the storage mode is coerced to `dual-write`. The command never refuses to run because the configuration is missing or unreadable; recovery commands must remain usable on a broken global configuration.

### Active-storage construction

The active storage layer is constructed for the resolved project directory. If construction throws:
- A two-line abort message is written to standard error: a first line "Heal aborted: cannot open Memory Bank storage." with the underlying error's message appended, and a second line directing the operator to run the diagnostic command by its CLI name (`jolli doctor`) to investigate the underlying configuration or storage issue.
- The exit code is set to `1`.
- An error-level debug-log line records the construction failure.
- The command returns.

### Heal-capability check

The constructed storage layer is inspected for the optional heal-missing-visible-markdown capability. If the capability is not present (the active storage layer has no visible layer to heal — the orphan-only mode), a single informational line is printed to standard output explaining that heal is not available in the current configuration and instructing the operator to switch the storage mode to `dual-write` or `folder` via the configure command. The exit code is `0` (this is not a failure; the operator simply asked for an operation that does not apply). The command returns.

### Heal-pass invocation

A progress line is printed to standard output announcing the manifest scan.

The heal pass is invoked with a single option deciding whether manifest rows whose hidden source is also missing may be permanently dropped:
- In `dual-write` mode the option is `true`. Rationale captured from source: the durable-ref-store is the system of record in this mode, so a manifest row that has lost its hidden source can be re-populated by a separate `enable` operation later, and keeping the unrecoverable row in the manifest would only cause subsequent passes to re-report it.
- In `folder` mode the option is `false`. Rationale captured from source: there is no truth source to re-populate from, so dropping a row is permanent data loss. The pass still counts unrecoverable rows as `failed` for visibility but never deletes them.
- In `orphan` mode this branch is unreachable — the capability check above already returned.

The invocation is wrapped in a single error guard that catches any synchronous or asynchronous throw:
- If a throw escapes the heal pass (the case when the underlying provider does not self-catch — folder-only storage), the abort path is taken: two lines on standard error, the first prefixed "Heal errored:" with (when the underlying error carries an errno-style code) the bracketed code inserted immediately before the message; the second instructing the operator to resolve the underlying error (storage permissions, disk space) and re-run. The exit code is `1`. An error-level debug-log line records the throw with code and message. The command returns.
- If no throw escapes, the returned result record proceeds to the result-classification step below.

### Result classification

The result record is dispatched into one of five output branches in this order:

1. **Surfaced error (recoverable-error branch).** When the `error` field is present (the case when the active storage layer self-catches a delegated heal failure and surfaces it via the result rather than throwing), three lines are written to standard error: "Heal errored:" with the surfaced message; a "Counts may be partial:" line echoing all three numeric fields; and the same "resolve and re-run" instruction. The exit code is `1`. An error-level debug-log line records the surfaced error. This branch is taken even when all three counts are zero; the operator explicitly ran a recovery command and MUST NOT be told "no heal needed" when the pass actually aborted partway through.

2. **No-op, empty manifest.** When `healed`, `failed`, and `skipped` are all zero, a single line "Manifest is empty — nothing to heal." is printed to standard output. The exit code is `0`. An informational debug-log line records the no-op outcome.

3. **No-op, fully consistent.** When `healed` and `failed` are zero but `skipped` is non-zero, a single line "No heal needed." is printed to standard output, with the skipped count appended. The exit code is `0`. An informational debug-log line records the no-op outcome with the skipped count.

4. **Partial or full success.** When `healed` or `failed` is non-zero, an operator-facing block is printed to standard output in this exact order, with each line omitted when the corresponding count is zero:

   - A "Healed:" line with the count and the phrase "visible .md file(s) regenerated from hidden JSON" — printed only when `healed > 0`.
   - A "Skipped:" line with the count and the disambiguation phrase "already on disk or path-drifted — run `jolli reconcile` to resolve drift" — printed only when `skipped > 0`. The phrase explicitly references the separate reconcile command by its CLI name because the `skipped` count conflates the path-drift case (which the operator can resolve only by running reconcile) with the already-on-disk case (which needs no action).
   - A "Failed:" line with the count and the phrase "(hidden JSON missing, malformed, or read-blocked)" — printed only when `failed > 0`. Beneath the failed line, a continuation block is printed whose contents depend on whether `droppedIds` is non-empty AND on the active storage mode:
       - **Dropped-IDs non-empty.** A "Dropped from manifest:" continuation line with the count, followed by an indented preview line listing the first five identifiers truncated to their first eight characters separated by ", ". When the dropped count exceeds five, ", ..." is appended after the last truncated identifier. A final continuation line instructs the operator to re-run the `enable` command (named by its CLI name) to repopulate from the durable-ref-store.
       - **Dropped-IDs empty AND mode is `folder`.** Two continuation lines: one stating "Manifest entries kept (folder-only mode has no truth source to repopulate)." and one instructing the operator to inspect the manifest file (named verbatim as `.jolli/manifest.json`) and either restore the hidden source or remove the row manually.
       - **Dropped-IDs empty AND mode is `dual-write`.** A single continuation line "Manifest entries kept (transient read error). Re-run later." pointing the operator at retry rather than at a manual fix.

   The block ends with a trailing blank line. The exit code is `0` even when `failed` is non-zero — the pass itself completed; the failures are reported but not promoted to an exit-code failure. An informational debug-log line records all three counts.

### Exit-code summary

- `0` on every non-error branch: heal-capability-absent, empty manifest, no heal needed, partial success, full success (including pure-failed-but-completed).
- `1` on every error branch: active-storage construction threw, heal pass threw and the guard caught it, heal pass surfaced an error via the result record.

### Debug-log emission

A start-of-command informational line is emitted unconditionally before storage construction. An end-of-command line is emitted on every terminal branch — informational on success branches (carrying either the skipped count for no-ops or all three counts for success branches), error on every abort branch (carrying the error message and, when present, the errno-style code).

## State Transitions

The command itself owns no persistent state. State mutation is delegated entirely to the heal pass invoked through the active storage layer:

- The visible-layer Markdown files re-emitted by the pass are a per-entry side effect counted in `healed`.
- The manifest file may be rewritten by the pass to drop unrecoverable rows when (and only when) the active storage mode is `dual-write`; the rewritten rows are returned in `droppedIds`.
- The debug log gains exactly two lines per invocation (start + end), or three when an error branch is taken (start + storage failure + end).

The user-global configuration is read-only for this command.

## Notable Behavior

- **The command never refuses to run because the user-global configuration is unreadable.** A throw while opening the configuration is silently coerced to the `dual-write` default. Rationale captured from source: the operator can still run heal on a project whose global configuration has become unreadable; failing closed at config-read time would lock the operator out of the recovery path that exists precisely for those situations. (Intentional.)
- **The exit code is `0` on the pure-failed branch.** When some entries failed but the pass itself completed, the exit code remains `0`. The failures are visible in the per-line block, but the command does not promote them to a process-level failure. Only an aborted pass (thrown or surfaced error) returns `1`. (Notable; intentional.)
- **Surfaced error always wins over the no-op branches.** Even when all three counts are zero, a present `error` field routes to the "Heal errored" branch with exit `1`, never to "Manifest is empty" or "No heal needed". The operator explicitly invoked a recovery command and MUST NOT be told the pass was a no-op when it actually aborted. (Notable; intentional.)
- **The `skipped` counter is intentionally ambiguous between "file already on disk" and "manifest path drifted".** The command does not distinguish them in output beyond the single disambiguation phrase pointing at the reconcile command. Rationale captured from source: heal explicitly refuses to silently rewrite a manifest's recorded path, because doing so would orphan whatever visible artifact the user has been navigating to; the reconcile command owns drift resolution. (Notable; intentional.)
- **The dropped-IDs preview is capped at five and always truncated to the first eight characters.** When more than five rows were dropped, the preview ends with ", ..." rather than expanding to a long block. The cap is intentional: a heavy manifest cleanup could otherwise dump hundreds of identifiers into the operator's terminal. The eight-character truncation matches the convention used elsewhere in operator-facing output. (Notable; intentional.)
- **The output classification refuses to collapse zero-zero into "Manifest is empty" when `skipped` is non-zero.** A pass that skipped every entry (all files were on disk) is the "No heal needed" branch, not the "Manifest is empty" branch. Telling the operator the manifest is empty when it actually contains entries would mislead later diagnostic work. (Notable; intentional.)
- **The errno-style code is prepended to the throw-caught error message when present.** A bare error message often lacks the code (`EACCES` vs. `ENOSPC` vs. `EBUSY`) that drives the operator's next step. Captured failures from the heal pass surface the code in square brackets immediately before the message in standard error and in the debug log. (Notable; intentional.)
- **The `dual-write` failure continuation line says "transient read error. Re-run later."** even when the underlying cause was not transient. The active storage layer does not (and cannot, without re-reading) distinguish a transient lock from a permanent corruption among the `failed` rows; the command defers diagnosis to the operator. (Notable.)
- **The command takes no lock of its own and coordinates with no other writer.** A concurrent sync engine, vault-side commit operation, or queue-worker pass against the same manifest could observe an interleaved state. Per-storage-layer atomicity is the heal pass's responsibility; this command relies on it. (Notable.)
- **The heal-capability check is the only mechanism that gates orphan-only mode.** A configuration explicitly set to `orphan` reaches storage construction, then short-circuits at the capability check with an informational message and exit `0`. There is no flag to force a heal pass against orphan-only storage. (Notable; intentional.)
- **The capability check also absorbs a refused Memory Bank write boundary, and reports it as a storage-mode problem.** Storage construction degrades to the durable-ref-store-only layer when the write boundary refuses the resolved project directory (covered by the memory-bank write-boundary and effective-state-reporting topic). Such a run reaches the same capability check and prints the same line — telling the operator the repository "is configured for orphan-only storage" and to set the storage mode to `dual-write`, even when the configured mode already *is* `dual-write` and the real blocker is the project directory or the folder's placement. The exit code is still `0`. The operator's actual diagnostic is the Memory Bank row of the status report, which names the blocker; this command does not consult it. (Surprising; observable gap.)
- **The trailing blank line on the success branch is part of the contract.** A success or partial-success block always ends with an empty line on standard output, separating the block from any subsequent shell prompt; the no-op branches and the error branches do not emit the same trailing blank in the same place. (Notable.)
- **The `--cwd` flag is the only flag.** There is no dry-run mode, no all-projects scope, no verbose flag, no JSON-output flag, no force-drop flag. Every behavior toggle (dropping vs. keeping manifest rows) is driven by the active storage mode read from the user-global configuration, not by command-line arguments. (Notable.)

## Shared Behavior

- **Folder-based summary storage** — covered by the folder-based-summary-storage topic. Owns the heal-missing-visible-markdown pass itself: the per-entry rules that decide whether each manifest row is healed, skipped, or failed; the manifest-vs-computed-path drift check; the batch-drop step; and the persisted shapes of the manifest, the per-entry hidden source files, and the per-branch visible folders.
- **Dual-write summary storage** — covered by the dual-write-summary-storage topic. Decides which side of the dual-write pair receives the heal call and how delegated failures are self-caught versus propagated. The default for the drop-orphaned-manifest-entries option at that seam is `true`, and the operator-facing command preserves that default by passing `true` whenever it knows the active mode is dual-write.
- **Memory-bank folder layout** — covered by the memory-bank-folder-layout topic. Defines the visible-layer per-branch directory structure, the branch-name-to-folder-name transcoding, and the manifest registry the heal pass reads.
- **Stale-child markdown cleanup** — covered by the stale-child-markdown-cleanup topic. A different recovery pass that *deletes* visible Markdown for non-head entries. This command never invokes that sweep and has no interaction with it beyond sharing the same visible-layer storage.
- **Manifest path-drift reconciliation** — pointed at by the operator-facing "run `jolli reconcile` to resolve drift" hint. The reconciliation command is the only place that may rewrite a manifest's recorded path; heal explicitly refuses to.
- **Manifest re-population from the durable-ref-store** — pointed at by the operator-facing "Re-run `jolli enable` to repopulate from the orphan branch." hint. That command can re-source dropped manifest rows from the durable-ref-store when the active mode is `dual-write`.
- **Diagnostic command** — pointed at by the operator-facing "Run `jolli doctor` to diagnose…" hint on the storage-construction failure branch. The diagnostic command's own behavior is outside this topic; this command only references it by name.
