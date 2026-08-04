# 322. Skill Usage Commit Archival

## Topic Statement

`associateSkillsWithCommit` freezes onto each commit the portion of every captured skill's usage that **no earlier commit has already claimed**. A skill is unlike a plan or a note: those are archived once and finished, while a skill can be entered again during the next piece of work and its registry row keeps ACCUMULATING (spec 319). So "what belongs on this commit" cannot be read off the row and cannot be gated on the archive guard — it is the row minus `archivedTotals`, the snapshot of its counters at the last archive. Keeping every commit's record an **increment** is what lets the PR-wide aggregate stay a plain sum across commits. Archival is a byte-for-byte **copy** of the working markdown onto the orphan branch at `skills/<source>/<stem>-<shortHash>.md`, and the working row is **guarded, not deleted** — `commitHash`, `contentHashAtCommit` and a fresh `archivedTotals` are set on the row that is already there, so the file survives as the dedup ledger and a later re-entry reads as fresh work by arithmetic.

## Scope

**In scope:**
- `uncommittedDelta` / `archivedTotalsOf` / `isLegacyArchived` — the delta rule, the per-session split's precedence over the aggregate, and the legacy-row exception.
- `associateSkillsWithCommit`: exclusion handling, the working-file copy, the ref it emits, the guard it writes, its lock and its save-time merge.
- `skillOrphanPath` and why the `<source>` segment is required.
- `SkillCommitRef` — what is a per-commit increment and what is a row-level snapshot.
- QueueWorker wiring: where archival runs on the plain-commit, amend and squash paths — including the squash path's **two** archival passes over one commit and the union of their refs — and how the exclusion set is assembled.
- `associateSkillWithCommit` — migrating a guard forward after squash / rebase, and the `collapsedHashes` argument.

**Out of scope:**
- The working markdown file, the fold that produces the counters, and `upsertSkillEntry`'s seeding of a legacy baseline (spec 319).
- Recognizing invocations (specs 320, 325, 326) and computing token figures (spec 321).
- `mergeSkillRef` / `mergeSkillRefs` / `collectChildSkills` and the summary-side hoist, the PR-wide aggregate, and the Memory Bank `skills--<hash8>.md` visible file (spec 323).
- The VS Code Context list and its per-skill exclusion checkbox, which writes the `skills` exclusion set consumed here (spec 324).
- `CommitSelectionStore` / `readExclusions` and the exclusion file format (spec 188).
- The AI relevance ranker (spec 258) — see Notable Behavior for why it never contributes a skill key.
- Orphan-branch plumbing, `writeFiles`, the write lock, and the Memory Bank hidden layer that `storeSkills` inherits for free (specs 01, 02, 03).
- Detach-time correction of committed figures (spec 306).

## Data Contracts

### `SkillCommitRef` — the per-commit snapshot

Stored on `CommitSummary.skills`. Every field other than `archivedKey` is a value-snapshot at archive time, and the counting fields hold **this commit's increment**, not the row's running total.

```ts
{
  archivedKey: string;          // `<mapKey>-<shortHash>`
  source, skill, plugin?, entryPaths,
  invocationCount: number;      // the DELTA's count
  firstUsedAt, lastUsedAt;      // the ROW's bounds
  usage?: SkillUsage;           // the DELTA's usage
  usageBySession?: Record<string, SkillUsage>;
  detection?: "heuristic";
}
```

`archivedKey` is the `plans.json.skills` mapKey plus the archiving commit's 8-char short hash. It is **not itself a key into that map** — the registry row keeps the bare `<source>:<skill>` mapKey, so consumers `splitArchivedKey` it to recover the row. It does name the orphan-branch file, via `skillOrphanPath`.

`usageBySession` is carried onto the commit rather than left behind in the working registry because detach happens AFTER the commit: correcting a committed skill's figures needs the split to still be reachable from the summary (spec 306). Without it the only options would be a stale number or an invented subtrahend.

`firstUsedAt` / `lastUsedAt` come from the **row**, not the delta, because `SkillArchivedTotals` carries no time fields. The VS Code preview reads them from the row for exactly the same reason, which is what keeps the two in parity (spec 324).

