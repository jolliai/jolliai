/**
 * Deterministic client-side merge for the four `.jolli/<aggregate>.json`
 * files (JOLLI-1316 §3). Pure functions — order-independent, no I/O, no
 * randomness — so the same `(local, remote)` pair on two devices produces
 * byte-identical output regardless of which side ran first.
 *
 * The plugin invokes these merges in two places:
 *   - Tier 1.5 conflict resolver (`ConflictResolver.tryAggregateMerge`):
 *     when `git pull --rebase` reports a conflict on one of the four files,
 *     read stage 2 (ours) + stage 3 (theirs), call the matching `merge*`,
 *     write back, `git add`.
 *   - `LegacyMigration` (db→git first-bind path): rarely needed because
 *     `mapLegacyDocToVaultPath` always returns `legacy/...` which can't
 *     collide with the per-repo aggregate paths, but the deterministic
 *     merge functions are exported here for any future re-introduction
 *     of aggregate-aware migration.
 *
 * The backend's `JolliMemoryAggregateValidator` rejects pushes whose
 * post-merge files violate well-formedness (duplicate primary key, bad ISO8601
 * timestamp, `folder !== canonical(branch)`, …). This module's contract is to
 * produce inputs that always pass that validation; tests pin the cases.
 */

import type { BranchEntry, CatalogEntry, IndexEntry, ManifestEntry } from "./AggregateTypes.js";

/**
 * Locale-independent string compare for stable cross-device output. Uses
 * UTF-16 code-unit ordering via `<`/`>` (NOT `String.localeCompare`, which
 * varies by ICU data and the user's locale). Two devices merging the same
 * `(local, remote)` pair must produce the same array order so the
 * downstream `JSON.stringify` yields byte-identical output — the next
 * `git pull --rebase` will otherwise re-conflict on these files forever.
 */
function byKey<T>(key: (entry: T) => string): (a: T, b: T) => number {
	return (a, b) => {
		const ka = key(a);
		const kb = key(b);
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	};
}

/**
 * Manifest merge — dedupe by `fileId`, keep the row with the newer
 * `source.generatedAt`. Ties on `generatedAt` keep the first occurrence
 * (i.e. `local` before `remote`); this is irrelevant when both sides have
 * identical entries (the usual case) but pins behaviour for the rare
 * generator-clock-collision scenario.
 *
 * Deletion is implicit: there's no tombstone in the schema. A file removed
 * locally simply doesn't appear in our manifest; a manifest entry whose
 * `path` no longer exists on disk is treated as a zombie at consumption time
 * and pruned on the next regen (§3.1 design doc).
 */
export function mergeManifest(
	local: ReadonlyArray<ManifestEntry>,
	remote: ReadonlyArray<ManifestEntry>,
): ManifestEntry[] {
	const byId = new Map<string, ManifestEntry>();
	for (const entry of local) byId.set(entry.fileId, entry);
	for (const entry of remote) {
		const existing = byId.get(entry.fileId);
		if (!existing) {
			byId.set(entry.fileId, entry);
			continue;
		}
		// Strict `>` keeps the earlier-inserted (local) entry on a tie so
		// the merge is stable; equal timestamps usually mean identical
		// content anyway.
		if (entry.source.generatedAt > existing.source.generatedAt) {
			byId.set(entry.fileId, entry);
		}
	}
	return [...byId.values()].sort(byKey((e) => e.fileId));
}

/**
 * Index merge — dedupe by `commitHash`, with the 2×2 tiebreak from §3.2:
 *
 * | local.parent | remote.parent | winner |
 * |---|---|---|
 * | set    | set    | newer `generatedAt` (strict `>`, ties keep local) |
 * | null   | null   | newer `generatedAt` |
 * | set    | null   | local |
 * | null   | set    | remote |
 *
 * Rationale: a non-null `parentCommitHash` is a stronger claim than null
 * (the row was generated with full history context), so it should always
 * outrank a null-parent row, irrespective of timestamps.
 */
export function mergeIndex(local: ReadonlyArray<IndexEntry>, remote: ReadonlyArray<IndexEntry>): IndexEntry[] {
	const byHash = new Map<string, IndexEntry>();
	for (const entry of local) byHash.set(entry.commitHash, entry);
	for (const entry of remote) {
		const existing = byHash.get(entry.commitHash);
		if (!existing) {
			byHash.set(entry.commitHash, entry);
			continue;
		}
		const existingHasParent = existing.parentCommitHash !== null;
		const incomingHasParent = entry.parentCommitHash !== null;
		if (existingHasParent === incomingHasParent) {
			if (entry.generatedAt > existing.generatedAt) {
				byHash.set(entry.commitHash, entry);
			}
		} else if (incomingHasParent) {
			byHash.set(entry.commitHash, entry);
		}
		// else: existing has parent, incoming is null → keep existing.
	}
	return [...byHash.values()].sort(byKey((e) => e.commitHash));
}

/**
 * Branches merge — dedupe by `branch`. No tiebreak: the `folder` field is
 * deterministic given `branch` (`folder === canonicalBranchFolder(branch)`),
 * so any two valid entries for the same branch differ only in `createdAt`,
 * which doesn't matter for downstream consumers.
 *
 * Last-write-wins on the input order: `remote` overrides `local` for any
 * shared key, matching design doc §3.3's reference implementation.
 */
export function mergeBranches(local: ReadonlyArray<BranchEntry>, remote: ReadonlyArray<BranchEntry>): BranchEntry[] {
	const byBranch = new Map<string, BranchEntry>();
	for (const entry of local) byBranch.set(entry.branch, entry);
	for (const entry of remote) byBranch.set(entry.branch, entry);
	return [...byBranch.values()].sort(byKey((e) => e.branch));
}

/**
 * Catalog merge — dedupe by `commitHash`. No tiebreak: catalog rows are
 * generated from the commit's deterministic recap pipeline, so two
 * independent devices produce identical content for the same hash. `remote`
 * overrides `local` for symmetry with `mergeBranches`.
 */
export function mergeCatalog(local: ReadonlyArray<CatalogEntry>, remote: ReadonlyArray<CatalogEntry>): CatalogEntry[] {
	const byHash = new Map<string, CatalogEntry>();
	for (const entry of local) byHash.set(entry.commitHash, entry);
	for (const entry of remote) byHash.set(entry.commitHash, entry);
	return [...byHash.values()].sort(byKey((e) => e.commitHash));
}

/**
 * Canonical folder name for a branch — used to enforce the
 * `branches.json.folder === canonical(branch)` invariant.
 *
 * Algorithm (design doc §5 + §9 O1): NFKD → lowercase → replace `/` and any
 * non-`[a-z0-9-]` run with a single `-` → collapse repeats → trim leading /
 * trailing `-`. Identical to `SlugUtils.slugify` (common/) so backend and
 * client produce the same folder for the same branch.
 *
 * Empty / all-junk input collapses to `"branch"` so we never write an empty
 * folder name (backend validator would reject it).
 */
export function canonicalBranchFolder(branch: string): string {
	const normalized = branch
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized.length === 0 ? "branch" : normalized;
}
