/**
 * LegacySkillDocIds — one-way migration from per-skill articles to the per-commit
 * skill-usage article.
 *
 * A shipped version published docType `skill` as ONE DOCUMENT PER (skill, commit),
 * recording each id on its own `SkillCommitRef.jolliDocId`. The aggregate model
 * publishes one document per COMMIT, with the id on
 * `CommitSummary.jolliSkillsDocId`. Without this step a summary carrying the old
 * shape would simply be pushed as if it had never been published: a fresh article
 * per commit, and every per-skill article left on the Space forever — invisible to
 * `cleanupOrphanedDocs`, which only ever sees `orphanedDocIds`.
 *
 * So the old ids are converted rather than discarded: the newest is ADOPTED as the
 * commit's article (the next push retitles and rewrites it into the aggregate),
 * and the rest are queued for deletion. N per-skill articles become 1 aggregate,
 * which is exactly the end state the model wants — reached in one push, with no
 * leak and no separate cleanup pass.
 *
 * **Runs before a push, not on load.** It only matters for a summary about to be
 * pushed, and it must be persisted by the same write-back that stores the push
 * result; doing it on every read would rewrite stored summaries that may never be
 * pushed at all.
 *
 * Idempotent by construction: the legacy fields are stripped from every ref it
 * touches, so a second call finds nothing to do and returns by identity. A summary
 * that already carries `jolliSkillsDocId` keeps it — but any legacy id still left
 * on its refs is reclaimed rather than ignored, which a mixed-vintage squash tree
 * can produce (see the note on the early return).
 */

import { createLogger } from "../../Logger.js";
import type { CommitSummary, SkillCommitRef } from "../../Types.js";

const log = createLogger("LegacySkillDocIds");

/**
 * Folds any legacy per-skill article ids into the commit-level one.
 *
 * Returns the summary unchanged (by identity) when there is nothing to migrate, so
 * callers can keep using `!==` to detect a rewrite.
 */
export function adoptLegacySkillDocIds(summary: CommitSummary): CommitSummary {
	const skills = summary.skills;
	if (skills === undefined || skills.length === 0) return summary;
	const published = skills.filter((ref) => typeof ref.jolliDocId === "number");
	// Ids a fold already banked on the refs but that no drain has reached yet. Read
	// before the early returns below: they are a leak in exactly the same way a live
	// `jolliDocId` is, and neither is reachable from anywhere but this function.
	const banked = skills.flatMap((ref) => ref.supersededDocIds ?? []);
	if (published.length === 0 && banked.length === 0) {
		// Still strip: a ref carrying only a legacy `jolliDocUrl` has no article to
		// reclaim, but leaving the field makes the shape ambiguous on the next pass.
		return skills.some((ref) => ref.jolliDocUrl !== undefined)
			? { ...summary, skills: skills.map(stripLegacyDocFields) }
			: summary;
	}

	// Already migrated — never re-point a live aggregate article at an old per-skill
	// one, which would abandon the article the commit is actually published as. But
	// "don't adopt" is not "do nothing": a squash tree can mix vintages, so
	// `collectChildSkillsDocMeta` can hoist an aggregate id onto the root from one
	// child while `mergeSkillRef` keeps a legacy-vintage child's per-ref `jolliDocId`
	// on the hoisted skill row. Returning by identity there strands that per-skill
	// article on the Space forever: it is the id `mergeSkillRef` KEPT, so it is in no
	// `supersededDocIds` either, and `cleanupOrphanedDocs` only ever sees
	// `orphanedDocIds`. Skip the adopt step alone and reclaim the rest.
	if (summary.jolliSkillsDocId !== undefined) {
		const orphaned = [
			...(summary.orphanedDocIds ?? []),
			...published.map((ref) => ref.jolliDocId as number),
			...banked,
		];
		log.info(
			"%s: already an aggregate — orphaning %d leftover legacy skill article(s)",
			summary.commitHash.substring(0, 8),
			orphaned.length - (summary.orphanedDocIds?.length ?? 0),
		);
		return {
			...summary,
			skills: skills.map(stripLegacyDocFields),
			...(orphaned.length > 0 && { orphanedDocIds: [...new Set(orphaned)] }),
		};
	}
	if (published.length === 0) {
		// Nothing to adopt, but banked ids still have to be reclaimed.
		return {
			...summary,
			skills: skills.map(stripLegacyDocFields),
			orphanedDocIds: [...new Set([...(summary.orphanedDocIds ?? []), ...banked])],
		};
	}

	// Newest first, so the adopted article is the one most recently written — the same
	// "most recent activity wins" rule the squash paths use to pick a survivor. Ties
	// break on `archivedKey` so the choice is deterministic across runs.
	const ordered = [...published].sort((a, b) => {
		if (a.lastUsedAt !== b.lastUsedAt) return a.lastUsedAt < b.lastUsedAt ? 1 : -1;
		return a.archivedKey < b.archivedKey ? -1 : a.archivedKey > b.archivedKey ? 1 : 0;
	});
	const [adopted, ...superseded] = ordered;
	const orphaned = [
		...(summary.orphanedDocIds ?? []),
		...superseded.map((ref) => ref.jolliDocId as number),
		...banked,
	];
	log.info(
		"%s: adopting legacy skill article %d as the commit aggregate, orphaning %d",
		summary.commitHash.substring(0, 8),
		adopted.jolliDocId,
		orphaned.length,
	);

	return {
		...summary,
		jolliSkillsDocId: adopted.jolliDocId,
		// Rides with the id: the reuse gate reads its origin to decide which backend
		// the id belongs to, so adopting one without the other would make the id
		// unusable rather than merely untagged.
		...(adopted.jolliDocUrl !== undefined && { jolliSkillsDocUrl: adopted.jolliDocUrl }),
		skills: skills.map(stripLegacyDocFields),
		...(orphaned.length > 0 && { orphanedDocIds: [...new Set(orphaned)] }),
	};
}

/**
 * Drops the three legacy per-ref fields.
 *
 * Deletes the keys rather than setting them to `undefined`: these refs are
 * serialized to the orphan branch as JSON, where `"jolliDocId": null` reads back as
 * a field that exists — and a ref that still looks published would be re-adopted by
 * the next call, undoing the migration.
 */
function stripLegacyDocFields(ref: SkillCommitRef): SkillCommitRef {
	if (ref.jolliDocId === undefined && ref.jolliDocUrl === undefined && ref.supersededDocIds === undefined) {
		return ref;
	}
	const { jolliDocId: _id, jolliDocUrl: _url, supersededDocIds: _superseded, ...rest } = ref;
	return rest;
}
