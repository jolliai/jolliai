# 175. VS Code Memory Bank Folder Browser

## Topic Statement

Surface the Memory Bank parent folder as a lazily-expanded tree that interleaves discovered repository entries with user-dropped sibling entries, enriching each tracked file with manifest-derived classification, title, branch, and divergence metadata — and, on a user-initiated Refresh of that tree, tidy the parent folder itself by archiving the repository folders that hold nothing and folding the several folders that hold one repository into one.

## Scope

**In scope:**
- The path protocol used by the consumer to address any node in the tree from a single string segment-joined relative path rooted at the Memory Bank parent folder.
- The flat root listing that interleaves managed-repository entries with arbitrary user-created top-level sibling directories and files.
- The lazy-expansion contract: a request for a relative path returns one folder node populated with its immediate children, with each child directory's own children left unloaded.
- The disambiguation rule between the repository namespace and the user-entry namespace when resolving the first segment.
- The per-listing reconcile + heal pre-pass that runs before any listing inside a discovered repository, the per-instance "clean repository" memoisation that suppresses it once a clean pass has been observed, and the manual-disable condition that suppresses it without memoising.
- Manifest-driven enrichment of every tracked Markdown file with a classification kind, a stable identifier, a human-readable title, a source branch, and a "user-edited on disk" divergence flag.
- Title derivation for Markdown files outside the manifest, falling back through frontmatter title, first H1, then nothing.
- Sort order: directories first then files, alphabetical within each group; at the root, discovered repositories first then user-created entries within the same dirs-then-files ordering.
- Filtering of dotfile and dotdirectory entries at every level.
- Filtering of non-file, non-directory directory entries (symbolic links, sockets, FIFOs) at every level.
- The repository-display-name composition rule that surfaces the on-disk basename in parentheses when it diverges from the recorded repository name.
- Repository-root identity restoration when a listing's relative path identifies a repository's own root.
- Validation of the relative-path protocol against absolute paths and parent-directory traversal.
- Error semantics: repository-segment misses, non-directory expansion requests, and inner stat failures.
- The healed-callback contract that fires after a heal pass regenerated at least one tracked file.
- The "drop the clean memo" interface used by external refresh triggers to re-arm the reconcile + heal pre-pass.
- The fact that a user-initiated Refresh of this tree **mutates the parent folder**, and the two operations it runs before re-listing: an archival sweep of the repository folders that provably hold nothing, and a modal-confirmed consolidation of the several folders that hold the current repository. Both are held under the per-vault write lock, both move folders into the same hidden archive directory, and both invalidate this service's clean-repository memo. Only the vocabulary of what they do to this surface is defined here; their own rules are boundaries below.
- The two interfaces this service exposes for them: the sweep (which reports the folders it archived and can point at the archive directory) and the consolidation's split detect-then-execute pair, whose split exists so a case-specific confirmation can sit between the two halves.
- The consolidation's precondition that the host supply the current project's working-tree root, and the silent disabling of the whole operation when it does not.

**Out of scope (boundaries):**
- Repository discovery itself — which on-disk subdirectories qualify, how they are identified, how the current-repository flag is assigned, and how they are ordered relative to each other (covered by the memory-bank-folder-layout spec and the repo-identity-and-folder-naming spec).
- The on-disk layout of a discovered repository's hidden metadata folder, the manifest document's schema and mutation semantics, the branches registry's schema, and the index document's schema (covered by the memory-bank-folder-layout spec and the folder-based-summary-storage spec).
- The heal pass itself — how visible Markdown files are regenerated from the hidden source-of-truth documents, and what the failed / healed / dropped counters mean (covered by the folder-based-summary-storage spec).
- The reconcile pass itself — how the manifest is rewritten when files move on disk (covered by the folder-based-summary-storage spec).
- The branches enumeration that surfaces a single repository's branch list (covered by the topic-index spec's projection rules and the folder-based-summary-storage spec; only the existence of the per-instance helper is noted here).
- The webview protocol surrounding the folder tree (the request/response message shape, the cache, the empty-tree fallback on error) — only the contract the listing service exposes is defined here.
- The visual rendering of any node (icons, badges, suffix text, divergence marker, current-repository highlight) — the service emits structured flags only.
- The Memory Bank parent-folder validation and default-resolution policy (covered by the memory-bank-folder-layout spec).
- The decoration provider that mirrors the divergence flag onto the host editor's native file tree.
- The archival sweep's own rules: the emptiness predicate it evaluates, its allowlist of inert hidden-layer documents, its two-name exemption for operating-system noise, its two-part current-repository guard, and its silent skip when the vault lock is busy (covered by the Memory Bank unused-folder archival spec).
- The consolidation's own rules: how the duplicate set is assembled, the three classifications and their survivor selection, the copy-if-absent merge and metadata union, the rebuild from the system of record, the base-slot hijack that rebuild admits, and its visible failure when the vault lock is busy (covered by the Memory Bank duplicate-folder consolidation spec).
- The archive directory those two operations move folders into — its location, its timestamped naming, and why archiving is a move rather than a deletion (covered by the Memory Bank migration-engine spec).

## Data Contracts

### Relative-path protocol

Every listing request and every node's identifier is a single string addressing one position in the tree relative to the Memory Bank parent folder. Segments are joined with forward slashes. The empty string addresses the parent folder itself.

The first segment, when non-empty, is interpreted as one of two namespaces, resolved in this order:

1. The on-disk basename of a discovered repository (which may carry a collision suffix such as `-2`, `-3`, etc., assigned independently of this surface).
2. The on-disk basename of any other direct child of the Memory Bank parent folder — a user-created folder or file that does not satisfy the repository-discovery criterion.

A first segment that matches neither yields a "repository not found" error. The second-namespace lookup is performed via a plain stat against the candidate path under the parent folder; only when both lookups miss is the error raised.

The remaining segments after a discovered repository's first segment are interpreted relative to the repository's on-disk root. The remaining segments after a user-entry first segment are interpreted relative to the user entry's on-disk path.

