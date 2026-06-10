import type { FileWrite, SummaryIndexEntry } from "../Types.js";
import type { TopicPage } from "./TopicKBTypes.js";

export interface StorageProvider {
	/** Read a file's content. Returns null if not found. */
	readFile(path: string): Promise<string | null>;

	/**
	 * Read many files in one logical operation. Returns a Map keyed by the
	 * requested path; a missing file maps to `null` (same contract as
	 * `readFile`). The map MUST contain exactly one entry per requested path.
	 *
	 * Optional: backends that can batch cheaply implement this to avoid
	 * per-file overhead (OrphanBranchStorage spawns one `git cat-file --batch`
	 * instead of N subprocesses — the v5 migration's 336-file read dropped from
	 * ~27 s to ~2 s on Windows because of this). Callers that need a batch read
	 * but find the method absent (FolderStorage, where a local `readFile` per
	 * path is already cheap) must fall back to looping `readFile` themselves.
	 */
	batchReadFiles?(paths: ReadonlyArray<string>): Promise<Map<string, string | null>>;

	/**
	 * Write multiple files in a single logical operation.
	 *
	 * Atomicity varies by implementation:
	 * - OrphanBranchStorage: fully atomic (single git commit).
	 * - FolderStorage: each file is atomic (atomicWrite), but the batch is NOT atomic.
	 * - DualWriteStorage: primary-first sequential; shadow failures are swallowed.
	 */
	writeFiles(files: FileWrite[], message: string): Promise<void>;

	/**
	 * List files under a prefix path.
	 *
	 * Returned paths use forward-slash separators (`/`) regardless of host OS.
	 * This mirrors `git ls-tree`'s output (the format the orphan-branch backend
	 * inherits) and lets downstream consumers (e.g. `SummaryStore.getTranscriptHashes`'s
	 * `transcripts/<hash>.json` regex) match without per-platform branching.
	 *
	 * Implementations that walk a filesystem (FolderStorage) MUST normalize via
	 * `toForwardSlash` before returning — `node:path.relative` emits backslashes
	 * on Windows, and an un-normalized return value silently fails every
	 * forward-slash regex on the consumer side. See the FolderStorage Windows
	 * path bug (2026-05-26) for the cautionary tale.
	 */
	listFiles(prefix: string): Promise<string[]>;

	/** Check if the storage backend is initialized. */
	exists(): Promise<boolean>;

	/** Ensure the storage backend is initialized (create if needed). */
	ensure(): Promise<void>;

	/** Mark storage as out-of-sync (e.g. shadow write failed). Optional. */
	markDirty?(message: string): void;

	/** Clear out-of-sync marker. Optional. */
	clearDirty?(): void;

	/** Check if storage is marked as out-of-sync. Optional. */
	isDirty?(): boolean;

	/**
	 * Remove the user-visible Markdown copy for a single summary entry.
	 * Does NOT touch .jolli/summaries/<hash>.json, .jolli/index.json, or any
	 * orphan-branch state. Idempotent: a missing file is not an error.
	 *
	 * Returns true when a file was actually unlinked, false when nothing was
	 * removed (the .md was already absent, or skipped as a hand-edit). Callers
	 * that count real mutations — e.g. the every-activate stale-child reconcile
	 * deciding whether the visible layer changed — must rely on this rather than
	 * on "entry was visited", because hoisted-child index entries persist in
	 * index.json indefinitely and would otherwise be counted on every pass.
	 *
	 * Optional: implemented by FolderStorage and delegated by DualWriteStorage.
	 * OrphanBranchStorage does not implement it (no visible layer).
	 */
	deleteVisibleMarkdown?(entry: SummaryIndexEntry): Promise<boolean>;

	/**
	 * Re-emit the user-visible Markdown copy for a single summary entry from
	 * the hidden `.jolli/summaries/<hash>.json` source. Idempotent: skips when
	 * the target `.md` already exists. Returns true when the file is on disk
	 * after the call (regenerated or already there), false when the hidden
	 * JSON source is missing or unparseable.
	 *
	 * Optional: implemented by FolderStorage and delegated by DualWriteStorage.
	 * OrphanBranchStorage does not implement it (no visible layer).
	 */
	regenerateVisibleMarkdown?(entry: SummaryIndexEntry): Promise<boolean>;

	/**
	 * Remove the user-visible Markdown copy of a plan for the given branch
	 * (`<branchFolder>/plan--<slug>.md`). Mirrors `deleteVisibleMarkdown`'s
	 * contract — does NOT touch the orphan-branch source, `.jolli/plans/<slug>.md`,
	 * or the local plans registry. Fingerprint-guarded: a hand-edited file is
	 * left in place. Idempotent on a missing file.
	 *
	 * Optional: implemented by FolderStorage and delegated by DualWriteStorage.
	 * OrphanBranchStorage does not implement it (no visible layer).
	 */
	deletePlanVisible?(slug: string, branch: string): Promise<void>;

	/**
	 * Remove the user-visible Markdown copy of a note for the given branch
	 * (`<branchFolder>/note--<id>.md`). Same contract as `deletePlanVisible`.
	 *
	 * Optional: implemented by FolderStorage and delegated by DualWriteStorage.
	 * OrphanBranchStorage does not implement it (no visible layer).
	 */
	deleteNoteVisible?(id: string, branch: string): Promise<void>;

