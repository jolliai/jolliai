# VS Code JolliMemory Bridge Data Abstraction

## Topic Statement

A central object the VS Code extension constructs once per workspace that funnels every command, view provider, and webview through one named surface — for changes, commit, amend, push, force-push, squash, summary read/list/search, plan/note read/edit/remove, index snapshot save/restore, install/uninstall, hook-staleness check, and local-folder export — so that no command spawns a subprocess that runs `git` itself and no command imports the storage backend directly; the object lazily creates the storage backend the user's settings ask for, exposes a single reload hook so settings changes invalidate it without a window reload, and routes structural errors (missing summary, malformed key, refused push target) into a small fixed set of bridge-level rejections that webviews can display verbatim.

## Scope

**In scope:**
- The single per-workspace bridge object that every command, provider, and webview message handler is constructed against.
- The full surface of operations exposed by the bridge, grouped into the categories below. Methods marked **read** use a separate read-side storage handle so that a dual-write deployment can read from the folder shadow while writes go to the orphan branch primary; methods marked **write** use the primary write-side handle.
  - **Install / status / staleness** — enable, disable, auto-install-for-worktree, status-snapshot, hook-staleness check.
  - **Storage lifecycle** — two reload hooks (`reload-everything` and `reload-read-only`), each with its own invalidation scope.
  - **Working tree** — list-files, list-files-by-commit, stage-files, unstage-files, discard-files, list-staged-paths, save-index-tree (with implicit unmerged-staging), restore-index-tree, reset-index.
  - **Commit message generation** — AI commit-message generator, no-LLM string-merge squash-message, LLM squash-message with string-merge fallback.
  - **Commit / amend / squash** — commit, amend-with-message, amend-no-edit, squash (with the summary-merge handoff below), squash-and-push.
  - **Branch history** — branch-commits walker with main-merge / fork-point detection, current-branch getter, HEAD-message getter, HEAD-hash getter, current-user-name getter, HEAD-pushed check.
  - **Push** — push current branch (with auto upstream set), force-push with lease.
  - **Summary access (read)** — read-summary-by-hash, recent-summaries listing, paged summary-entries listing with substring filter, cross-repo read-summary-by-hash (with and without source-repo / remote-url echoed back), summary index-entry map, transcript-id set, single-transcript read, batch transcript read across commits, index-needs-migration probe.
  - **Summary access (write)** — store-summary, regenerate-summary end-to-end, load-regenerate-context, store-plans, store-notes, store-references, save-transcripts-batch.
  - **Plans, notes, references** — list-plans, remove-plan, archive-plan-for-commit, cleanup-visible-plan-artifact, list-notes, save-note, remove-note, cleanup-visible-note-artifact, archive-note-for-commit, list-references, remove-reference, open-reference-in-browser, open-reference-markdown.
  - **Cross-repo helpers** — discover repos under the Memory Bank parent, build a storage handle rooted at a foreign repo's Memory Bank folder, build a storage handle rooted at the current workspace's Memory Bank folder, resolve a memory file at an absolute path to its (repo, slug, source) tuple, detect whether a memory file on disk has diverged from the storage-backed copy.
  - **Memory-bank caching** — the cached "all root index entries" optimization for the Memories panel with its single-purpose invalidation hook, plus a short-lived (few-second TTL) discovery cache for the file-decoration provider's per-URI polling.
- The lazy storage backends: a write-side handle and a read-side handle, each created on first use of its accessor, each cached for the bridge's lifetime. The `reload-everything` hook clears both handles and every dependent cache on settings save; the narrower `reload-read-only` hook clears just the read handle so a user-initiated refresh can re-probe the folder/orphan fallback without churning the write side.
- The squash-with-summary-merge handoff: a squash-pending record is written to the project state directory **before** the new commit is created so the post-commit hook reads it and merges the per-commit summaries instead of running the LLM.
- The plugin-source marker that every commit / amend / squash writes before invoking git, so the post-commit-hook queue knows the operation came from this surface.
- The error-normalization contract: backend-specific exceptions and subprocess-spawn errors are caught and re-surfaced through the bridge's own promise rejections / sentinel returns; the rest of the extension never touches storage exceptions or git-subprocess errors directly.
- The cached "all root index entries" optimization for the Memories panel and its single-purpose invalidation hook.

