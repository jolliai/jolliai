# 164. Vault Symlink Safety Guard

## Topic Statement

Every write into the local vault working tree is preceded by a fresh walk of the path chain from the vault root down to the target's parent that refuses the write if any existing intermediate directory segment is a symbolic link, preventing a hostile symlink anywhere in the chain from redirecting the write outside the vault.

## Scope

**In scope:**

- The pre-write path-chain check that lstats every intermediate segment between the vault root and the target's parent directory.
- The two callable forms of the check (asynchronous and synchronous) which share an identical contract — same rejection rules, same error message text, same boundary cases.
- The "safe atomic write" wrapper that composes the path-chain check, recursive directory creation, write of a sibling temp file with a no-follow flag on its open, and atomic rename onto the final target.
- The set of failure modes the check distinguishes (symlink in chain, non-directory in chain, target outside vault, non-absolute argument, ENOENT segment, non-ENOENT lstat error).
- The leaf-vs-chain split — the chain check explicitly does **not** lstat the final basename, leaving that to the no-follow flag on the temp-file open.
- The per-call freshness policy: the check is performed on every write, never cached across writes.
- The cold-start behavior when intermediate segments don't yet exist (mkdir-recursive will materialize them).
- The cross-platform handling of paths that escape the vault (including the Windows cross-drive case).
- The two call sites of the safe-write wrapper inside the vault (vault working-tree storage writes and memory-bank-bootstrap sentinel/gitignore writes).
- The one call site of the chain-only async form (staging-time classification of paths the round is about to stage).
- The threat model the guard exists to neutralize and the relationship to the complementary leaf-level no-follow open.

**Out of scope (boundaries — sent/received but not re-specified):**

- The staging-time path classification that calls the chain check as one input to a "is this path safe to stage?" boolean, including the canary bucket it routes blocked paths into and the per-round telemetry counters (covered by the **vault path allowlist staging** spec, 163). This spec describes only the chain-check contract; how the result is consumed at staging time is owned by 163.
- The end-to-end sync reconciliation cycle that ultimately invokes both the staging-time chain check and the write-time chain check (covered by the **sync engine reconciliation** spec, 150).
- The on-disk shape of the vault parent folder, the per-repo subdirectory layout, and the hidden machine-readable layer that hosts most of the writes the guard protects (covered by the **memory bank folder layout** spec, 151).
- The per-vault writer lock that serializes concurrent writers against the same vault (a separate per-vault lock file lives outside the vault; this spec covers the write-time symlink check, not the lock).
- The companion configuration that materializes incoming mode-120000 git tree entries as plain text files instead of real symlinks (set on every git invocation against the vault); this configuration is the inbound-side counterpart to the guard and is owned by the git-client / sync-engine specs.
- The legacy tree-walking "symlink sweep" quarantine pass this guard replaced. That pass scanned the entire vault tree on every round and renamed any symlink it found. It no longer exists; only its rationale (why a per-write check is preferable to a tree-walk) is captured here as notable behavior.

## Data Contracts

### Inputs

The chain check takes two arguments:

| Field        | Type              | Meaning                                                                                                                            |
| ------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| vault root   | absolute path     | The vault working-tree root. Every check is scoped to a single vault root; the caller chooses which vault root applies.            |
| target path  | absolute path     | The path that is about to be written. The check walks from the vault root toward this path, exclusive of its final basename.       |

Both arguments are required to be absolute paths. A non-absolute argument is itself a rejection condition (see error behavior).

The safe-atomic-write wrapper adds one more argument:

| Field        | Type                  | Meaning                                                                                                          |
| ------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| content      | string or byte buffer | Payload to write. String content is encoded as UTF-8; byte-buffer content is written verbatim.                   |

### Rejection signal

The chain check is a void function on success and an exception on failure. The exception is a plain error with a human-readable message; callers distinguish failure causes by inspecting the message text or by treating any throw as "do not proceed with this write". The five distinct rejection messages are:

