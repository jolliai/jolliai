/**
 * DualWriteStorage — StorageProvider that writes to both orphan branch and folder.
 *
 * Primary (OrphanBranchStorage) is the source of truth for reads.
 * Shadow (FolderStorage) receives a copy of every write. Shadow failures
 * are logged as warnings but never block the primary write path.
 */

import { createLogger } from "../Logger.js";
import type { FileWrite } from "../Types.js";
import type { StorageProvider } from "./StorageProvider.js";

const log = createLogger("DualWriteStorage");

export class DualWriteStorage implements StorageProvider {
	constructor(
		private readonly primary: StorageProvider,
		private readonly shadow: StorageProvider,
	) {}

	async readFile(path: string): Promise<string | null> {
		return this.primary.readFile(path);
	}

	// Primary writes first because it's the source of truth (orphan branch).
	// Shadow (folder KB) is best-effort — failures are swallowed so a flaky
	// filesystem never blocks the critical git-based write path.
	async writeFiles(files: FileWrite[], message: string): Promise<void> {
		await this.primary.writeFiles(files, message);
		try {
			await this.shadow.writeFiles(files, message);
			this.shadow.clearDirty?.();
		} catch (e) {
			log.warn("Shadow write failed (folder storage): %s", e instanceof Error ? e.message : String(e));
			this.shadow.markDirty?.(message);
		}
	}

	async listFiles(prefix: string): Promise<string[]> {
		return this.primary.listFiles(prefix);
	}

	async exists(): Promise<boolean> {
		return this.primary.exists();
	}

	async ensure(): Promise<void> {
		await this.primary.ensure();
		try {
			await this.shadow.ensure();
		} catch (e) {
			log.warn("Shadow ensure failed: %s", e instanceof Error ? e.message : String(e));
		}
	}
}
