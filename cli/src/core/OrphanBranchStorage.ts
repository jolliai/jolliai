import { isManuallyDisabled, ORPHAN_BRANCH } from "../Logger.js";
import type { FileWrite } from "../Types.js";
import {
	batchReadFilesFromBranch,
	ensureOrphanBranch,
	listFilesInBranch,
	orphanBranchExists,
	readFileFromBranch,
	writeMultipleFilesToBranch,
} from "./GitOps.js";
import { readCutoverFence } from "./RepoProfile.js";
import type { StorageKind, StorageProvider } from "./StorageProvider.js";

export class OrphanBranchStorage implements StorageProvider {
	readonly kind: StorageKind = "orphan-branch";

	constructor(private readonly cwd?: string) {}

	async readFile(path: string): Promise<string | null> {
		return readFileFromBranch(ORPHAN_BRANCH, path, this.cwd);
	}

	async batchReadFiles(paths: ReadonlyArray<string>): Promise<Map<string, string | null>> {
		return batchReadFilesFromBranch(ORPHAN_BRANCH, paths, this.cwd);
	}

	async writeFiles(files: FileWrite[], message: string): Promise<void> {
		if (isManuallyDisabled()) return;
		// The write-time fence check — the D6 invariant's last line. Routing
		// (createStorage) already keeps NEW storage objects off a fenced repo,
		// but long-lived processes (the VS Code host, the MCP server, a worker
		// started before the fence) hold THIS object for their lifetime, and a
		// cache invalidation can never close that window. Reading the fence
		// from disk here, immediately before the plumbing write, means a write
		// racing the cutover either lands before the CAS's tip check (which
		// then retries and imports it) or fails loudly here — never silently
		// onto the frozen branch after commit.
		const fence = await readCutoverFence(this.cwd ?? process.cwd()).catch(() => null);
		if (fence !== null) {
			throw new Error(
				"orphan branch is frozen (cutover fence in place) — this process holds a pre-cutover storage " +
					"object; restart it so writes route to the database",
			);
		}
		// Second witness, because the fence is PER-CLONE: a checkout of the same
		// remote that the cutover never enumerated (or a clone made after it)
		// carries no fence, yet a write here would land on an orphan branch
		// nothing will ever read again — post-CAS reads resolve to the database
		// by the shared identity. The CAS row is the one trace such a clone can
		// see. Quiet and fail-open (`false` when the database cannot answer): an
		// unfenced repo must never be blocked by a missing or broken database.
		const { hasCutoverRow } = await import("../dashboard/CutoverRouter.js");
		if (await hasCutoverRow(this.cwd ?? process.cwd()).catch(() => false)) {
			throw new Error(
				"orphan branch is retired for this repository (cutover committed) — writes route to the " +
					"database; re-run the operation from an up-to-date surface",
			);
		}
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