| Cause                                               | Message shape                                                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Non-absolute target argument                        | Identifies the function and the offending argument as the target path.                                                                                 |
| Non-absolute vault-root argument                    | Identifies the function and the offending argument as the vault root.                                                                                  |
| Target outside the vault (path escape)              | Names both the target and the vault root; tells the operator the target is "not inside" the vault.                                                     |
| Intermediate segment is a symbolic link             | Names the exact segment that was the symlink and the original target. Includes the phrase "path segment is a symlink" and the instruction "Inspect and unlink before retrying." |
| Intermediate segment exists but is not a directory  | Names the exact offending segment and the original target. Includes the phrase "path segment is not a directory".                                      |

A non-ENOENT lstat error (e.g. EACCES on a 0-permission parent) is re-thrown verbatim — not wrapped — so the caller can inspect its `code` property. ENOENT on a segment short-circuits the walk with success (see below).

### Threat model record

The guard's existence is motivated by an intermediate-segment symlink exploit. In the absence of the guard:

1. An attacker (or a misbehaving tool) installs a symlink at some segment along the path from the vault root to a write target — for example, replacing the per-repo `<vault>/<repo-folder>/<hidden-layer>` segment with a symlink that points at `/etc/`.
2. A subsequent recursive-directory-creation call on the target path follows that symlink and creates the deeper directories inside the link's target rather than inside the vault.
3. The subsequent temp-file write and rename land inside the foreign location, clobbering files outside the vault.

The intermediate-segment case is **not** mitigated by a no-follow flag on the leaf write, because the leaf is the temp file inside the parent — by the time the leaf opens, the directory chain has already been followed. The chain check is the part that closes that hole; the no-follow flag on the leaf open is complementary defense for the rare case where the temp file's own name was pre-placed as a symlink.

## Behavior

### Chain-check pipeline (called per write)

The chain check executes the following steps in order on every call. There is no caching, no memoization across calls, and no shared mutable state between the async and sync forms.

1. **Validate absolute paths.** Reject immediately if the target path argument is not absolute (`isAbsolute` is false). Reject immediately if the vault root argument is not absolute. Each rejection is a thrown error naming the function and the offending argument.
2. **Compute the relative path from vault root to target.** Use the platform's path-relative routine, which returns a string of separator-joined segments when the target is inside the vault, returns a string starting with `..` when the target is outside, and returns the absolute target path itself when the two arguments are on different drives (Windows-only).
3. **Detect path escape.** Reject if any of these three escape signals fire on the relative path:
   - The relative path is the empty string (meaning the target *is* the vault root — a nonsensical input).
   - The relative path starts with `..` (the target is on a sibling branch outside the vault, on POSIX or same-drive Windows).
   - The relative path is absolute (the target is on a different drive on Windows; cross-drive `relative` returns the absolute target).
