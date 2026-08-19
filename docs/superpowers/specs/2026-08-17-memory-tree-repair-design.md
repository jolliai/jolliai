# Memory tree repair — design

**Date:** 2026-08-17
**Status:** Approved, pending implementation plan

## Problem

When a commit is rewritten (amend, rebase, squash), the memory tree must migrate
from the old hash to the new one. When that migration does not happen, the old
tree is left mounted under a commit the branch no longer has, and the new HEAD
either has no memory at all or a thin shell with no conversations and no skills.

Nothing reports this. The user sees "the memory is not showing" and has no way to
learn that the conversations, skills and topics are intact one hash away.

A real occurrence: an IntelliJ plugin build predating the SQLite cutover ran the
git hooks (its own `java -jar` hook bodies bypass the `run-hook` dispatcher, so
the dist-version competition never happened), wrote the frozen orphan branch in
legacy dual-write mode, and never wrote SQLite. `cutover --probe` catch-imported
the stranded memory as a **thin root** — its `protectNewerThanMs` guard correctly
refused to overwrite the newer child row, which also meant the child was never
re-parented. The user then clicked Regenerate on that thin root; `Regenerator`
takes its transcript IDs from the *stored* summary, found none, and produced a
summary from zero conversation at full LLM cost. Recovery required hand-written
scripts.

Two failures compound here, and only the second is in scope:

1. The writer that bypassed the fence — out of scope, fixed by upgrading the host.
2. **No user-reachable repair.** In scope.

## Scope

First version is CLI-only. A VS Code / IntelliJ button is deliberately deferred:
the repair must be reliable and replayable before it gets a one-click surface.

Covers rewrites of both shapes:

- **amend / rebase-pick** (1→1)
- **squash** (N→1), including the LLM consolidation the normal path performs

## Detection

Runs on `listSummaries()` plus git. It does not touch SQL, so it behaves
identically before and after cutover and against either storage backend.

A memory root is **stranded** when all three hold:

1. it is a root (no parent);
2. its `commitHash` is **not reachable from any ref** — the core invariant. A
   rewritten commit's object usually survives with nothing pointing at it, while
   a root that is still reachable is never a repair candidate;
3. a target hash can be derived, and that target **is** currently reachable.

Condition 2 is what keeps the blast radius small: commits on other branches,
un-pushed WIP and leftovers from deleted branches all stay out of the candidate
set without needing a special case.

### Deriving the target

From `git reflog --all --format='%gd %H %gs'`, grouped by ref so that each ref's
own newest-first order is preserved — `--all` interleaves refs by timestamp, so
adjacency in the raw stream crosses refs.

**A pair is taken only where git declared a rewrite, and the two declarations
that qualify carry different weight.** Within one ref, entry `i` may be
rewritten into entry `i-1`:

- **`commit (amend)` — trusted alone.** Amend acts on HEAD, and HEAD is the
  entry immediately older, so the operation itself identifies what it rewrote.
  No corroboration, deliberately: an amend routinely rewords, and demanding a
  matching subject here would reject the common case.
- **`rebase (finish)` — requires both ends to share a commit subject.** It
  records a branch moving from its old tip to its new one, which equals a
  rewrite only when the rebase actually replayed commits. When every local
  commit is already upstream — the ordinary `git pull --rebase` after a
  squash-merge — git drops them by patch-id and the branch fast-forwards, so
  the "new tip" is an unrelated upstream commit while the old tip becomes
  unreachable and looks exactly like a rewritten one. A replayed tip keeps its
  subject, and keeps it through conflict resolution where a patch-id
  comparison would not, so an identical subject separates the two cases.

Everything else is excluded — `checkout`, `reset`, `branch`, `pull`, `merge`,
`cherry-pick`, `rebase (start)`, `rebase (abort)`, and the mid-rebase
`rebase (squash|fixup|reword)` steps, whose predecessor is the half-built
commit rather than the original source. Each of those moves a ref without
claiming the old commit *became* the new one.

Those pairs form an old→new graph, and the walk follows it until it reaches a
commit some ref still holds. Rewrites chain — amending three times leaves the
first two hashes unreachable — but the walk only ever moves along a declared
rewrite, so a chain cannot wander into an unrelated commit. Two refs recording
a rewrite of one hash into different commits is a `conflict`, not a guess.

**Under-pairing is the intended failure direction.** A rebase pairs its branch
TIP and nothing below it; `git merge --squash` records nothing at all. Those
answer `none`, which is correct: an unpaired tree is reported and waits for
`--from/--to`, while a wrong pairing grafts one commit's memory onto another
and stops being reported at all.

