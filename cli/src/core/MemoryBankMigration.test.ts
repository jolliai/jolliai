import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderStorage } from "./FolderStorage.js";
import * as KBPathResolver from "./KBPathResolver.js";
import type { MigrationState } from "./KBTypes.js";
import { runMemoryBankMigration } from "./MemoryBankMigration.js";
import { MetadataManager } from "./MetadataManager.js";
import { MigrationEngine } from "./MigrationEngine.js";
import { OrphanBranchStorage } from "./OrphanBranchStorage.js";
import * as SessionTracker from "./SessionTracker.js";

/** Stubs path resolution + config so no real repo/config is touched. */
function stubResolution(localFolder?: string): void {
	vi.spyOn(SessionTracker, "loadConfig").mockResolvedValue({ localFolder });
	vi.spyOn(KBPathResolver, "extractRepoName").mockReturnValue("myrepo");
	vi.spyOn(KBPathResolver, "getRemoteUrl").mockReturnValue("git@github.com:acme/myrepo.git");
	vi.spyOn(KBPathResolver, "resolveKBPath").mockReturnValue("/kb/myrepo");
}

beforeEach(() => {
	process.exitCode = 0;
	// FolderStorage.ensure() is a filesystem side effect the unit test must not run.
	vi.spyOn(FolderStorage.prototype, "ensure").mockResolvedValue(undefined);
});
afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
});

describe("runMemoryBankMigration", () => {
	it("reports an empty completed run when there is no orphan branch", async () => {
		stubResolution();
		vi.spyOn(OrphanBranchStorage.prototype, "exists").mockResolvedValue(false);
		const runMigration = vi.spyOn(MigrationEngine.prototype, "runMigration");

		const result = await runMemoryBankMigration("/repo");

		expect(result).toEqual({ status: "completed", totalEntries: 0, migratedEntries: 0 });
		expect(runMigration).not.toHaveBeenCalled();
	});

	it("runs a full migration when migration state is absent", async () => {
		stubResolution("/custom/bank");
		vi.spyOn(OrphanBranchStorage.prototype, "exists").mockResolvedValue(true);
		vi.spyOn(MetadataManager.prototype, "readMigrationState").mockReturnValue(null);
		const runMigration = vi
			.spyOn(MigrationEngine.prototype, "runMigration")
			.mockResolvedValue({ status: "completed", totalEntries: 4, migratedEntries: 4 } as MigrationState);
		const reconcile = vi.spyOn(MigrationEngine.prototype, "runStaleChildCleanup");

		const result = await runMemoryBankMigration("/repo");

		expect(result).toEqual({ status: "completed", totalEntries: 4, migratedEntries: 4 });
		expect(runMigration).toHaveBeenCalledOnce();
		expect(reconcile).not.toHaveBeenCalled();
	});

	it("runs a full migration when a prior run did not complete", async () => {
		stubResolution();
		vi.spyOn(OrphanBranchStorage.prototype, "exists").mockResolvedValue(true);
		vi.spyOn(MetadataManager.prototype, "readMigrationState").mockReturnValue({
			status: "in_progress",
			totalEntries: 10,
			migratedEntries: 2,
		} as MigrationState);
		const runMigration = vi
			.spyOn(MigrationEngine.prototype, "runMigration")
			.mockResolvedValue({ status: "partial", totalEntries: 10, migratedEntries: 9 } as MigrationState);

		const result = await runMemoryBankMigration("/repo");

		expect(result).toEqual({ status: "partial", totalEntries: 10, migratedEntries: 9 });
		expect(runMigration).toHaveBeenCalledOnce();
	});

	it("runs the idempotent stale-child reconcile when already completed", async () => {
		stubResolution();
		vi.spyOn(OrphanBranchStorage.prototype, "exists").mockResolvedValue(true);
		vi.spyOn(MetadataManager.prototype, "readMigrationState").mockReturnValue({
			status: "completed",
			totalEntries: 7,
			migratedEntries: 7,
		} as MigrationState);
		const runMigration = vi.spyOn(MigrationEngine.prototype, "runMigration");
		const reconcile = vi
			.spyOn(MigrationEngine.prototype, "runStaleChildCleanup")
			.mockResolvedValue({ status: "completed", totalEntries: 7, migratedEntries: 7, swept: 0 });

		const result = await runMemoryBankMigration("/repo");

		expect(result).toEqual({ status: "completed", totalEntries: 7, migratedEntries: 7 });
		expect(runMigration).not.toHaveBeenCalled();
		expect(reconcile).toHaveBeenCalledOnce();
	});
});