### `SkillArchivedTotals` — the baseline

```ts
{ invocationCount: number; usage?: SkillUsage; usageBySession?: Record<string, SkillUsage> }
```

Written onto the row at archive time as `archivedTotalsOf(entry)` — the row's **current** total, not the delta just written: everything up to here is now accounted for on some commit. Absent on rows written before the field existed; treated as an all-zero baseline, which makes the first archive after an upgrade carry the full history exactly once.

### `AssociateSkillsResult`

```ts
{ refs: ReadonlyArray<SkillCommitRef>; filesToStore: ReadonlyArray<{ path, content }> }
```

The caller passes `filesToStore` to `SummaryStore.storeSkills` and `refs` onto the `CommitSummary`.

### The orphan-branch path

`skillOrphanPath(source, skill, shortHash)` → `skills/<source>/<sanitizeSkillIdForPath(skill)>-<shortHash>.md`.

The `<source>` segment is **required**, mirroring the reference layout. The design sketched a flat `skills/<slug>-<hash>.md`, but the registry key is `<source>:<skill>` — two hosts can hold the same skill id, and a flat layout would archive one over the other. `<stem>` comes from the same sanitizer the working-area file uses (spec 319), so an id from an untrusted transcript cannot shape the path.

## Behavior

### The delta rule

`uncommittedDelta(entry)` returns the part of a row no commit has claimed, or `undefined` when the row is fully accounted for:

1. **Legacy check.** A row with **no** `archivedTotals` that `isLegacyArchived` — i.e. carries `commitHash !== null` **or** `contentHashAtCommit !== undefined` — returns `undefined`. It was archived in full by a version that predates the field, so its baseline is its current total even though nothing wrote one down; reading it as an all-zero baseline would re-archive the skill's entire history onto the first commit after the upgrade. **EITHER guard field standing alone counts as archived**, matching the predicate this replaced: a half-written row (a content hash with no commit) is the one shape where the two disagree, and treating it as fresh would republish a whole history on the strength of a partial write. `upsertSkillEntry` seeds a real baseline the moment such a row is used again (spec 319), so this only has to hold until then.
2. **Counting decides.** `invocationCount = entry.invocationCount - (base?.invocationCount ?? 0)`; `<= 0` means nothing uncommitted, return `undefined`. `invocationCount` only ever grows, so a positive difference is exactly "entered again since the last commit".
3. **`usageBySession` leads when present.** Each session's fresh share is `current - prior` (`subtractUsage`), clamped at zero and **dropped entirely when nothing was added** — attribution recomputes a session from line 0 on every pass (spec 321), so a figure can be revised DOWN and an unclamped subtraction would report negative spend. The delta's `usage` is then **re-derived from the surviving split** (`totalOf`) rather than subtracted independently, because `DetachedUsageSubtraction` recomputes `usage` from whatever keys survive a detach — a total that disagreed with its own split would be silently overwritten the first time anything was detached. An **empty** split with a real invocation count degrades to `{ invocationCount }` alone: the honest "it ran, we cannot say what it cost", the same shape a fully-detached row reaches.
4. **Otherwise fall back to the aggregate.** No `usage` at all → `{ invocationCount }`. Otherwise subtract `base.usage` with the same clamp; a `undefined` result degrades to count-only.

### The archival pass

Everything runs inside `withPlansLock(cwd)`:

1. Load the registry. An absent or empty `skills` map returns immediately with empty results.
2. For each `[mapKey, entry]`:
   - `uncommittedDelta(entry)`; skip when `undefined`.
   - **Skip when `mapKey` is in `excludedKeys`.**
   - Read the working file at `entry.sourcePath`. **A missing file logs a warning and skips** — emitting a ref anyway would point the commit summary at a file that was never written.
   - Push a `SkillCommitRef` combining the delta's counts and usage with the row's `plugin`, `entryPaths`, `firstUsedAt`, `lastUsedAt` and `detection`. `detection` is carried forward so an archived heuristic entry still reads as inferred; dropping it would silently promote a guess to an observation the moment the commit landed.
   - Push `{ path: skillOrphanPath(...), content }` — the working file's **bytes**, unmodified.
   - Guard the row: `commitHash`, `contentHashAtCommit` = sha256 of **the bytes actually archived**, and `archivedTotals = archivedTotalsOf(entry)`.
