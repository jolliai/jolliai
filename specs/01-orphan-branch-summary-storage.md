# 01. Orphan Branch Summary Storage

## Topic Statement
Persist summary files on a long-lived parallel git ref using only object-database plumbing operations, never checking out a working tree.

## Scope
**In scope:**
- The fixed name of the parallel ref where all summary files live.
- How the ref is initialized when absent.
- How files are read from the ref without a working-tree checkout.
- How one or more files are written or deleted in a single atomic ref update.
- How the path of the underlying ref directory is resolved when the host repository uses an alternate working-tree pointer (a worktree-style indirection).
- The contract this storage implements (read one path, write a batch with a message, list paths under a prefix, check existence, ensure initialization).

**Out of scope (boundaries):**
- The schema or interpretation of files written under this storage (covered by "Summary Tree Structure" and downstream consumers).
- The folder-mirror copy of the same files (covered by "Folder-Based Summary Storage").
- The conditional combination of this storage with other backends (covered by "Dual-Write Summary Storage").
- Locking and concurrency at higher levels (queues, hooks). This storage performs no in-process or filesystem locking of its own; it relies entirely on the atomicity of a single ref-update at the underlying VCS layer.
- The durable repo-wide manual-disable opt-out — how it is set, cleared, and stored, and the full inventory of writes it suppresses (covered by "Manually-Disabled Zero-Write Contract"). Only its position inside this storage's write batch is stated here.

## Data Contracts

### Ref name
A constant string of the form `<product-namespace>/summaries/v<schemaVersion>`, where `<schemaVersion>` is the integer 3. The canonical literal is `jollimemory/summaries/v3`, composed of three parts: a product-namespace prefix (`jollimemory`), a category subnamespace (`summaries`), and a schema version suffix (`v3`). The version suffix changes only when the on-branch tree-and-blob layout changes incompatibly (see "Summary Schema Migration"). The name appears in two equivalent forms:
- The unqualified branch-style name (e.g. for ref-existence check, file-read, file-list operations that accept a branch name).
- The fully qualified ref form `refs/heads/<name>` (used when creating, updating, or directly verifying the ref).

### Initial-tree contents
When the ref does not exist, it is initialized with a single root-level file:
- Path: `index.json`
- Content: a JSON document with two fields:
  - `version`: integer 1
  - `entries`: empty array
- Serialized with tab indentation.

### Storage-provider contract
A surface offering:
- `readFile(path) -> content | null`: returns the file's textual content as stored under the ref, or null if absent.
- `writeFiles(files, message)`: applies a batch of writes/deletes atomically with a commit message attached to the resulting ref-tip commit.
- `listFiles(prefix) -> [path, ...]`: returns the recursive set of file paths whose location starts with `prefix` (including paths containing arbitrary bytes).
- `exists() -> boolean`: whether the ref currently exists.
- `ensure()`: initializes the ref if missing.

### File-write entry
Each entry in the batch has:
- `path`: a string path inside the ref's tree (slash-separated, may include nested directories).
- `content`: the textual content (ignored when `delete` is true).
- `delete`: optional boolean; when true, the entry removes the path instead of writing it.
- `branch`: optional string used by other backends; ignored here.

### Result of `writeFiles`
A new commit on the ref whose tree reflects the cumulative effect of all entries in the batch in entry order, parented to the previous tip.

## Behavior

### Initialization (`ensure`)
1. Verify the ref exists; if it does, return.
2. Build an initial blob from the canonical empty-index JSON above and obtain its content-addressed hash by piping the content to a "write blob from stdin" plumbing operation.
3. Build a one-entry tree object containing a single regular-file entry pointing at that blob under the name `index.json`. The tree input is supplied via stdin to a "make tree from textual entries" plumbing operation.
4. Create a parentless commit object whose root tree is the tree above and whose message is a fixed initialization message.
5. Point the ref at the new commit via a ref-update operation.
6. If any plumbing step fails (non-zero exit), throw an error containing the underlying stderr.