**Out of scope:**
- The webview message protocol that talks to the bridge (separate spec).
- The view providers (Memories, Plans & Notes, Changes, Commits) (separate specs).
- Specific commands' UI flows (commit, squash, push, force-push) (separate specs).
- The hook scripts the post-commit / post-rewrite / prepare-commit-msg paths run.
- The OAuth login flow (separate spec).
- The local pusher implementation that ships a summary into a directory.
- The summary-store implementation; the bridge only knows it exposes the read-summary-by-hash capability, the recent-summaries listing capability, the index-entry snapshot capability, the read-plan-from-branch capability, the read-note-from-branch capability, and the tree-hash alias scanner.

## Data Contracts

### One bridge per workspace root

The extension constructs exactly one bridge per workspace root, holding the absolute path to the workspace as the workspace directory. Every method on the bridge takes its workspace from this field; no method receives a working-directory argument. The bridge is constructed at activation time and lives until deactivation.

### Lazily-created storage backends

The bridge holds two private storage-backend handles, each initialized lazily and each used for a distinct half of the bridge's surface:

- A **write-side handle**, used by every method that mutates summaries / plans / notes / transcripts on this workspace's primary storage.
- A **read-side handle**, used by every method that reads summaries / plans / notes / transcripts from this workspace's storage. The read-side handle exists separately because a dual-write deployment reads from the folder-shadow when it is current and clean, falling back to the orphan-branch primary only when the folder is empty or its last write was incomplete. Reading through the write-side handle would silently miss any row written to the folder shadow by something other than this device's local commits (sync, external migration, sibling IDE on the same folder).

| State                  | Trigger                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| Unset                  | Bridge construction; or after the corresponding storage-reload hook fires.                              |
| In flight              | First call to a method that needs the handle; or first read after invalidation.                        |
| Resolved (cached)       | Subsequent calls reuse the same handle instance.                                                       |

Both handles are created from the user's saved settings (storage mode and folder path). When either lazy initialization rejects, its cache slot is cleared so the next caller gets a fresh attempt rather than awaiting the cached rejected promise forever.

The bridge does **not** persist either handle across calls into the in-process global the queue worker uses — that global is only relevant to the worker process, which lives in a different process from the extension host.

The two reload hooks differ in scope:

- The **full reload** clears the write handle, the read handle, the cached root-entries list, and the short-lived discovery cache. Fired by the settings-save callback when `storageMode` or `localFolder` changes — both handles must be cleared together because leaving the read cache after an orphan ↔ dual-write flip would silently keep reads on the previous mode's storage; the entries cache is cleared because `localFolder` changes the discoverable set of foreign repos.
- The **read-only reload** clears just the read handle. Fired by a user-initiated refresh (e.g. after a peer-sync repopulates the folder). The write-side handle stays hot so the refresh button does not churn the (config-load + factory) path when the user has not changed mode or folder. Without this narrower hook, a dual-write session that fell back to the orphan-branch backend on first read (because the folder shadow's index was still missing) would keep serving that cached instance forever — folder-side rows iCloud or a sibling IDE just dropped in would stay invisible until the next window reload or a settings flip.

The discovery cache that the file-decoration provider's per-URI polling uses has its own short (few-second) TTL plus explicit invalidation by the full reload, so per-URI redraws don't fire a config read + filesystem scan for every visible markdown file on every Explorer scroll.

### Method categories

Every method below is on the bridge surface. Errors that escape are documented inline.

#### Install / status
- The enable capability — runs the installer in vscode-extension mode and returns `{ success, message }`.
- The disable capability — runs the uninstaller and returns `{ success, message }`.
- The status-snapshot capability — returns the install status snapshot. On any thrown error, returns a fully-zeroed default snapshot (enabled=false, all hook flags false, zero sessions, zero summaries, default orphan branch name, no detected agents) so the caller never has to handle a status-query failure. The zeroed snapshot also carries the effective Memory Bank state as its **"off" arm** — the same arm a user who opted out of the folder layer entirely would see. The reasoning is that the underlying probe threw before it could resolve anything, so the folder layer's real state is unknown; reporting "off" matches what the rest of this fallback asserts (nothing is working) and is safer than naming an active folder that was never confirmed. The state's arms and their user-facing wording are defined by the memory-bank write-boundary and effective-state-reporting spec.
- The worktree auto-install capability — re-runs install for a freshly-checked-out worktree.
- The hook-staleness check — checks the per-source dist-path entry and re-installs when stale; returns a `{ resolvedVersion, extensionVersion, source }` mismatch hint when a different source has registered a higher version. Errors are swallowed so it never blocks activation.

#### File ops
- The working-tree listing capability — runs `git status -z --porcelain=v1 -uall` and returns a status row per file. Empty list on git failure.
- The commit-files listing capability — runs `git diff-tree -m --first-parent -M -r --name-status --root <hash>` and returns a per-file info row for the given commit. Empty list on git failure.
- The stage capability — `git add` for present paths; with the allow-missing option, partitions paths by on-disk existence and `git rm --cached --ignore-unmatch`s the missing ones. Errors propagate.
- The unstage capability — `git restore --staged --` in a single invocation. Errors propagate.
- The discard capability — groups by status and runs the matching restore / rm flow per group. Errors propagate.

#### Commit message generation
- The commit-message generator — gathers the staged diff, branch name, staged file list, and global config; calls the Anthropic-or-Jolli routing layer; returns the proposed message. Errors propagate.

#### Commit / amend
- The commit capability — writes a plugin-source marker, runs `git commit -m`, returns the new HEAD hash.
- The amend-with-message capability — writes a plugin-source marker, runs `git commit --amend -m`, returns the new HEAD hash.
- The amend-no-edit capability — writes a plugin-source marker, runs `git commit --amend --no-edit`, returns the new HEAD hash.

#### Branch history
- The branch-commits walker — resolves a base ref (origin/<main>, then upstream/<main>, then local <main>), walks `<base>..HEAD`, and returns `{ commits, isMerged }`. When the branch is fully merged into main (merge-base equals HEAD), it reads the branch reflog once and resolves both the log-range base (where the branch was created) and whether the branch ever committed anything of its own; a fully-merged branch with **no own commit** (created from main then rebased/reset onto main — a routine sync) returns an empty result so already-merged sync commits aren't re-listed as this branch's work. When it does have own commits it switches to "merged mode": uses the resolved creation point as the base and filters commits by the configured user. When the branch is **not** merged, the own-commits base is measured from the branch's true fork point (its reflog creation point when that sits downstream of the mainline merge-base — e.g. a branch cut from a release branch — otherwise the mainline merge-base) rather than from the mainline directly. For each commit, it emits topic count, insertion count, deletion count, files-changed count, push status, summary presence, and an optional commit type. Background scans for tree-hash aliases run when commits without a summary are present.

#### Push
- The current-branch push capability — `git push`, automatically setting `-u origin <branch>` when no upstream is configured.
- The force-push capability — `git push --force-with-lease`, with the same upstream rule.
- The HEAD-pushed check — returns true when the current HEAD is reachable from the branch upstream.

#### Squash
- The string-merge squash-message capability — string-merge of the per-commit subjects (no LLM).
- The LLM squash-message capability — calls the LLM with the commits' subjects and summary topics; falls back to string-merge on failure.
- The squash capability — see "Squash with summary-merge handoff" below.
- The squash-and-push capability — squash followed by force-push.

#### Summary access (read)
- The recent-summaries listing — top-N most recent commit summaries (full payloads).
- The paged summary-entries listing — paged lightweight summary index entries (sorted newest-first, deduplicated by commit hash, root entries only). Filter is a case-insensitive substring against the commit message and branch. Cached after the first call; the entries-cache invalidator clears the cache.
- The branch-memories listing — summaries reachable from the current branch, for the Branch Memories tree.
- The entries-cache invalidator — drops the cached root entries.
- The read-summary-by-hash capability — returns the full summary or null.
- The cross-repo read-summary-by-hash capabilities — current-repo-first lookup that falls back to scanning every discoverable foreign-repo Memory Bank; one variant returns just the summary, the other also echoes back the source-repo name and remote URL so callers can gate write actions on foreign-vs-local provenance.
- The summary index-entry map — full index keyed by commit hash (used by the branch-history walker to populate diff stats and topic counts without a per-commit git call).
- The transcript-id set — every transcript ID stored on the orphan branch for this commit; the conversations card uses this set, intersected with the in-summary transcript list, to render the per-source group counts.
- The single-transcript read — returns the stored transcript for one commit, or null when absent.
- The batch transcript read — returns transcripts for a set of commit hashes, used to assemble the multi-commit transcript modal.
- The index-needs-migration probe — surfaces whether the on-disk index uses a pre-v3 layout and should be migrated.

#### Summary access (write)
- The store-summary capability — writes a full summary to the active write-side storage.
- The regenerate-summary capability — runs the end-to-end regenerate flow (rebuild transcripts → LLM → write summary → update banner state).
- The load-regenerate-context capability — assembles the auxiliary fields (diff stats, transcript entry counts, LLM provider info) the regenerate confirmation dialog uses.
- The store-plans / store-notes / store-references capabilities — partial writes against the summary's satellite arrays.
- The batch transcript save — writes a batch of transcript edits across one or more commits.

#### Plans / notes / references
- The plans listing — returns the per-row plan info from the project's plan registry, applying the visibility filter.
- The plan removal — soft-deletes a plan by setting its ignored flag.
- The visible-plan-artifact cleanup — for committed plans the user removed; deletes the on-disk artifact rendered for the given branch.
- The plan archive-for-commit — moves a plan's working content into the per-commit archive on the orphan branch.
- The notes listing — returns the per-row note info from the registry.
- The note save — creates or updates a note; returns the saved row.
- The note removal — removes a note; for uncommitted snippets with a source path, also deletes the source file.
- The visible-note-artifact cleanup — counterpart to the plan-artifact cleanup, for notes.
- The note archive-for-commit — counterpart to the plan archive-for-commit, for notes.
- The references listing — returns the per-row external-reference info (Linear issues / Jira tickets / GitHub issues / Notion pages) detected for the workspace.
- The reference removal — hard-removes a reference (registry row plus backing markdown) by its registry key; the row can be revived later by re-detection.
- The reference open-in-browser — opens the reference's upstream URL in the user's default browser; returns whether the open was attempted.
- The reference open-markdown — opens the per-reference markdown file in a VS Code editor tab.

#### Index snapshot
- The index-tree save — stages any unmerged files (assumes the worktree version is the resolution), runs `git write-tree`, returns the tree SHA.
- The index-tree restore — runs `git read-tree <treeSha>`.
- The index reset — mixed reset (no flags) to clear the index back to HEAD.

#### Local folder push
- The local-folder push — loads the full summary, filters plans/notes by commit hash, reads each file from disk (with a fallback to read-from-orphan-branch when the disk copy is missing), builds the summary markdown, and delegates to the local pusher. Throws when no summary exists for the given hash.

#### Cross-repo helpers
- The cross-repo summary lookup (with and without source-repo / remote-url echoed back) — tries the current repo's storage first; on miss, walks every other repo discovered under the configured Memory Bank parent and reads through each one's folder-storage shadow. The variant that echoes back the source-repo name and remote URL is used by callers that need to gate write actions on foreign-vs-local provenance (write actions must be disabled for foreign reads); the thinner variant is used by callers that only need the summary content.
- The current-repo read-storage builder — constructs a folder-storage handle rooted at the current workspace's Memory Bank folder so detail panels (transcripts, plans, notes) read from the same surface the Memory Bank tree view walks. Returns null when the user is in orphan-only mode or no matching Memory Bank folder is discoverable yet.
- The foreign-repo read-storage builder — constructs a folder-storage handle rooted at a named foreign repo's Memory Bank folder so callers can issue cross-repo reads without going through the current workspace's primary storage. Identity preference is remote URL over repo name (matching the repo-discoverer's identity rule); skips the current-repo entry intentionally. Returns null when no foreign repo matches.
- The memory-file-on-disk divergence check — given an absolute path to a memory file, returns true when the file on disk has been edited away from what the storage layer would currently render. Used by the UI to badge edited-on-disk files.
- The memory-file resolver — given an absolute path, returns the (repo, slug, source) tuple identifying which discovered repo, which storage source, and which slug the path corresponds to. Returns null when the path is not under any discovered Memory Bank.

#### Convenience getters
- The user-name getter — `git config user.name`.
- The current-branch getter — `git rev-parse --abbrev-ref HEAD`, defaults to `HEAD` when detached.
- The HEAD-message getter — first-line subject of HEAD.
- The HEAD-hash getter — HEAD commit hash.
- The staged-paths getter — paths from `git diff --cached -z --name-only`.

### Squash with summary-merge handoff

The squash capability runs in this exact order:

1. Snapshot the current HEAD hash for logging.
2. Write the plugin-source marker in the project state directory.
3. Resolve the parent of the oldest commit (`<oldestHash>^`) — this is the fork point.
4. Write the squash-pending record to the project state directory carrying the squash inputs: the list of hashes being squashed and the expected parent (the fork point).
5. Run `git reset --soft <forkPointHash>` so HEAD moves to the fork point and all changes go back to the staging area.
6. Run `git commit -m <message>` to create the squash commit.
7. Read and return the new HEAD hash.

The squash-pending record is what tells the post-commit hook (running in a separate process) to merge the source commits' summaries instead of generating a fresh one for the squash commit.

### Plugin-source marker

Every method that creates a commit (commit, amend-with-message, amend-no-edit, squash) writes the plugin-source marker to the project state directory before invoking `git commit`. The post-commit-hook queue worker reads this marker and tags the queue entry with `commitSource: "plugin"`. This is what differentiates plugin-driven commits from CLI-driven and external-tool commits in the queue.

### Error normalization

The bridge funnels three classes of errors:

| Source                                    | Bridge surface                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Status-snapshot exceptions                | Caught; replaced with a fully-zeroed default snapshot.                                                  |
| Tolerant git-subprocess non-zero exits    | Caught; empty string returned. Methods built on the tolerant runner (history, branch lookups, working-tree listing, commit-files listing, current-branch getter, HEAD-pushed check, etc.) treat the empty string as a no-data sentinel and return empty arrays / sensible defaults. |
| Strict git-subprocess non-zero exits      | Propagated as a thrown error with the original git stderr. Methods built on the strict runner (stage / unstage / discard / commit / amend / squash / push / read-tree / write-tree / reset) propagate. |

Local-folder push throws an error with the message `No summary found for commit <hash>` when the requested hash has no stored summary.

The contract: methods that may legitimately fail because of a transient repository state (no remote, no commits yet, status command errored) return empty / null / default values; methods that drive a state mutation propagate. Local-folder push is the lone exception — it throws specifically when the user asks to export a hash that does not exist.

### Cached root entries for paged listings

The paged summary-entries listing caches the sorted, deduplicated list of root summary index entries on the bridge after its first computation. Subsequent calls slice into the cached array using offset and count, optionally filter case-insensitively, and recompute the total only against the filter. The entries-cache invalidator is the single hook that drops the cache; the Memories provider calls it after any mutation that changes the index (push to space, refresh from another source, etc.).

### Path normalization for hook-staleness check

The hook-staleness check compares `<extensionPath>/dist` (the path the extension is currently running from) with the registered `dist-paths/<self-tag>` entry. The comparison normalizes each path by:

1. Replacing backslashes with forward slashes.
2. Trimming trailing slashes.
3. On Windows or macOS (case-insensitive filesystems), lower-casing the result.

Symlinks and `..` segments are not resolved. A path mismatch is treated as a staleness signal and triggers a re-install to register a fresh entry. Versions of the same extension from sequential releases can bundle the same core CLI version, so path equality (not version equality) is what the staleness check relies on.

## Behavior

### Construction

The extension activation handler constructs one bridge per workspace root. The constructor stores the workspace directory. No I/O happens at construction.

### Storage backend lifecycle

The first method that needs the backend (any summary access, branch history with index lookup, push-to-local, paged summary-entries listing) requests the backend through the storage-backend accessor:

1. If the storage-backend handle is unset, it is set by invoking the storage factory with the workspace directory, which reads the user's saved storage mode and instantiates the matching backend (orphan-only, folder-only, or dual-write wrapper).
2. The handle resolves to a backend that exposes the summary-store interface methods.
3. Subsequent storage-backend accesses return the cached handle.

When the user saves the settings webview (changing storage mode or folder path), the extension fires the storage-reload hook on the bridge. The next storage-backend access rebuilds.

### File-listing flow

The working-tree listing capability runs `git status -z --porcelain=v1 -uall` and parses the NUL-separated output. The `-uall` flag is what expands untracked directories into per-file rows so the Changes panel surfaces individual paths instead of a single directory row. Renames and copies emit two NUL-separated segments (new path then old path); the parser advances by one extra segment for those entries. Directory-shaped entries (paths ending with `/`) are skipped defensively even with `-uall` set.

### Commit-message-generation flow

The commit-message generator:

1. Gathers the staged diff, current branch, and global config in parallel.
2. Reads the staged file paths (one extra `git diff --cached -z --name-only`).
3. Calls the Summarizer routing layer (Anthropic direct or Jolli proxy depending on saved credentials) with the staged diff, the branch, the staged files, and the config.
4. Returns the generated message.

The full transcript is **not** passed — that is reserved for the post-commit hook's structured-summary call. The commit-message call is intentionally cheap (diff + branch only).

### Branch-history flow

The branch-commits walker:

1. Resolves the history base ref by trying `origin/<main>`, then `upstream/<main>`, then local `<main>`; the first that exists is used.
2. Computes the merge-base of HEAD and the base ref.
3. If the merge-base equals HEAD, the branch is fully merged. It reads the branch reflog once to resolve the merged-history base (the explicit "branch created from" entry, else the oldest surviving entry) and a flag for whether the reflog records a `commit` op of the branch's own. If the branch has **no own commit** (only creation + rebase/reset/checkout ops, i.e. a routine sync), it returns an empty result so the panel shows nothing — those commits belong to main, not this branch. Otherwise it enters "merged mode": uses the resolved base, filters by `git config user.name`, and sets the merged flag. (Detached HEAD or an expired/unavailable reflog also yields an empty result.)
4. Otherwise it resolves the own-commits base (the reflog creation point when downstream of the mainline merge-base, else the mainline merge-base) and walks `<base>..HEAD` with `git log --pretty=format:%H%x00%s%x00%an%x00%ae%x00%aI%x00%x00`.
5. Resolves the push base ref (`@{upstream}` first, then `origin/<currentBranch>`) and computes the set of unpushed hashes.
6. Reads the summary index map (one call) and, for each commit, looks up its index entry to populate topic count, insertion count, deletion count, files-changed count, and commit type. When the index entry has no diff stats, it falls back to a single `git diff --shortstat` call per commit.
7. Fires a background tree-hash alias scan for any commit without an index match — this is what catches cross-branch tree-hash matches after rebases.

### Squash flow

See "Squash with summary-merge handoff" above.

### Hook-staleness flow

The hook-staleness check:

1. If the project has hooks in the legacy hardcoded-path format (no `dist-path` indirection in `.claude/settings.local.json`), runs the enable capability to migrate them.
2. Resolves this extension's source tag from its install path.
3. Reads all per-source dist-path entries from the global state directory.
4. If this extension's own entry is missing, unavailable, or its registered path does not equal `<extensionPath>/dist` (after normalization), runs the enable capability to register a fresh entry. This only touches this source's per-source file.
5. Scans all source entries for the highest available version. If a different source has a higher version than this extension's own version, returns a `{ resolvedVersion, extensionVersion, source }` mismatch hint.

Errors anywhere in this flow are caught and not propagated.

### Local-folder push flow

The local-folder push:

1. Loads the full summary; throws if not found.
2. Loads all plans and all notes in parallel; filters each by commit hash.
3. Builds URL maps from the summary's `plans[*].jolliPlanDocUrl` / `notes[*].jolliNoteDocUrl`.
4. For each matched plan: reads its file from disk if a file path is set; otherwise reads it from the orphan branch by slug. Empty content rows are skipped.
5. For each matched note: reads its file from disk if a file path is set; otherwise (snippet with inline content) uses the inline content; otherwise reads from the orphan branch by id.
6. Builds the summary markdown.
7. Delegates to the core local-pusher with the assembled folder, summary, summary markdown, satellites, and workspace directory.

## State Transitions

On extension activation, the bridge is constructed for the workspace root and its storage-backend handle is left unset. No I/O happens yet.

The first time any method that needs storage runs, the bridge invokes the storage factory with the workspace directory and caches the resulting handle. Every subsequent storage-needing call awaits the same handle.

When a settings save changes the storage mode or the folder path, the storage-reload hook clears the cached handle. The next storage-needing call rebuilds it from the freshly-saved settings.

When a command runs commit, amend, or squash, the bridge first writes the plugin-source marker for the workspace. If the operation is a squash, the bridge writes the squash-pending record (with the hash list and the fork point) before the soft reset. It then invokes git as appropriate (a plain commit, an amend, or a soft reset followed by a commit), reads the new HEAD, and returns it.

The hook-staleness check fires once on activation. If the project still has legacy hooks in the repo, it runs the enable capability to migrate them. It then derives this extension's source tag, reads its own dist-path entry, and runs the enable capability again whenever the entry is missing or the registered path does not match. Finally it scans all sources and, if any other source has registered a higher version, returns a mismatch hint.

When the settings webview updates entries that affect the cached root listing, the bridge's entries-cache invalidator is called. The same invalidator is called whenever a push to space or another external surface mutates the orphan branch.

When a tolerant-git-runner-backed method observes a non-zero exit, the empty stdout is treated as a no-data sentinel and the method returns an empty array, null, or its sensible default. When a strict-git-runner-backed method observes a non-zero exit, the thrown error propagates to the caller. When the local-folder push is invoked with an unknown commit hash, it throws an error of the form `No summary found for commit <hash>`.

On deactivation there is no explicit dispose; the bridge is GC'd with the extension context.

## Notable Behavior

- **The bridge is the single git boundary.** No command, provider, or message handler spawns a subprocess that runs `git` itself. The strict and tolerant git-subprocess runners are private to the bridge module.
- **The bridge does not persist a worker-side global storage instance.** The bridge holds the storage backend on its own field; the in-process global the queue worker uses is irrelevant to the extension host because they live in different processes. This is what lets the user change storage mode in settings without affecting in-flight queue worker runs.
- **The tolerant and strict git runners differ only in error handling.** Both invoke `git` as a child process from the workspace directory. The tolerant runner swallows non-zero exits and returns the empty string; the strict runner rethrows. Methods pick one based on whether their failure mode is "no data" vs. "operation failed".
- **The plugin-source marker is written by every commit-creating path.** Without it, the post-commit-hook queue worker tags the queue entry with `commitSource: "external"` and may pick a different summary-generation strategy.
- **The squash flow's squash-pending record is written before `git reset --soft`.** This ordering is required because the post-commit hook reads the file the instant `git commit` resolves; if the file were written after `git commit`, the hook would race and miss it.
- **The index-tree save quietly stages unmerged files first.** The bridge assumes that a file appearing in the user's Changes view is a successfully resolved merge; it does not inspect contents for conflict markers. This is what lets the commit flow succeed even when `git write-tree` would otherwise refuse because of stage-1/2/3 entries.
- **The working-tree listing uses `-z` and `-uall`.** `-z` prevents quoting / escaping ambiguity for paths with arrows, newlines, or unicode. `-uall` expands directories of untracked files into individual rows. Both are non-default flags critical to the parsing contract.
- **The commit-files listing uses `-m --first-parent`.** Merge commits otherwise emit empty output for `diff-tree`. The parser stops after the first NUL-separated block so only the first-parent diff is kept; `--first-parent` is added for symmetry but `diff-tree` ignores it for single-commit invocations.
- **Path-equality is the staleness signal, not version-equality.** Two sequential extension releases can bundle the same core CLI version, so a semver comparison would miss the upgrade. The dist path embeds the extension version, so a path mismatch reliably signals "this extension was upgraded".
- **The paged summary-entries listing deduplicates by commit hash before sort.** The summary store's index map can carry multiple keys (commit-hash, tree-hash aliases) pointing at the same entry; the deduplication keeps each distinct commit hash exactly once.
- **The status-snapshot capability is total.** Any thrown error during install-status probing is mapped to a fully-zeroed default snapshot. Callers (status bar, sidebar status pane) never have to handle a status-query failure. The snapshot's effective-Memory-Bank-state field is required rather than optional, so the fallback has to supply a value for it too; it supplies the "off" arm, which means a probe failure and a deliberate opt-out are indistinguishable at this seam. (Notable; the alternative — guessing at an active folder — would be worse.)
- **The hook-staleness check swallows errors.** Activation cannot be blocked by a stale-hook check; if anything in the staleness logic throws, activation continues.
- **The local-folder push falls back to the orphan branch for missing files.** A plan or note whose source file has been deleted (e.g. an archived plan whose live file was removed) is still readable because the orphan branch carries a copy. Snippet notes whose source is inline in the summary are handled in-memory without any read at all.
- **The cached entries cache invalidates explicitly, not on settings change.** Callers that mutate the orphan branch (push to space, settings save that switches backend) invoke the entries-cache invalidator themselves; the bridge does not infer invalidation from settings or storage events.

## Shared Behavior

- **Installer (enable, disable, status-snapshot)** — the bridge is the only consumer; commands and providers go through the bridge.
- **Storage factory** — the bridge instantiates one backend per workspace; the storage interface methods (the read-summary-by-hash capability, the recent-summaries listing capability, the index-entry snapshot capability, the read-plan-from-branch capability, the read-note-from-branch capability, the tree-hash alias scanner) are called through the cached backend.
- **Session tracker (the plugin-source marker writer, the squash-pending writer)** — the writers of the plugin-source marker and the squash-pending record.
- **Summarizer routing** — called by the commit-message generator and the LLM squash-message capability; the bridge supplies the input bundle.
- **Local pusher** — called by the local-folder push after the bridge prepares the satellite list.
- **Plan and note services** — the bridge re-exports their list / save / remove / archive / cleanup methods.
- **Reference service** — the bridge re-exports the reference detector, the registry-and-markdown remover, and the open-in-browser / open-markdown helpers.
- **Repo discoverer and Memory Bank path resolver** — used by the cross-repo helpers to enumerate the foreign repos under the configured Memory Bank parent and resolve the per-repo Memory Bank root.
- **Folder storage and metadata manager** — instantiated by the cross-repo helpers to construct a storage handle rooted at any one repo's Memory Bank folder.
- **Read-storage resolver** — picks the right read-side backend (folder when both index and shadow-cleanliness check pass, orphan-branch otherwise) for the current workspace and the read-side handle.
- **Dist-path resolver** — used by the hook-staleness check to read all per-source entries.
- **Commit-message merge utility** — used by the string-merge squash-message capability for the no-LLM path.
- **Diff-stats helper** — fallback path when the index entry lacks cached diff stats.
- **Webview message handlers** — every handler routes through the bridge for git, summaries, plans/notes, and install state.
- **All view providers (Memories, Plans & Notes, Changes, Commits)** — each holds a reference to the bridge and never bypasses it.
- **The IntelliJ surface's equivalent of this bridge is not an in-process object.** It is a hidden command surface reached over a JSON-RPC envelope (spec 287), served either by a long-lived per-project connection or by a one-shot spawn (spec 288). The two hosts therefore have structurally different data abstractions over the same core: this one is a single object whose methods are ordinary in-process calls against a lazily created storage handle, while the other is a named action-and-operation catalogue whose every call crosses a process boundary and can fail for transport reasons this bridge has no equivalent of.