### Path validation

Every incoming relative path is normalised before resolution:

- Backslashes are folded to forward slashes.
- Leading and trailing slashes are trimmed.
- An absolute path (including any path starting with a path-separator) is rejected with an error.
- A path that, after normalisation, begins with a parent-directory traversal segment, contains one as an intermediate segment, or ends with one, is rejected with an error.
- A normalised path of a single dot or the empty string resolves to the empty path (the root listing).
- A path that contains a parent-directory segment which cancels with a sibling segment and leaves a valid in-tree path after normalisation is permitted (the protocol permits forward-equivalent paths the user-agent might emit).

### Folder node

Every listing returns one folder node with these fields:

- **Name**: the display label. Empty string for the root. The on-disk basename for a user-entry top-level node. The composed repository-display name (see below) for a discovered repository's root. The on-disk basename for any node inside a repository or inside a user-entry directory.
- **Relative path**: the address described above. Empty string for the root.
- **Is-directory**: true for directories, false for files.
- **Children**: an ordered list of immediate child folder nodes when this is a directory whose listing was performed; the literal absent value when this is a directory that has not been listed; the empty list when this is a file.
- **File kind** (file nodes only): one of `memory`, `plan`, `note`, `wiki`, `skill`, or `other`, derived from the owning repository's manifest (see classification below). Absent on directory nodes.
- **File key** (file nodes only): the stable identifier from the manifest entry (commit hash for memories, slug for plans, identifier for notes). Absent when the file has no manifest entry.
- **File title** (file nodes only): a display string derived from either the manifest entry's recorded title or the file's own content (see title derivation below). Absent when neither source yields a value.
- **File branch** (file nodes only): the source branch recorded on the manifest entry's source record. Absent when the manifest entry has no recorded source branch.
- **Is-diverged** (file nodes only): true when the manifest entry's recorded content fingerprint differs from the file's current on-disk content fingerprint. Computed only when a manifest entry with a recorded fingerprint exists.
- **Is-repo-root** (directory nodes only): true when this node is a discovered repository's own root (the first segment of the address is a repository basename and there are no further segments). Absent or false elsewhere.
- **Is-current-repo** (directory nodes only): true when this node is a discovered repository's own root and that repository matches the currently active workspace identity. Absent or false elsewhere.

The "absent" / "empty list" / "the listed empty list" distinction in the children field is load-bearing: it lets the consumer distinguish "not yet expanded" from "expanded and known empty" from "this is a leaf".

### Repository display name

For a discovered repository whose recorded repository name matches its on-disk basename, the display name is the recorded repository name.

For a discovered repository whose recorded repository name differs from its on-disk basename (the common case after collision-suffix allocation, where two distinct repositories sharing a name would otherwise be indistinguishable), the display name is the recorded repository name followed by the on-disk basename in parentheses, separated by a space.

This composition applies both in the root listing and in the listing that returns a repository at its own root; expanding a repository at its own root after a collapse must not lose the disambiguating suffix.

### Classification of a file

A manifest entry, when present, dictates the file kind:

- A manifest entry of type "commit" maps to `memory`.
- A manifest entry of type "plan" maps to `plan`.
- A manifest entry of type "note" maps to `note`.
- A manifest entry of type "wiki" maps to `wiki`.
- A manifest entry of type "skill" maps to `skill` — the per-commit skill-usage aggregate file, one per commit that captured any skill.
- A file with no manifest entry (or whose owning subtree has no manifest, such as a user-entry directory) maps to `other`.

Only the "commit" type is renamed; the classifier's default branch returns the manifest type verbatim, so `plan`, `note`, `wiki` and `skill` all pass straight through. A new manifest type therefore reaches this surface as its own file kind automatically — but it must also be added to the consumer's file-kind union, or the folder tree stops type-checking (see the message-protocol spec).

### Title derivation

For a Markdown file (filename ending in `.md`, case-insensitive):

1. If a manifest entry exists for the file's repository-relative path and the entry carries a non-empty recorded title, use that title.
2. Otherwise read the first kilobyte of the file's content.
3. Strip a leading byte-order mark if present.
4. If the leading content matches a frontmatter block (a fence line of three hyphens, body lines, then a closing fence line of three hyphens), look inside the block for a line of the form `title:` followed by a value. If found, strip a matching pair of surrounding double-quote or single-quote characters (only when the string is at least two characters long and both characters match), then trim. If the trimmed result is non-empty, use it.
5. Otherwise, after stripping any frontmatter block, walk the content one logical line at a time (line endings normalised across the two common forms). For the first non-blank line, attempt to parse it as an ATX-form first-level heading: a hash character, then at least one space or tab, then content, then optionally trailing whitespace and trailing hash characters and more whitespace. If the line matches, use the captured content trimmed. If the line does not match the heading form, do not look further.
6. Otherwise, the file has no derived title.

A file whose name does not end in `.md` (case-insensitive) is not subjected to this derivation; its title is unset regardless of content. A read failure while opening or reading the file's content yields no title.

If the captured heading content is non-empty but trims to the empty string, the title is treated as absent.

### Divergence flag

For a file node whose manifest entry records a content fingerprint:

- If the on-disk file is absent, the flag is false (cleanup of stale manifest rows is the responsibility of a separate pipeline).
- If the on-disk file is present and its computed fingerprint matches the recorded fingerprint, the flag is false.
- If the on-disk file is present and its computed fingerprint differs from the recorded fingerprint, the flag is true.
- If reading the file's content to compute the fingerprint fails, the flag is true (conservative: surface the marker rather than hide it).

For a file node whose manifest entry does not record a fingerprint (legacy rows pre-dating fingerprint tracking), or whose file has no manifest entry at all, the flag is false.

### Sort order

Within any directory listing — root or inner — entries are sorted with directories before files, alphabetical (locale-aware) within each kind.