3. If nothing changed, return without writing.
4. **Reload the registry inside the lock** before saving, and merge back **only the rows this run actually changed** (`pickArchived` compares each updated entry against its pre-loop identity). A concurrent Stop hook or discovery tick may have added an unrelated row between the read and this write.

**Rows are guarded BEFORE the orphan write**, which is the opposite of the reference flow's write-ahead ordering. The row itself survives a failed orphan write, because a guarded skill row is never deleted and the guard clears no data — so the inversion cannot lose the row. What it does not protect is the increment: `archivedTotals` was advanced in the same write, so a failed `storeSkills` leaves that increment claimed by a commit whose file was never stored, and `uncommittedDelta` will not surface it again.

### Where it runs in the pipeline

`consumeWorkspaceContext` archives plans, notes, references and skills for one commit. Skills are last, and are **metadata about HOW the work happened**: archived and displayed, never fed to the summarizer — the same track-only contract references use.

The exclusion set handed to `associateSkillsWithCommit` is the union of two sources:

```ts
new Set([...(exclusions.skills ?? []), ...aiExcludedKeys.skill])
```

- `exclusions.skills` — the user's persisted checkbox state from `commit-selection.json` (spec 188). Optional on the persisted shape: a selection file written before skills were selectable has no such field, and absent means none excluded.
- `aiExcludedKeys.skill` — built from `excludedContext` entries whose `kind` is `"skill"`. **Always empty in practice** — see Notable Behavior.

Every path that consumes working-area Context reaches it: the normal commit pipeline (`executePipeline`), the amend short-circuit, the full amend path, the amend fresh-leaf path, and — through the `consumeSquashContext` wrapper — the squash consolidation pipeline. When `skillFiles` is non-empty it calls `storeSkills(files, "Archive N skill(s) for <commit|amend|squash> <shortHash>", cwd, branch)`. Refs are attached to the summary only when non-empty (`...(skillRefs.length > 0 ? { skills: skillRefs } : {})`).

### The squash path archives twice for one commit

`runSquashPipeline` reaches `associateSkillsWithCommit` twice for the same commit hash, and the refs from both passes are unioned before they are placed on the consolidated root:

1. **An explicit pass**, called directly by the pipeline. A squash lands new work, so uncommitted skill rows belong on the squash commit exactly as they would on a plain commit. Unlike plans and notes there is no separate detect step; `associateSkillsWithCommit` reads the registry itself.
2. **An implicit pass**, inside `consumeWorkspaceContext`, which this path also calls — it is what archives the squash's own plans, notes and references, and it archives skills as part of the same step.

Both results go through the shared skill accumulation — `mergeSkillRefs([...explicitRefs, ...consumed.skillRefs])` — and are handed to `mergeManyToOne` as `extraSkills`, which folds them together with the children's hoisted refs onto the root it writes. Archival must precede that merge because there is no second summary write to patch refs in afterwards.

**The union is a correctness requirement, not tidiness.** The second pass is *normally* a no-op: once the first has advanced a row's `archivedTotals` to its total, `uncommittedDelta` returns `undefined` for it. But "normally" is not "always". The two passes straddle real I/O — the first pass's own `storeSkills` orphan write when it has anything to store, then the whole plan / note / reference consumption including `storeReferences` — and the agent Stop hook writes `plans.json` asynchronously. Any row whose delta appears **only** at the second pass is archived by it and by nothing else, and there are two such shapes: a skill entered for the very first time inside the window, and a row that was fully accounted for at the first pass (so it was skipped there) and was entered again inside the window. Either way the first pass emitted no ref carrying that row's `archivedKey`, so dropping the second pass's ref would strand its orphan-branch bytes with no summary pointing at them **and** leave the row guarded — `uncommittedDelta` returns `undefined` from then on, so nothing could ever re-archive it. Permanent and silent, which is the failure class this whole consumption exists to prevent.

