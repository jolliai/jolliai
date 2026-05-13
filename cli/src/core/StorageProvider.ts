import type { FileWrite, SummaryIndexEntry } from "../Types.js";

export interface StorageProvider {
	/** Read a file's content. Returns null if not found. */
	readFile(path: string): Promise<string | null>;

	/**
	 * Write multiple files in a single logical operation.
	 *
	 * Atomicity varies by implementation:
	 * - OrphanBranchStorage: fully atomic (single git commit).
	 * - FolderStorage: each file is atomic (atomicWrite), but the batch is NOT atomic.
	 * - DualWriteStorage: primary-first sequential; shadow failures are swallowed.
	 */
	writeFiles(files: FileWrite[], message: string): Promise<void>;

	/** List files under a prefix path. */
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
	 * Optional: implemented by FolderStorage and delegated by DualWriteStorage.
	 * OrphanBranchStorage does not implement it (no visible layer).
	 */
	deleteVisibleMarkdown?(entry: SummaryIndexEntry): Promise<void>;

	/**
	 * Re-emit the user-visible Markdown copy for a single summary entry from
	 * the hidden `.jolli/summaries/<hash>.json` source. Used to recover head
	 * (`parentCommitHash == null`) `.md` files that were erroneously deleted by
	 * 0.99.2's inverted leaf-only cleanup. Does NOT touch hidden JSON, index,
	 * or orphan-branch state.
	 *
	 * Returns true when a `.md` was (re)written, false when the hidden JSON
	 * source is missing (cannot regenerate). The implementation is allowed to
	 * skip when the target `.md` already exists on disk; callers must not
	 * depend on whether a write actually happened (idempotent contract).
	 *
	 * Optional: implemented by FolderStorage and delegated by DualWriteStorage.
	 * OrphanBranchStorage does not implement it (no visible layer).
	 */
	regenerateVisibleMarkdown?(entry: SummaryIndexEntry): Promise<boolean>;
}