### Read (`readFile(path)`)
1. Invoke the VCS "show" operation against `<ref>:<path>` (no working-tree changes).
2. If the operation exits with a non-zero status (for any reason — missing file, malformed ref, etc.), return null.
3. Otherwise return the captured stdout as the file content.

### Write batch (`writeFiles(files, message)`)
0. If the project is **manually disabled**, return immediately. The refusal sits **before** the initialization routine in step 1, so a disabled project never has the ref created for it: on a repository whose ref does not yet exist, a batch write leaves the repository with no parallel ref at all rather than an empty initialized one. This is the only entry point on this storage that carries the gate — read, list, existence, and the standalone initialization routine are unaffected. The opt-out itself is defined by **Manually-Disabled Zero-Write Contract**.
1. Call the initialization routine first; this is a no-op if the ref already exists.
2. Resolve the current commit at the ref's tip; if resolution fails, throw with the underlying stderr.
3. Resolve the tree object at that commit; if resolution fails, throw.
4. For each entry in the batch, in order:
   - If `delete` is true: produce an updated tree by removing the named entry at the given path. If the path traverses a subdirectory and the target does not exist, the tree is returned unchanged. After removal, if a subdirectory becomes empty, the subdirectory entry is also removed from its parent tree (cascading upward).
   - Otherwise: hash the content as a blob (content piped via stdin to "hash-object -w --stdin"), then update the tree by adding or replacing a regular-file entry at the given path. Nested paths are handled recursively: missing intermediate directories are created as new (empty) trees. Existing intermediate directory entries are read, replaced with an updated subtree, and re-attached.
   - Each tree-update produces a new tree hash that becomes the input for the next entry.
5. Create a new commit whose root tree is the final accumulated tree, whose only parent is the previous tip, and whose message is the supplied message.
6. Update the ref to point at the new commit.

All plumbing failures during steps 4–6 throw with the underlying stderr.

### List (`listFiles(prefix)`)
1. Run a recursive list of name-only entries against `<ref>` filtered by `prefix`, requesting NUL-delimited output (so paths with arbitrary characters are preserved).
2. If the operation fails (non-zero exit), return an empty list.
3. Split the captured output on NUL and discard empty strings.

### Existence (`exists`)
- Verify the qualified ref `refs/heads/<name>` resolves; success means the ref exists.

### Tree-update primitives (internal)
- "Replace or add an entry in a tree": list the current tree's entries (NUL-delimited), drop any entry whose name matches the target, append a new entry line of the form `<mode> <type> <hash>\t<name>`, write the resulting block as a new tree. Order of entries in the input is irrelevant to the resulting tree's identity.
- "Remove an entry by name from a tree": list entries (NUL-delimited), filter out the matching name; if nothing was removed, return the original tree hash unchanged; if all entries were removed, write an empty tree; otherwise write the filtered set as a new tree.

### Worktree-aware path resolution
Two related helpers exist to translate a working directory into the canonical project root:
- "Common-dir lookup": runs the VCS "rev-parse --git-common-dir" operation in the given working directory; if it fails, throws. Resolves the returned (possibly relative) path against the working directory and returns an absolute path.
- "Project-root lookup": uses the common-dir lookup, then returns its parent directory. This is the location used as the canonical project root for project-scoped configuration.

A separate hook-directory resolver (used by installation, not this storage) inspects the `.git` entry inside a project directory:
- If `.git` is a directory, hooks are at `<.git>/hooks`.
- If `.git` is a file, its content is read and parsed as `gitdir: <path>`. The pointed-at gitdir is resolved against the project directory. If the resolved gitdir contains the path segment `worktrees/`, hooks are at the directory above that segment plus `/hooks`. Otherwise hooks are directly inside the resolved gitdir as `<gitdir>/hooks`.

## State Transitions

