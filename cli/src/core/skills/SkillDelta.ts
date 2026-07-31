/**
 * SkillDelta — "what has this skill done since the last commit?"
 *
 * Its own module rather than a helper inside SkillArchive or SessionTracker
 * because both need it and those two already point at each other: SkillArchive
 * loads and saves the registry through SessionTracker, so exporting from either
 * side would close an import cycle.
 *
 * **Why a delta exists at all.** A skill is not a plan or a note. Those are
 * archived once and done; a skill can be entered again during the next piece of
 * work, and its registry row keeps ACCUMULATING across every session that used
 * it. So "uncommitted" cannot be read off the row directly — it is the row minus
 * whatever the last archive already froze onto a commit.
 *
 * Keeping every commit's record an increment is what lets the PR-wide aggregate
 * stay a plain sum. The alternative — refs carrying running totals — would need
 * the aggregate to pick a winner per skill instead, and a single commit's own
 * table would report spend that belonged to an earlier one.
 */

import type { SkillArchivedTotals, SkillCommitRef, SkillEntry, SkillUsage } from "../../Types.js";

/** Accumulation key: the registry mapKey, NOT `archivedKey` (which carries a per-commit hash). */
function skillRefKey(ref: SkillCommitRef): string {
	return `${ref.source}:${ref.skill}`;
}

/**
 * Folds one commit's record of a skill into a running one.
 *
 * Usage is SUMMED rather than replaced — every ref is one commit's increment (see
 * {@link uncommittedDelta}), so summing is what reconstructs a span of commits.
 * The merged figure degrades to `estimated` if either side was: a sum containing a
 * guess is a guess. `detection` likewise degrades to `heuristic`, because one
 * inferred contributor makes "some inferred" true of the total.
 *
 * `usageBySession` is merged per key alongside the total, and the two are kept
 * CONSISTENT by construction: a split survives only when every ref that contributed
 * to `usage` brought one. Summing the totals while keeping just `prev`'s split was a
 * silent under-report waiting for a detach — `subtractSkillUsage` re-derives `usage`
 * from the surviving split rather than subtracting from the total, so detaching any
 * one session would have thrown away the whole contribution of every ref whose split
 * was missing. Dropping the split instead leaves the merged total stale on detach,
 * which that function already handles explicitly (its forward-only guard returns a
 * split-less ref untouched) and which is the honest degradation of the two.
 *
 * `archivedKey` comes from `prev`, i.e. from whichever ref the caller folded FIRST —
 * not from the earliest commit. `reassociateMetadata` and the squash hoist walk
 * `oldSummaries` newest-first, so in practice the newest contributor's key survives.
 * Either way it addresses a file that really is on the orphan branch, which is the
 * property that matters; the other contributors' files stay there unreferenced, the
 * same trade-off `collectChildPlans` already makes. Inventing a synthetic key would
 * be worse — it would address nothing.
 */
export function mergeSkillRef(prev: SkillCommitRef | undefined, next: SkillCommitRef): SkillCommitRef {
	if (prev === undefined) return next;
	const usage =
		prev.usage === undefined || next.usage === undefined
			? (prev.usage ?? next.usage)
			: {
					input: prev.usage.input + next.usage.input,
					output: prev.usage.output + next.usage.output,
					cached: prev.usage.cached + next.usage.cached,
					confidence:
						prev.usage.confidence === "attributed" && next.usage.confidence === "attributed"
							? ("attributed" as const)
							: ("estimated" as const),
				};
	// Only the refs that actually contributed to `usage` have to account for it: when
	// one side reports no usage at all (a heuristic source), the merged total IS the
	// other side's total and that side's split still decomposes it exactly.
	const contributors = [prev, next].filter((ref) => ref.usage !== undefined);
	const usageBySession = mergeUsageSplits(contributors);
	// `usageBySession` destructured out rather than left to `...prev`, so a dropped
	// split really is dropped instead of surviving as prev's stale half.
	const { usageBySession: _prevSplit, ...prevRest } = prev;
	return {
		...prevRest,
		invocationCount: prev.invocationCount + next.invocationCount,
		...(usage !== undefined ? { usage } : {}),
		...(usageBySession !== undefined ? { usageBySession } : {}),
		...(prev.detection === "heuristic" || next.detection === "heuristic"
			? { detection: "heuristic" as const }
			: {}),
	};
}

/**
 * Per-key sum of every contributor's split, or `undefined` when any of them lacks one.
 *
 * Summing (not overwriting) is required because a single session can span commits: the
 * same `<source>:<sessionId>` key legitimately appears in two refs, each carrying that
 * session's share of its own commit.
 *
 * The all-or-nothing rule is what keeps `usageBySession` a faithful decomposition of
 * `usage` — see {@link mergeSkillRef} on why a partial split is worse than none.
 */
function mergeUsageSplits(
	contributors: ReadonlyArray<SkillCommitRef>,
): Readonly<Record<string, SkillUsage>> | undefined {
	if (contributors.length === 0) return undefined;
	if (contributors.some((ref) => ref.usageBySession === undefined)) return undefined;

	const merged: Record<string, SkillUsage> = {};
	for (const ref of contributors) {
		for (const [key, usage] of Object.entries(ref.usageBySession ?? {})) {
			const prior = merged[key];
			merged[key] =
				prior === undefined
					? usage
					: {
							input: prior.input + usage.input,
							cached: prior.cached + usage.cached,
							output: prior.output + usage.output,
							confidence:
								prior.confidence === "attributed" && usage.confidence === "attributed"
									? "attributed"
									: "estimated",
						};
		}
	}
	return merged;
}

