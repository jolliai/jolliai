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
	/**
	 * spec 110 — `"wiki"` added for `<kbRoot>/_wiki/topic--<slug>.md` and
	 * `<kbRoot>/_wiki/_index.md` pages. MemoryBankScanner (spec 108
	 * Correction 1) already filters by manifest path membership, so wiki
	 * entries are automatically excluded from "user-written" classification
	 * the moment they land here.
	 */
	readonly type: "commit" | "plan" | "note" | "wiki";
	readonly fingerprint: string;
	readonly source: ManifestSource;
	readonly title?: string; // human-readable display name
	/** ISO 8601 last-write time. Ordering key for plan/note in the topic-KB timeline fold. */
	readonly updatedAt?: string;
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

/**
 * Why `KBPathResolver.checkClaimable` refused to let a cwd claim a Memory Bank
 * folder. Each member is user-facing — it is rendered verbatim-ish by the
 * `Memory Bank:` status row and the Settings → Memory Bank tab, so a new member
 * needs a display string in both places.
 */
export type ClaimBlocker =
	/** Not inside a git worktree: an agent temp cwd, a bare `/tmp`, or `/`. */
	| "not-a-project"
	/** The Memory Bank folder is at or inside this project's own working tree. */
	| "folder-inside-repo"
	/** The configured folder couldn't be resolved at all (unusable `$HOME`). */
	| "unresolvable-folder";

/** Result of the write-boundary gate. */
export type ClaimVerdict = { readonly claimable: true } | { readonly claimable: false; readonly blocker: ClaimBlocker };

/** The two config keys `resolveMemoryBankState` needs, so it stays config-loader-free. */
export interface MemoryBankConfig {
	readonly storageMode?: string;
	readonly localFolder?: string;
}

/**
 * Whether folder-layer writes will actually land, and where.
 *
 * Exists because the write-boundary gate degrades **silently**: `StorageFactory`
 * and `ReadStorageResolver` both fall back to orphan-only with nothing but a
 * `debug.log` line, and `storageMode` was never user-visible anywhere. A Memory
 * Bank folder that stopped updating (or never appeared) was therefore
 * unattributable from the outside — the only symptom was staleness. This is the
 * type that makes the fallback reportable.
 */
export type MemoryBankState =
	/** `storageMode` is `"orphan"` (or unrecognized) — no folder layer by choice. */
	| { readonly kind: "orphan-only" }
	/** Folder writes land in `folder`. */
	| { readonly kind: "active"; readonly mode: "dual-write" | "folder"; readonly folder: string }
	/**
	 * Folder layer wanted but refused by the write-boundary gate. `parent` is the
	 * resolved Memory Bank parent, absent only for `"unresolvable-folder"`.
	 */
	| { readonly kind: "degraded"; readonly blocker: ClaimBlocker; readonly parent?: string };

/**
 * .jolli/migration.json — tracks orphan→folder migration progress.
 * `"skipped"` is a transient return value used when the project is manually
 * disabled; it is never persisted to disk.
 */
export interface MigrationState {
	readonly status: "pending" | "in_progress" | "completed" | "partial" | "failed" | "skipped";
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
