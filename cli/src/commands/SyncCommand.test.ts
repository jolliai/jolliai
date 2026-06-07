import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncRoundResult } from "../sync/SyncTypes.js";
import { registerSyncCommand } from "./SyncCommand.js";

const {
	mockLoadConfig,
	mockBuildSyncEngine,
	mockOrphanExists,
	mockReadMigrationState,
	mockRunMigration,
	mockRunStaleChildCleanup,
	mockResolveKBPath,
} = vi.hoisted(() => ({
	mockLoadConfig: vi.fn(),
	mockBuildSyncEngine: vi.fn(),
	mockOrphanExists: vi.fn(() => Promise.resolve(false)),
	mockReadMigrationState: vi.fn(() => null as unknown),
	mockRunMigration: vi.fn(),
	mockRunStaleChildCleanup: vi.fn(),
	mockResolveKBPath: vi.fn(
		(_repoName: string, _remote: string | null, _custom: string | undefined) => "/tmp/fake-kb-root",
	),
}));

vi.mock("../core/SessionTracker.js", async () => ({
	loadConfig: mockLoadConfig,
}));

vi.mock("../sync/SyncBootstrap.js", () => ({
	buildSyncEngine: mockBuildSyncEngine,
}));

vi.mock("../core/KBPathResolver.js", () => ({
	extractRepoName: () => "fake-repo",
	getRemoteUrl: () => null,
	resolveKBPath: mockResolveKBPath,
}));

vi.mock("../core/OrphanBranchStorage.js", () => ({
	OrphanBranchStorage: class {
		exists() {
			return mockOrphanExists();
		}
	},
}));

vi.mock("../core/MetadataManager.js", () => ({
	MetadataManager: class {
		readMigrationState() {
			return mockReadMigrationState();
		}
	},
}));

vi.mock("../core/FolderStorage.js", () => ({
	FolderStorage: class {
		async ensure() {
			/* no-op in tests */
		}
	},
}));

vi.mock("../core/MigrationEngine.js", () => ({
	MigrationEngine: class {
		async runMigration() {
			return mockRunMigration();
		}
		async runStaleChildCleanup() {
			return mockRunStaleChildCleanup();
		}
	},
}));

vi.mock("../Logger.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../Logger.js")>();
	return {
		...actual,
		setLogDir: vi.fn(),
		createLogger: () => ({
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		}),
	};
});

function makeProgram(): Command {
	const program = new Command();
	program.exitOverride();
	registerSyncCommand(program);
	return program;
}

async function runCommand(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
	let stdout = "";
	let stderr = "";
	const origLog = console.log;
	const origErr = console.error;
	const origExitCode = process.exitCode;
	process.exitCode = undefined;
	console.log = (msg: string) => {
		stdout += `${msg}\n`;
	};
	console.error = (msg: string) => {
		stderr += `${msg}\n`;
	};
	try {
		await makeProgram().parseAsync(["node", "jolli", "sync-memory-bank", ...args]);
	} finally {
		console.log = origLog;
		console.error = origErr;
	}
	const exitCode = process.exitCode;
	process.exitCode = origExitCode;
	return { stdout, stderr, exitCode };
}

function fakeResult(overrides: Partial<SyncRoundResult> = {}): SyncRoundResult {
	return {
		fetched: true,
		pulled: false,
		pushed: true,
		conflicts: [],
		newState: "synced",
		...overrides,
	};
}