A row that **both** passes archive is not that failure and needs no handling: both passes share the commit hash, so `archivedKey` and the orphan-branch path are identical, the second write overwrites the first, and the first pass's ref still addresses it. What that case does cost is an under-count — see Notable Behavior.

**The exclusion selection is read ONCE for the whole path** (`readExclusions(cwd)`) and the resulting set is shared by both passes. Two reads would straddle the intervening orphan write and could disagree, leaving the two halves of one commit's archival honouring different sets. Squash runs no relevance LLM — it consolidates existing topic structures rather than re-deriving from diff plus transcript — so `excludedContext` is empty on this path and the set is the user's persisted checkbox state alone.

**The explicit pass is deliberately ordered BEFORE the consumption, not after.** Skill archival is itself an orphan-branch write that can throw, and everything between the Context consumption and the summary write is a window in which a throw strands a snapshot with no pointer: the consumption writes each item's snapshot to the orphan branch and marks its local registry row as claimed (deleting it outright, for references) before any summary exists, so a throw after it leaves bytes on the branch that no summary addresses and no panel row offers again. Running the explicit pass first shortens that stretch instead of lengthening it.

That is not a claim that skill archival risks nothing. Its rows are guarded rather than removed, so a failure of its *own* orphan write leaves nothing on the branch and deletes no local state. But the guard — `archivedTotals` included — is written *before* the bytes are handed off, which leaves two exposures of its own: an increment whose `storeSkills` never lands has already been claimed, so `uncommittedDelta` will not offer it again; and once `storeSkills` *has* succeeded, a failure before the summary write leaves those bytes unreferenced with the row equally unable to re-archive them — the same failure the two-pass union above exists to prevent.

### Guard migration after squash / rebase

`reassociateMetadata` walks each old summary's `skills` and calls `associateSkillWithCommit(skillRef.archivedKey, newHash, cwd, collapsedHashes)`. It `splitArchivedKey`s the ref to recover the registry mapKey, then moves the guard's `commitHash` forward when the guard is **anchored**: either its current hash starts with the key's embedded old short hash, **or** it prefix-matches one of `collapsedHashes` in either direction.

The `collapsedHashes` argument is load-bearing. A hoisted ref keeps the `archivedKey` of the commit that ORIGINALLY archived it, while the guard has since been migrated by an earlier squash — so matching the embedded hash alone worked once and then silently stopped, stranding the row on a commit that no longer existed, where nothing could ever archive it again.

`contentHashAtCommit` and `archivedTotals` are both preserved: squash and rebase rewrite commit metadata, not file content, so the archive-time anchor must survive, and `archivedTotals` records how much of the row a commit already claimed — a metadata rewrite un-claims none of it. Dropping it would make the row's whole history look uncommitted again and republish it onto the next commit.

References have no `plans.json` guard row (commit deletes the entry), so there is nothing to re-anchor for them.

Every path that both archives and migrates — the squash pipeline, the amend short-circuit and the full amend path — runs its archival BEFORE `reassociateMetadata`. A row this commit just archived therefore already carries the new hash, and neither anchor test matches it — the embedded old short hash is not its prefix, and the new hash is not among `collapsedHashes` — so migration is a no-op for exactly the rows that need none.

## State Transitions

Per registry row, across its archival life:

