# IntelliJ Native Git CLI Wrapper

## Topic Statement

The IntelliJ side of Jolli Memory invokes the user's system `git` binary through a thin subprocess wrapper that resolves the user's interactive-shell PATH, adds an extra entry on Windows so the queue worker's POSIX text utilities are reachable, runs each command with a default 15-second timeout, and reads stdout on a separate thread to avoid pipe-buffer deadlock.

## Scope

- Resolving an environment PATH that mirrors what the user sees in their interactive terminal, so the processes the plugin itself spawns can locate `node`, package-manager-installed tools, and POSIX utilities such as `sed` and `awk`. (Installed hooks inherit their environment from git, not from this wrapper.)
- Spawning the system `git` binary with that PATH and the project directory as the working directory.
- Executing arbitrary git argument lists, optionally with stdin piped in.
- Returning trimmed stdout on success and null on any non-zero exit, timeout, or exception (the plain call form).
- A second call form that returns a structured result — exit code, stdout, and stderr — unconditionally, so a caller can classify *why* a command failed rather than just observing that it did (used by force-push-gate detection, spec 264).
- A small set of git plumbing helpers tailored to the Jolli Memory needs (worktree resolution, head hash, status porcelain, write-tree / read-tree round-trip, push-state queries, branch listing, blob and tree reads from arbitrary refs, changed-file listing, ancestry tests, branch-creation-point and merged-history reflog walks, own-commits base resolution, and the committing user's name).
- The fact that this wrapper is now a concrete class with no extracted interface in front of it: the abstraction that existed purely so tests could substitute a fake git has been deleted, and the wrapper's methods re-declare their own default parameter values rather than inheriting them from an interface declaration. There is no supported substitution point for git on this surface.

Out of scope: any IDE-specific git integration (commit dialogs, log viewer); the committed-memory **read and write** protocols, neither of which uses this wrapper any more (see Shared Behavior); installation of git hooks (spec 128).

## Data Contracts

The wrapper holds two pieces of state:
- The project directory it operates inside, supplied on construction.
- A lazily computed PATH string, computed once on first command invocation and reused for every subsequent invocation.

Each `exec` call accepts:
- An ordered list of git arguments (without the leading `git` token).
- An optional timeout in seconds (default 15).
- An optional flag controlling whether to trim trailing whitespace from stdout (default true).

Each `execWithStdin` call accepts the same plus a string to send to the process's stdin, written in UTF-8.

Both return either trimmed (or trail-trimmed) stdout as a string on success, or null on any of: non-zero exit, timeout, or thrown exception. There is no exception form of the failure signal. This null-or-string contract is the **plain** call form; callers that need to distinguish *why* a command failed use the **result** call form instead (below).

**Result call form.** A parallel entry point accepting the same ordered argument list, timeout, and trim flag, but returning a structured result unconditionally: an exit code, the captured stdout, and the captured stderr. All three fields are populated on every path — clean success, non-zero exit, timeout, and thrown exception alike — there is no null case. On timeout the exit code is a sentinel non-zero value, stdout is empty, and stderr carries a synthesized "timed out" message; on a thrown exception the same sentinel exit code is used with stdout empty and stderr carrying the exception's message. The plain call form is implemented in terms of this one: it returns the result's stdout when the exit code is zero, and null otherwise, discarding stderr entirely. Callers that need to pattern-match a failure's stderr text (e.g. recognizing a specific kind of push rejection) must use the result form — the plain form's null collapses every distinct failure mode into the same signal.

A separate worktree-resolution helper takes no arguments and returns the **current** worktree root. It runs a git subprocess and then canonicalises two paths, so unlike the other helpers it can both fail and touch the filesystem; it falls back to the project directory on either failure (see "Worktree resolution" below).

## Behavior

### PATH resolution

The PATH is computed once per wrapper instance, on first read. The resolution branches on operating system:

- On Unix-like systems (macOS, Linux), the wrapper reads the `SHELL` environment variable, defaulting to `/bin/zsh` if unset, and runs that shell with login + command flags executing `echo $PATH`. The output is captured (with stderr merged into stdout via a redirect), bounded by a 5-second wait, and trimmed. If the resulting string is non-blank, it becomes the cached PATH; otherwise the IDE's inherited `PATH` is used as fallback. This step exists because the IDE's process environment does not include shell-managed paths such as version-manager binaries or system package-manager prefixes, so a spawn that relies on `node` or another user-installed tool fails with "command not found" without it.

- On Windows, the wrapper starts from the IDE's inherited `PATH`. It then runs `where git` (with stderr merged), bounded by a 5-second wait, takes the first line ending in `git.exe`, walks two parents up to the git installation root (e.g. `C:\Program Files\Git`), and looks for a `usr\bin` subdirectory. If that subdirectory exists, its absolute path is appended to the inherited PATH using the OS path separator. The intent is to expose the POSIX utilities (`sed`, `awk`, `cat`) that the queue worker's shell scripts depend on; Windows distributions of git ship those in `usr\bin\` but do not add it to the system PATH.

- Any failure during resolution falls back to the IDE's inherited `PATH`; if that is null, the cached PATH becomes empty.

### Subprocess invocation

Every command builds an argument list starting with the literal `git` token and the user-supplied arguments. The process is configured with the project directory as the working directory, with stderr left as a separate stream (not merged), and with the resolved PATH overriding the inherited environment's `PATH` entry.

After spawning the process, the wrapper schedules **two** asynchronous reads on worker threads, decoding as UTF-8: the entire stdout stream and, concurrently, the entire stderr stream. The main thread then waits on the process for the requested timeout in seconds. Reading both streams concurrently (rather than reading one only after the exit code is known) exists to prevent pipe-buffer deadlock on either stream: when a stream exceeds the OS pipe buffer (commonly around 64 KB), the child blocks on writing while the parent blocks on `waitFor`, producing a timeout that looks like a hung process. Keeping both pipes drained from the moment the process starts avoids that regardless of which stream fills first.

If the timeout elapses before the process exits, the process is force-destroyed, both stream futures are cancelled, a warning is logged with the argument list and working directory, and the call's outcome is reported as described below.

Once the process exits, both stream futures are awaited with a separate 5-second timeout each (a defensive guard against a reader thread hanging after the process exited cleanly). If the exit code is non-zero, a warning is logged with the exit code, the working directory, and the captured stderr truncated to its first 200 characters — the truncation is a log-message concern only; the full, untruncated stderr is still part of the call's returned outcome (see the two call forms below). Stdout is trimmed or trail-trimmed depending on the call's flag.

Any thrown exception during the dance — process spawn failure, IO error, future-get timeout — is caught at the boundary, logged at warn level with the argument list, exception message, and working directory, and converted into the call's failure outcome.

### Two return shapes: plain vs. result

The mechanics above (spawn, concurrent dual-stream read, timeout, exception handling) are shared by both call forms; only what is returned to the caller differs:

- The **plain** form collapses every outcome down to trimmed stdout on success, or null on non-zero exit, timeout, or exception. Stderr is never exposed to the caller through this form — only to the log line above.
- The **result** form returns a structured exit-code/stdout/stderr triple on every path, including the failure paths. On timeout or exception, the exit code is a sentinel non-zero value, stdout is empty, and stderr carries a synthesized message (a "timed out after Ns" string, or the exception's own message). On a non-zero exit from the process itself, stderr carries the process's actual (untruncated) stderr. The plain form is implemented on top of the result form: it is exactly "return the result's stdout when its exit code is zero, else null" — the two are not independent implementations.

The result form exists so a caller can pattern-match on *why* a command failed (its stderr text) rather than only knowing that it did. The force-push gate's non-fast-forward detection (spec 264) is the reason this form exists — it needs the process's own rejection text, which the plain form's null discards.

### Stdin variant

When stdin is supplied, the wrapper opens a UTF-8 buffered writer on the process's stdin stream, writes the entire input string, and closes the stream before scheduling the stdout reader. The rest of the protocol (timeout, deadlock-avoiding read, exit-code check) is identical, except that stderr is not read on non-zero exit (the variant logs at debug level and returns null).

### Worktree resolution

The wrapper exposes a method that returns the **current** worktree root. It no longer answers with the project directory unchanged: it asks git for the top-level directory of the working tree, and then decides which *spelling* of that directory to hand back.

1. Run the top-level query through the plain call form. A null or blank answer — no repository, git unreachable — returns the project directory.
2. Canonicalise both the git answer and the project directory and compare them. When they name the same directory, return the **project directory's own spelling**; otherwise return the git answer.
3. Any exception from that canonicalisation returns the project directory.

Step 2 is not redundant. The git answer resolves symlinks (a temporary directory under a symlinked prefix comes back under its real prefix), while every other surface in the plugin compares against the project directory as the IDE spelled it — so returning the resolved form for the same directory would make otherwise-equal paths compare unequal. Returning the git answer whenever it names a *different* directory is what fixes the case the change was made for: the project directory is **not** the git root when the project is opened on one module of a monorepo, and a discard or status request anchored at the wrong root produces paths git has no entry for.

It still parses no `.git` entry and walks no parents. It **can** fail, twice, and both failures degrade to the project directory rather than to null; the declared nullable return type remains never-null in practice, and callers' project-directory fallbacks remain dead.

The helper previously read the `.git` entry, recognized a `gitdir:` pointer, and walked three parents up (`<main-gitdir>/worktrees/<name>` → main repo root) to return the **main** worktree root. That walk-up was removed because it was wrong for this plugin's needs: the per-project state directory (plans, sessions, notes, references, the git-op queue, the briefing cache, the space binding, cursors, the debug log) is **per-worktree**, not repo-wide. Resolving to the main worktree meant a session running in a secondary worktree wrote its state into that worktree while the IDE read from the main one, silently hiding those entries from the CONTEXT and WORKING MEMORY surfaces. The one genuinely repo-wide file, the repo profile, is anchored to the main worktree inside the command-line surface itself, so callers here do not need to know about it.

### Helper methods

A handful of named methods wrap common git commands, all using `exec` for the underlying call:
- Branch existence (`rev-parse --verify refs/heads/<name>`) — **no production caller**.
- Listing files in a tree under a path prefix (`ls-tree -r --name-only`) — **no production caller**.
- Reading a single file from a ref (`show <ref>:<path>`) — **no production caller**.
- Current branch (`rev-parse --abbrev-ref HEAD`).
- HEAD hash, commit info, diff content/stats.
- Status in porcelain v1 format (passes the trim-suppression flag so leading status-code spaces are preserved).
- Index snapshot via `write-tree` (returns the tree SHA) and restoration via `read-tree <sha>` (returns boolean success).
- Listing staged file paths (`diff --cached --name-only`).
- Staging and unstaging multiple paths in a single command, with empty-list short-circuit. **Every path in both is wrapped as a literal, non-glob pathspec.** A bare path is matched as a glob, so a filename containing glob metacharacters would stage or unstage a *different* file, exit zero, and leave the intended one untouched — measured. These are the only two helpers in the wrapper that do this, and they are the only two that take a caller-supplied path list; the rule is deliberately not applied to a caller-authored pattern, where the glob is the point. The wrapper's version of this is a hand-maintained mirror of the command-line surface's, which is where the same rule reaches the discard path.
- "Has HEAD been pushed to upstream?" implemented as upstream lookup + `merge-base --is-ancestor`.
- Changed-file-name listing for a commit (names only, no content).
- HEAD commit info as a single structured read (hash plus message metadata).
- An ancestry test between two revisions.
- The branch's creation point, resolved by walking the reflog rather than by a merge-base against a named trunk — used where a branch's fork point cannot be assumed to be against `main`.
- Merged-history resolution, which walks the reflog to reconstruct the set of commits a branch absorbed through merges.
- Own-commits base resolution, which narrows a branch's commit range to the commits the current user authored.
- The committing user's configured name.

These helpers are thin: they encode the argument list and parse trivial output (line splitting, blank filtering); none of them validate semantic correctness of git's output. The three reflog-based helpers (creation point, merged history, own-commits base) are the exception in complexity — they interpret reflog text — but they still return plain values and never raise.

## State Transitions

The wrapper itself has effectively two states per instance: PATH-not-yet-resolved and PATH-resolved. The transition happens once on first command invocation and is sticky for the lifetime of the wrapper instance. There is no recomputation; if the user changes their shell profile mid-session, the IDE must restart for the new PATH to take effect.

## Notable Behavior

- The login-shell PATH probe runs `echo $PATH`, so any side effect of the user's profile (printing banners, sourcing other files) is visible only because the wrapper merges stderr into stdout for capture; the merged content is not parsed beyond reading the first non-blank result, which is itself trimmed. A profile that prints content after `echo $PATH` would corrupt the cached PATH; this is accepted as user-error.
- Login shells block on prompts in pathological setups (e.g., a profile that calls `read`); the 5-second wait limits the damage but does not eliminate it. On timeout, the IDE-inherited PATH is used.
- The 15-second default timeout was chosen to comfortably exceed normal git operations against large indexes while still failing fast on truly hung commands. Callers needing more time pass a custom timeout; this is exercised in practice by long-running operations such as a divergence-probe fetch and a force-push, both of which pass timeouts well above the default (spec 264).
- Force-destruction on timeout uses the platform's strongest kill signal; both orphaned stream buffers (stdout and stderr) are discarded.
- Non-zero exits truncate stderr to 200 characters **in the log line only**; the value handed back to a result-form caller is the full, untruncated stderr. Debugging via the log alone for longer output requires re-running the command with verbose logging or reading the result form's own stderr field.
- **Worktree resolution is no longer a field read.** It spawns a git subprocess and canonicalises two paths, so it is both the slowest helper relative to its apparent triviality and the only one whose failure path is a *substitution* (the project directory) rather than a null. Because it is subprocess-backed, callers must not treat it as UI-thread-cheap; the project service resolves it once at initialisation and every consumer reads that cached answer instead. The method name still says "worktree", and the field that stores its value on the project service is still named for the *main* repo root (spec 124), but both now hold the current worktree root; renaming the field is deferred as a large mechanical cleanup.
- **Worktree resolution deliberately prefers the caller's spelling over git's.** When the two canonicalise to the same directory, the project directory is returned even though git's answer is the more "correct" one — because the git answer resolves symlinks and every other surface compares against the IDE's spelling. The git answer wins only when it names a genuinely different directory.
- **Only the two path-list helpers wrap their pathspecs as literal.** Nothing enforces that a future path-taking helper does the same, and the plugin's own memory-bank sync counterpart on the command-line surface still passes bare paths — so the rule is honoured where it was applied, not universally.
- The wrapper does not detect the case where the system has no `git` binary at all; spawn fails, the exception is logged, and the call returns null. Callers see this as the same null result as a failed git operation.
- The Windows POSIX-utilities path append is unconditional: even if the user's PATH already includes that directory, the wrapper appends another copy. This is harmless because PATH lookup uses the first match.
- **The wrapper no longer serves any committed-memory content read.** It documents itself as an IDE-only surface scoped to display-time reads, on the grounds that domain-level input/output has moved to the command-line surface. That is now true for memory content: the summary reader holds a storage handle instead of this wrapper, and every one of its reads — the memory list, a single memory document parsed or raw, a plan body, a note body, an archived reference body, a stored transcript, a rendered committed conversation — goes through that handle. What still drives git through this wrapper is the working-tree and history side: status, index snapshot and restore, staging, commit, amend, squash, push, branch and ancestry queries, the reflog walks, diffs, and the committing user's name.
- **Two helpers survive with no production caller.** The tree-listing and single-blob reads scoped to a named branch — the pair the summary reader used to reach the version-controlled ref through — are still declared on the wrapper, and nothing in the plugin calls either one. They are unreachable code, not a supported path; the branch-existence helper is in the same position.
- **The extracted git interface has been deleted, so there is no test seam left.** The abstraction existed only so a fake git could be substituted in tests; with both it and the fake gone, code that depends on git on this surface depends on a real subprocess. The wrapper's methods re-declare their own parameter defaults as a consequence.

## Shared Behavior

- **Committed-memory reads and writes both bypass this wrapper now.** The IDE's storage handle is a command-line-backed provider that routes read / batch-read / list / exists / ensure / write-files through the bridge's `storage` action, and it **never dereferences the git-wrapper argument it still accepts** — that parameter survives only for source compatibility with the previous constructor shape. The summary reader is built over that handle and holds no wrapper at all, so neither a display read nor a write touches this subprocess. There is no mirror-first ordering left to describe: the second, filesystem-direct read source that the three single-item reads used to try ahead of the wrapper was **deleted** (historical record in spec 307, retired), and it was not replaced by a fallback — the bridge call is the whole read. This spec defines only the subprocess plumbing.
- Status snapshot helpers (`writeTree` / `readTree`) are reused by the changes panel's "snapshot, run, restore on cancel" flow; this spec defines the round-trip; the panel spec defines the use case.
- Worktree resolution is consumed by the project service (spec 124) and by the delegated install sequence (spec 128) but is implemented here. Because it now returns the current worktree root, every consumer that stores or forwards that value is scoped to the worktree the project is opened on, not to the repository's main worktree.
- **Working-tree file discard does not use this wrapper.** The wrapper carries no checkout, reset or clean helper: discarding a path goes to the command-line surface's shared rule set, which takes paths only and runs its own status read. What this wrapper contributes to that flow is indirect — the worktree root the paths are relative to, and the same literal-pathspec rule on staging and unstaging. This wrapper is also re-anchored at that resolved root rather than at the project directory, because a pathspec is resolved against the process working directory even though status output is not.
- The PATH resolution is what allows the plugin's **own** subprocess spawns — the git commands here, the bundled command-line entry, and the long-lived bridge server — to locate `node` and the POSIX utilities without explicit absolute paths on a GUI-launched IDE. It does **not** serve the installed git hooks: those are the command-line surface's own dispatcher scripts run under the resolved Node runtime (specs 128, 284), and they resolve their own environment. No installed hook invokes a Java runtime or a bundled archive.
- The result call form (exit code + stdout + stderr on every path) is what the force-push gate's non-fast-forward detection is built on — this spec defines only the wrapper's return shape, not the detection or gating logic; see spec 264.
