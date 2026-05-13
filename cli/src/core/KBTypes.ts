/**
 * Data types for the local Knowledge Base (.jolli/ metadata layer).
 */

/** Source tracking for AI-generated files */
export interface ManifestSource {
	readonly commitHash?: string;
	readonly branch?: string;
	readonly generatedAt?: string;
}

/** A single entry in .jolli/manifest.json */
export interface ManifestEntry {
	readonly path: string;
	readonly fileId: string;
	readonly type: "commit" | "plan" | "note";
	readonly fingerprint: string;
	readonly source: ManifestSource;
	readonly title?: string; // human-readable display name
}

/** .jolli/manifest.json — tracks AI-generated files in the KB folder */
export interface Manifest {
	readonly version: number;
	readonly files: ManifestEntry[];
}

/** Maps a git branch name to a transcoded folder name */
export interface BranchMapping {
	readonly folder: string;
	readonly branch: string;
	readonly createdAt: string;
}

/** .jolli/branches.json — branch ↔ folder mapping registry */
export interface BranchesJson {
	readonly version: number;
	readonly mappings: BranchMapping[];
}

/** .jolli/config.json — Knowledge Base settings */
export interface KBConfig {
	readonly version: number;
	readonly sortOrder: "date" | "name";
	readonly remoteUrl?: string;
	readonly repoName?: string;
}

/** .jolli/migration.json — tracks orphan→folder migration progress */
export interface MigrationState {
	readonly status: "pending" | "in_progress" | "completed" | "partial" | "failed";
	readonly totalEntries: number;
	readonly migratedEntries: number;
	readonly failedHashes?: readonly string[];
	readonly lastMigratedHash?: string;
	/**
	 * v2 leaf-cleanup step (shipped briefly in 0.99.2, never read after that
	 * release). Its algorithm was inverted under v4 Hoist semantics — it kept
	 * stale children and deleted heads. Retained in the type purely so existing
	 * on-disk migration.json entries that carry this field still parse; the
	 * field is never written or read by code after 0.99.2.
	 * @deprecated use {@link staleChildCleanup} instead.
	 */
	readonly leafCleanup?: { readonly completedAt: string };
	/**
	 * v3 stale-child cleanup step (added 2026-05-12 to replace the inverted
	 * `leafCleanup` from 0.99.2): one-shot deletion of visible .md files for
	 * v4 Hoist hoisted children (entries with `parentCommitHash != null`),
	 * combined with one-shot regeneration of head .md files erroneously
	 * deleted by 0.99.2's inverted pass. `completedAt` set on first successful
	 * run; subsequent activate runs skip when present. Absent = not yet
	 * attempted (or only the 0.99.2 inverted pass ran — re-run is required).
	 */
	readonly staleChildCleanup?: { readonly completedAt: string };
}
