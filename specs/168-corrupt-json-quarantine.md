# 168. Corrupt JSON Quarantine

## Topic Statement

Before any dirty Memory Bank vault working-tree paths are staged for commit onto the orphan history, syntactically invalid engine-owned JSON files are atomically renamed into a single vault-root quarantine directory so the unparseable bytes never leave the local device.

## Scope

**In scope:**

- The path filter that decides which dirty paths are eligible for validation (extension and ancestor-segment requirements).
- The validation rule — content must be parseable as JSON; any other property of the content (schema, shape, semantic correctness) is intentionally not checked.
- The disposition of validation failure — the offending file is moved (by rename) out of its tracked location into a fixed engine-owned quarantine directory at the vault root.
- The encoding of the original path into a single safe filename inside the quarantine directory.
- Collision handling when a quarantined file with the same safe name already exists from a previous round.
- Idempotency over repeated rounds when the same path keeps producing corrupt content.
- Tolerance of missing files (uncommitted deletions) and non-regular-file entries (symlinks, directories, sockets) that may appear in the dirty list.
- Defensive treatment of the quarantine directory itself when something hostile or unexpected occupies its path (pre-existing symlink, pre-existing regular file, pre-existing real directory, or nothing at all).
- The per-clone exclude entry written so the quarantine directory is invisible to any whole-tree `add`-style operation, even during the brief window of a first-bind round before the canonical ignore template lands.
- The structured report returned to the caller (count and the list of paths that were moved).
- Diagnostic logging at warn level on every quarantine action and at warn level when the quarantine directory cannot be made usable.

**Out of scope (boundaries — what is sent/received but not re-specified here):**

- The choice of which paths are dirty and the decision to invoke this pass — both are decided by the caller. The caller is the sync engine's auto-reconcile step, immediately before allowlist staging on a dirty tree. See spec 150 (sync engine reconciliation) — only the boundary call matters here.
- The downstream staging logic that runs after this pass. Spec 163 (vault path allowlist staging) covers what happens to the paths that survive validation; this pass only filters the list by removing corrupt entries from the working tree before staging begins.
- The shape of the vault folder layout. The directory the quarantine dir is created at (the vault root) is defined by spec 151 (memory bank folder layout); this pass treats the vault root as an opaque absolute directory.
- The canonical ignore template that ultimately conceals the quarantine directory from `git status`. The per-clone exclude entry is a belt-and-suspenders bridge for the pre-bootstrap window; both mechanisms exist independently.
- The hostile-symlink sweep over engine-owned content paths (a separate, sibling pass). This pass uses the same name-encoding and same directory-protection rules as that sweep, but operates on a different file set (parseable JSON, not unsafe symlinks).
- The source of the corrupt content. Causes include a crashed storage write that flushed half a file, an editor whose save was interrupted, or a manual user edit. This pass treats every cause identically.
- Recovery or repair of corrupt content. The quarantined copy is preserved verbatim for forensic inspection until the user deletes it; the engine never attempts to reconstruct the original.

## Data Contracts

### Inputs

- An absolute vault working-tree root path (an opaque string passed through; never validated by this pass).
- An ordered collection of relative paths (each relative to the vault root, in the POSIX-or-native form the caller already had). Duplicates are permitted; non-eligible entries are silently filtered out before any disk access.

### Filter predicate (eligibility for validation)

A relative path is eligible iff **both**:

- Its final extension is the JSON extension.
- Its split-on-path-separator segment list contains the literal engine-owned hidden-directory segment at any depth. Both a vault-root-relative layout (`.<hidden>/...`) and a per-repo nested layout (`<repo>/.<hidden>/...`) match. The check is presence anywhere in the segments — not a prefix check — so legitimate engine paths at either depth qualify.

Ineligible paths (no JSON extension, or no engine-owned hidden segment) are pass-through: this pass never reads them, never moves them, and never logs about them.

### Quarantine directory

- A fixed, dot-prefixed, engine-reserved subdirectory directly under the vault root. Its name is a stable string compiled into the engine; it is not configurable.
- Created lazily — only when at least one corrupt file has been found this round. A round in which every dirty JSON file parses successfully leaves the filesystem untouched.

### Safe-name encoding

The destination filename inside the quarantine directory is the original relative path with every path separator (forward slash or backslash) replaced by a single dash. No other character is altered, no truncation is applied, no extension is stripped. The resulting name is a single flat filename that:

- Round-trips visibly back to its origin by reading dashes as separators.
- Collides deterministically across rounds — the same logical path always maps to the same safe name, which is how repeated quarantine of the same flaky writer stays bounded to one entry.