At the root, the two namespaces are concatenated in this order:

1. Discovered repositories, in the order produced by the repository-discovery surface (which places the current-workspace repository first when matched, then the rest alphabetically by display name — see boundary spec).
2. User-created top-level entries, sorted by the directories-first / alphabetical rule above.

User-created entries that share a basename with any already-included repository are excluded from the second list so that one entry never appears twice.

### Dotfile filtering

At every level — root listing and listings inside a discovered repository or a user-entry directory — any entry whose name begins with a literal dot character is omitted from the children list. The filter is applied to the directory enumeration, not the path the consumer requested; a consumer can still address a hidden path directly through other means but it will not be surfaced as a child in any tree response.

### Non-file, non-directory filtering

Any directory entry that is neither a regular file nor a regular directory (notably symbolic links, FIFOs, and sockets) is silently omitted from the children list at the root and inside user-entry directories. Inside a discovered repository's tree, this filter is not applied at the immediate-directory enumeration step (the directory enumeration's predicate is the directories-first sort and the dotfile filter only); a symbolic link that the underlying file-system API reports as a directory or a file is included.

A consequence at every level except the root user-entry list: symbolic links whose target is a directory are followed during expansion. This makes the repository boundary soft — a symbolic link inside a repository pointing outside its root will surface the target's contents under the repository's address. This is intentional; users may legitimately organise their content with symbolic links.

### Per-instance "clean repository" memo

Each instance of the listing service maintains a set of absolute repository-root paths that were observed to be in sync between manifest and on-disk content. A repository is added to the set after a listing inside it observes a heal pass that healed zero files and failed zero files. Membership in the set suppresses reconcile + heal on subsequent listings inside that repository.

The insertion happens *inside* the gated pre-pass block, so a session in which the pre-pass never runs — notably a manually disabled workspace — never adds to the set at all.

The set is keyed by absolute repository-root path, not by basename, so that a configuration change that re-points the Memory Bank parent folder to a different location cannot leak a memoised "clean" status onto a same-named repository under the new parent.

The memo has two interfaces for invalidation:

- A whole-set clear, used by external refresh triggers when the change is not scoped to a single repository (manual refresh, settings-saved, migration completion, parent-folder change).
- A single-repository clear, used by callers that know exactly which repository changed (single-file revert paths, focused per-repository update events).

### Healed-callback contract

The service accepts an optional callback at construction. After a heal pass inside a discovered repository regenerates at least one visible file, the callback is invoked once with: the repository's on-disk basename (the first segment), the count of regenerated files, and the list of manifest fileIds whose orphaned rows were dropped during the pass (currently always empty for this surface — see "Reconcile + heal pre-pass" below).

The callback is not invoked when the heal pass regenerated zero files, even if it failed to regenerate some. The callback's contract is solely "the consumer should refresh sibling nodes that may now exist on disk".

### Folder-tree address rewriting

When a listing inside a discovered repository or a user-entry directory returns, every relative path inside the resulting node and its descendants is rewritten to be prefixed with the first segment of the original request, so that the consumer's cache can address every node by its full top-level address regardless of which intermediate hop produced the listing.

### Validation of relative paths returned from inner listings

The inner listing produces nodes with names equal to the on-disk basename of each entry. When the inner listing returns a node for a relative path that is the empty string (the inner root), the wrapper that prefixes the address also restores the outer-level name: the composed repository display name for a discovered-repository root, the on-disk basename for a user-entry root.

For any inner sub-path, the outer name is left as the on-disk basename produced by the inner listing.

## Behavior

### Resolving a listing request