reflog is garbage-collected (90 days by default), is per-clone and does not
travel between machines. `--from <old> --to <new>` is therefore a **required
fallback, not a convenience**: conditions 1 and 2 do not depend on reflog, so
detection still reports "N stranded trees" when pairing is impossible — it just
cannot pair them automatically.

Consequence worth stating: N:1 auto-pairing is now rare, because only a squash's
resulting tip is adjacent to anything. The `needsLlm` consolidation path is
therefore reached mostly by hand — and `--from/--to` is 1:1, so a multi-source
squash currently has no override that expresses it. That gap is open.

### Why the rule is the operation label, and not adjacency

The first implementation read `%gd %H` only and treated bare adjacency —
specifically "the first currently-reachable entry newer than the stranded hash"
— as the pairing. That is wrong whenever a ref merely moved: a `checkout` to
another branch or a `reset --hard` makes the next reachable entry an unrelated
commit, and the scan-until-reachable loop would travel arbitrarily far to find
one.

Measured on this repository, 2026-08-19: of six repairs the tool proposed and
executed, **two were correct and four were not**. The two correct ones had a
source and target carrying the identical commit message — real rewrites. The
four wrong ones attached, among others, a local-agent wiring fix to a
`chore(deps-dev): bump linkify-it` commit, and a session-attribution design doc
to `release: intellij 0.99.13`. Nineteen stranded trees, sixteen of them
`wip(task-N)` onboarding commits, were consolidated onto four unrelated commits.

The failure was silent in the worst way. Nothing errored, nothing was lost, and
the tree stopped being reported as stranded — so the repo carried a commit whose
memory described work that commit never contained, and the one command that
could have surfaced it said everything was fine.

Reading `%gs` was the first half of the fix and, on its own, was not enough:
`rebase (finish)` is a ref move that only sometimes is a rewrite, and a second
live run on 2026-08-19 grafted seven more trees onto unrelated commits through
exactly that edge — a `Fix transcript token stats` tip onto
`chore(actions)(deps): bump actions/setup-java`, two release-notes commits onto
one unrelated commit, and four more. Hence the split above: the operation label
decides *whether* an edge exists, and for the weaker of the two labels a
matching commit subject decides whether it may be followed.

Applying that check to `commit (amend)` as well was tried and is wrong: it drops
a genuine reworded amend (`Decouple MCP registration from the node:sqlite
readability gate` → `Gate MCP registration on host presence…`, one real
pairing in that same run). Uniform corroboration produces false negatives and
false positives at once, which is why the two labels are treated differently.

Replayed against both incidents — thirty-three stranded trees in total — the
rule as specified makes seven correct pairings and refuses twenty-six, with no
wrong pairing and none of the known-correct ones lost.

