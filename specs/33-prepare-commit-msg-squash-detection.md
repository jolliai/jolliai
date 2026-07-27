# 33. Prepare-Commit-Msg Squash Detection

## Topic Statement
Detect, before a commit is finalized, that the operation in progress is one of two squash patterns — a merge-squash (the VCS pre-staged a multi-commit message) or a manual reset-then-commit (the user moved the branch tip backwards via a soft reset and is now creating a single replacement commit) — and write a pending-state file the post-commit hook will later consume to enqueue a squash queue entry.

## Scope
**In scope:**
- The hook's contract with the VCS (when invoked, the meanings of its positional arguments).
- The repo-wide manual-disable gate read before any detection, and its downstream consequence for the post-commit consumer.
- Detection of merge-squash via the well-known squash-message file the VCS writes inside the metadata directory.
- Detection of manual reset-squash via the multi-layer validation routine described in **Git Operation Type Detection**.
- The schema and target location of the pending-state file written on positive detection.
- Worktree-aware resolution of the metadata directory used to find the squash-message file.
- Non-fatal handling: any failure (parse, read, detection) lets the commit proceed normally.

**Out of scope (boundaries):**
- The classification logic for the manual reset-squash itself (covered by **Git Operation Type Detection** §"Reset-squash detection").
- Consumption of the pending-state file at post-commit time (covered by **Post-Commit Hook Enqueue**).
- Amend detection — explicitly removed from this hook in the canonical implementation; amend is handled by the post-commit + post-rewrite pair (covered by **Git Operation Type Detection**, **Post-Commit Hook Enqueue**, **Post-Rewrite Hook Handling**).
- The worker that processes the squash queue entry (covered by the queue-worker spec).
- The orphan-branch storage of summaries (covered by orphan-branch storage spec).

## Data Contracts

