/**
 * Union of archived working-area refs (plans / notes / references) into a
 * hoisted summary root.
 *
 * One merge function, TWO key families — and picking the wrong family silently
 * strands orphan-branch files (a snapshot on the branch with no summary pointing
 * at it), which is the failure class this module exists to prevent:
 *
 * - `baseKeyOf` — amend. Collapses the per-commit `-<shortHash>` stamp, so a
 *   revived guard re-archived under a new hash lists once.
 * - `snapshotKeyOf` — squash. Keeps the stamp, so N children each holding the
 *   same logical item at a different commit keep N pointers.
 *
 * Its own module rather than a SummaryStore export because the consumers span
 * both files — `SummaryStore.mergeManyToOne` (squash) and
 * `QueueWorker.buildHoistedAmendRoot` (amend) — and QueueWorker's tests mock
 * SummaryStore wholesale. A pure helper living in a mocked module would force
 * every such suite to re-export it from its mock factory.
 */

import type { NoteReference, PlanReference, ReferenceCommitRef } from "../Types.js";

/**
 * Trailing `-<8 hex>` short-hash suffix that association appends to plan slugs / note ids.
 *
 * The single spelling of this pattern. Besides `baseKeyOf` below, the display and
 * push paths that group snapshots by logical item import it: `planBaseKey`
 * (JolliMemoryPushOrchestrator and the panel's PlanGrouping) and the relevance
 * lookups in SummaryMarkdownBuilder / SummaryHtmlBuilder. Any drift between them
 * would have one layer group snapshots another layer kept apart. No `g` flag, so
 * the shared object carries no `lastIndex` state between callers.
 */
export const REF_HASH_SUFFIX = /-[0-9a-f]{8}$/;

/**
 * Unions old (hoisted) refs with newly-associated refs, deduped by the caller's
 * key, with **new refs winning** on collision. New-wins is a data-integrity
 * requirement: the new ref is the one whose markdown was just written to the
 * orphan branch, so dropping it in favour of the old ref would leave an
 * orphan-branch file with no summary pointer.
 *
 * The dedupe key decides which snapshots survive — pass `baseKeyOf.*` on amend
 * and `snapshotKeyOf.*` on squash. See this module's header.
 */
export function mergeRefsNewWins<T>(
	oldRefs: ReadonlyArray<T> | undefined,
	newRefs: ReadonlyArray<T> | undefined,
	dedupeKey: (ref: T) => string,
): T[] {
	const byKey = new Map<string, T>();
	for (const ref of oldRefs ?? []) byKey.set(dedupeKey(ref), ref);
	for (const ref of newRefs ?? []) byKey.set(dedupeKey(ref), ref);
	return [...byKey.values()];
}

/**
 * AMEND keys — identity of the logical ITEM, with the per-commit hash stamp
 * stripped. `foo-<oldHash>` and `foo-<newHash>` collide, so a revived guard that
 * re-archived the same plan under the amend's new hash lists once (as the new
 * ref) instead of twice.
 *
 * Sound only because an amend root has exactly ONE old summary, so there is at
 * most one old ref per base key. Never use these on a many-children merge.
 */
export const baseKeyOf = {
	plan: (p: PlanReference): string => p.slug.replace(REF_HASH_SUFFIX, ""),
	note: (n: NoteReference): string => n.id.replace(REF_HASH_SUFFIX, ""),
	reference: (r: ReferenceCommitRef): string => `${r.source}:${r.nativeId}`,
} as const;

/**
 * SQUASH keys — identity of the archived FILE, hash stamp included.
 *
 * A squash root hoists refs from N children, and two children can legitimately
 * hold the same logical item at different commits: consult ticket PROJ-9 on
 * commit 1, consult it again on commit 3, and the branch carries BOTH
 * `linear:PROJ-9-<hash1>` and `linear:PROJ-9-<hash3>` as separate orphan-branch
 * files. Nothing on the squash path renames or deletes a child's snapshot
 * (`reassociateMetadata` only re-anchors `plans.json` registry rows), so both
 * files outlive the squash and both need a pointer. Base keys here would keep
 * whichever child was visited last and strand the other.
 *
 * These are the same keys `collectChildPlans` / `collectChildNotes` /
 * `collectChildReferences` already dedupe by, so feeding their output through
 * `mergeRefsNewWins` with these is order-preserving and idempotent.
 */
export const snapshotKeyOf = {
	plan: (p: PlanReference): string => p.slug,
	note: (n: NoteReference): string => n.id,
	reference: (r: ReferenceCommitRef): string => r.archivedKey,
} as const;