The original triage of this as a deferred Minor ("scan-direction ambiguity …
acceptable while the repair is additive") was wrong on its own terms: additive
is not harmless. Grafting one commit's memory onto an unrelated commit pollutes
the target and reads as a successful repair.

## Repair: two actions, not one

Which action applies is decided by the target's state. This distinction is
load-bearing and was discovered by reading `migrateOneToOne`: its `topics` come
from `resolveEffectiveTopics(oldSummary)` — **from the old summary** — so calling
it against a target that already has a memory would overwrite that memory's
topics and recap.

| Target commit | Action | Implementation |
|---|---|---|
| has no memory | **migrate** | `migrateOneToOne` / `mergeManyToOne` as-is, no new logic |
| already has a memory | **remount** | keep the target's own topics / recap / llm; attach the old tree as `children[0]` and Copy-Hoist |

**Remount is the piece that does not exist yet**, and it is the case a user most
often reaches, because regenerating is the obvious thing to try first. It lands
as `remountStrandedTree` in
[`SummaryStore`](../../../cli/src/core/SummaryStore.ts).

### Copy-Hoist must be shared, not restated

`migrateOneToOne` copies `skills`, `jolliSkillsDocId`, `jolliSkillsDocUrl`,
`transcripts` (and the plans / notes / references group) onto the new root, and
deliberately does not strip them off the child. `remountStrandedTree` needs the
identical set.

The field set is extracted into one helper both call. A second hand-maintained
copy is exactly how a field gets missed: during the manual recovery this design
came out of, the first attempt did the remount without the hoist and silently
produced a root with `skills: 0`. It was caught only by comparing against the
repo's other trees — 16 of the 18 amended trees carrying skills had them on the
root, and the repair had landed in the 2-tree minority.

## Command surface

```
jolli repair-memory                            # repair
jolli repair-memory --status                   # report only, changes nothing
jolli repair-memory --from <old> --to <new>    # manual pairing when reflog cannot
jolli repair-memory --no-llm                   # squash consolidation falls back to mechanical merge
jolli repair-memory --cwd <dir>
```

Repair-by-default with `--status` for inspection mirrors `jolli cutover` /
`cutover --status`, which is the right precedent: this is a one-shot operation
with side effects, not a diagnostic. (`doctor` / `doctor --fix` is the wrong
analogy — see below.)

`--status` prints, per stranded tree: the action, the target hash, how many
conversations and skills the repair brings back, and **whether that tree needs an
LLM call**.

Running the repair without `--status` performs LLM consolidation where a squash
needs it, without prompting. This is a deliberate choice: the command's name
states its intent, and an interactive gate would make it unusable from scripts.
`--no-llm` is the opt-out.

### `doctor` integration

`doctor` gains one `Memory tree` check — `warn` when stranded trees exist,
message pointing at `jolli repair-memory`. **`doctor --fix` does not repair it.**

Every existing `doctor --fix` repair (releasing a stale lock, clearing a stuck
queue, reinstalling hooks, `repairParkedDashboardEvents`) is instant, free and
idempotent. Memory repair can cost money, take tens of seconds, fail, and is not
idempotent in the squash case. Folding it into `--fix` would make "let me just
run doctor" a risky act, which degrades the diagnostic tool itself.

## Safety

1. **Automatic backup before writing.** Affected roots' summary JSON is written
   to `.jolli/jollimemory/repair-backups/<timestamp>/`. `storeSummary` overwrites
   and `SotWrite`'s upsert replaces `summary_json`, so there is no second copy
   otherwise.
5. **The command establishes the configured backend before it reads or writes.**
   `setActiveStorage(await createStorage(cwd, cwd))`, ahead of `buildRepairPlan`.
   Every store call below it is made without threading `storage`, so without
   this they fall through `resolveStorage` to the system of record and bypass
   `DualWriteStorage` — on an uncutover repo each repaired tree lands on the
   orphan branch while the Memory Bank copy silently misses it. This shipped
   missing; the only symptom was one `resolveStorage fell back` WARN per write.
2. **Remount never calls an LLM.** Only "squash + target has no memory" can.
3. **Idempotent for the migrate/remount actions.** After repair the old root is
   no longer a root, so detection stops matching it and a re-run is a no-op.
   Asserted by test.
4. **The command must not take an outer lock.** `migrateOneToOne` /
   `mergeManyToOne` already wrap themselves in `withRequiredOrphanWriteLock`, and
   `remountStrandedTree` uses the same wrapper. An outer lock around the loop
   would self-block: the lock refuses even its own PID, so the write would poll
   out its budget and report *contention* — a log line indistinguishable from
   real contention while nothing lands. This is the failure AGENTS.md records for
   `jolli compile`'s search-index rebuild.

## Failure handling

- **Target unreachable or absent** → refuse. Never guess a target.
- **reflog yields multiple candidates** → report the conflict and require
  `--from/--to`. Never pick one.
- **Squash LLM call fails** → error, and point at `--no-llm`. **No silent
  fallback** to mechanical merge: the same reasoning AGENTS.md applies to a
  local-agent run that produces no answer — a silent downgrade looks like success
  while the stored content is worse, and nothing reports it.
- **One tree's failure does not stop the others.** Results are summarised; a
  non-zero exit code if any failed.

## Testing

Standard cases: action dispatch, reachability predicate, idempotency, reflog
multi-candidate, `--no-llm`, `--from/--to` override, non-zero exit on partial
failure.

One case is specifically required:

**Assert that `migrateOneToOne`'s and `remountStrandedTree`'s Copy-Hoist field
sets are equal.** Two independently maintained field lists is the mechanism by
which the next field gets dropped, and the failure is silent — a memory that is
simply missing its skills, with nothing to indicate it. This follows the repo's
existing lockstep-test pattern.

CLI coverage thresholds apply unchanged (97 / 96 / 97 / 97).

## Out of scope

- The fence-bypassing writer itself (fixed by upgrading the host).
- `Regenerator`'s behaviour when the stored summary carries no transcripts. It
  currently feeds the LLM an empty conversation and overwrites the stored summary
  with the result, reporting nothing. That is a real defect surfaced by this
  investigation, but it is a separate change.
- IDE buttons.
