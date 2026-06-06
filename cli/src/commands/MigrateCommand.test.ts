import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMigrateCommand } from "./MigrateCommand.js";

// All heavy dependencies are mocked so the command never touches a real repo,
// orphan branch, or ~/.jolli config. Each test installs its own behavior.
const {
	mockHasMigrationMeta,
	mockMigrateV1toV3,
	mockWriteMigrationMeta,
	mockIndexNeedsMigration,
	mockMigrateIndexToV3,
	mockMigrateSchemaToV5,
	mockLogError,
} = vi.hoisted(() => ({
	mockHasMigrationMeta: vi.fn(),
	mockMigrateV1toV3: vi.fn(),
	mockWriteMigrationMeta: vi.fn(),
	mockIndexNeedsMigration: vi.fn(),
	mockMigrateIndexToV3: vi.fn(),
	mockMigrateSchemaToV5: vi.fn(),
	mockLogError: vi.fn(),
}));

vi.mock("../core/SummaryMigration.js", () => ({
	hasMigrationMeta: mockHasMigrationMeta,
	migrateV1toV3: mockMigrateV1toV3,
	writeMigrationMeta: mockWriteMigrationMeta,
}));

vi.mock("../core/SummaryStore.js", () => ({
	indexNeedsMigration: mockIndexNeedsMigration,
	migrateIndexToV3: mockMigrateIndexToV3,
}));

vi.mock("../core/SchemaV5Migration.js", () => ({
	migrateSchemaToV5: mockMigrateSchemaToV5,
}));

vi.mock("../Logger.js", () => ({
	setLogDir: vi.fn(),
	createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: mockLogError, debug: vi.fn() }),
}));

vi.mock("./CliUtils.js", () => ({
	resolveProjectDir: () => "/repo",
}));

function makeProgram(): Command {
	const program = new Command();
	program.exitOverride();
	registerMigrateCommand(program);
	return program;
}

async function runMigrate(args: string[]): Promise<{ stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const origLog = console.log;
	const origErr = console.error;
	console.log = (...msgs: unknown[]) => {
		stdout += `${msgs.map(String).join(" ")}\n`;
	};
	console.error = (...msgs: unknown[]) => {
		stderr += `${msgs.map(String).join(" ")}\n`;
	};
	try {
		await makeProgram().parseAsync(["node", "jolli", "migrate", ...args]);
	} finally {
		console.log = origLog;
		console.error = origErr;
	}
	return { stdout, stderr };
}