4. **Split the relative path into segments.** Use the platform's path separator.
5. **Walk segments from the vault root down to the parent of the target.** Initialize a cursor at the vault root. For each segment **except the last** (the last segment is the target's basename — the leaf — and is intentionally not lstatted here):
   - Skip the segment if it is empty (defensive — the platform's relative routine normalizes empty/duplicate separators away, so this branch is unreachable in practice but is kept in case a future caller bypasses normalization).
   - Append the segment to the cursor.
   - lstat the cursor.
   - **If lstat throws ENOENT**: return successfully without checking the rest of the chain. The caller's recursive-mkdir will create this segment and every deeper segment fresh, none of which can be a symlink because none of them yet exist.
   - **If lstat throws any other error code**: re-throw the error verbatim. A permission failure or any other I/O surface is treated as "can't verify safety, refuse the write".
   - **If lstat returns a stat that is a symbolic link**: warn-log at the configured warn level with a message naming the offending segment, then throw an error whose message names the offending segment, names the original target, and tells the operator to inspect and unlink before retrying.
   - **If lstat returns a stat that is neither a directory nor a symbolic link** (i.e. a regular file, socket, FIFO, or character device standing where a directory must be): throw an error whose message names the offending segment, names the original target, and reports "path segment is not a directory". This case would also fail at the caller's recursive-mkdir, but the guard's error is preceded by the warn-level log line and identifies the offending segment precisely.
   - **If lstat returns a stat that is a directory**: continue to the next segment.
6. **Return successfully** when all intermediate segments have been verified as real directories.

The two forms of the function (asynchronous via promise-flavored lstat, synchronous via blocking lstat) execute the identical pipeline with the identical messages.

### Safe-atomic-write wrapper

The wrapper composes the chain check with a write-and-rename pattern that is the canonical "atomic write under vault root" operation in the codebase. Its steps:

1. **Run the synchronous chain check** with the same vault root and the target path. If the check throws, the wrapper propagates the throw verbatim — no write happens.
2. **Recursive-mkdir the target's parent directory.** Safe because the chain has been verified symlink-free; the recursive mkdir will not follow any link.
3. **Choose the sibling temp filename.** The temp file is the target path with a literal `.tmp` suffix appended (no random suffix, no temp directory — same directory, same basename plus `.tmp`).
4. **Open the temp file with a no-follow flag.** The open flags are: write-only, create, truncate, and (on platforms that support it) no-follow. On POSIX platforms, no-follow causes the open to fail if the temp file's basename is itself a symlink. On Windows, the platform constant for no-follow resolves to zero — the flag is a no-op there. The mode for newly-created files is set to the platform's default file mode (the same mode the legacy write-file routine produced).
5. **Write the content.** String content is written with explicit UTF-8 encoding. Byte-buffer content is written verbatim with no encoding argument.
6. **Close the file descriptor** unconditionally, even if the write threw. The descriptor close happens in a finally clause so a write error does not leak the descriptor.
7. **Atomically rename the temp file onto the target path.** The rename succeeds if and only if the temp file is on the same filesystem as the target (it always is — they share a directory).

If the chain check (step 1) or the open (step 4) throws, no temp file is left behind. If the write (step 5) throws after the open succeeded, the close still runs in the finally block, and the rename does not run — a stale `.tmp` file may remain on disk, which the caller's next safe-write attempt for the same target will overwrite via the truncate flag on the next open.

### Cross-platform handling of the no-follow flag

The no-follow flag is consulted from the platform's file-system constants. On POSIX (Linux, macOS), this constant is the kernel's `O_NOFOLLOW` and an `open` against a symlinked leaf fails with `ELOOP`. On Windows, the constant resolves to zero, making the flag a no-op — the open succeeds even if the leaf is a symlink. This is treated as acceptable in the rationale because Windows does not have the same symlink-traversal exploit surface in practice; the path-chain check still applies in full on Windows.

### Cold-start ENOENT short-circuit

Returning early on the first ENOENT segment is correct: anything below an ENOENT segment is also ENOENT, so no symlink can exist there. The recursive mkdir in the caller's wrapper (or in the caller's own code, for callers that invoke the chain check directly) materializes the missing chain freshly. Freshly-created directories cannot be symlinks. This is what makes the guard tolerable for cold-start writes against a not-yet-cloned vault.

### Per-call freshness, no caching

The chain check is invoked on every single write. There is no cache that says "this chain was clean last time". This is deliberate: a hostile or accidental symlink can be installed between any two writes (including a hook installing one mid-round), and a cached "clean" result would let the next write traverse the new link. The cost is one lstat per intermediate segment per write; the rationale (preserved from source) is that the prior tree-walk-quarantine approach (which scanned and renamed every symlink in the vault on every round) was strictly more expensive and additionally moved user files, which was a UX complaint.

### Call-site inventory

The guard is exposed to callers in three forms with distinct usage:

**Form A — `assertNoSymlinksInPath` (async).** Called once, from the staging-time path classification that decides whether a dirty vault path is safe to feed to `git add`. The classifier composes this with an additional leaf-level lstat (the leaf is not checked by the guard; the classifier checks it separately for staging purposes). When either check fails or the leaf-lstat throws ENOENT (file disappeared mid-round) or throws any other code, the path is routed into the staging-time canary bucket rather than being staged. The classifier's wider behavior is owned by spec 163.

**Form B — `assertNoSymlinksInPathSync` (sync).** Re-exported for symmetry with the async form; the codebase calls it indirectly via the safe-atomic-write wrapper rather than directly. It exists so the chain check can be composed into synchronous write APIs (which historically use blocking I/O for atomic-rename semantics) without forcing those APIs to become async just for the guard.

**Form C — `safeAtomicWriteSync` (sync, composed).** Called from two production write paths inside the vault:

- The vault working-tree storage's per-file atomic write. Every write of every aggregate document, per-branch human-readable document, topic-page, and shadow-status sentinel into the vault routes through this single call. The "shadow status" sentinel write is best-effort historically — its caller catches the wrapper's throw and warn-logs it, surfacing the suppressed failure under a second log line tagged to the caller (so a hostile symlink in the vault root produces both the guard's warn and the caller's warn, making the suppressed update visible during log triage). All other vault writes propagate the throw to the round, which fails the write phase and surfaces the error in the round outcome.
- The memory-bank-bootstrap's `.gitignore` write at the vault root, and its per-vault sentinel `bootstrap-state.json` write. The `.gitignore` write propagates the throw; the bootstrap-state write is best-effort (catch-and-warn) so the round still proceeds if the sentinel can't be persisted.

There are no other production callers. Tests call all three forms directly to exercise the rejection paths.

## State Transitions

The guard is **stateless**. Every invocation reads the live filesystem state at the moment of the call. There is no cache, no per-vault sticky bit, no "last-clean-at" timestamp. Two consecutive calls against the same vault root and target path issue independent lstats and can produce different outcomes if the filesystem changed between them.

The only side effect of a successful chain check is the warn-level log line that is emitted *before* the throw on the symlink-in-chain case (i.e. the log only fires on failure, and only on the symlink case — not on the not-a-directory case, not on the non-absolute-argument case, not on the path-escape case, and not on a re-thrown non-ENOENT lstat error). Successful calls produce no log output.

The safe-atomic-write wrapper has one extra observable effect on partial-failure: a stale `.tmp` file may remain in the target's parent directory if the write step threw after the open succeeded. The next safe-write call against the same target overwrites the stale file via the truncate flag on the next open. There is no separate cleanup path for stale `.tmp` files.

## Notable Behavior

- **The leaf is intentionally not lstatted by the chain check.** A symlink at the final basename of the target is *not* an error from this guard's perspective; the safe-atomic-write wrapper handles that case at the next layer down via the no-follow flag on the temp-file open. The split exists so the hot per-write path does not double-stat. The unit test that exercises this case writes a symlinked leaf, calls the chain check, and asserts it returns successfully. The leaf-side defense is engaged only when the wrapper opens the temp file, not when it opens the final target. (Surprising; load-bearing.)
- **The check is performed per write, not per vault session.** A caller that writes a thousand files into the same vault during one round pays for one chain walk per write, not one walk for the whole round. The rationale is freshness — anything that could install a symlink between two writes (a peer process, the user, a misbehaving tool) is mitigated by re-walking. (Notable; intentional CPU trade-off.)
- **An ENOENT segment short-circuits the entire remaining walk.** Anything below an ENOENT cannot exist either, so no symlink can be hiding there. The check returns successfully and the recursive-mkdir at the next layer creates the missing chain fresh. (Notable.)
- **An EACCES (or any other non-ENOENT) lstat error is re-thrown verbatim.** A permission failure is treated as "can't verify safety" — the guard refuses the write rather than swallowing the error or treating it as a successful (clean) chain. Mock-isolated tests pin this contract because a real filesystem can't reliably produce EACCES on a CI runner that runs as root. (Notable; defensive.)
- **A non-directory standing where a directory must be is treated as a hard refuse.** The recursive mkdir at the next layer would also fail with ENOTDIR, but the guard's own error is preceded by a precise message naming the offending segment, which is clearer than the mkdir's stack. (Notable.)
- **The Windows cross-drive case is detected via the absolute-relative-result signal.** On Windows, asking for a relative path between two drives returns the absolute target unchanged (no `..` prefix is possible across drives). The chain check treats an absolute-shaped relative result as a path escape and rejects. (Notable; cross-platform.)
- **The exact-equal-to-vault-root case is also rejected.** Asking the guard to verify the chain "to the vault root itself" is meaningless and almost certainly a caller bug; the empty-string relative-path branch routes that input into the path-escape rejection. (Notable.)
- **The async and sync forms have identical contracts byte-for-byte.** Same error message text, same rejection conditions, same short-circuit behavior on ENOENT, same re-throw on non-ENOENT. The two exist purely so synchronous write APIs can compose the check without re-architecting to async. Diverging the two would silently weaken one of the two write paths. (Notable.)
- **The no-follow flag on the temp-file open is a no-op on Windows.** The platform constant resolves to zero. The rationale (preserved from source) is that Windows does not have the same symlink-traversal exploit surface in practice; the path-chain check still applies in full on Windows, which is the load-bearing defense. (Notable; platform divergence.)
- **The warn log fires only on the symlink-in-chain case.** It does not fire on path-escape, non-absolute-argument, not-a-directory, or non-ENOENT lstat error. The rationale is that the symlink case is the active threat indicator — an operator needs to see it surfaced even if the throw is later caught by a best-effort caller (like the shadow-status sentinel write). The other failure modes are either caller bugs (path-escape, non-absolute) or environmental issues (permission denied) that are surfaced by the throw itself. (Notable.)
- **The shadow-status sentinel write deliberately suppresses the chain-check throw.** This write is historically best-effort; if a hostile symlink in the vault root prevents the sentinel from being persisted, the round still proceeds. The caller's catch emits a second warn-level log line tagged to the suppressed update, so a log-triage operator sees both the guard's warn and the caller's "markDirty suppressed" warn for the same incident. (Notable; intentional UX.)
- **The memory-bank bootstrap-state sentinel write is also best-effort.** Same rationale: a failure to persist the per-vault scan sentinel is degraded to "didn't persist sentinel" rather than failing the entire round. The `.gitignore` write in the same module is **not** best-effort — its throw propagates. (Notable; asymmetric handling within one module.)
- **The guard replaced a tree-walk symlink-quarantine pass.** The replaced pass scanned the whole vault tree on every round and renamed every symlink it found into a sidecar file. Two complaints retired it: it moved user files (UX), and it required an extra full tree scan before every round (cost). The per-write guard is strictly cheaper (one chain walk per write, not one tree walk per round) and never touches the filesystem on a clean chain. (Notable; rationale preserved.)
- **The complementary inbound-side defense materializes incoming mode-120000 git tree entries as plain text files, not real symlinks.** That defense is owned by the git-client / sync-engine specs (set on every git invocation against the vault, plus persisted into the vault's per-repo git config after clone/init). Together, the two layers cover the outbound (write-time guard) and inbound (incoming git materialization) sides of the symlink threat surface. (Notable; cross-spec.)
- **The chain walk computes path joins by string-concatenation of the segment to the cursor with the platform separator.** Empty segments are skipped defensively (unreachable in practice because the platform's relative-path routine normalizes empty/duplicate separators) so a future caller that bypasses normalization can't crash the walk. (Notable; defensive.)
- **The guard does not perform any normalization of its inputs.** It trusts that both arguments are already absolute and lexically normalized (the caller is expected to have run the equivalent of "resolve" on both arguments before passing them in). The only normalization the guard does is the relative-path computation between the two arguments. Passing un-normalized inputs (e.g. a vault root with a trailing separator, or a target with `..` segments) may cause the relative-path computation to produce a result the guard does not expect; the rejection in those cases is conservative (path-escape) rather than permissive. (Notable.)
- **String content is written with explicit UTF-8 encoding.** The wrapper uses an explicit encoding argument on the write call so a future Node default change does not silently re-encode existing content. Byte-buffer content is written verbatim, with no encoding argument. (Notable; preserves the legacy "writeFileSync default" behavior.)
- **The temp file mode is the platform's default new-file mode.** No explicit chmod is performed beyond the mode the open call applies on file creation. The legacy `writeFileSync` it replaced behaved the same way; the rationale (preserved from source) is to avoid behavior changes from a pure-internal refactor. (Notable.)
- **The rename step is the commit point.** Until the rename runs, no observer of the target path sees the new content; after the rename, every observer sees the new content atomically (within the constraints of the underlying filesystem's rename atomicity, which is per-directory on POSIX and per-filesystem on Windows). A failure between open and rename leaves a `.tmp` file on disk that the next write will overwrite. (Notable.)
- **A stale `.tmp` file from a prior failed write is not separately cleaned up.** The next successful write to the same target overwrites it via the truncate flag on open. There is no background sweeper. (Notable.)
- **The wrapper does not perform an O_EXCL on the temp open.** If a prior failed write left a `.tmp` file, the next open truncates and reuses it. The rationale is that the lock-protected single-writer model around the vault (a per-vault writer lock outside the vault) guarantees only one writer is touching this target at a time, so reusing a stale `.tmp` cannot collide with a concurrent peer. (Notable.)
- **The chain check's per-segment cost is one lstat call.** The total cost per write is `O(depth-of-target)` lstats plus one open, one write, one close, and one rename. For a typical vault write at a depth of three or four segments, this is small enough that the per-round cost (across hundreds of writes) is still bounded by I/O of the writes themselves, not by the guard. (Notable.)
- **The guard is invoked in three forms (async chain-only, sync chain-only, sync chain+write).** The chain-only forms exist for callers that want to perform a custom write after verification (the staging-time classifier in spec 163 is the only such caller in production); the composed form is used by every other vault-write site. (Notable.)
- **A successful chain check produces no log output.** Only the failure path — and only the symlink-in-chain failure path — produces a warn-level log line. Silent success keeps the per-write log volume bounded. (Notable.)
- **The rejection of a non-absolute argument is itself a hard refuse, not a coerce-and-retry.** The guard does not call "resolve" on its arguments; it refuses the call. This protects against a caller that derived the target from un-trusted input and forgot to normalize it; resolving silently would mask the bug. (Notable.)

## Shared Behavior

- The staging-time path classification that uses the async chain check as one of two inputs (the other being a leaf-level lstat) is defined by the **vault path allowlist staging** spec (163). That spec also owns the canary bucket the classifier routes blocked paths into and the per-round telemetry counters.
- The end-to-end reconciliation round that ultimately exercises both the staging-time and the write-time forms of the guard is defined by the **sync engine reconciliation** spec (150).
- The on-disk shape of the vault parent folder, the per-repo subdirectory layout, and the hidden machine-readable layer the guard protects is defined by the **memory bank folder layout** spec (151).
- The per-vault writer lock that serializes concurrent writers against the same vault (and that justifies the absence of an O_EXCL on the temp open in the safe-atomic-write wrapper) is owned by the vault-write-lock spec (separate file under sync) — a hashed lock file outside the vault, in the per-user lock directory.
- The git-client configuration that materializes incoming mode-120000 tree entries as plain text files (the inbound-side counterpart to this guard) is owned by the git-client / sync-engine specs. The two layers together cover both directions of the symlink threat surface.
- The shadow-status sentinel write and the bootstrap-state sentinel write — the two best-effort callers that catch this guard's throw and warn-log it as a suppressed update — are owned by the folder-storage and memory-bank-bootstrap specs respectively. This spec describes only the guard's contract; the suppression behavior is the callers' choice.
