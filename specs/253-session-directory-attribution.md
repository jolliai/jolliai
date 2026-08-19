# 253. Session Directory Attribution

## Topic Statement

This spec defines the single shared predicate that decides whether an AI-agent session whose recorded working directory is some path on disk belongs to the git worktree rooted at a given project directory. It is the attribution rule every hookless, directory-scoped session discoverer applies: containment rather than exact-path equality, with an exclusion walk that keeps a session living inside a nested repository, a submodule, or a linked worktree from being swept up by the enclosing worktree's commit.

## Scope

**In scope**

- The two inputs (a candidate session working directory; a project/worktree root) and the boolean outcome.
- Null-safety: an absent, empty, or otherwise falsy recorded working directory is rejected before any path handling runs.
- The containment rule and the path-normalization it compares under, including the per-platform case-sensitivity rule.
- The separator-boundary requirement that stops a sibling directory whose name merely begins with the root's name from matching.
- The exact-equality fast path and the fact that it deliberately skips the exclusion walk.
- The nested-repository / submodule / linked-worktree exclusion walk performed for a strict-subdirectory candidate: which directories it inspects, which it deliberately does not, and the single existence check that covers all three cases.
- Best-effort behavior when an intermediate directory no longer exists on disk.
- The absence of symbolic-link resolution.
- The unreachable loop guard at the filesystem root.
- Which sources apply this rule, and — as a documented inconsistency — which equally hookless sources still use exact-path equality.
- As a boundary marker only: that a third, git-backed directory attribution rule exists elsewhere in the product, and how it differs from this one.

**Out of scope**

- How any individual source enumerates candidate sessions, where it stores them, or how it reads their transcripts (the per-source discovery specs own that).
- How a project directory is resolved, and how a repository's set of worktree roots is enumerated (one consumer tests the candidate against every worktree root; that fan-out belongs to that consumer's spec).
- Hook-backed sources, which never need this rule: their lifecycle hook resolves the repository root when the session ends and records the session against it directly.
- The staleness window, freshness computation, and any other per-source filter applied alongside this predicate.
- Any git subprocess or repository interrogation. This predicate is pure path arithmetic plus filesystem existence checks. That remains true of the predicate, but it is no longer true of the product's session attribution as a whole: the Claude ownership route described under Shared Behavior resolves a directory to a worktree root by asking git, memoised per directory. Nothing in that route is specified here.

## Data Contracts

### Inputs

| Input | Type | Notes |
| --- | --- | --- |
| candidate session directory | string, possibly absent/empty | The working directory a source recorded for one session. Several sources read this from a nullable column, so an absent value is an ordinary, expected input — not an error. |
| project root | string | The absolute path of the worktree the attribution question is being asked about. |

### Output

A boolean: whether this session is attributed to this project root. There is no third "unknown" outcome and no error channel — every input shape resolves to true or false.

### Path-comparison normalization

Both sides of the containment comparison are normalized identically before comparison:

1. Backslash separators are folded to forward slashes.
2. Trailing separators are stripped.
3. The result is lowercased **only on case-insensitive host platforms** (Windows and macOS). On case-sensitive platforms (Linux) case is preserved and comparison is case-sensitive.

Normalization is used **only** for comparison. The exclusion walk below operates on the raw candidate path, because it must address real on-disk entries.

## Behavior

The rule is evaluated in this fixed order; the first rule that resolves wins.

1. **Null-safety gate.** If the candidate session directory is absent, empty, or otherwise falsy, the session is **not** attributed. This check precedes every path operation, so a source that maps this predicate across every row of a session store — where one row may legitimately carry no working directory (a session started outside any project) — cannot fault on that row and lose the whole scan.

2. **Containment.** Normalize both paths per the rule above. The session is a candidate for attribution only when the normalized candidate either equals the normalized root, or begins with the normalized root followed by a single separator. The required separator is what makes the boundary sound: a sibling directory whose name merely starts with the root's name (for example a root `…/repo` and a candidate `…/repo2`) does not match. A candidate failing containment is **not** attributed, and no further work is done.

