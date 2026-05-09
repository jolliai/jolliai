/**
 * PlanSlug — Plan slug normalization shared between recall payload assembly
 * and SearchHit projection.
 *
 * When a plan is archived at a particular commit, its file in the orphan
 * branch is renamed from `plans/<slug>.md` to `plans/<slug>-<shortHash>.md`,
 * and the `PlanReference.slug` recorded on subsequent commits carries the
 * suffixed form. To resolve "is this the same logical plan?" across
 * pre-archive and post-archive references, both call sites must collapse the
 * slug back to its **base** form by cross-validating the trailing
 * `-<shortHash>` against the host commit's hash.
 *
 * Two short-hash widths (7 and 8) are accepted because both have appeared in
 * historical archive runs.
 */

/**
 * Returns the base slug — the slug with any `-<hostShortHash>` archive suffix
 * stripped. If no such suffix is present (or the trailing token doesn't match
 * `commitHash`), the slug is returned unchanged.
 */
export function extractBaseSlug(slug: string, commitHash: string): string {
	const shortHash8 = commitHash.substring(0, 8);
	if (slug.endsWith(`-${shortHash8}`)) {
		return slug.slice(0, -(shortHash8.length + 1));
	}
	const shortHash7 = commitHash.substring(0, 7);
	if (slug.endsWith(`-${shortHash7}`)) {
		return slug.slice(0, -(shortHash7.length + 1));
	}
	return slug;
}
