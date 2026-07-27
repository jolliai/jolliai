# 45 — Git Shell Hook Installation

## Topic Statement

Each of the five git shell hooks (post-commit, post-merge, post-rewrite, prepare-commit-msg, pre-push) is installed as a marker-delimited section inside the standard git hooks directory's hook script, coexisting safely with any existing third-party content. Four of the five carry a single dispatch command line built the same way; the pre-push hook is a special case whose section is hand-built so a best-effort sync never blocks or masks the failure of a push.

## Scope

**In scope.** The marker convention, the body of each section, the unconditional source-neutrality of every written command line, the file-creation path when no hook script exists, the normalize-and-compare file-mutation path when one does exist (including collapsing duplicate owned sections), worktree handling for locating the real hooks directory, the executable-bit treatment in both installation and detection, idempotent re-runs, and the removal path including file deletion when only the shebang would remain.

**Out of scope.** What the dispatched product runtime actually does when each hook fires (covered by the per-hook runtime specs: post-commit-enqueue (spec 31), post-rewrite (spec 32), prepare-commit-msg (spec 33), and the post-merge and pre-push/sync-on-push runtime specs). The dispatch script that the inserted command line invokes (covered by spec 49). The orchestration layer that decides when to invoke this installer (covered by spec 44). The config flag that gates whether pre-push does any work at runtime — the installer writes the pre-push section unconditionally regardless of that flag.

## Data Contracts

### Marker convention

Each hook section is bracketed by a pair of comment lines that begin with the comment character understood by the hook's interpreter. The two markers form a begin/end pair that:

- Names the product, so the section can be uniquely located by string-search.
- Names the specific hook (post-commit, post-merge, post-rewrite, prepare-commit-msg, pre-push), so multiple product sections in different hook files do not clash.
- Uses an "open chevron" sequence on the begin line and a "close chevron" sequence on the end line so the pair is visually distinguishable in plain text.

The exact textual form is part of the on-disk format and must remain stable across releases (older installs leave their markers behind; newer installs detect them by substring match).

### Section body — the four generic hooks

Four of the five hooks (post-commit, post-merge, post-rewrite, prepare-commit-msg) each contain exactly one effective line plus its bracketing comments:

- Begin marker comment.
- A single command line that invokes the product's dispatch script with the hook type as the first argument and any positional arguments forwarded from the hook invocation. Forwarded arguments differ per hook:
  - post-commit: no extra arguments.
  - post-merge: no extra arguments.
  - post-rewrite: the rewrite kind (one of `amend` or `rebase`) is forwarded as `"$1"`.
  - prepare-commit-msg: the commit-message file path and source-type are forwarded as `"$1" "$2"`.
- End marker comment.

The dispatch invocation uses an indirection so the on-disk command line does not bake in a runtime path that would break across product upgrades. The line invokes a stable shell entry-point that lives in the user's per-user state directory (a config-driven location, not a source-code path); that entry-point reads the active runtime from the dist-paths registry and execs the per-hook script. See spec 49 for the resolver's behavior.

The command line is **unconditionally source-neutral**. It carries no marker, no argument, and no environment assignment identifying which install surface wrote it, and no installer accepts a source identity to stamp into it. In particular, **no surface ever writes a source-preference environment prefix ahead of the dispatch call.** An earlier design did prefix the call so that the installing surface's own bundle would win a version tie; that was removed, and the effect is that the on-disk bytes of all five hook sections are identical no matter which surface (standalone CLI, editor extension, IDE plugin, or the embedded assistant plugin) performed the install. Which runtime actually services a hook fire is decided entirely inside the resolver at dispatch time, from the registry — never from anything recorded in the repository.

### Section body — the pre-push special case

The pre-push hook does **not** use the shared single-line command builder. Its section body is three effective lines between the markers, and it is the only hook whose command is hand-constructed, for two reasons rooted in pre-push being the only installed hook whose non-zero exit **aborts** the git operation:

1. **Best-effort, non-blocking dispatch.** The dispatch call is guarded by an is-executable test on the shell entry-point and suffixed with `|| true`, so a missing entry-point, an absent runtime, or a failing sync can never block the user's push. Concretely the effective lines are:
   - Capture the incoming exit status into a private shell variable (`$?` at the top of the section) — this is the status left by whatever ran before the product's appended section.
   - `if` the shell entry-point path is executable, run it with hook type `pre-push` and all forwarded positional arguments (`"$@"`), and swallow its failure with `|| true`.
   - Restore the captured status as the section's final result (`exit` of the captured value inside a subshell), so the appended section leaves the script's exit status exactly as it found it.
2. **Never mask a preceding hook's failure.** Because the product section is *appended* after any pre-existing content, letting the best-effort command become the script's final status would turn a preceding hook's failure into a success and wrongly allow a push. The explicit capture-and-restore of the incoming status prevents that.

The pre-push section forwards `"$@"` (rather than a fixed count of positional arguments) so the remote name and URL that git passes reach the runtime, and the exec of the runtime inherits stdin so the ref lines git supplies on stdin are visible too.