describe("registerMigrateCommand", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Sensible defaults: nothing migrated, everything already in place.
		mockHasMigrationMeta.mockResolvedValue(false);
		mockMigrateV1toV3.mockResolvedValue({ migrated: 0, skipped: 0 });
		mockWriteMigrationMeta.mockResolvedValue(undefined);
		mockIndexNeedsMigration.mockResolvedValue(false);
		mockMigrateIndexToV3.mockResolvedValue({ migrated: 0, skipped: 0 });
		mockMigrateSchemaToV5.mockResolvedValue({ alreadyDone: false, fresh: false, migrated: 0, skipped: 0 });
	});

	afterEach(() => {
		process.exitCode = undefined;
	});

	// ----- Step 1: orphan branch v1 -> v3 -----

	it("Step 1 (already migrated): prints retained message and skips migrateV1toV3", async () => {
		mockHasMigrationMeta.mockResolvedValue(true);
		const { stdout } = await runMigrate([]);
		expect(stdout).toContain("Orphan branch migration already completed");
		expect(mockMigrateV1toV3).not.toHaveBeenCalled();
		expect(mockWriteMigrationMeta).not.toHaveBeenCalled();
	});

	it("Step 1 (fresh, nothing found): prints 'No summaries found' and does not write meta", async () => {
		mockMigrateV1toV3.mockResolvedValue({ migrated: 0, skipped: 0 });
		const { stdout } = await runMigrate([]);
		expect(stdout).toContain("Step 1: Migrating orphan branch");
		expect(stdout).toContain("No summaries found in v1 branch.");
		expect(stdout).not.toContain("summaries converted to tree format");
		expect(stdout).not.toContain("summaries (already in tree format or unparseable)");
		expect(mockWriteMigrationMeta).not.toHaveBeenCalled();
	});

	it("Step 1 (migrated only): prints migrated count, writes meta and retention notice", async () => {
		mockMigrateV1toV3.mockResolvedValue({ migrated: 4, skipped: 0 });
		const { stdout } = await runMigrate([]);
		expect(stdout).toContain("Migrated: 4 summaries converted to tree format");
		expect(stdout).not.toContain("summaries (already in tree format or unparseable)");
		expect(stdout).toContain("V1 branch retained for 48 hours");
		expect(mockWriteMigrationMeta).toHaveBeenCalledWith("/repo");
	});

	it("Step 1 (skipped only): prints skipped count and still writes meta", async () => {
		mockMigrateV1toV3.mockResolvedValue({ migrated: 0, skipped: 7 });
		const { stdout } = await runMigrate([]);
		expect(stdout).toContain("Skipped:  7 summaries (already in tree format or unparseable)");
		expect(stdout).not.toContain("summaries converted to tree format");
		expect(stdout).toContain("V1 branch retained for 48 hours");
		expect(mockWriteMigrationMeta).toHaveBeenCalledOnce();
	});

	it("Step 1 (both migrated and skipped): prints both counts", async () => {
		mockMigrateV1toV3.mockResolvedValue({ migrated: 2, skipped: 3 });
		const { stdout } = await runMigrate([]);
		expect(stdout).toContain("Migrated: 2 summaries");
		expect(stdout).toContain("Skipped:  3 summaries");
	});

	// ----- Step 2: index v1 -> v3 -----

	it("Step 2 (index already v3): prints 'already in v3' and skips migrateIndexToV3", async () => {
		mockIndexNeedsMigration.mockResolvedValue(false);
		const { stdout } = await runMigrate([]);
		expect(stdout).toContain("Index is already in v3 flat format.");
		expect(mockMigrateIndexToV3).not.toHaveBeenCalled();
	});

	it("Step 2 (no entries): prints 'No index entries found'", async () => {
		mockIndexNeedsMigration.mockResolvedValue(true);
		mockMigrateIndexToV3.mockResolvedValue({ migrated: 0, skipped: 0 });
		const { stdout } = await runMigrate([]);
		expect(stdout).toContain("No index entries found.");
		expect(mockMigrateIndexToV3).toHaveBeenCalledWith("/repo");
	});

	it("Step 2 (migrated only): prints upgraded count", async () => {
		mockIndexNeedsMigration.mockResolvedValue(true);
		mockMigrateIndexToV3.mockResolvedValue({ migrated: 9, skipped: 0 });
		const { stdout } = await runMigrate([]);
		expect(stdout).toContain("Migrated: 9 index entries upgraded to v3 flat format");
		expect(stdout).not.toMatch(/Skipped:\s+\d entries/);
	});

	it("Step 2 (skipped only): prints skipped count", async () => {
		mockIndexNeedsMigration.mockResolvedValue(true);
		mockMigrateIndexToV3.mockResolvedValue({ migrated: 0, skipped: 5 });
		const { stdout } = await runMigrate([]);
		expect(stdout).toContain("Skipped:  5 entries (summary file missing or unparseable)");
		expect(stdout).not.toContain("index entries upgraded");
	});

	it("Step 2 (both): prints both index counts", async () => {
		mockIndexNeedsMigration.mockResolvedValue(true);
		mockMigrateIndexToV3.mockResolvedValue({ migrated: 3, skipped: 1 });
		const { stdout } = await runMigrate([]);
		expect(stdout).toContain("Migrated: 3 index entries");
		expect(stdout).toContain("Skipped:  1 entries");
	});

	// ----- Step 3: schema v3 -> v4 -> v5 -----

	it("Step 3 (already done): prints 'Already migrated' with prior count", async () => {
		mockMigrateSchemaToV5.mockResolvedValue({ alreadyDone: true, fresh: false, migrated: 12, skipped: 0 });
		const { stdout } = await runMigrate([]);
		expect(stdout).toContain("Already migrated (12 summaries previously upgraded).");
	});

	it("Step 3 (fresh, no orphan branch): prints the post-first-commit notice", async () => {
		mockMigrateSchemaToV5.mockResolvedValue({ alreadyDone: false, fresh: true, migrated: 0, skipped: 0 });
		const { stdout } = await runMigrate([]);
		expect(stdout).toContain("No orphan branch yet — migration will run automatically after the first commit.");
	});

	it("Step 3 (migrated, no skipped): prints upgraded count only", async () => {
		mockMigrateSchemaToV5.mockResolvedValue({ alreadyDone: false, fresh: false, migrated: 8, skipped: 0 });
		const { stdout } = await runMigrate([]);
		expect(stdout).toContain("Migrated: 8 summaries upgraded to v5");
		expect(stdout).not.toMatch(/Skipped:\s+\d summaries \(already v5/);
	});

	it("Step 3 (migrated with skipped): prints both counts", async () => {
		mockMigrateSchemaToV5.mockResolvedValue({ alreadyDone: false, fresh: false, migrated: 8, skipped: 2 });
		const { stdout } = await runMigrate([]);
		expect(stdout).toContain("Migrated: 8 summaries upgraded to v5");
		expect(stdout).toContain("Skipped:  2 summaries (already v5 or unparseable)");
	});

	it("Step 3 (failure): reports the error, retry hint, and logs it; does not throw", async () => {
		mockMigrateSchemaToV5.mockRejectedValue(new Error("orphan ref locked"));
		const { stdout, stderr } = await runMigrate([]);
		expect(stderr).toContain("v5 migration failed: orphan ref locked");
		expect(stderr).toContain("Re-run `jolli migrate` to retry; data is unchanged on failure.");
		expect(mockLogError).toHaveBeenCalledWith("v5 migration failed: %s", "orphan ref locked");
		// Command still completes (trailing blank line printed after the catch).
		expect(stdout.endsWith("\n")).toBe(true);
	});

	// ----- Flags / wiring -----

	it("--cwd: threads the explicit dir to every migration step", async () => {
		await runMigrate(["--cwd", "/custom"]);
		expect(mockHasMigrationMeta).toHaveBeenCalledWith("/custom");
		expect(mockIndexNeedsMigration).toHaveBeenCalledWith("/custom");
		expect(mockMigrateSchemaToV5).toHaveBeenCalledWith("/custom");
	});

	it("default --cwd: uses resolveProjectDir() result", async () => {
		await runMigrate([]);
		expect(mockHasMigrationMeta).toHaveBeenCalledWith("/repo");
	});

	it("runs all three steps in order on a full migration path", async () => {
		mockHasMigrationMeta.mockResolvedValue(false);
		mockMigrateV1toV3.mockResolvedValue({ migrated: 1, skipped: 0 });
		mockIndexNeedsMigration.mockResolvedValue(true);
		mockMigrateIndexToV3.mockResolvedValue({ migrated: 1, skipped: 0 });
		mockMigrateSchemaToV5.mockResolvedValue({ alreadyDone: false, fresh: false, migrated: 1, skipped: 0 });
		const { stdout } = await runMigrate([]);
		expect(stdout.indexOf("Step 1")).toBeLessThan(stdout.indexOf("Step 2"));
		expect(stdout.indexOf("Step 2")).toBeLessThan(stdout.indexOf("Step 3"));
	});
});
