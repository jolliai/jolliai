import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderStorage } from "../core/FolderStorage.js";
import * as KBPathResolver from "../core/KBPathResolver.js";
import type { MigrationState } from "../core/KBTypes.js";
import { MetadataManager } from "../core/MetadataManager.js";
import { MigrationEngine } from "../core/MigrationEngine.js";
import { OrphanBranchStorage } from "../core/OrphanBranchStorage.js";
import * as SessionTracker from "../core/SessionTracker.js";
import { registerMigrateMemoryBankCommand, runMemoryBankMigration } from "./MigrateMemoryBankCommand.js";

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

/** Runs `jolli migrate-memory-bank` capturing stdout. */
async function run(): Promise<string> {
	const logs: string[] = [];
	vi.spyOn(console, "log").mockImplementation((m?: unknown) => void logs.push(String(m)));
	const program = new Command();
	registerMigrateMemoryBankCommand(program);
	await program.parseAsync(["node", "jolli", "migrate-memory-bank", "--cwd", "/repo"]);
	return logs.join("\n");
}

describe("migrate-memory-bank command", () => {
	it("prints the migration result as a single JSON line", async () => {
		stubResolution();
		vi.spyOn(OrphanBranchStorage.prototype, "exists").mockResolvedValue(false);

		const out = await run();

		expect(JSON.parse(out)).toEqual({
			type: "migrate-memory-bank",
			status: "completed",
			totalEntries: 0,
			migratedEntries: 0,
		});
		expect(process.exitCode).toBe(0);
	});

	it("prints a JSON error and sets exit code 1 when migration throws", async () => {
		stubResolution();
		vi.spyOn(OrphanBranchStorage.prototype, "exists").mockResolvedValue(true);
		vi.spyOn(MetadataManager.prototype, "readMigrationState").mockReturnValue(null);
		vi.spyOn(MigrationEngine.prototype, "runMigration").mockRejectedValue(new TypeError("index.json corrupt"));

		const out = await run();

		expect(JSON.parse(out)).toEqual({
			type: "error",
			message: "index.json corrupt",
			errorName: "TypeError",
		});
		expect(process.exitCode).toBe(1);
	});
});