| From | Event | To | Notes |
|---|---|---|---|
| `commitHash: null`, no `archivedTotals` | First archive | Guarded; `archivedTotals` = the row's full current counters | The commit's ref carries that same full history — exactly once. |
| Guarded, `archivedTotals` = T | Skill entered again (spec 319) | Guard fields untouched; counters grow past T | The row is uncommitted again by arithmetic, not by clearing the guard. |
| Guarded, counters > T | Next archive | `commitHash` → new hash, `contentHashAtCommit` re-hashed over the newly archived bytes, `archivedTotals` → the new current total | The ref carries `current - T`. |
| Guarded, counters == T | Any archive pass | Unchanged | `uncommittedDelta` returns `undefined`; no ref, no orphan write. |
| Guarded by a pre-`archivedTotals` version | Any archive pass | Unchanged | `isLegacyArchived` treats it as fully archived until `upsertSkillEntry` seeds a baseline. |
| Any row with a delta | Present in `excludedKeys` | Unchanged, `commitHash` stays as-is | Not archived, not guarded, not written to the orphan branch — returns to the panel for the next commit. |
| Any row with a delta | Working file missing | Unchanged | Warning logged; no ref, so no summary points at an unwritten file. |
| Guarded at hash A | Squash / rebase collapses A into B | `commitHash` → B | `contentHashAtCommit` and `archivedTotals` preserved. |
| Guarded by the squash path's first pass | Skill entered again before that same path's second pass | `commitHash` unchanged (same commit); `contentHashAtCommit` re-hashed over the newer bytes; `archivedTotals` advanced again | The second pass's ref carries the in-window increment but shares the first's `archivedKey`, so the accumulation drops it — that increment reaches no summary. |
| Absent, or present with no delta, at the squash path's first pass | Delta appears before that path's second pass | Guarded at the squash hash by the second pass | Only the second pass's ref carries that `archivedKey`; it rides the union onto the root. Without the union the orphan bytes are stranded and the row can never re-archive. |

## Notable Behavior

- **`commitHash` is deliberately NOT the archival predicate.** It is set on every archive and never cleared, so gating on it froze a re-used skill out of every later commit permanently. The predicate is `uncommittedDelta`, i.e. the counters moving past `archivedTotals`. This is the single most load-bearing difference between skills and the plan/note lifecycle they otherwise follow, and it is restated at every consumer (`SkillArchive`, `detectActiveSkillsForBranch`, the VS Code `SkillService`) because a local re-derivation of the guard rule has already drifted out of sync once and hid every re-used skill.
- **Exclusions are applied INSIDE the association, not to its result.** The function has side effects — it guards the row and emits orphan-branch bytes — so a post-filter would leave an excluded skill archived on the branch while merely hiding it from the summary. Skipping association is also not a delete: the row keeps `commitHash: null` and comes back on the panel for the next commit.
- **The AI-excluded `skill` key set is always empty.** `ExcludedContextItem.kind` accepts `"skill"`, QueueWorker builds the set and consumes it, and `CommitSelectionStore` accepts `"skills"` as an `ExclusionKind` — but the relevance ranker's own `ContextKind` is `"plan" | "note" | "reference"` and it only ever emits those three, so no `excludedContext` entry can carry `kind: "skill"`. The plumbing is complete and inert; the only live contributor to `excludedKeys` is the user's persisted checkbox set. Recorded because the union reads as if two sources were active. (Surprising; declared-but-unreachable, not behavior.)
- **When BOTH squash passes archive the same row, the commit UNDER-counts it — and that is the accepted trade.** Both passes stamp the same commit hash, so both refs carry the same `archivedKey`, and the shared accumulation dedupes by `archivedKey` **before** accumulating (spec 323): it keeps the first ref it saw rather than summing the two. The first pass's ref therefore reports only the increment known at that moment, while the second pass has already advanced the row's `archivedTotals` past the rest — so the invocations that landed between the passes are reported on no commit at all. They are not lost from the archive itself: the bytes on the branch are the second pass's newer copy of the working file (same path, so it replaces the first pass's), which does contain them. Summing instead is not available: the `archivedKey` dedupe is what stops a recursive walk over a squash tree from inflating every count by one generation per squash. The cost is a wrong number on one commit's table for one narrow window, versus stranded bytes and an unarchivable row. (Surprising.)
- **Skills need no archived-file-identity union of the kind plans, notes and references get on this path.** Those three are unioned onto the consolidated root by a key that KEEPS the per-commit hash stamp, because two children can legitimately hold the same logical item archived at different commits, and a stamp-stripped key would keep one ref and drop the other — leaving that other's orphan-branch file with no summary addressing it. The whole choice does not arise for skills: the accumulation folds on the registry mapKey and ACCUMULATES rather than picking a winner, so the two passes' records both reach the root and no skill's increment is lost by a key collision. Where the same skill is reached at several commits, the fold sums their counts into one row that carries one `archivedKey` — so a file pointer can go unreferenced there while the figures still add up, which is a materially different trade from a plan / note / reference, whose ref is the item's ONLY carrier in the memory. That fold and its trade belong to spec 323; recorded here because it is why this path treats the two families differently rather than by oversight.
- **`detectActiveSkillsForBranch` has no production caller.** It exists in `SessionTracker.ts` and is exercised only by tests; `SkillArchive` reads the registry itself, and the VS Code panel has its own `detectSkills` (spec 324). Both restate the `uncommittedDelta` predicate rather than routing through it. Declared-but-unreachable.
- **`readSkillFromBranch` has no production caller.** It exists in `SummaryStore.ts` and is exercised only by tests. Nothing currently reads an archived skill's markdown back off the orphan branch — the summary's `SkillCommitRef` carries everything the display surfaces need. Declared-but-unreachable.
- **The amend fresh-leaf path archives skills but does not attach their refs to the summary it writes.** It calls `consumeWorkspaceContext` (which guards the rows and writes the orphan bytes) and then builds `freshLeaf` with `plans`, `notes` and `references` from `consumed`, but no `skills` field — unlike the amend short-circuit and full-amend paths, which both set `skills: consumed.skillRefs`. The archived record therefore exists on the orphan branch and the rows are correctly guarded, but that commit's summary reports no skills. Recorded as observed reality.
- **Archival is a copy, not a re-render.** The working markdown is read byte-for-byte and handed to the caller. Rendering from the registry row here would put the display format in a second place and let the two drift silently — and it would break `contentHashAtCommit`, which must hash exactly what was stored so a later re-entry that rewrites the file reads as changed against the archived bytes.
- **A row is guarded before the orphan write, which inverts the reference flow's ordering.** The row is never deleted, so a failed `storeSkills` loses no row and leaves nothing on the branch — but the guard advances `archivedTotals` in the same write, so that failure claims an increment which was never stored and no later commit re-offers it. Do not copy the reference flow's write-ahead reasoning here, and do not copy this ordering back to references.
- **`usageBySession` leads the delta and the total is re-derived from it, never subtracted independently.** Subtracting both separately would produce a `usage` that disagrees with its own split, which detach then silently overwrites — the disagreement would never surface as an error, only as a wrong number after an unrelated user action.
- **An empty split with a real invocation count is a valid, deliberate output.** It says "the skill ran, we cannot say what it cost", which is the same degradation a fully-detached row reaches — and it is why consumers must treat an absent `usage` as unknown rather than zero.
- **The save merges back only rows this run changed.** A blanket `{ ...fresh, skills: updated }` would revert a concurrent writer's change to a different row; `pickArchived` compares by object identity against the pre-loop snapshot, so only genuinely-guarded rows are written.

