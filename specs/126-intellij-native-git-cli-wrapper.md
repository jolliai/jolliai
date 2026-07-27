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

Out of scope: any IDE-specific git integration (commit dialogs, log viewer); orphan-branch **write** protocol, which no longer uses this wrapper at all (see Shared Behavior); installation of git hooks (spec 128).

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

A separate worktree-resolution helper returns either the project directory itself (when not in a worktree, or when the `.git` entry is not a worktree pointer) or the resolved main worktree root by walking the chain `<gitdir>/worktrees/<name>` two levels up.

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

The wrapper exposes a method that returns the main repo root for the project directory:
- If the `.git` entry is a directory, the project directory is returned unchanged.
- If the `.git` entry is a regular file, its first line is read; if it begins with `gitdir:`, the remainder is the worktree's gitdir path. The worktree gitdir is structured as `<main-gitdir>/worktrees/<worktree-name>`, so the wrapper walks three parent directories up (one for the worktree name, one for `worktrees`, one for `.git`) to land on the main repo root, which is returned as an absolute path.
- Any failure or unexpected `.git` content returns the project directory unchanged.

### Helper methods

A handful of named methods wrap common git commands, all using `exec` for the underlying call:
- Branch existence (`rev-parse --verify refs/heads/<name>`).
- Listing files in a tree under a path prefix (`ls-tree -r --name-only`).
- Reading a single file from a ref (`show <ref>:<path>`).
- Current branch (`rev-parse --abbrev-ref HEAD`).
- HEAD hash, commit info, diff content/stats.
- Status in porcelain v1 format (passes the trim-suppression flag so leading status-code spaces are preserved).
- Index snapshot via `write-tree` (returns the tree SHA) and restoration via `read-tree <sha>` (returns boolean success).
- Listing staged file paths (`diff --cached --name-only`).
- Staging and unstaging multiple paths in a single command, with empty-list short-circuit.
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
- Worktree resolution is read-only: it never modifies `.git` or its target files, even if the file's content is unparseable.
- The wrapper does not detect the case where the system has no `git` binary at all; spawn fails, the exception is logged, and the call returns null. Callers see this as the same null result as a failed git operation.
- The Windows POSIX-utilities path append is unconditional: even if the user's PATH already includes that directory, the wrapper appends another copy. This is harmless because PATH lookup uses the first match.
- **The wrapper's own self-description no longer matches its call sites.** It documents itself as an IDE-only surface scoped to display-time reads, on the grounds that domain-level orphan-branch input/output has moved to the command-line surface. Its remaining callers contradict that: the summary reader still performs every orphan-branch **content** read — the summary list, an individual summary, plan bodies, note bodies, and committed-conversation rendering — as direct tree-listing and blob-read calls through this wrapper, and the plugin's commit, amend, squash, and push mutations still drive git through it directly. The actual split (below) is the behavior; the self-description is aspirational.
- **The extracted git interface has been deleted, so there is no test seam left.** The abstraction existed only so a fake git could be substituted in tests; with both it and the fake gone, code that depends on git on this surface depends on a real subprocess. The wrapper's methods re-declare their own parameter defaults as a consequence.

## Shared Behavior

- **Orphan-branch reads and writes are split.** Orphan-branch **display reads** still call this wrapper for every plumbing operation: the summary reader lists tree entries and reads blobs from the orphan branch directly through it for the summary list, individual summaries, plan bodies, note bodies, and committed-conversation rendering. The **storage-provider surface does not**: the IDE's storage handle is a command-line-backed provider that routes read / list / exists / ensure / write-files through the bridge's `storage` action, and it **never dereferences the git-wrapper argument it still accepts** — that parameter survives only for source compatibility with the previous constructor shape. So an orphan-branch write on this surface never touches this wrapper, while an orphan-branch read for display always does. This spec defines only the subprocess plumbing, not the orphan-branch semantics.
- Status snapshot helpers (`writeTree` / `readTree`) are reused by the changes panel's "snapshot, run, restore on cancel" flow; this spec defines the round-trip; the panel spec defines the use case.
- Worktree resolution is consumed by the project service (spec 124) and by the delegated install sequence (spec 128) but is implemented here.
- The PATH resolution is what allows the plugin's **own** subprocess spawns — the git commands here, the bundled command-line entry, and the long-lived bridge server — to locate `node` and the POSIX utilities without explicit absolute paths on a GUI-launched IDE. It does **not** serve the installed git hooks: those are the command-line surface's own dispatcher scripts run under the resolved Node runtime (specs 128, 284), and they resolve their own environment. No installed hook invokes a Java runtime or a bundled archive.
- The result call form (exit code + stdout + stderr on every path) is what the force-push gate's non-fast-forward detection is built on — this spec defines only the wrapper's return shape, not the detection or gating logic; see spec 264.