/**
 * Accumulates many commits' skill refs into one row per skill, insertion-ordered.
 *
 * Shared by the PR-wide aggregate and the squash/rebase summary hoist so the two
 * cannot disagree about what "the same skill across several commits" totals to.
 *
 * **Deduped by `archivedKey` before accumulating**, and that order is load-bearing.
 * `archivedKey` is unique per (skill, archiving commit), so the same value appearing
 * twice is ONE archived record reached twice — which a squash tree does routinely: a
 * squash root carries its children's hoisted refs and still keeps those children, so
 * a recursive walk meets each hoisted ref from both ends. Accumulating blindly
 * inflated every count by one generation per squash. Distinct archivedKeys ARE
 * distinct commits' increments and must still sum.
 *
 * This is the one place the accumulate-vs-dedupe distinction bites: the sibling
 * `collectChildReferences` recurses safely only because it dedupes outright.
 */
export function mergeSkillRefs(refs: ReadonlyArray<SkillCommitRef>): ReadonlyArray<SkillCommitRef> {
	const byArchivedKey = new Map<string, SkillCommitRef>();
	for (const ref of refs) {
		if (!byArchivedKey.has(ref.archivedKey)) byArchivedKey.set(ref.archivedKey, ref);
	}
	const merged = new Map<string, SkillCommitRef>();
	for (const ref of byArchivedKey.values()) {
		const key = skillRefKey(ref);
		merged.set(key, mergeSkillRef(merged.get(key), ref));
	}
	return [...merged.values()];
}

/**
 * The part of a row that no commit has claimed yet, or `undefined` when the row
 * is fully accounted for.
 *
 * Counting is what decides: `invocationCount` only ever grows, so a positive
 * difference against the baseline is exactly "entered again since the last
 * commit". Usage is then reported for that same span.
 *
 * A row with no `archivedTotals` has never been archived, and its whole history is
 * uncommitted — which is what an all-zero baseline says.
 *
 * The exception is a row GUARDED by a version that predates this field: it was
 * archived in full, so its baseline is its current total even though nothing wrote
 * one down. Reading it as an all-zero baseline instead would re-archive a skill's
 * entire history onto the first commit after the upgrade. `upsertSkillEntry` seeds a
 * real baseline the moment such a row is used again, so this only has to hold until
 * then.
 *
 * EITHER guard field standing alone counts as archived here, matching the predicate
 * this replaced. A half-written row (a content hash with no commit) is the one shape
 * where the two disagree, and treating it as fresh would republish a whole history
 * on the strength of a partial write.
 */
export function uncommittedDelta(entry: SkillEntry): SkillArchivedTotals | undefined {
	const base = entry.archivedTotals;
	if (base === undefined && isLegacyArchived(entry)) return undefined;
	const invocationCount = entry.invocationCount - (base?.invocationCount ?? 0);
	if (invocationCount <= 0) return undefined;

	// `usageBySession` leads when present, and the total is re-derived from it rather
	// than subtracted independently. DetachedUsageSubtraction recomputes `usage` from
	// whatever keys survive a detach, so a total that disagreed with its own split
	// would be silently overwritten the first time anything was detached.
	if (entry.usageBySession !== undefined) {
		const bySession: Record<string, SkillUsage> = {};
		for (const [key, usage] of Object.entries(entry.usageBySession)) {
			const prior = base?.usageBySession?.[key];
			const fresh = prior === undefined ? usage : subtractUsage(usage, prior);
			if (fresh !== undefined) bySession[key] = fresh;
		}
		// A session already archived in full contributes no key. An empty split with a
		// real invocation count is the honest "it ran, we cannot say what it cost" —
		// the same shape a fully-detached row degrades to.
		if (Object.keys(bySession).length === 0) return { invocationCount };
		return { invocationCount, usage: totalOf(bySession), usageBySession: bySession };
	}

	if (entry.usage === undefined) return { invocationCount };
	const usage = base?.usage === undefined ? entry.usage : subtractUsage(entry.usage, base.usage);
	return usage === undefined ? { invocationCount } : { invocationCount, usage };
}

/**
 * A row archived before `archivedTotals` existed — recognised by the bare guard, the
 * only evidence such a row carries.
 */
export function isLegacyArchived(entry: SkillEntry): boolean {
	return entry.commitHash !== null || entry.contentHashAtCommit !== undefined;
}

/** Snapshot to store as the new baseline once `entry` has been archived. */
export function archivedTotalsOf(entry: SkillEntry): SkillArchivedTotals {
	return {
		invocationCount: entry.invocationCount,
		...(entry.usage !== undefined ? { usage: entry.usage } : {}),
		...(entry.usageBySession !== undefined ? { usageBySession: entry.usageBySession } : {}),
	};
}

/** `current - prior`, or `undefined` when nothing was added. */
function subtractUsage(current: SkillUsage, prior: SkillUsage): SkillUsage | undefined {
	const input = current.input - prior.input;
	const cached = current.cached - prior.cached;
	const output = current.output - prior.output;
	// Attribution recomputes a session from line 0 on every pass, so a figure can be
	// revised DOWN. Clamping keeps a corrected estimate from reporting negative spend.
	if (input <= 0 && cached <= 0 && output <= 0) return undefined;
	return {
		input: Math.max(0, input),
		cached: Math.max(0, cached),
		output: Math.max(0, output),
		confidence: current.confidence,
	};
}

/** Sum of a split, with confidence re-derived — one estimated part makes the total a guess. */
function totalOf(bySession: Readonly<Record<string, SkillUsage>>): SkillUsage {
	let input = 0;
	let cached = 0;
	let output = 0;
	let estimated = false;
	for (const usage of Object.values(bySession)) {
		input += usage.input;
		cached += usage.cached;
		output += usage.output;
		if (usage.confidence !== "attributed") estimated = true;
	}
	return { input, cached, output, confidence: estimated ? "estimated" : "attributed" };
}