### Hook contract
- The VCS invokes this hook before the commit message is finalized. It receives up to three positional arguments:
  - 1st: the path to the prepared commit-message file (this hook does not modify it).
  - 2nd: a "source" string identifying how the message came to be. Conventional values seen include `squash` (merge-squash), `commit` (using an existing commit's metadata, e.g. amend or `-C`), `message` (a `-m` invocation), and unset/empty (default editor-driven path).
  - 3rd: the SHA1 of an existing commit, present only when the second argument is `commit`.
- The hook is expected not to block; it performs only file reads/writes and lightweight VCS plumbing operations. Exit status is observed but the hook always returns cleanly even on internal errors — it never blocks the commit.

### Inputs
- The "source" argument value (above).
- The current working directory (taken to be the project root).
- The VCS-written squash-message file at a well-known path inside the resolved metadata directory; this file is present only during the merge-squash flavor and contains, in plain text, the concatenated original messages along with explicit `commit <40-hex-hash>` headers for each squashed source commit.
- The most recent reflog entry's subject (used by the manual reset-squash branch).
- The pre-operation tip ref written by the VCS before destructive operations (used by the manual reset-squash branch).
- The current branch tip, resolved via the VCS.
- Any pre-existing pending-state file at the well-known product-namespace path (used by the manual reset-squash branch's pre-existence guard).

### Pending-state file
A JSON document written at the well-known path under the product-namespace state directory inside the working tree, with these fields:
- `sourceHashes`: a non-empty list of 40-hex-character commit hashes corresponding to the commits being collapsed into the about-to-be-created commit.
- `expectedParentHash`: the current branch tip at the moment this hook ran (i.e. the parent the new squash commit will have once finalized). Used downstream as a stale-file guard.
- `createdAt`: an ISO-8601 timestamp captured at write time.

This is the same file consumed by **Post-Commit Hook Enqueue**; the schema is shared with **Git Operation Type Detection**.

### Resolved metadata directory
Same resolution routine as in **Git Operation Type Detection** §"Resolved git directory": if the project's `.git` entry is a directory, use it directly; if it is a file containing `gitdir: <path>`, parse that and resolve relative paths against the project root. This matters here for locating the VCS-written squash-message file in secondary working trees.

## Behavior

### Top-level dispatch on the "source" argument
1. Configure the logger to write inside the project's product-namespace log directory.
2. **Repo-wide manual-disable gate.** Read the repository's manual-disable flag. If it is set, log that the repository is manually disabled and return — before the source argument is inspected, before the metadata directory is resolved, and before the reset-squash detector runs. The flag's storage, priority, and migration are owned by the manual-disable spec.
3. Inspect the source argument:
   - If it equals `squash`, run the merge-squash handler. After it completes, return.
   - Otherwise (notably for `message`, unset, or any other value that does not indicate `commit`), run the manual reset-squash detector. Whether it writes a file or not, return.
   - The `commit` value is recognized but no longer triggers any action in the canonical implementation. (See Notable Behavior.)
4. The hook always exits cleanly. Internal errors anywhere in the dispatch are caught and logged at error level; the commit proceeds.

### Merge-squash handler (source == `squash`)
1. Resolve the metadata directory per the worktree-aware routine.
2. Read the VCS-written squash-message file under that directory. If reading fails (for instance, the file does not exist), log the error and return without writing anything.
3. Parse the file as a sequence of newline-separated lines. For each line, after trimming leading/trailing whitespace, test it against the pattern `^commit\s+<40-hex>\b`. Collect the captured hash from every match, in order.
4. If the resulting list is empty, log "no commit hashes found" and return without writing anything.
5. Resolve the current branch tip via the VCS. (This is captured here, before the squash commit is created, precisely so the post-commit hook can use it as a stale-file guard against `HEAD~1` of the to-be-created commit.)
6. Write the pending-state file at the well-known product-namespace path with: `sourceHashes` = the captured list; `expectedParentHash` = the resolved tip; `createdAt` = the current ISO-8601 timestamp.

### Manual reset-squash detector (source != `squash`)
- Delegate to the multi-layer reset-squash detection routine specified in **Git Operation Type Detection** §"Reset-squash detection". On success, that routine itself writes the pending-state file (with the same `sourceHashes` / `expectedParentHash` / `createdAt` schema) and returns "success." On failure of any layer, it returns "no action" and writes nothing. Any exception thrown by the routine is caught here and logged at error level; the hook still returns cleanly.

### Worktree awareness
- All metadata-directory access in the merge-squash handler (specifically: locating the squash-message file) goes through the worktree-aware routine described above. As a consequence, the hook works correctly in secondary working trees whose `.git` entry is a pointer file.

### Squash-message parsing details
- The pattern is anchored at line start (after trim), requires the literal token `commit`, one or more whitespace characters, exactly 40 lowercase hexadecimal digits, and a word boundary. Any line that does not meet this pattern is ignored.
- Order is preserved; duplicates (if any) are kept (the VCS does not normally produce duplicates, but the parser does not deduplicate).
- The parser does not consult any other portion of the squash-message file beyond these `commit <hash>` headers. The original commit messages and author lines are present in the file but are deliberately ignored.

## State Transitions

Per invocation, observable persistent state changes are:
- **Pending-state file** at the well-known product-namespace path: `absent → present` on positive detection (either branch); otherwise unchanged. This hook never deletes the file; deletion is the post-commit hook's responsibility.
- **Repository manually disabled**: unchanged. No detection runs, so the pending-state file is never written.
- **No other persistent state is written by this hook.** The commit-message file (the hook's first positional argument) is read-only as far as this hook is concerned.

## Notable Behavior

- **Two squash patterns share one downstream contract.** Both the VCS-driven merge-squash and the user-driven reset-then-commit produce the same pending-state file with the same fields, so the post-commit consumer needs only one code path. (Notable; central design choice.)
- **Source-hashes from a merge-squash come from the squash-message file's headers.** The VCS writes a human-readable concatenation of original commit messages and headers; this hook parses the headers, not the messages. The `commit <40-hex>` line is the load-bearing piece. (Notable.)
- **`expectedParentHash` is captured before the commit, on purpose.** The whole point is to record what the about-to-be-created commit's parent should be; capturing it here, ahead of time, lets the post-commit consumer detect a stale pending file by comparing it to `HEAD~1` of the actual commit. (Surprising; intentional.)
- **Reset-squash detection is non-fatal everywhere.** Any of its five layers failing — including I/O errors — collapses to "no action," not to an error. The user's commit completes regardless. (Notable.)
- **Reset-squash respects pre-existing pending files.** Layer 0 of the reset-squash detector explicitly checks for and yields to a pre-existing pending file. This lets a graphical-client integration pre-write the file with richer metadata without this hook overwriting it. (Surprising; intentional.)
- **`message`, unset, or unknown source falls through to reset-squash detection.** The dispatch is not a strict allowlist — anything that does not equal `squash` is examined for the reset pattern. This is what makes plain `git commit` after a soft reset trigger the detector. (Notable.)
- **Hook never blocks the commit.** All exception paths are caught at the top level. The hook may produce log output but never propagates an error to the VCS. (Notable.)
- **Empty squash-message hash list is treated as "no detection."** If the VCS wrote a squash-message file but it contains no parseable headers, this hook logs and returns without writing the pending-state file; the commit then proceeds and is later classified as a plain `commit`. (Notable.)
- **Amend handling has been removed from this hook.** Earlier versions wrote an "amend pending" file here when source was `commit` and the third positional argument equaled the current tip. That code path has been deleted; amend is now detected at post-commit time (via reflog inspection) and handled by **Post-Rewrite Hook Handling** (which receives the authoritative old-to-new mapping on stdin). (Surprising; intentional.)
- **On a manually-disabled repository no squash entry can ever be enqueued.** This hook is the *only* writer of the squash pending-state file, and its manual-disable gate precedes both detection branches. With no file written, the post-commit consumer finds no squash marker and can only classify the commit as a plain commit — and that consumer is itself gated on the same flag, so nothing is enqueued at all. The squash path is therefore closed at both ends. (Notable; the two-hook chain means the gate here is what makes the *absence* of a squash classification deterministic rather than incidental.)
- **The hook does not modify the commit message.** Even though the VCS supplies the path to the prepared message file as the first argument, this hook never reads or writes that file. (Notable.)
- **One implementation, two dispatch branches.** This hook is the single implementation of the prepare-commit-msg contract for every surface, and it handles exactly the `squash` branch and the default reset-squash branch. An alternate port that handled a third `commit` branch (writing an amend-pending file when the third argument equalled the current tip) no longer exists. (Notable.)
- **Reset-squash detection runs even when no squash is in progress.** The detector is cheap (a few VCS commands) and fails fast at layer 1 if the most recent reflog entry isn't a reset. The cost on every commit is negligible; the benefit is correctly identifying user-driven squashes that the VCS does not signal in any other way. (Notable.)

## Shared Behavior
- The repo-wide manual-disable flag read at step 2 — its storage, repo-wide anchoring, priority, migration, and the per-invocation cost of the read — is owned by the manual-disable spec.
- The pending-state file written here is consumed (validated and deleted) by **Post-Commit Hook Enqueue**, which carries the same gate; a disabled repository therefore produces neither the file nor a consumer for it.
- The multi-layer reset-squash detection routine is fully specified in **Git Operation Type Detection**.
- The worktree-aware metadata-directory resolution rule is shared with **Git Operation Type Detection** and **Post-Commit Hook Enqueue**.
- The amend code path that previously lived here is now realized by the post-commit reflog-based detection (**Git Operation Type Detection**) plus the stdin-mapping handling in **Post-Rewrite Hook Handling**.
