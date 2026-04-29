import { ORPHAN_BRANCH } from "../Logger.js";
import type { FileWrite } from "../Types.js";
import {
	ensureOrphanBranch,
	listFilesInBranch,
	orphanBranchExists,
	readFileFromBranch,
	writeMultipleFilesToBranch,
} from "./GitOps.js";
import type { StorageProvider } from "./StorageProvider.js";

export class OrphanBranchStorage implements StorageProvider {
	constructor(private readonly cwd?: string) {}

	async readFile(path: string): Promise<string | null> {
		return readFileFromBranch(ORPHAN_BRANCH, path, this.cwd);
	}

	async writeFiles(files: FileWrite[], message: string): Promise<void> {
		await this.ensure();
		await writeMultipleFilesToBranch(ORPHAN_BRANCH, files, message, this.cwd);
	}

	async listFiles(prefix: string): Promise<string[]> {
		return [...(await listFilesInBranch(ORPHAN_BRANCH, prefix, this.cwd))];
	}

	async exists(): Promise<boolean> {
		return orphanBranchExists(ORPHAN_BRANCH, this.cwd);
	}

	async ensure(): Promise<void> {
		await ensureOrphanBranch(ORPHAN_BRANCH, this.cwd);
	}
}