beforeEach(() => {
	mockLoadConfig.mockReset();
	mockBuildSyncEngine.mockReset();
	mockOrphanExists.mockReset();
	mockOrphanExists.mockResolvedValue(false);
	mockReadMigrationState.mockReset();
	mockReadMigrationState.mockReturnValue(null);
	mockRunMigration.mockReset();
	mockRunMigration.mockResolvedValue({ status: "completed", migratedEntries: 0, totalEntries: 0 });
	mockRunStaleChildCleanup.mockReset();
	mockRunStaleChildCleanup.mockResolvedValue({
		staleChildCleanup: { completedAt: "2026-05-22T00:00:00Z" },
		swept: 0,
	});
	mockResolveKBPath.mockClear();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("registerSyncCommand", () => {
	it("refuses to run without a Jolli sign-in", async () => {
		mockLoadConfig.mockResolvedValue({});
		const { stderr, exitCode } = await runCommand([]);
		expect(stderr).toContain("Sync requires a Jolli sign-in");
		expect(exitCode).toBe(1);
		expect(mockBuildSyncEngine).not.toHaveBeenCalled();
	});

	it("treats a null engine as dormant", async () => {
		mockLoadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x" });
		mockBuildSyncEngine.mockResolvedValue(null);
		const { stderr, exitCode } = await runCommand([]);
		expect(stderr).toContain("Sync dormant");
		expect(exitCode).toBe(1);
	});

	it("runs a manual round and reports synced state", async () => {
		mockLoadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x" });
		const runRound = vi.fn().mockResolvedValue(fakeResult());
		mockBuildSyncEngine.mockResolvedValue({ runRound });
		const { stdout, exitCode } = await runCommand([]);
		expect(runRound).toHaveBeenCalledWith(expect.objectContaining({ reason: "manual", transcripts: false }));
		expect(stdout).toContain("Synced.");
		expect(exitCode).toBeUndefined();
	});

	it("honors --transcripts override regardless of config", async () => {
		mockLoadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x", syncTranscripts: false });
		const runRound = vi.fn().mockResolvedValue(fakeResult());
		mockBuildSyncEngine.mockResolvedValue({ runRound });
		await runCommand(["--transcripts"]);
		expect(runRound).toHaveBeenCalledWith(expect.objectContaining({ transcripts: true }));
	});

	it("uses syncTranscripts config when --transcripts not passed", async () => {
		mockLoadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x", syncTranscripts: true });
		const runRound = vi.fn().mockResolvedValue(fakeResult());
		mockBuildSyncEngine.mockResolvedValue({ runRound });
		await runCommand([]);
		expect(runRound).toHaveBeenCalledWith(expect.objectContaining({ transcripts: true }));
	});

	it("reports conflicts as exit 0 and lists the unresolved paths", async () => {
		mockLoadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x" });
		const runRound = vi.fn().mockResolvedValue(
			fakeResult({
				newState: "conflicts",
				conflicts: [{ path: "a.md", tier: 3, detectedAt: "2026-05-21T00:00:00Z" }],
			}),
		);
		mockBuildSyncEngine.mockResolvedValue({ runRound });
		const { stdout, exitCode } = await runCommand([]);
		expect(stdout).toContain("1 unresolved conflict");
		expect(stdout).toContain("a.md");
		expect(stdout).toContain("re-run `jolli sync-memory-bank`");
		expect(exitCode).toBeUndefined();
	});

	it("reports offline state with the error code from the engine", async () => {
		mockLoadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x" });
		const runRound = vi.fn().mockResolvedValue(
			fakeResult({
				newState: "offline",
				lastError: { code: "network", message: "DNS resolution failed" },
			}),
		);
		mockBuildSyncEngine.mockResolvedValue({ runRound });
		const { stderr, exitCode } = await runCommand([]);
		expect(stderr).toContain("Sync failed (network)");
		expect(stderr).toContain("DNS resolution failed");
		expect(exitCode).toBe(1);
	});

	it("uses fallback messages when offline state lacks lastError", async () => {
		mockLoadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x" });
		const runRound = vi.fn().mockResolvedValue(fakeResult({ newState: "offline" }));
		mockBuildSyncEngine.mockResolvedValue({ runRound });
		const { stderr, exitCode } = await runCommand([]);
		expect(stderr).toContain("Sync failed (unknown)");
		expect(stderr).toContain("no error message");
		expect(exitCode).toBe(1);
	});

	it("reports lock contention (syncing state) as a non-error skip", async () => {
		mockLoadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x" });
		const runRound = vi.fn().mockResolvedValue(fakeResult({ newState: "syncing" }));
		mockBuildSyncEngine.mockResolvedValue({ runRound });
		const { stdout, exitCode } = await runCommand([]);
		expect(stdout).toContain("already in flight");
		expect(exitCode).toBeUndefined();
	});

	it("surfaces buildSyncEngine throws as a 1 exit", async () => {
		mockLoadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x" });
		mockBuildSyncEngine.mockRejectedValue(new Error("boom"));
		const { stderr, exitCode } = await runCommand([]);
		expect(stderr).toContain("Sync aborted");
		expect(stderr).toContain("boom");
		expect(exitCode).toBe(1);
	});

	it("surfaces runRound throws as a 1 exit", async () => {
		mockLoadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x" });
		const runRound = vi.fn().mockRejectedValue(new Error("kaboom"));
		mockBuildSyncEngine.mockResolvedValue({ runRound });
		const { stderr, exitCode } = await runCommand([]);
		expect(stderr).toContain("Sync failed");
		expect(stderr).toContain("kaboom");
		expect(exitCode).toBe(1);
	});

	describe("ensureKBInitAndMigrated wiring (P3#7)", () => {
		it("claims the KB folder for the repo before building the engine", async () => {
			mockLoadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x", localFolder: "/custom/folder" });
			const runRound = vi.fn().mockResolvedValue(fakeResult());
			mockBuildSyncEngine.mockResolvedValue({ runRound });
			await runCommand([]);
			// Pass-through of `localFolder` from config means custom paths
			// route through `resolveKBPath` (validated via `resolveKbParent`).
			expect(mockResolveKBPath).toHaveBeenCalledWith("fake-repo", null, "/custom/folder");
		});

		it("runs full migration when orphan branch has data and migration has not completed", async () => {
			mockLoadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x" });
			mockOrphanExists.mockResolvedValue(true);
			mockReadMigrationState.mockReturnValue(null);
			const runRound = vi.fn().mockResolvedValue(fakeResult());
			mockBuildSyncEngine.mockResolvedValue({ runRound });
			await runCommand([]);
			expect(mockRunMigration).toHaveBeenCalled();
			expect(mockRunStaleChildCleanup).not.toHaveBeenCalled();
		});

		it("runs stale-child cleanup when migration completed but cleanup did not", async () => {
			mockLoadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x" });
			mockOrphanExists.mockResolvedValue(true);
			mockReadMigrationState.mockReturnValue({ status: "completed" });
			const runRound = vi.fn().mockResolvedValue(fakeResult());
			mockBuildSyncEngine.mockResolvedValue({ runRound });
			await runCommand([]);
			expect(mockRunMigration).not.toHaveBeenCalled();
			expect(mockRunStaleChildCleanup).toHaveBeenCalled();
		});

		it("skips both passes when no orphan branch exists (fresh CLI install)", async () => {
			mockLoadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x" });
			mockOrphanExists.mockResolvedValue(false);
			const runRound = vi.fn().mockResolvedValue(fakeResult());
			mockBuildSyncEngine.mockResolvedValue({ runRound });
			await runCommand([]);
			expect(mockRunMigration).not.toHaveBeenCalled();
			expect(mockRunStaleChildCleanup).not.toHaveBeenCalled();
		});

		// The stale-child reconcile is recurring, not one-shot: an already-set
		// completedAt stamp must NOT skip it. The stamp only retires the inner
		// 0.99.2 head-regen — the sweep still runs so children hoisted on dormant
		// branches get their orphaned visible .md cleaned on every sync.
		it("still runs stale-child reconcile when completedAt is already set (does not migrate)", async () => {
			mockLoadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x" });
			mockOrphanExists.mockResolvedValue(true);
			mockReadMigrationState.mockReturnValue({
				status: "completed",
				staleChildCleanup: { completedAt: "2026-05-22T00:00:00Z" },
			});
			const runRound = vi.fn().mockResolvedValue(fakeResult());
			mockBuildSyncEngine.mockResolvedValue({ runRound });
			await runCommand([]);
			expect(mockRunMigration).not.toHaveBeenCalled();
			expect(mockRunStaleChildCleanup).toHaveBeenCalled();
		});

		it("warns but continues when migration throws — the round still tries to sync", async () => {
			mockLoadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x" });
			mockOrphanExists.mockResolvedValue(true);
			mockReadMigrationState.mockReturnValue(null);
			mockRunMigration.mockRejectedValue(new Error("disk full"));
			const runRound = vi.fn().mockResolvedValue(fakeResult());
			mockBuildSyncEngine.mockResolvedValue({ runRound });
			const { stderr, exitCode } = await runCommand([]);
			expect(stderr).toContain("partial failure");
			expect(stderr).toContain("disk full");
			expect(runRound).toHaveBeenCalled();
			expect(exitCode).toBeUndefined();
		});
	});
});