### Outputs of an install operation

For each hook installer call:

- The absolute path of the hook script that was written or modified (returned to the caller for reporting).
- An optional warning string when an existing third-party hook script was found and the product's section was appended to it.

## Behavior

### Locating the hooks directory

The git hooks directory is resolved through the same logic that git uses internally:

- For a regular checkout, the hooks directory is `<git-dir>/hooks` where `<git-dir>` is the directory referenced by the entry named `.git` at the project root.
- For a linked worktree, the entry named `.git` at the worktree root is a regular file whose contents reference the worktree's per-worktree git directory (typically a path beneath the main checkout's git directory). The hooks live in the *main* git directory's `hooks/`, not in the per-worktree directory. The resolver follows the indirection and returns the main hooks directory.
- The hooks directory may not yet exist; the installer creates it as a parent-recursive `mkdir` before writing.

The resolver always targets `<git-dir>/hooks` (the common git dir for worktrees). It does **not** consult any configured hooks-directory relocation — there is no `core.hooksPath` or other git-config lookup. Consequently, a repo that has relocated its hooks directory will have the product's section written to the default `<git-dir>/hooks` location, not the relocated one.

### Install — file does not exist

1. Construct the section: begin-marker line, the command line, end-marker line, joined by newlines.
2. Construct the new file content: a generic POSIX shebang line, a blank line, the section, a trailing newline.
3. Recursively create the hooks directory.
4. Write the file atomically (a temporary sibling file renamed into place, so a crash mid-write cannot leave a torn hook script that git would try to run).
5. Mark the file executable for owner / group-read / world-read (the standard `0755` permission). On systems where the executable bit is not meaningful (where the chmod is a silent no-op), the operation tolerates failure.
6. No warning is recorded.

### Install — file exists, no product section

1. Construct the section as above.
2. Read the existing file content.
3. Append: existing content, blank line, blank line, section, trailing newline. (Two blank lines provide visual separation from any prior section.)
4. Write the file atomically. Re-apply executable permission.
5. Record a warning that names the affected hook ("an existing hook was found; the product's section was appended").

### Install — file exists, product section present

There is a single path here; the installer does not distinguish "already current" from "stale" up front, and it does not patch a section in place. It **normalizes**:

1. Construct the canonical section.
2. Strip **every** occurrence of an owned section from the existing content. The match anchored on the begin/end marker pair (with regex-special characters in the markers escaped) is applied **globally**, not to the first occurrence only, so a file that has accumulated duplicate owned sections — from an interrupted earlier write, or from two surfaces installing concurrently — is collapsed rather than left with the duplicates.
3. Re-append exactly one canonical section after the surviving content, separated by a blank line, with a single trailing newline.
4. Compare the resulting whole file against the existing file's bytes:
   - **Byte-identical** — no write occurs, but the executable permission is still re-asserted (see **Detection** for why that matters).
   - **Different** — the file is replaced with the new content, written atomically (a temporary sibling file renamed into place), and the executable permission is re-asserted.

This one path therefore covers the previously distinct "already current", "stale command", and "correct but duplicated" cases. No warning is recorded on it, and it can never leave a duplicate section behind.

Because the comparison is over the whole file rather than a substring search for the command line, a file that already contains the exact canonical section *plus* a second owned section is rewritten (to collapse it), whereas a file that already contains exactly one canonical section in canonical position is not written at all.

### Forwarding arguments

The post-rewrite hook receives a command-name argument from git (`amend` or `rebase`); the inserted command line passes `"$1"` through to the dispatch script so the runtime can branch on the rewrite kind without re-parsing.

The prepare-commit-msg hook receives the message-file path and source-type from git; the inserted command line passes `"$1" "$2"` through.

The post-commit and post-merge hooks receive no positional arguments.

The pre-push hook receives the remote name and URL as positional arguments and the ref lines on stdin; its section forwards `"$@"` and inherits stdin (see the pre-push special case above).

In all cases the dispatch script's first argument is the hook-type name (a fixed string per hook); subsequent arguments are these forwarded values.

### Detection

A query "is this hook installed?" reads the hook script and requires **two** conditions:

1. The begin-marker substring appears anywhere in the file.
2. On POSIX platforms, the file carries at least one executable permission bit. On Windows the executable bit is not meaningful and is not consulted, so marker presence alone is sufficient there.

A marker-bearing but non-executable hook script therefore reports **not installed** on POSIX — which is the correct answer, because git will not run it. This is also the reason every install path re-asserts the executable permission even on the path where it writes nothing: a hook whose executable bit was stripped by an unrelated tool self-heals on the next install or refresh rather than staying silently dead.

A hook authored manually that happens to include the marker as a comment would be falsely detected, but the marker text is sufficiently distinctive that this is acceptable.

### Removal

