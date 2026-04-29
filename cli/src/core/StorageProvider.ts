import type { FileWrite } from "../Types.js";

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
}