	/**
	 * Remove `branches.json` mappings for the given branch names without
	 * touching the manifest. Called by `StaleChildMarkdownCleanup` after it
	 * deletes the visible `.md` files of hoisted older versions, so the
	 * "Folders" sidebar tab does not surface a branch whose only index
	 * entries are hoisted children (the "ghost branch" bug). Idempotent on
	 * unknown branch names; returns the count of mappings actually removed.
	 *
	 * Optional: implemented by FolderStorage and delegated by DualWriteStorage.
	 * OrphanBranchStorage does not implement it (the orphan branch carries no
	 * `branches.json` — that artifact is folder-only).
	 */
	pruneBranchMappings?(branches: readonly string[]): Promise<number>;

	/**
	 * Walk the manifest and re-emit any commit-typed visible `.md` the manifest
	 * still records but the filesystem no longer contains. Reads the hidden
	 * `.jolli/summaries/<hash>.json` as the authoritative source for branch +
	 * commit message (manifest fields can drift across renames or user edits).
	 *
	 * Counts:
	 * - `healed`: visible `.md` written this pass.
	 * - `skipped`: manifest entries whose `.md` was already on disk, AND
	 *   entries whose recomputed visible path differs from the manifest's
	 *   recorded path (heal refuses to silently rewrite — reconcile owns
	 *   that). The hidden JSON is intact in both cases.
	 * - `failed`: manifest entries that could not be recovered (hidden JSON
	 *   missing / unreadable / malformed, or regenerate refused).
	 *
	 * Idempotent: a second pass with no new deletions reports every entry as
	 * `skipped` (the loop's own `existsSync` short-circuits before reaching the
	 * regenerate step).
	 *
	 * When `opts.dropOrphanedManifestEntries` is true, manifest rows whose
	 * hidden JSON is also missing (ENOENT only — transient EACCES/EBUSY/EIO
	 * never drop) are removed from the manifest and returned in `droppedIds`.
	 * Callers MUST only set this flag when a higher-level truth source (e.g.
	 * the orphan branch in dual-write mode) can re-source the entries — in
	 * folder-only mode dropping is permanent data loss.
	 *
	 * Optional: implemented by FolderStorage and delegated by DualWriteStorage.
	 * OrphanBranchStorage does not implement it (no visible layer).
	 */
	healMissingVisibleMarkdown?(opts?: HealOptions): Promise<HealResult>;

	/**
	 * Renders the visible `_wiki/` layer from topic-KB pages (SP3). Folder-backed
	 * providers implement it; orphan-only leaves it undefined (render no-op).
	 */
	renderTopicWiki?(pages: ReadonlyArray<TopicPage>): Promise<void>;

	/**
	 * Whether the visible `_wiki/` layer is currently present on disk. Folder-backed
	 * providers implement it so the post-commit ingest can re-render a wiki the user
	 * deleted even when no new sources were ingested (`ingested === 0`). Orphan-only
	 * leaves it undefined (no visible layer to recover).
	 */
	isTopicWikiPresent?(): boolean;

	/**
	 * Absolute path to this provider's per-repo Memory Bank root (`<localFolder>/
	 * <repo>`), when folder-backed. The disposable search index is keyed off this
	 * so it lives ALONGSIDE the data it indexes: the `jolli compile` sweep (which
	 * runs with folder storage rooted here) and the MCP server (which runs in the
	 * git checkout but resolves the SAME folder root in dual-write/folder mode)
	 * then agree on the index location, instead of the sweep warming an index the
	 * MCP server can't find. Folder-backed providers implement it; DualWriteStorage
	 * delegates to its folder backend; orphan-only leaves it undefined (the index
	 * falls back to the checkout's `.jolli/jollimemory/`).
	 */
	readonly kbRoot?: string;
}

/** Options for a heal-missing-markdown pass. */
export interface HealOptions {
	/**
	 * Drop manifest entries whose hidden JSON is ALSO missing (ENOENT only).
	 * Default false — safe for any storage mode. Callers backed by a truth
	 * source that can repopulate the manifest (orphan branch, dual-write
	 * primary) may set this to true to stop reconcile from re-reporting
	 * unrecoverable rows; folder-only callers must NOT set this — the
	 * manifest is the last record and dropping it is data loss.
	 */
	readonly dropOrphanedManifestEntries?: boolean;
}

/** Outcome of a heal-missing-markdown pass; consumed by reconcile-callers and the `jolli heal-folder` CLI. */
export interface HealResult {
	readonly healed: number;
	readonly skipped: number;
	readonly failed: number;
	/**
	 * Manifest entries that were dropped because their hidden JSON was also
	 * missing AND `opts.dropOrphanedManifestEntries` was true. Empty when no
	 * rows were dropped (either nothing to drop, or the caller opted out).
	 */
	readonly droppedIds?: readonly string[];
	/**
	 * Populated when the heal pass aborted with an exception (e.g. delegated
	 * shadow storage threw before completing). The numeric counts may be
	 * partial in that case; treat the pass as "errored", not "no-op".
	 */
	readonly error?: string;
}