1. Resolve the hooks directory (gracefully tolerating a non-git project directory by returning an empty result).
2. Read the hook script (gracefully tolerating absence by returning an empty result).
3. If the begin marker is not in the content, return without modification.
4. Use a **global** regex match that captures any leading and trailing newlines surrounding the section, plus the begin marker, the section body, and the end marker. Every owned section is matched, not just the first, so a file carrying duplicates is fully cleaned in one pass. Each match is replaced with a single newline (so removal does not introduce blank-line drift).
5. Trim the cleaned content. If only the shebang remains, or the cleaned content is empty, delete the file (so an installer that created the file from nothing leaves no residue). Otherwise, write the cleaned content back atomically and re-assert the executable permission on the surviving file — the third-party content left behind must remain runnable.

## State Transitions

For each hook script, the on-disk states form a small lattice:

- **Absent** — no file at the hook path.
- **Other-only** — file exists with one or more non-product sections (and possibly a shebang).
- **Product-only** — file exists with exactly the product section (and a shebang).
- **Mixed** — file exists with the product section and one or more non-product sections.
- **Duplicated** — file exists with two or more owned sections (with or without non-product content).

Transitions:

- Install on **Absent** → **Product-only**, no warning.
- Install on **Other-only** → **Mixed**, warning recorded.
- Install on **Product-only** already in canonical form → no content change; the executable permission is re-asserted.
- Install on **Product-only** with a stale command → **Product-only** (rewritten), no warning.
- Install on **Mixed** already in canonical form → no content change; the executable permission is re-asserted.
- Install on **Mixed** with a stale command → **Mixed** (the owned section removed and re-appended at the end), no warning.
- Install on **Duplicated** → **Product-only** or **Mixed** (all owned sections stripped, exactly one re-appended), no warning — even when one of the duplicates was already the canonical section.
- Install on any state whose content is already canonical but whose executable bit is stripped → no content change; the file becomes executable again and detection flips from "not installed" to "installed".
- Remove on **Absent** → no transition.
- Remove on **Other-only** → no transition.
- Remove on **Product-only** → **Absent** (file deleted).
- Remove on **Mixed** → **Other-only**.
- Remove on **Duplicated** → **Absent** or **Other-only** (all owned sections are removed in one pass).

## Notable Behavior

- The "delete file when only shebang remains" rule is what allows `enable` followed by `disable` to leave a previously-empty hooks directory looking exactly as it did before. Without this rule, a residual one-line script would persist forever.
- The marker text is stable on purpose: it must match exactly across product versions because an old install's markers must still be findable by a new install. Changing the marker text would orphan all old sections.
- The installer never reorders or modifies content outside its marked section. Other tools (lefthook, husky, plain handwritten hooks) coexist without interference.
- The post-merge, post-rewrite, prepare-commit-msg, and pre-push installers share a generic helper that handles the create / append / normalize cases identically once the section text and the marker pair are determined; the post-commit installer was the historical original and retains a slightly different code path purely for backwards compatibility — observable behavior is identical to the generic helper. The pre-push installer differs only in the section text it feeds the helper (the three-line hand-built body); the normalize path works unchanged for it because the skip decision is a whole-file byte comparison after the rebuild, not a substring search for a particular command line.
- **Normalization is the idempotency mechanism, not a fast path.** The installer always rebuilds the intended file content and only then decides whether a write is needed. The consequence is that idempotency and self-healing are the same code path: a duplicated section, a section in a non-canonical position, and a stripped executable bit are all repaired by an ordinary re-install, with no separate repair mode.
- The post-commit hook intentionally writes a section whose effective line is `"$HOME/.jolli/jollimemory/run-hook" post-commit` (no `&` and no positional args) — the runtime side of post-commit is responsible for spawning a detached worker; see spec 31. The script itself blocks only briefly.
- The dispatch indirection allows in-place upgrades: when the product is updated to a new bundle path, only the dist-paths registry entry needs to change; every git hook script on disk continues to point at the same `run-hook` shell entry-point.
- **All four install surfaces write identical bodies.** The standalone CLI, the editor extension, the IDE plugin, and the embedded assistant plugin all produce byte-identical sections for all five hooks, because none of them writes any hook body of its own: each drives this same installer. The IDE plugin in particular no longer writes JVM-invoking command lines for any hook — it shells the shared install path instead. A machine with several surfaces installed therefore sees each install rewrite the same bytes, so "which surface installed last" is unobservable in the repository; the markers identify the product, not the surface, and the runtime choice is made at dispatch time from the registry.

## Shared Behavior

- The marker-delimited section convention is shared across all five hooks (post-commit, post-merge, post-rewrite, prepare-commit-msg, pre-push). The wording differs only in the hook-name embedded in the marker.
- The "delete the file if only the shebang remains" cleanup rule is shared across all five.
- The "appended to an existing hook" warning is shared across all five.
- The escape-special-regex-chars helper used to build the section-replacement regex is a shared utility.
- The hooks-directory resolver (worktree-aware; always resolves to `<git-dir>/hooks`, with no hooks-directory-relocation lookup) is shared with any other consumer that needs the git hooks directory.
- The dispatch indirection (`run-hook` entry-point) is shared with the JSON-based hook installers (Claude, Gemini); see specs 46 and 47.