The ref has two states:
- **Absent**: any read returns null; `exists()` is false.
- **Present**: a chain of commits whose latest tree contains the live set of stored files. New writes append a single new commit per `writeFiles` call.

Allowed transitions:
- Absent → Present: triggered by `ensure()` (called explicitly, or implicitly at the start of `writeFiles`).
- Present → Present: each successful `writeFiles` advances the ref to a new tip.

There is no Present → Absent transition implemented by this storage.

## Notable Behavior

- **Plumbing-only by design.** The ref is never checked out into a working tree. All reads use a "show by ref:path" operation; all writes use blob/tree/commit/ref-update plumbing. As a consequence, the ref is invisible to ordinary working-tree operations on the host repository and never collides with the user's branches.
- **Atomicity at the batch level.** A single `writeFiles` call results in a single commit and a single ref-update. Either all entries land or none do. (Surprising/intentional.)
- **Implicit `ensure` on write.** Even if the caller never invokes `ensure` first, `writeFiles` initializes the ref on demand.
- **Read-by-ref returns null on any error.** A missing file, a missing ref, and a corrupt object are indistinguishable from null at the read API. (Surprising.)
- **List-on-missing-ref returns empty.** `listFiles` against a non-existent ref silently returns an empty list rather than erroring. (Surprising.)
- **NUL-delimited listing.** File listing requests NUL-separated output specifically so that names containing arbitrary bytes (newlines, non-ASCII) are preserved verbatim. (Notable.)
- **Tree-update is order-independent at the object level.** When rewriting a tree's entries, the textual entry order in the input does not affect the resulting tree hash; the underlying make-tree operation produces a deterministic canonical ordering. (Notable.)
- **Cascading empty-subtree removal.** Deleting the last file in a nested directory also removes the (now empty) directory entry from its parent tree, repeated upward. (Notable; intentional.)
- **No locking.** This storage performs no in-process mutex, no advisory lock file, and no transaction. Concurrent writers race on the underlying ref-update operation; one will succeed and the other's commit becomes unreachable from the ref unless the caller serializes externally.
- **Plumbing pipe-to-stdin requirement.** Operations that supply content to the VCS via stdin (blob hashing, tree creation) must use a process-spawn primitive that exposes a writable stdin. A simpler "exec with input option" primitive in the implementation language silently ignores the input and the child process hangs forever waiting for stdin. (Surprising/intentional-bug-avoidance.)
- **First-commit diff fallback** (in a sibling helper used by callers, not by this storage itself): when a diff against `<ref>^..<ref>` fails because the ref has no parent, the fallback diffs against the empty-tree blob hash. Documented here only because the helper lives next to the plumbing primitives used by this storage. (Notable.)
- **Maximum capture buffer** for VCS-command stdout is fixed at 10 mebibytes; larger outputs cause the underlying process invocation to fail and surface as a generic error. (Notable.)
- **Initial-index version mismatch.** The initial-tree content sets `version: 1`, while the ref name itself encodes schema version 3. The storage layer makes no attempt to reconcile these; downstream consumers maintain and upgrade the index document. (Surprising; intentional.)
- **There is one implementation of this storage.** The former JVM-based port is gone. The JVM-hosted surface still **reads** the orphan branch natively — it lists and shows branch files with its own direct VCS invocations, bypassing the storage abstraction entirely — but it performs **no writes**: every write on that surface goes through this implementation over a bridge action. So the write protocol described above has exactly one implementation, while the read path has two (this one, and the JVM surface's native display-time reads). (Notable.)

## Shared Behavior
- The durable repo-wide manual-disable opt-out that suppresses this storage's write batch is defined by **Manually-Disabled Zero-Write Contract**.
- The schema and interpretation of stored summary documents are defined by **Summary Tree Structure**.
- A folder-on-disk mirror of the same files, layered on top of this storage, is defined by **Folder-Based Summary Storage**.
- Conditional dual-write semantics that combine this storage with the folder mirror are defined by **Dual-Write Summary Storage**.