### Report returned to the caller

A read-only structure with two fields:

- A non-negative integer count of files actually moved into the quarantine directory this invocation.
- A list of relative paths (the original input paths, verbatim, in input order modulo filter) for every file that was moved.

When the eligible-set is empty, when every eligible file parses, or when the quarantine directory cannot be made usable, both fields are reported as "empty / zero".

### Per-clone exclude side effect

A trailing-slash exclude pattern naming the quarantine directory is appended to the per-clone exclude file (in the vault's internal git directory) once per invocation that finds at least one corrupt file. The exclude helper is append-once with deduping semantics. Failure of this append is non-fatal and is not surfaced in the report.

## Behavior

### Phase 1: Eligibility filter (pure, no disk access)

1. Apply the filter predicate above to the input paths, in input order.
2. If the resulting eligible list is empty, return the zero/empty report immediately. No directory is created, no exclude line is written.

### Phase 2: Per-file validation pass

For each eligible path, in input order:

3. Compose an absolute path by joining the vault root and the relative path (host-native path joining).
4. Take a non-following stat of the absolute path (a lstat-equivalent that does not traverse symlinks at the leaf).
   - **Stat throws** (typical cause: file does not exist on disk — an uncommitted deletion left a porcelain-dirty record but no file to read): silently skip this path. Do not log, do not include in the report.
   - **Stat succeeds but the leaf is not a regular file** (it is a symlink, a directory, a socket, a fifo, anything else): silently skip this path. Symlinks specifically are handled by the sibling hostile-symlink sweep before this pass runs.
   - **Stat succeeds and the leaf is a regular file**: continue.
5. Read the file's full contents as UTF-8 text.
   - **Read throws** (extreme race: lstat saw a regular file but a permission flip or unlink happened before the read completed): log at debug level naming the path, treat as if missing, continue with the next path. Do not include in the corrupt list.
6. Attempt to parse the text as JSON.
   - **Parse throws** (any reason — truncation, syntax error, empty string, BOM-only, control characters that the parser rejects): record the relative path in the "to quarantine" list. Notable: a zero-byte file is recorded as corrupt because an empty string is not valid JSON; this is intentional, since a zero-byte aggregate file is exactly the mid-write-truncation hazard this pass guards against.
   - **Parse succeeds**: continue with no side effect. Whatever the resulting value's shape is (an array where an object was expected, an object missing required fields, etc.) is not this pass's concern.

7. If the "to quarantine" list is empty after walking every eligible path, return the zero/empty report. The filesystem is untouched.

### Phase 3: Make the quarantine directory usable

When at least one corrupt file was identified, prepare the quarantine directory at the vault root:

8. Take a non-following stat of the quarantine directory's path.
   - **Stat throws** (typical: nothing there yet): proceed to step 11.
   - **Stat succeeds and the leaf is a symbolic link**: treat as hostile — a pre-existing symlink at this engine-owned path could be a redirection into a host directory. Log a warn-level message that the symlink is being unlinked, then unlink it. (The location is engine-owned and contains no user data; replacement is safe.) Then proceed to step 11. If the unlink itself fails (rare race), log warn and return zero/empty report — leave the corrupt files in place rather than risk a write through a hostile target.
   - **Stat succeeds and the leaf is a real directory**: proceed to step 12 (use as-is).
   - **Stat succeeds and the leaf is anything else** (regular file, fifo, socket, etc.): the engine refuses to clobber unknown user data sitting at this path. Log a warn-level message identifying the path and the situation. Return zero/empty report — leave the corrupt files in place. The caller (auto-reconcile) will see the warn and proceed to its staging step accepting the risk for this round; next round can recover automatically once the user clears the blocker.

9. Append the per-clone exclude pattern (the quarantine directory name followed by a trailing slash) to the vault's per-clone exclude file. This is performed even when steps 8/11 ultimately decide the directory cannot be created; the exclude entry's presence is independent of the directory's existence and protects future rounds. Append failure is logged and swallowed (the canonical ignore template is the eventual permanent cover; the per-clone exclude is the bridge for the pre-bootstrap window).

10. Reconfirm whether the quarantine directory is usable. If it is not (step 8 returned a "refuse" outcome via the non-symlink non-directory branch), log a warn-level message stating that the directory is unusable and that N corrupt files are being left in place where N is the size of the corrupt list, and return the zero/empty report.

11. **(Creation branch.)** When the directory does not exist (either nothing was at the path, or step 8 removed a hostile symlink), create it. The creation is **non-recursive** — the engine has already proven the vault root exists by this point (the caller invokes this pass only after clone or fetch succeeded), so the parent is guaranteed. On creation success: proceed to phase 4. On creation failure (filesystem corruption, read-only mount, permissions): log a warn-level message naming the path and the error and return zero/empty report.

12. **(Existing real-directory branch.)** Proceed to phase 4 with the existing directory.

### Phase 4: Move each corrupt file into quarantine

For each path in the corrupt list, in input order:

13. Compose the source absolute path by joining vault root and relative path.
14. Compute the safe destination name by replacing every separator (forward or back) in the relative path with a single dash, and compose the destination absolute path by joining the quarantine directory and the safe name.
15. Best-effort delete any existing file at the destination path (a previously-quarantined entry from a prior round whose original then keep being corrupted). Errors are silently swallowed — a non-existent destination ("nothing stale to clean") is the normal case; an unlinkable-but-existent destination is rare and the subsequent rename will surface its own error.
16. Rename the source to the destination. This is the single atomic operation that removes the corrupt file from its tracked location and places it at the quarantine location. On success: increment the moved count, append the original relative path to the moved-paths list, and log a warn-level message naming both the source relative path and the destination relative path. On failure (an EBUSY / EACCES race between the unlink-cleanup and the rename, or platform-specific rename-over restrictions): log a warn-level non-fatal message naming the path and the error; do not include the path in the moved list; continue with the next corrupt path. The round can still proceed with whatever paths did succeed.

17. After all corrupt paths have been processed, return the report carrying the final moved count and moved-paths list.

## State Transitions

This pass is stateless across invocations — it owns no in-memory state between calls. Across rounds, persistence lives entirely on the filesystem:

- **First corrupt round**: the quarantine directory is created and one file is renamed in. The per-clone exclude file gains a one-line entry.
- **Subsequent rounds where the same path keeps producing a corrupt file**: the quarantine directory already exists; the prior copy at the safe-name destination is best-effort unlinked, then the new copy is renamed in. The quarantine directory holds exactly one entry per logical original path regardless of how many rounds have triggered it.
- **Round where every dirty JSON parses cleanly**: zero filesystem mutations. The previous corrupt entry (if any) remains in the quarantine directory undisturbed for forensic inspection until the user manually deletes it.
- **Round where the quarantine directory's location is occupied by a non-symlink non-directory blocker**: report is zero/empty; warn is logged; corrupt files stay in place; next round retries the whole pass from scratch and recovers automatically when the blocker is gone.

## Notable Behavior

- **JSON-parseability is the entire validation surface.** Schema, shape, semantic correctness, and content authenticity are all explicitly out of scope. A file that parses to `null`, an empty array, a wrong-typed object, or a structurally complete object missing required fields is treated as parse-successful and left in place. Strict shape checks belong adjacent to the storage layer's read paths, not here; this pass exists solely to prevent unparseable bytes from being staged.
- **A zero-byte file is corruption, by intent.** Although a half-written file is the canonical hazard, a file of exactly zero bytes is identical in outcome — the parser rejects it. This catches the case where a crashed write truncated a JSON aggregate to nothing.
- **Only engine-owned JSON is validated; user-authored content is pass-through.** A `.md` note authored by the user, a `.txt` file, or even a `.json` file that does not live under the engine-owned hidden-directory segment is silently ignored. The rationale is twofold: parsing user-authored content would be a privacy surprise, and the staging step downstream classifies non-engine content separately anyway.
- **Eligibility uses segment-presence, not a path prefix.** Engine-owned JSON exists at two depths (vault-root-level and per-repo-nested), and a single presence check across the split segments captures both layouts in one rule. A path with the engine-owned segment buried anywhere in the chain — even nested deeper than expected — is eligible; this is permissive by design to avoid undercounting.
- **Missing files are silently skipped.** A relative path whose stat throws is treated as already handled — typically an uncommitted deletion that the porcelain output reported. The pass produces no log entry for this case (logging every missing entry would dominate the log during a large clean-up).
- **Non-regular-file leaves are silently skipped.** A symlink at the leaf (handled by the sibling sweep), a directory whose name happens to end in `.json` (an unusual but legal layout), or any other non-regular-file kind is not validated and not logged. Bytes can only be parsed from a regular file.
- **Same-name collision in quarantine overwrites the prior copy.** A flaky writer that produces a corrupt JSON every round must not produce N stale quarantine copies. The safe-name encoding is deterministic per logical path, and the pre-rename best-effort unlink ensures exactly one current copy survives.
- **The pre-rename unlink is best-effort and silently swallows all errors.** The dominant case is "nothing was there" (a fresh entry); the rare case is "something is there but cannot be removed", in which case the subsequent rename will surface the real error.
- **A hostile pre-existing symlink at the quarantine directory's path is unlinked, not followed.** Following a hostile symlink would land the corrupt file in a host-system directory chosen by the attacker (or by a careless user). The engine treats the quarantine path as engine-owned, contains no user data, and freely replaces a symlink with a real directory.
- **A pre-existing non-symlink non-directory blocker at the quarantine path causes the round to skip quarantining altogether.** The corrupt files are left in place and a warn is logged. The downstream staging step will then process them with whatever classification it produces — typically those files get classified as engine-owned and the bad bytes do reach the index this round. This is a deliberate trade-off: the engine refuses to delete unknown user data sitting at the engine path, accepts one bad round, and recovers automatically next round once the blocker is gone.
- **The per-clone exclude line is appended even before the canonical ignore template lands.** On a first-bind round, the canonical ignore template is written later in the same round; for the brief window before that write, the per-clone exclude is the only barrier preventing a whole-tree `add` from pulling the quarantine directory into the index. The append helper is append-once / deduping, so re-running the pass across many rounds does not bloat the exclude file.
- **Per-clone exclude append failure is non-fatal.** The canonical ignore template is the eventual cover; the per-clone entry is only the bridge. A failed append is logged and swallowed.
- **Read failure for a stat-confirmed regular file is treated as missing, not as corruption.** The path is silently skipped (debug log only). A genuine race where a permission flip or unlink happens between stat and read is extremely rare; treating it as "missing" matches the broader pass's contract of "if we cannot read it, we cannot judge it".
- **Rename failure is non-fatal per-path.** An EBUSY / EACCES race or a platform-specific rename-over restriction logs a warn and continues with the next corrupt path. The round still makes progress with whatever paths could be moved.
- **The directory creation is non-recursive.** The caller's contract guarantees the vault root exists (the caller is the sync engine after clone-or-fetch succeeded); a single non-recursive mkdir is sufficient. A failure here therefore implies filesystem corruption or a read-only mount, not a missing parent.
- **The report's moved-paths list reflects only the paths actually renamed.** Paths that were identified as corrupt but whose rename then failed are not in the list; the count and the list are always in agreement. Callers that need "everything we tried to quarantine" do not have that information from this pass and must consult the warn-level log.
- **Idempotency across rounds is filesystem-level, not in-memory.** Two consecutive invocations on a clean tree produce zero filesystem mutations; a clean rewrite of a previously-corrupt file passes validation on the next round and stays in place. The quarantine copy persists indefinitely (forensic preservation) until the user removes it.
- **No repair is attempted, ever.** Quarantine plus forensic preservation is the conservative move. The engine never tries to reconstruct, infer, or salvage content from a corrupt file.
- **No signal-handler / cleanup hook.** If the process is killed mid-rename, the corrupt file may end up in either location or neither; the next round's stat-and-validate sweep recovers any "in-place still corrupt" case automatically. A partial rename that left both source and destination is recovered by the next round's same-name collision unlink.

## Shared Behavior

- **Mirrors the hostile-symlink sweep's directory-protection routine** — both passes share the same lazy-creation-with-symlink-replacement logic for an engine-owned quarantine directory at the vault root. The two passes operate on disjoint file sets (parseable JSON here; unsafe symlinks there) but their directory contract is identical: dot-prefixed, non-recursive mkdir, unlink-and-recreate on hostile symlink, refuse-and-warn on unknown-blocker.
- **Mirrors the hostile-symlink sweep's safe-name encoding** — replacing every path separator with a dash preserves origin recoverability and produces a deterministic, collision-stable filename. The two passes use the same encoding so that a forensic inspector reading either quarantine directory can read the dashes as separators.
- **Per-clone exclude file append helper** — the same append-once / deduping helper used by other engine-owned ephemeral directories. See spec 150 for the cross-component contract; this pass only invokes it.
- **Pre-stage placement within the sync engine round** — this pass runs as a sub-step of the sync engine's auto-reconcile, immediately before the allowlist staging step. Spec 150 (sync engine reconciliation) describes when and why this pass is invoked; spec 163 (vault path allowlist staging) describes what happens to the surviving (parseable) files. Neither boundary spec re-describes the validation rule itself.
- **The hidden engine-owned directory name** is the same product-tag-derived dot-prefixed directory used throughout the Memory Bank layout. See spec 151 (memory bank folder layout) for its canonical definition; this pass treats it as a known segment string compiled into the engine.