1. Validate and normalise the incoming relative path as defined above. Reject absolute paths. Reject any parent-directory escape.
2. If the normalised path is the empty string, return the root listing (see "Root listing" below). Done.
3. Otherwise split the normalised path on the forward-slash separator. The first segment is the namespace key.
4. Invoke the repository-discovery surface (passing the current-workspace identity and the configured Memory Bank parent folder, every call, so settings changes take effect on the next listing without recreating the service) and look for a discovered repository whose on-disk basename equals the first segment.
5. If a discovered repository matches:
   - If the repository's absolute root is **not** in the per-instance clean-repository memo **and** the workspace is not manually disabled, run the reconcile + heal pre-pass for this repository. See "Reconcile + heal pre-pass" below. When either condition suppresses it, the listing continues unchanged.
   - Compute the inner relative path: the remaining segments joined by forward slashes (the empty string when the first segment is the entire path).
   - Call the inner listing on the repository's on-disk root with the inner relative path. See "Inner listing of a directory" or "Inner listing of a file" below.
   - Prefix every relative path in the returned node and its descendants with the first segment, joined by a forward slash.
   - If the inner relative path was the empty string (the consumer addressed the repository's own root), override the returned node's name with the composed repository display name; set is-repo-root to true; set is-current-repo to the repository's current-repository flag from discovery.
   - Return the result.
6. If no discovered repository matches the first segment, attempt a plain-filesystem lookup against the candidate path under the Memory Bank parent folder:
   - Stat the path. On stat failure (entry missing, deleted, or never existed), raise a "repository not found" error using the first segment in the message. The protocol cannot disambiguate this from a stale cache; the error lets the consumer drop its cached path and re-list the root.
   - If the stat result is not a directory (the consumer addressed a top-level user file), raise a "cannot expand non-directory" error using the first segment in the message. Top-level files have no expandable children; the protocol expects no such request, but the throw is the safety net.
   - Otherwise treat the candidate path as a user-entry root, compute the inner relative path as above, call the inner listing on the candidate path, prefix the addresses with the first segment, and override the returned node's name with the first segment when the inner relative path was the empty string.

### Root listing

1. Invoke the repository-discovery surface with the current-workspace identity and the Memory Bank parent folder.
2. For each discovered repository, project a folder node with: the composed repository display name, the on-disk basename as its relative path, is-directory true, is-repo-root true, the repository's current-repository flag as is-current-repo, and a children field of the literal absent value (lazy: the consumer will request expansion to load).
3. Collect the set of repository-on-disk basenames into an exclusion set.
4. Enumerate the immediate children of the Memory Bank parent folder via a single directory-read.
5. Filter the enumeration: drop entries whose name starts with a dot; drop entries whose name is in the exclusion set.
6. Sort the surviving entries: directories before files; within each group, alphabetical (locale-aware) by name.
7. For each surviving entry, project a folder node:
   - For a directory entry: name equal to its on-disk basename, relative path equal to its on-disk basename, is-directory true, children the literal absent value (lazy).
   - For a file entry: name equal to its on-disk basename, relative path equal to its on-disk basename, is-directory false, children the empty list, file kind `other`, file title derived from content as defined above.
   - For any other entry kind (symbolic link, FIFO, socket): the entry is silently skipped (the projection function returns nothing for this entry, and the surrounding filter drops it).
8. Concatenate the repository nodes followed by the user-entry nodes; return as the children of a root folder node whose name and relative path are both the empty string and whose is-directory is true.

If the directory-read of the Memory Bank parent folder fails for any reason (most commonly the parent folder not existing on disk), the user-entry list is treated as empty and the listing proceeds with only the repository nodes. If the discovery surface also returns no entries (the same parent-missing condition), the listing returns an empty-children root.

### Reconcile + heal pre-pass

Triggered before any listing inside a discovered repository whose absolute root is not in the clean-repository memo **and** whose workspace has not been manually disabled by the user. Both conditions gate the same block; the disabled case is a plain skip with no logging and no error.

The skip is scoped tightly: reconcile rewrites the manifest and heal regenerates visible files, so both must not run for a repository the user has turned off — but **the listing itself still proceeds in full**. Every folder node, classification, title, branch and divergence flag is computed exactly as usual. A disabled project's Memory Bank browser is therefore fully readable; only the self-healing is paused. (Rationale: the browser is one of the surfaces a user reaches *while* the product is off, so making it degrade would be the wrong trade.)

Because the clean-repository memo is recorded **inside** the skipped block, a disabled session never memoises anything. That is the elegant part of the placement: the memo is the only thing that would make the skip sticky, so once the repository is re-enabled the pre-pass re-arms automatically on the next listing, with no invalidation call and no bookkeeping. Had the memo been recorded outside the block, a single listing during a disabled window would have permanently convinced the service the repository was clean.

Cross-reference: spec 145 for the manual-disable state, `specs/304-manually-disabled-zero-write-contract.md` for the wider contract.

When the pre-pass does run:

1. Invoke the repository's metadata-reconcile entry point (which rewrites the manifest in place when a file recorded under one path is now located under another, based on fingerprint match — boundary).
2. Invoke the repository's heal pass with an explicit flag instructing it **not** to drop orphaned manifest entries when their hidden source is missing. The dual-write storage mode could otherwise produce false positives at this call site, since this surface cannot inspect the active storage-mode configuration to determine whether folder-only mode is in effect. The explicit pass-through is the deliberate "preserve under uncertainty" policy. (As a consequence, the dropped-ids field of the healed-callback invocation is always empty when populated by this pre-pass.)
3. Heal runs to completion before the listing continues — the regenerated files must be on disk by the time the inner listing enumerates the folder, otherwise the consumer would have to re-trigger the listing to see the recovered content.
4. If heal returned zero healed files and zero failures, record the repository's absolute root in the clean memo.
5. If heal returned one or more healed files, invoke the healed-callback with the repository's on-disk basename, the healed count, and the dropped-ids list (empty per step 2's flag).
6. Any error thrown by reconcile or heal is caught. Errors whose error code is in the set `ENOSPC`, `EROFS`, `EACCES`, `EPERM` are logged via the host-warning channel with a "heal blocked" prefix and the error's code in square brackets (these signal disk-level or permission problems the user can act on). All other errors are logged with a "heal failed" prefix and the code (or a literal `?` placeholder if no code is exposed). The listing then continues — labelling for the visible file rows degrades gracefully when heal fails.

The pre-pass holds no lock around its reconcile + heal sequence. Two concurrent listings against the same repository can both miss the memo and both run heal. The single-file write within heal is atomic at the disk level; the manifest read-modify-write window is bounded by the metadata layer's own atomic write. Concurrent re-runs with drop disabled are idempotent — the only manifest mutation is the entry update keyed by fileId.

### Inner listing of a directory

Called with a repository-root or user-entry-root absolute path and an inner relative path (possibly empty) that addresses a directory under the root.

1. Compute the absolute path of the target: the root path if the inner relative path is empty, otherwise the root joined with the inner relative path.
2. Stat the absolute path. The repository-discovery / user-entry-stat steps already gated on a corresponding existence check, so a missing absolute path here is rare; any stat failure throws and propagates back through the resolution flow.
3. If the stat reports a non-directory, take the file branch instead (see "Inner listing of a file" below).
4. Enumerate the immediate children of the absolute path via a single directory-read with type information per entry.
5. Filter: drop every entry whose name starts with a dot.
6. Sort: directories before files; within each group, alphabetical by name.
7. If at least one filtered entry is **not** a directory (i.e. at least one file row will need classification), build a manifest lookup by reading the manifest at the repository's hidden-metadata path and indexing every recorded entry by its repository-relative path. If the manifest read fails or the content is unparseable, the lookup is an empty mapping. If the manifest is parseable but has no entries field, the lookup is an empty mapping. A user-entry root has no manifest by construction; the lookup is an empty mapping.
8. For each surviving entry, project a child folder node:
   - The child's inner relative path is `<inner-relative-path>/<entry-name>` (or just `<entry-name>` when the inner relative path is empty).
   - For a directory: name is the entry's basename; relative path is the inner relative path; is-directory true; children the literal absent value.
   - For a file: name is the entry's basename; relative path is the inner relative path; is-directory false; children the empty list. Look up the manifest entry by the child's inner relative path. Compute file kind via classification. If a manifest entry exists, populate file key from the entry's identifier and file branch from the entry's recorded source branch. Derive file title: the manifest entry's recorded title takes precedence; otherwise the content-derived title. Compute is-diverged via the fingerprint comparison.
