# 30. Git Operation Type Detection

## Topic Statement
Classify which kind of git operation produced the current invocation by inspecting environment variables, the most recent reflog entry, and on-disk markers, returning a single tagged enum value with optional companion metadata.

## Scope
**In scope:**
- The fixed enum of operation kinds the detector can return.
- Inputs the detector reads (a specific environment variable, the most recent reflog subject, on-disk markers under the resolved git directory, an on-disk pending-state file written by an earlier hook).
- The fixed precedence among detection signals when multiple match.
- Worktree-aware resolution of the underlying git directory (when the project's `.git` is a pointer file rather than a directory).
- A secondary, multi-layer detector for the "manual reset-then-commit collapses many commits into one" scenario, which runs before the commit is finalized.
- The default kind returned when no signal matches.

**Out of scope (boundaries):**
- What the caller does with the detected kind (covered by the post-commit, post-rewrite, and prepare-commit-msg specs).
- The schema and lifecycle of the pending-state file beyond "exists / does not exist" (covered by the prepare-commit-msg spec and the queue-state spec).
- The amend-vs-rebase old-to-new mapping itself (covered by the post-rewrite spec).
- The downstream queue entry produced after detection (covered by the post-commit spec and the queue-state spec).

## Data Contracts

### Operation-kind enum
The post-commit-time detector returns one of:
- `commit` — a normal new commit.
- `amend` — the most recent commit was rewritten in place.
- `squash` — multiple existing commits were collapsed into one (either via the merge-squash mode of the VCS or via a manual reset-then-commit), as evidenced by an on-disk pending-state file written before the commit.
- `rebase` — a rebase is in progress (the hook will be invoked once per replayed commit; downstream callers use this kind to skip work).
- `cherry-pick` — a commit was replayed onto the current branch.
- `revert` — a commit was inverted onto the current branch.

The reset-squash detector returns a boolean (success / no-action) and, on success, has the side-effect of writing the pending-state file consumed by the squash branch above.

### Detector output shape
- A required `type` field carrying one of the enum values above.
- An optional path to the on-disk pending-state file, populated only when `type === squash`. The path is the well-known location under the project's product-namespace state directory; the caller is responsible for opening, validating, and deleting it.

### Inputs
- An environment variable conventionally set by the VCS during many internal operations to describe the current logical action (values seen include `commit`, `commit (amend)`, `pull`, `merge`, `rebase ...`, `cherry-pick`, `revert`). May be empty (notably empty for plain amend at post-commit time).
- The most recent reflog entry's subject line, as produced by the VCS's reflog-listing operation in "subject only, count = 1" mode. Conventional prefixes include `commit: ...`, `commit (amend): ...`, `commit (initial): ...`, `reset: moving to ...`, `rebase (pick): ...`, `cherry-pick: ...`.
- The presence of well-known marker subdirectories inside the resolved git directory, indicating an in-progress rebase (one for the interactive flavor, another for the non-interactive / mailbox-apply flavor).
- The presence of a well-known squash-message file inside the resolved git directory (written by the VCS during a merge-squash), used only by the prepare-commit-msg path, not by the post-commit-time detector.
- The presence of a previously-written pending-state file at the well-known product-namespace path inside the working tree's product state directory.
- A reference to the pre-operation tip of the current branch, recorded by the VCS as a special ref before destructive operations such as reset, used as one input to the multi-layer reset-squash detector.

### Resolved git directory
- The directory that holds the VCS's internal metadata (refs, objects, in-progress operation markers, etc.). Resolved per call from the project root: if the project's `.git` entry is itself a directory, that directory is used directly; if it is a file containing a single line of the form `gitdir: <path>` (whitespace tolerated), the value (resolved against the project root if relative, otherwise used as-is) is used. Any read error during this resolution falls back to treating the project's `.git` entry as a directory at its literal path. This makes the detector behave correctly for both ordinary working trees and secondary working trees that point at a shared metadata directory.

## Behavior

### Post-commit-time detection (precedence-ordered)
The detector tries each rule in the listed order; the first match wins. Earlier rules are deliberately preferred where they would conflict.

1. **Rebase.** If the conventional environment variable's value contains the substring `rebase`, OR either of the well-known in-progress marker subdirectories exists inside the resolved git directory, return `rebase`. The filesystem fallback exists specifically for VCS clients that do not propagate the environment variable (notably some graphical clients).

2. **Squash (pre-staged).** If the well-known pending-state file exists at the product-namespace path under the working-tree state directory, return `squash` and attach the absolute path to that file in the result. This rule comes before amend because the manual reset-then-commit form of squash uses the same VCS plumbing as a normal commit (a "soft" reset followed by a commit), which produces an unremarkable reflog entry — making the file's presence the only certain signal.

3. **Amend.** Read the most recent reflog subject. If it begins with the literal prefix `commit (amend)`, return `amend`. The check is strictly a prefix check: substring matching against `amend` would falsely trigger on any normal commit whose message merely contains the word "amend".

4. **Cherry-pick / revert.** If the conventional environment variable's exact value is `cherry-pick`, return `cherry-pick`. If it is `revert`, return `revert`.

5. **Default.** Return `commit`.

### Reset-squash detection (pre-commit-time, multi-layer)
This is a separate routine invoked from the prepare-commit-msg hook before the commit is finalized. It detects the pattern "the user manually moved the branch tip backwards using a soft reset, then issued a single new commit, intending to collapse several commits into one." On success, it writes the pending-state file the post-commit-time detector's squash branch will later observe; on any layer failing, it returns "no action" and the commit proceeds as a normal commit.

The detection runs five layers in fixed order, and any single failure causes the whole detection to be abandoned silently:

0. **Pre-existence guard.** If the pending-state file already exists (for example, written by a graphical-client integration that pre-detected the squash), return "no action" without touching it.
1. **Reflog kind check.** Read the most recent reflog subject. It must begin with the literal prefix `reset:`. If not, return. (Filters out normal commits, merges, and rebases.)
2. **Pre-reset-tip exists.** Read the special pre-operation-tip ref the VCS writes during destructive operations. If it cannot be resolved, return.
3. **Backward-reset confirmation.** Confirm that the current branch tip is an ancestor of the pre-operation tip. If it is not, the user did something other than a backward reset (for example, a sideways branch switch), so return.
4. **Non-empty range.** Compute the list of commits between the current tip (exclusive) and the pre-operation tip (inclusive). If empty, return.

If all five layers pass, write the pending-state file containing: the list of commit hashes from layer 4 as the source-hash array; the current branch tip as the "expected parent of the about-to-be-created commit"; and a creation timestamp. Return "success."

(In one of the two implementations, layer 2 is omitted as a separate step and the pre-operation-tip is read inline at layer 3 via a positional reflog reference; the effective precondition that the pre-operation-tip must resolve is unchanged.)

### Worktree-aware reading
Every place the detector consults a path inside the VCS metadata (the in-progress rebase markers, the squash-message file) goes through the resolved-git-directory routine described under Data Contracts so that secondary working trees that point at a shared metadata directory are read correctly.

## State Transitions
The detector itself is stateless — it is a pure function over (environment, filesystem snapshot, reflog) returning an enum. The only state it mutates is the pending-state file, written exclusively by the reset-squash detector path; this transition is `absent → present` and is observed (and consumed) later by the post-commit-time detector's squash branch.

## Notable Behavior

- **Prefix match, not substring match, on reflog subjects.** Substring matching against `amend` once produced a real misclassification of squash operations as amends because some squash commit messages contained the word; the contract is `startsWith` only, on the canonical prefix tokens. (Surprising; intentional bug-avoidance.)
- **Squash-pending file beats reflog.** The pending-state file is checked before the amend rule, so the manual reset-then-commit form of squash is classified correctly even though its reflog entry looks like a normal commit. (Surprising; intentional.)
- **Empty environment variable on amend.** The conventional environment variable is empty in the amend case, so reflog subject inspection is the only available signal — but the check must still run after the squash-file check, per the previous point. (Notable.)
- **Rebase substring is permissive on purpose.** The rebase rule uses substring containment, not prefix, against the environment variable, because the VCS uses several rebase-related verbs (e.g. `rebase (pick)`, `rebase`) and they all warrant the same skip-and-defer outcome. (Notable.)
- **Filesystem fallback for graphical clients.** Some graphical VCS clients spawn the hook without setting the conventional environment variable; in that case the rebase rule still triggers via the in-progress marker subdirectories. (Notable.)
- **Worktree-aware metadata reads.** The detector resolves the metadata directory from the project's `.git` entry on every call, so secondary working trees pointing at a shared metadata directory observe the correct in-progress markers and squash-message file. (Notable.)
- **Reset-squash skips when pending file already exists.** Pre-existence is layer 0, which avoids overwriting state another integration may have already written. (Surprising/intentional.)
- **Reset-squash is non-fatal.** Any of the five layers failing — including I/O errors during reflog or ref reads — silently returns "no action" rather than raising; the commit then proceeds and is classified as a normal commit at post-commit time. (Notable.)
- **Two implementations diverge slightly on reset-squash inputs.** One implementation reads the pre-reset tip from the explicit special pre-operation-tip ref written by destructive operations; the other reads it from a positional reflog reference for the previous tip. Both arrive at the same intent (find the tip immediately before the soft reset), but the chosen plumbing differs. (Notable parity fact.)
- **Default-on-unrecognized.** Any input the detector does not understand — including an unset environment variable, an unparseable reflog line, or a missing reflog altogether — collapses to `commit`. There is no error-out path: the worst-case behavior is "treat it like a normal commit." (Notable; intentional.)
- **`commit (initial)` is treated as a plain commit.** The reflog prefix for the very first commit in a repository is recognized only insofar as it does not start with `commit (amend)`; it falls through to the default `commit` kind. (Notable.)
- **No mutation under the post-commit-time detector.** The post-commit-time path never writes the pending-state file; only the prepare-commit-msg-time reset-squash routine does. The post-commit-time path may direct the caller to read and delete it, but the detector itself does not. (Notable.)

## Shared Behavior
- The squash branch returns the path to a pending-state file whose schema (`sourceHashes`, `expectedParentHash`, `createdAt`) is defined under **Prepare-Commit-Msg Squash Detection** and consumed under **Post-Commit Hook Enqueue**.
- The rebase branch returns a kind that the **Post-Commit Hook Enqueue** spec uses purely as a "skip" signal; the actual rebase work is handled per-mapping by **Post-Rewrite Hook Handling**.
- The `cherry-pick` and `revert` kinds become queue entries of the same names; the queue and worker semantics are covered by the queue-worker spec (referenced from **Post-Commit Hook Enqueue**).
- The amend kind is similarly a "skip and defer" signal at post-commit-time; the actual amend work is handled by **Post-Rewrite Hook Handling**.