## Shared Behavior

- The working markdown file, `sanitizeSkillIdForPath`, the fold that produces the row's counters, and the legacy-baseline seeding in `upsertSkillEntry` are owned by spec 319.
- `SkillUsage` figures and their `confidence` are owned by spec 321; capture of the invocations by specs 320, 325 and 326.
- `mergeSkillRef` / `mergeSkillRefs`, `collectChildSkills`, the squash hoist onto a merged root, the PR-wide aggregate and the Memory Bank visible `skills--<hash8>.md` file are owned by spec 323 — including the `archivedKey` dedupe that makes a recursive walk over a squash tree safe.
- The user-facing exclusion checkbox that populates `exclusions.skills`, and the panel preview that mirrors `uncommittedDelta`, are owned by spec 324.
- `commit-selection.json`, `readExclusions` and the `ExclusionKind` union are owned by spec 188.
- `withPlansLock`, `loadPlansRegistry` / `savePlansRegistry` and the sibling plan / note / reference archival steps are owned by specs 29, 42, 43 and 179.
- `storeSkills`' orphan-branch write, its lock, the `isManuallyDisabled` pre-lock gate, and the Memory Bank hidden-layer mirror it inherits are owned by specs 01, 02, 03 and 304.
- Squash consolidation and rebase metadata migration, which drive `reassociateMetadata`, are owned by specs 13, 40 and 41.
- Detach-time correction of a committed skill's figures using the snapshotted `usageBySession` is owned by spec 306.