9. Return a folder node: name is the basename of the inner relative path (or the empty string when the inner relative path is empty); relative path is the inner relative path; is-directory true; children is the projected list.

### Inner listing of a file

Called when the stat in step 2 of the directory branch reports a non-directory.

1. Build the manifest lookup (same logic as the directory branch's step 7).
2. Look up the manifest entry by the inner relative path.
3. Compute the file's name as the trailing segment of the inner relative path.
4. Derive the file's title: manifest entry's recorded title if non-empty, otherwise content-derived.
5. Return a folder node with: name from step 3; the inner relative path as the relative path; is-directory false; children the empty list; file kind via classification; file key from the manifest entry's identifier (if any); file branch from the manifest entry's source branch (if any); file title from step 4; is-diverged via fingerprint comparison.

### Fingerprint divergence computation

For a given absolute path and a recorded fingerprint (or its absence):

1. If no fingerprint is recorded, return false.
2. If the absolute path does not exist on disk, return false.
3. Otherwise read the file's bytes synchronously, compute the same fingerprint algorithm used by the metadata layer over the content, and compare to the recorded fingerprint. Return true on mismatch, false on match.
4. If the read or compute step throws, return true (conservative).

### Title derivation from content

1. If the file's name does not end with `.md` (case-insensitive), return no title.
2. Open the file for read. Read up to one kilobyte from the start. Decode as UTF-8.
3. Close the file. If the open, read, or close step throws, return no title.
4. Pass the decoded head to the parser:
   - Strip a leading byte-order mark if present.
   - Attempt to match a leading frontmatter fence pattern: an opening line of exactly three hyphen characters (with optional carriage-return), body lines, and a closing line of exactly three hyphen characters (with optional carriage-return) followed by optional trailing newline. If matched, extract the body; search the body for a line matching the case-insensitive multiline pattern of optional leading whitespace, `title`, optional whitespace, a colon, optional whitespace, captured value, optional trailing whitespace. If found, strip a matching pair of surrounding quote characters (double-quote–double-quote or single-quote–single-quote, only when the value is at least two characters and the first and last characters match) from the captured value, trim, and if the trimmed result is non-empty, return it. Otherwise consume the entire frontmatter block (advance past it) and continue.
   - Walk the remaining content one line at a time (line endings normalised across `\n` and `\r\n`). For each line, trim; if the trimmed line is the empty string, skip to the next. For the first non-empty trimmed line, attempt to match the ATX-form first-level heading pattern: a single `#` character, then at least one space or tab, then non-greedy content, then optionally trailing whitespace, trailing `#` characters, and optional trailing whitespace. If matched, trim the captured content; if the trim yields a non-empty string, return it; if it yields an empty string, return no title. If the first non-empty trimmed line does not match the heading pattern, return no title.
   - If no non-empty line is found, return no title.

### Listing repositories for the breadcrumb

A separate single-call interface returns the current list of discovered repositories under the parent folder. It invokes the repository-discovery surface with the current-workspace identity (refreshed every call) and returns the result unchanged. (The breadcrumb uses this to populate a repository dropdown; the result's per-row current-repository flag drives sort and labelling on the consumer side.)

### Listing branches for a repository

A separate single-call interface, given a recorded repository name, returns the list of branch names known to that repository:

1. Invoke the repository-discovery surface and find the repository whose recorded name matches the input. If no repository matches, return an empty list.
2. Read the per-repository branch-mapping registry. The branch names are the registered branches in the registry (boundary spec). If the registry is missing or unparseable, the mapping list is empty.
3. If the mapping list is empty, return an empty list (the repository is either unknown or pre-commit fresh).
4. Read the per-repository projected summary index. For each entry, classify by whether the entry has a head (a `parentCommitHash` of null) versus is a hoisted child (a `parentCommitHash` set). Project two sets: branches that have at least one head entry, and branches that appear in the index at all (head or child).
5. If the projected index is missing or unparseable, return the mapping-list values, de-duplicated and sorted ascending, unchanged.
6. Otherwise filter the mapping list: a branch surfaces if it has a head in the index OR it is not in the index at all (the fresh-repo case where a mapping pre-dates any commit on it). A branch is hidden if it appears in the index but has no head (the orphan-mapping case where every entry on that branch is a hoisted child). De-duplicate the survivors and sort ascending. Return.

### Clearing the clean-repository memo

A single public interface drops entries from the per-instance memo. When called with a specific repository-root absolute path, only that entry is removed. When called with no argument, the entire set is cleared. This is invoked by external refresh triggers so that the next listing actually re-runs reconcile + heal.

### Healed-callback fan-out

When a heal pass during the pre-pass returns at least one healed file, the service invokes the optional callback supplied at construction with: the on-disk basename of the repository (the first segment of any address that will refer to it), the healed count, and the dropped-ids list (an empty array for this entry point, see "Reconcile + heal pre-pass" step 2). The callback is the consumer's signal to refresh sibling nodes that may now exist on disk.

## State Transitions

The service is stateful only via the per-instance clean-repository memo. The set transitions as follows for any given repository's absolute root:

```
ABSENT ──(listing inside the repository observes a heal pass with healed=0 and failed=0)──> PRESENT
PRESENT ──(another listing inside the repository requests the heal pre-pass)──> PRESENT (no-op; pre-pass skipped)
PRESENT ──(external refresh trigger calls the whole-set clear)──> ABSENT
PRESENT ──(external refresh trigger calls the single-repo clear with this root)──> ABSENT
PRESENT ──(a Refresh's archival sweep archived at least one folder)──> ABSENT (whole-set clear; a sweep that archived nothing leaves the memo intact)
PRESENT ──(a Refresh's duplicate consolidation completed)──> ABSENT (whole-set clear; the survivor's contents changed even when its path did not)
ABSENT ──(listing inside the repository observes a heal pass that healed at least one file)──> ABSENT (pass through; memo not added)
ABSENT ──(listing inside the repository observes a heal pass that failed at least one file)──> ABSENT (pass through; memo not added)
ABSENT ──(reconcile or heal throws)──> ABSENT (memo not added; warning logged; listing continues)
ABSENT ──(listing inside the repository while the workspace is manually disabled)──> ABSENT (pre-pass skipped entirely; memo not added; listing proceeds in full; the pre-pass re-arms by itself once re-enabled)
```

The folder-node payload returned from any single listing has no state of its own; every listing is computed from disk and the manifest at the moment of the call. Consumer-side caching of expanded subtrees is the consumer's concern; the service simply returns one folder node per call.

## Notable Behavior

- **This surface is no longer read-only, and the Refresh button is where it stopped being read-only.** Every listing path described above still only reads and (through the pre-pass) regenerates files from their own hidden sources — but a user-initiated Refresh of the tree now archives repository folders and folds several folders into one before re-listing. Both operations move directories. Anyone reasoning about this surface as a viewer, or about Refresh as a safe re-read, is reasoning about a previous behavior. (Notable; the single largest change to the surface's contract.)
- **The two Refresh mutations have opposite busy disciplines against the same lock.** Both take the per-vault write lock with the same short budget. The sweep skips silently and reports nothing archived, which is indistinguishable from a clean sweep. The consolidation surfaces the busy vault to the user and asks them to click Refresh again shortly, because they confirmed that merge through a modal. (Notable.)
- **The clean-repository memo is cleared by both mutations, but only conditionally by the sweep.** The consolidation always clears the whole set after a successful merge; the sweep clears it only when it actually archived something. A sweep that archived nothing leaves a previously-clean repository memoised, so the following listing still short-circuits past the reconcile + heal pre-pass. (Notable.)
- **The first-segment namespace lookup is two-tier and ordered.** A first segment matching both a discovered repository and a user-created entry of the same name resolves as the repository — the exclusion-set step at root listing also prevents the user entry from appearing twice. Two repositories of the same configured name disambiguate via their on-disk basenames (the recorded name plus parenthesised basename composition). The user-entry second-tier exists so the parent folder doubles as an Obsidian-style notes dump without those notes being mistakenly classified as repositories.
- **Repository-discovery is re-invoked on every listing.** The service stores no repository list; every listing fetches the latest snapshot from the boundary discovery surface using the latest-supplied workspace identity and Memory Bank parent folder. A repository created or removed since the previous listing is reflected immediately on the next call. (Notable.)
- **Reconcile + heal is awaited inline, not fire-and-forget.** The regenerated visible files must be on disk by the time the inner listing enumerates the folder; a fire-and-forget heal would return a tree omitting the recovered files and require the consumer to refresh again. (Notable.)
- **The pre-pass passes "do not drop orphaned manifest entries" explicitly.** This surface cannot inspect the active storage-mode configuration to determine whether dropping is safe, so it always preserves. The explicit pass-through makes the contract visible at the call site and survives future signature changes. As a consequence, the dropped-ids field of the healed-callback is always an empty array when populated by this pre-pass. (Notable; intentional defensive default.)
- **A manually disabled workspace skips the pre-pass but keeps a fully readable browser.** Reconcile and heal both write, so both are suppressed; every listing, classification, title, branch and divergence flag is still computed. Read access is deliberately not a casualty of turning the product off. (Notable.)
- **The disabled skip is self-cancelling, because the clean memo lives inside the skipped block.** A disabled session never memoises, so the pre-pass re-arms automatically on the first listing after re-enable — no invalidation call, no marker, no bookkeeping. Had the memo been recorded outside the gate, one listing during a disabled window would have permanently marked the repository clean and silently disabled self-healing forever after. (Surprising; the placement is the whole mechanism.)
- **This call site is the sole suppression point for the pre-pass.** Neither the reconcile operation nor the heal-and-regenerate operations carry a manual-disable gate of their own — only the underlying bulk-write entry point does, and heal does not go through it. So moving, duplicating, or bypassing this one check would let a disabled repository be written to. (Surprising; a real refactoring hazard. Cross-reference: spec 145 and `specs/304-manually-disabled-zero-write-contract.md`.)
- **The clean-repository memo is keyed by absolute root path, not basename.** A configuration change that re-points the Memory Bank parent folder to a different location cannot leak a "clean" status onto a same-named repository under the new parent. (Notable; intentional regression-closer.)
- **The clean-repository memo can short-circuit recovery of externally deleted files.** Once a repository is marked clean, external actors that delete a tracked visible file (manual deletion, file-system eviction, cloud-sync conflict) will not see the file regenerated on the next listing — the memo skips heal. The external-refresh-clear interface exists precisely to re-arm the pre-pass. Consumers that wrap external file-system events into a refresh trigger must invoke the clear before the listing. (Notable; surprising at first sight; intentional.)
- **Inner stat throws propagate; root readdir throws are swallowed.** A listing inside a discovered repository for a stale sub-path will throw (the consumer's webview catches and converts into an empty-tree fallback so the loading state ends). A root listing whose parent folder does not exist returns an empty children list. The asymmetry is intentional: a missing root is the normal "fresh install / reconfigured to a path not yet created" state, while a missing inner path is a stale-cache signal. (Notable.)
- **Symbolic links inside a repository or user-entry directory are followed.** The directory-walk uses standard stat semantics, not no-follow, so a symbolic link whose target is a directory will surface the target's contents under the source link's address. The repository boundary is soft, not enforced at the file-system layer. Symbolic links at the immediate root listing are silently dropped (the projection's non-file-non-directory filter catches them). (Notable; the within-repository behaviour is intentional flexibility, the root-level filter is intentional safety against dangling links and unusual file types.)
- **The classification map collapses one source type (`commit`) to a different display kind (`memory`); every other type passes through verbatim.** The `commit` → `memory` asymmetry is historical and is duplicated nowhere else; renaming on either side would silently drop the labelling. The pass-through default is why `skill` needed no classifier edit when the per-commit skill-usage aggregate became a manifest-tracked type — but it does mean a manifest type absent from the consumer's file-kind union breaks the build rather than degrading to `other`. (Notable.)
- **The consumer renders `skill` as a tagged Markdown row with a reachable context menu.** The service emits the flag only, but the two consumer-side decisions are worth recording because they are what a `skill` row is *for*: the sidebar gives it the same Markdown icon as memory / plan / note rows (they are all `.md`), tints it by kind, and appends an `S` tag reading "Skills used" — the same tag mechanism as the `P` / `N` plan and note tags, keyed by a lookup so adding a kind is one entry. Its right-click menu is **reachable** because the early-return that suppresses the menu for untracked kinds now admits `skill` alongside `plan` and `note`; without that one predicate the row would fall into the "other / untracked" branch and offer nothing (not even the Revert entry a diverged row earns). Cross-reference specs 151 and 324. (Notable; consumer-side, recorded here because the rendering follows directly from this classification.)
- **Manifest title takes priority over content-derived title; content-derived title is read only when no manifest title exists.** This avoids paying the per-file open + read cost on tracked files that already carry a title and also avoids surprising the user when a manifest title differs from the file's H1. (Notable.)
- **Title derivation cap is one kilobyte.** Each listing reads up to one kilobyte from each Markdown file lacking a manifest title. Folders full of large notes pay a bounded cost per listing. (Notable.)
- **A frontmatter title that captures the empty string falls through to the H1.** The frontmatter parser is tolerant of `title:` with no value, `title: ""`, or `title: ''` — all three trigger the fall-through path so the user still sees a useful title from an H1 below. (Notable.)
- **A first non-blank line that is not an H1 commits to no title.** The body walker does not look past the first non-blank line. A note whose first line is a paragraph followed later by an H1 will not derive a title. (Notable; intentional; matches the assumption that an authored title belongs at the top.)
- **An H1 whose content is only whitespace yields no title.** The heading regex's non-greedy capture can match a whitespace-only payload; the trim-and-non-empty check is the safety net so the UI does not render a blank-string title. (Notable.)
- **The `#` form `#foo` (no space after the hash) is not a valid H1.** The parser requires at least one space or tab between the hash and the content. (Notable; matches the CommonMark spec.)
- **The divergence flag is conservative on read errors.** A file whose content cannot be read (permissions, transient disk error) is reported as diverged so that the consumer's marker reflects "something is wrong here" rather than silently hiding the row's edited state. (Notable.)
- **The divergence flag is false for missing files.** Stale manifest rows pointing at deleted files do not raise the divergence marker; cleanup of those rows is a separate pipeline's responsibility. The pre-pass's heal would regenerate the file from its hidden source where available, so the divergence-equals-false state for a missing file is also short-lived in the common case. (Notable.)
- **The divergence flag is false for legacy manifest rows lacking a fingerprint.** Older entries written before fingerprint tracking are treated as "no source of truth to compare against" — no marker, matching the storage layer's preservation contract. (Notable.)
- **Repository-display name composition is duplicated at two call sites.** Both the root listing and the repository-at-its-own-root override apply the same composition; expanding then collapsing then re-expanding a collision-suffixed repository would otherwise silently revert the row label via the consumer's tree-merge pass. (Notable; intentional duplication.)
- **The repository-root override applies only at the literal own-root address.** A listing for a deeper sub-path inside a discovered repository must not carry is-repo-root or is-current-repo on its returned root node — those flags drive the consumer's repo-styling pseudo-class only on the actual repository row. (Notable; pinned regression.)
- **User-entry directories list their contents through the same inner-listing flow as repositories.** The flow happens to be correct for user entries by virtue of the manifest lookup degrading gracefully to an empty mapping when no manifest exists — every file in a user-entry tree consequently classifies as `other` without any extra branching. (Notable; intentional reuse.)
- **The user-entry exclusion set is the set of discovered-repository on-disk basenames, not their recorded names.** A repository whose recorded name happens to match a user-created sibling directory's name on the same parent folder will not cause the sibling to be hidden; only basename collisions hide. (Notable.)
- **The branch list filter has three modes.** With both registry and index present, the orphan-mapping filter applies. With the registry present but the index missing or unparseable, the registry's mappings surface unchanged. With the registry absent or empty, no branches surface at all (the repository is either unknown or fresh pre-commit). The "fresh repo" case (a branch with a mapping but no index entry) is preserved through the filter; only branches that appear in the index with zero head entries are hidden. (Notable.)
- **The index's index-summary projection tolerates an index file missing its entries field.** A version-only document with no entries field projects to two empty sets, which collapses to "no head invariants" and reverts the branch listing to mapping-only. The fall-through preserves the "fresh repo" path against schema-incomplete writers. (Notable.)
- **The heal-blocked vs heal-failed log distinction.** When the heal path throws an error code in `ENOSPC`, `EROFS`, `EACCES`, `EPERM`, the warning uses the prefix "heal blocked" and includes the code in square brackets — these are the categories an end user can fix (free disk space, remount read-write, grant permissions). All other errors use "heal failed" with the code (or `?` when the error is not an Error instance and exposes no code). Both branches continue to return the tree. (Notable; intentional differentiation to drive optional consumer toasts.)
- **The healed-callback fires only when at least one file was actually regenerated.** A pass that failed every regeneration without succeeding does not invoke the callback; the consumer's refresh signal is reserved for the "you have new content" case. (Notable.)
- **Lazy expansion is signalled by absent children, not empty children.** A directory whose listing has not been performed carries the literal absent-children value. A directory whose listing has been performed and is empty carries the empty-list value. A file always carries the empty-list value. This three-valued distinction lets the consumer drive its "Loading…" vs "no files yet" vs "leaf row" rendering without an extra flag. (Notable; intentional protocol shape.)
- **The relative-path validator rejects after collapse, not before.** A path containing a parent-directory segment that fully cancels with a sibling segment (`<repo>/foo/../bar`) normalises to a valid in-tree path (`<repo>/bar`) and is permitted; only paths whose normalised form contains an uncancelled parent-directory segment are rejected. This lets consumers send forward-equivalent paths without the service second-guessing them. (Notable.)
- **A user-created top-level file is a leaf and refuses expansion.** The expand path stat-checks the candidate and throws "cannot expand non-directory" when the candidate is a regular file. Consumers should not request expansion of a file node; the throw is the safety net. (Notable.)
- **The error message for a missing first segment uses the literal phrase "Unknown repo:" followed by the first segment.** Consumers can pattern-match the message to distinguish stale-path retries from other listing errors. (Notable; the message intentionally says "repo" even when the segment turned out to also miss the user-entry namespace, because the protocol's mental model is repository-first.)
- **The pre-pass concurrency is not locked.** Two concurrent listings against the same uncached repository will both invoke reconcile and heal. The single-file write within heal is atomic; the manifest update within heal is idempotent under concurrent re-runs because it is keyed by fileId. The pre-pass's only externally observable mutation is the manifest, which both passes converge to the same value. (Notable.)
- **The root listing user-entry scan is robust against unreadable parent folders.** A parent folder that exists but cannot be read (permission denied) yields an empty user-entry list, mirroring the missing-parent behaviour. Per-entry stat failures (dangling symbolic links, per-entry permission denials) inside the parent are silently skipped so one bad entry cannot break the listing. (Notable.)
- **Dotfile filtering is universal at every depth.** A dot-prefixed entry is excluded whether at the root, inside a user-entry directory, or inside a repository tree. A repository's own hidden metadata directory (a dot-prefixed name) is the most visible target, but the filter also drops every other dot-prefixed artefact (version-control directories, OS metadata, editor metadata). (Notable.)
- **The repository's own hidden metadata directory is never surfaced as a child.** It begins with a dot and is excluded by the dotfile filter at the root of any repository listing. Listings inside it (e.g. by addressing the literal dot-prefixed path) are also not supported — the path validator does not reject dot-prefixed segments, but the namespace lookup is not aware of them; the repository discovery surface would still match the parent repository, and the inner listing would walk into the dot-prefixed directory. The behaviour is undefined; consumers that respect the dotfile-filter convention never address it. (Notable.)
- **Identity restoration for repository-root listings overrides three fields together.** Name, is-repo-root, and is-current-repo are all restored on the root node of a repository-at-its-own-root listing. A refactor that overrides only some of them would silently regress the consumer's display. The override is pinned as a triple in tests. (Notable.)

## Shared Behavior

- **Memory Bank parent folder layout, repository-discovery rules, repository identity (recorded name and remote URL), collision suffix allocation, branch-folder transcoding, and the structure of the per-repository hidden metadata directory** are defined by the memory-bank-folder-layout spec. This spec consumes those contracts only at the boundary.
- **The manifest's record schema — its entry types (`commit`, `plan`, `note`, `wiki`, `skill`), recorded path, file identifier, source-branch field, fingerprint, and recorded title — and the manifest's reconcile-on-rename pipeline** are defined by the folder-based-summary-storage spec. This spec only reads the manifest's `files` list and projects per-file rows.
- **The heal pass that regenerates visible Markdown files from their hidden source-of-truth documents, the heal-result counters (healed, failed, dropped), and the "drop orphaned manifest entries" flag's semantics** are defined by the folder-based-summary-storage spec.
- **The per-repository projected summary index and its `parentCommitHash`-null head invariant** are defined by the folder-based-summary-storage spec and the orphan-branch-summary-storage spec. This spec consumes the projection only at the boundary.
- **Repository identity matching against the current workspace** (URL-equality versus name-equality, normalisation rules) is defined by the repo-identity-and-folder-naming spec.
- **The content-fingerprint algorithm** is defined by the folder-based-summary-storage spec. This spec computes the same algorithm at every divergence check.
- **The consumer-side message protocol that drives this service** (the expand-folder request, the folders-data response, the folders-reset signal, the error fallback that returns an empty-children tree to end the consumer's loading state) is defined by the VS Code sidebar webview message-protocol spec. This spec defines only the in-process interface.
- **The per-commit skill-usage aggregate file behind the `skill` kind** — its path within a branch folder, its content, and when it is written — is defined by spec 323 (and the Memory Bank folder layout, spec 151). The sidebar row's rendering, tag and context menu are owned by spec 324; this spec's own note on them records only what follows from the classification.
- **The archival sweep a Refresh runs before re-listing** — its emptiness predicate, its inert-document allowlist, its two-name operating-system-noise exemption, its two-part current-repository guard, its notification, and its silent skip on a busy vault — is defined by the Memory Bank unused-folder archival spec. This spec defines only that the sweep exists on this surface's Refresh, the interfaces it reaches through here, and its effect on the clean-repository memo.
- **The duplicate-folder consolidation a Refresh runs after the sweep** — the duplicate set, the three classifications and their survivors, the copy-if-absent merge and metadata union, the rebuild from the system of record, its two degradations, and its visible failure on a busy vault — is defined by the Memory Bank duplicate-folder consolidation spec. This spec defines only the split detect-then-confirm-then-execute shape it needs from this service and the current-project-root precondition.
- **The per-vault write lock** both Refresh mutations hold, its short wait budget, and the cross-repository pending-worker registry that neither of them drains on release are defined by the vault write-lock spec.
- **The on-disk file-system semantics** (the readdir-with-types primitive, the stat primitive, the line-ending and byte-order-mark conventions) are platform conventions and not duplicated here.