3. **Exact-equality fast path.** If the normalized candidate equals the normalized root, the session **is** attributed immediately. The exclusion walk is deliberately skipped: an exact match is unambiguous, and the root's own repository marker must never be read as evidence against it.

4. **Strict-subdirectory exclusion walk.** For a candidate strictly below the root, walk upward one parent directory at a time, starting at the candidate itself and stopping when the current directory normalizes equal to the root. At each visited directory — **including the candidate, excluding the root** — check whether that directory contains its own `.git` entry. If any does, the session is **not** attributed. If the walk reaches the root without finding one, the session **is** attributed.

   - One existence check covers all three exclusion cases, and they are deliberately not distinguished: a nested clone carries a `.git` **directory**, while a submodule and a linked worktree each carry a `.git` **file**. No entry-type inspection is performed.
   - The root's own `.git` is never inspected, which is why an ordinary repository's subdirectory sessions are always kept.
   - The check is a plain filesystem existence probe. No repository is opened and no version-control subprocess is invoked.

5. **Missing intermediate directory.** If a visited directory no longer exists on disk, the existence check simply reports "no marker here" and the walk continues. A candidate directory that has since been deleted is therefore **kept** — best-effort attribution to the project that matched by path, on the reasoning that the recorded directory is gone and no better evidence exists.

6. **Loop guard (unreachable).** The upward walk also stops if it reaches a directory whose parent is itself (the filesystem root) without ever meeting the project root. **This path is unreachable**: the containment rule in step 2 already guaranteed the root is an ancestor of the candidate, so the walk always meets the root first. The guard exists only to make an infinite loop structurally impossible on an exotic path shape; it does not encode observable behavior.

### No symbolic-link resolution

Neither the comparison nor the exclusion walk resolves symbolic links. Both operate on the literal path strings supplied by the caller and by the parent-directory walk. A session recorded through a symlinked path that resolves into the project, but does not textually contain the root, is not attributed; conversely a symlink inside the tree is walked as an ordinary directory.

## State Transitions

None. The predicate is a pure function of its two inputs plus the current state of the filesystem. It reads nothing else, writes nothing, and caches nothing — every call re-probes the directories it walks.

## Notable Behavior

- **Containment replaced exact equality, and that is the whole point.** Every session whose recorded working directory is a strict subdirectory of the project root — the ordinary case when an agent is launched from inside a package folder of a monorepo — is now attributed to the project. Under the previous exact-equality rule every such session was silently dropped, producing no memory for work that plainly belonged to the repository.
- **Containment alone would double-attribute, which is why the exclusion walk exists.** A session that genuinely lives inside a nested repository or submodule would otherwise be attributed to both the inner repository (by its own commit) and the enclosing one. The exclusion walk makes the inner context the sole owner.
- **A linked worktree created inside the tree is deliberately excluded from its parent's attribution.** Such a worktree's root carries a `.git` file, so a session recorded inside it is rejected when the question is asked about the enclosing worktree. The very same session is attributed when the question is asked about that worktree's own root — there the candidate is at or below the root and the intervening-marker walk never fires. This asymmetry is intentional: a linked worktree is its own working context on its own branch, and sweeping its sessions into a sibling or parent worktree's commit would be cross-context bleed.
- **The exact-equality fast path is not merely an optimization.** Skipping the walk is required for correctness: a project root is itself a repository root and carries a `.git` entry, so a walk that inspected the root would reject every session.
- **A deleted directory is kept, not dropped.** The best-effort rule favors retaining a session over discarding it, on the grounds that the path evidence already matched and the missing directory carries no counter-evidence.
- **No case-folding on Linux.** Two candidates differing only in case are two different directories there, and the rule honors that. On Windows and macOS the fold also absorbs incidental drift such as a differently-cased drive letter.
- **Absent working directory is an expected input, not an error.** The falsy gate exists specifically because it is reached in normal operation, and because a fault at that point would abort the enclosing scan rather than skip one session.
- **The predicate is filesystem-sensitive, so it is not a pure path function.** Two calls with identical inputs can disagree if a `.git` entry appears or disappears between them (a submodule being initialized, a worktree being added or removed). Callers treat each scan's verdict as a point-in-time answer.
- **This document's model has one session belonging to one project; the Claude ownership route is many-to-many.** This predicate answers a yes/no question about one candidate directory and one root, and every consumer of it asks that question to pick *the* project a session belongs to. The ownership route has no such shape: one session is attributed to several worktree roots at once — every root its recorded working directories and its authored files resolve to — and each attribution carries its own line-offset lower bound saying where that root's participation began. Nothing in the containment rule, its inputs, or its boolean output can express that, which is why the route is a separate rule rather than an extension of this one. (Surprising; the consequence most likely to mislead a reader of this document.)

## Shared Behavior

- **Adopting sources.** The hookless, directory-scoped discoverers that apply this identical rule, each restating it in full, are: the Codex source (spec 18), the OpenCode source (spec 19), the GitHub Copilot CLI source (spec 21), the Devin CLI source (spec 277), the Antigravity source (spec 278), and the Kimi Code CLI source (spec 339). The list is enumerated rather than counted because it grows: each newly-wired hookless source joins it. Two of them apply it more than once per candidate: the Devin source tests the session's primary working directory and then each entry of its auxiliary attached-directory list; the Antigravity source tests the recovered workspace path against every worktree root of the repository, accepting on the first root that attributes it.
- **Filtering moved out of the store query.** For the three sources backed by an embedded structured-data store (OpenCode, Copilot CLI, Devin CLI), the directory predicate used to be expressed in the store query itself. It cannot be, now that attribution requires a filesystem walk, so those queries fetch a broader row set and this predicate filters it afterwards. Each of those three also lost its query-level ordering clause as part of the same move; their result sets are unordered. The per-source specs record this.
- **Adoption is NOT universal — this is a real, documented inconsistency.** Several equally hookless, equally directory-scoped sources still match on exact-path equality and are therefore still exposed to the dropped-subdirectory-session problem this rule was written to fix: the Cline editor-extension source, the Cline CLI source, the Cursor CLI source, and the VS Code Copilot Chat source (whose second scan pass keys off a workspace-identity hash rather than a path at all). A reader must not assume the containment rule is applied product-wide. The remaining directory-scoped sources — Cursor's editor surface and Copilot Chat's hash-based pass — attribute by workspace-identity lookup rather than by path containment, so this rule does not apply to them at all. There are now **three** directory-based attribution rules in the product, not two: this predicate's containment-plus-exclusion-walk, the plain exact-path equality the sources above still use, and worktree-root equality after a git-backed resolution — the last of which is Claude's ownership route and is applied **per authorship event** (per transcript line, per authored file) rather than once per session.
- **Hook-backed sources never consult this rule — and for Claude that is now true of a directory-derived route as well.** The Gemini CLI source learns its repository from a lifecycle hook that resolves it at session end, so it has no directory-scan predicate to share. Claude still does that too, but it additionally has a directory-derived attribution route, and that route deliberately does **not** use this predicate. It resolves each transcript line's recorded working directory — **and the directory of every file the session authored** — to a worktree root by asking git, and then attributes by **exact key equality on that resolved root**, not by containment plus an exclusion walk. Because git answers with the *innermost* worktree containing a directory, the nested-repository, submodule and linked-worktree exclusions this document implements by hand come for free: a path inside an inner context resolves to the inner root and simply never equals the outer one. And a directory that is inside no worktree at all resolves to *nothing* rather than to a bogus root, which this document's containment rule has no way to express. The two routes coexist: this predicate remains the rule for the hookless directory-scoped sources listed above.
- **Path-comparison normalization** (separator folding, trailing-separator strip, platform-conditional case fold) is the same shared normalization used everywhere in the product for filesystem-path equality, not a comparison written for session attribution alone.
