import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("./SessionTracker.js", () => ({
	loadConfig: vi.fn(),
}));

vi.mock("../dashboard/CutoverRouter.js", () => ({
	resolveCutoverRoute: vi.fn().mockResolvedValue({ state: "uncutover" }),
}));

vi.mock("../dashboard/RepoRegistry.js", () => ({
	resolveRepoIdentity: vi.fn().mockResolvedValue({ identity: "https://github.com/test/repo.git" }),
	resolveRepoIdentityForCwd: vi.fn().mockResolvedValue({ identity: "https://github.com/test/repo.git" }),
}));

vi.mock("./SqliteStorage.js", () => {
	const SqliteStorage = vi.fn();
	SqliteStorage.prototype.type = "sqlite";
	return { SqliteStorage };
});

vi.mock("./KBPathResolver.js", () => ({
	extractRepoName: vi.fn().mockReturnValue("test-repo"),
	getRemoteUrl: vi.fn().mockReturnValue("https://github.com/test/repo.git"),
	resolveKBPath: vi.fn().mockReturnValue("/tmp/kb-test"),
	initializeKBFolder: vi.fn(),
	// Claimable by default; the gate's own conditions are covered in
	// KBPathResolver.test.ts against real git worktrees.
	isClaimableProject: vi.fn().mockReturnValue(true),
}));

vi.mock("./MetadataManager.js", () => {
	const MetadataManager = vi.fn();
	return { MetadataManager };
});

vi.mock("./OrphanBranchStorage.js", () => {
	const OrphanBranchStorage = vi.fn();
	OrphanBranchStorage.prototype.type = "orphan";
	return { OrphanBranchStorage };
});

vi.mock("./FolderStorage.js", () => {
	const FolderStorage = vi.fn();
	FolderStorage.prototype.type = "folder";
	return { FolderStorage };
});

vi.mock("./DualWriteStorage.js", () => {
	const DualWriteStorage = vi.fn();
	DualWriteStorage.prototype.type = "dual-write";
	return { DualWriteStorage };
});

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

import { resolveCutoverRoute } from "../dashboard/CutoverRouter.js";
import { DualWriteStorage } from "./DualWriteStorage.js";
import { FolderStorage } from "./FolderStorage.js";
import { MetadataManager } from "./MetadataManager.js";
import { OrphanBranchStorage } from "./OrphanBranchStorage.js";
import { loadConfig } from "./SessionTracker.js";
import { SqliteStorage } from "./SqliteStorage.js";
import { createFolderStorageAtRoot, createStorage } from "./StorageFactory.js";

const mockLoadConfig = vi.mocked(loadConfig);

describe("StorageFactory", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(resolveCutoverRoute).mockResolvedValue({ state: "uncutover" });
	});

	it("returns DualWriteStorage when no storageMode is configured (default)", async () => {
		mockLoadConfig.mockResolvedValue({});

		const storage = await createStorage("/project/path");

		expect(DualWriteStorage).toHaveBeenCalledOnce();
		expect((storage as unknown as Record<string, unknown>).type).toBe("dual-write");
	});

	it("ignores a residual storageMode — the key is retired, routing decides", async () => {
		// "orphan" and "folder" both revert to the uncutover default
		// (dual-write) until this repo cuts over; folder-only meant the
		// memories were never in the source of truth anyway.
		for (const residual of ["orphan", "folder"]) {
			vi.clearAllMocks();
			vi.mocked(resolveCutoverRoute).mockResolvedValue({ state: "uncutover" });
			mockLoadConfig.mockResolvedValue({ storageMode: residual } as unknown as Awaited<
				ReturnType<typeof loadConfig>
			>);
			const storage = await createStorage("/project/path");
			expect((storage as unknown as Record<string, unknown>).type).toBe("dual-write");
		}
	});

	it("routes legacy-fenced and cutover to SqliteStorage + the visible-layer renderer", async () => {
		for (const state of ["legacy-fenced", "cutover"] as const) {
			vi.clearAllMocks();
			vi.mocked(resolveCutoverRoute).mockResolvedValue(
				state === "cutover"
					? { state, record: { tips: {}, cutoverVersion: 1, committedAt: "t", schemaVersion: 1 } }
					: { state },
			);
			mockLoadConfig.mockResolvedValue({});
			const kbResolver = await import("./KBPathResolver.js");
			(kbResolver.isClaimableProject as ReturnType<typeof vi.fn>).mockReturnValue(true);
			const storage = await createStorage("/project/path");
			expect(SqliteStorage).toHaveBeenCalledWith("https://github.com/test/repo.git");
			// Dual-write is invariant across the cutover: the folder side is the
			// SAME full FolderStorage the uncutover route builds (hidden JSON
			// included — the layer sync, the IntelliJ reader and mirror recovery
			// consume), only the system of record changed. The frozen branch is
			// never touched.
			expect((storage as unknown as Record<string, unknown>).type).toBe("dual-write");
			expect(FolderStorage).toHaveBeenCalledWith(expect.anything(), expect.anything());
			expect(OrphanBranchStorage).not.toHaveBeenCalled();
		}
	});

	it("fenced route without a claimable project stays SqliteStorage-only", async () => {
		vi.mocked(resolveCutoverRoute).mockResolvedValue({ state: "legacy-fenced" });
		mockLoadConfig.mockResolvedValue({});
		const kbResolver = await import("./KBPathResolver.js");
		(kbResolver.isClaimableProject as ReturnType<typeof vi.fn>).mockReturnValue(false);
		try {
			const storage = await createStorage("/var/folders/xx/jolli-localagent-abc123");
			expect((storage as unknown as Record<string, unknown>).type).toBe("sqlite");
			expect(kbResolver.resolveKBPath).not.toHaveBeenCalled();
		} finally {
			(kbResolver.isClaimableProject as ReturnType<typeof vi.fn>).mockReturnValue(true);
		}
	});

	it("throws on blocked — a fenced repo with no database has nowhere safe to write", async () => {
		vi.mocked(resolveCutoverRoute).mockResolvedValue({ state: "blocked", reason: "database file does not exist" });
		mockLoadConfig.mockResolvedValue({});
		await expect(createStorage("/project/path")).rejects.toThrow(/doctor --recover/);
		expect(OrphanBranchStorage).not.toHaveBeenCalled();
	});

	it("resolves the KB path via resolveKBPath (which claims identity internally)", async () => {
		// Regression for the phantom-`<repo>-2` bug: `resolveKBPath` is now
		// atomic — it both picks the path AND writes identity to
		// `.jolli/config.json`. StorageFactory no longer needs an explicit
		// follow-up `initializeKBFolder` call; verifying `resolveKBPath` is
		// invoked with the repo identity is what pins this contract.
		mockLoadConfig.mockResolvedValue({});
		const kbResolver = await import("./KBPathResolver.js");
		(kbResolver.resolveKBPath as ReturnType<typeof vi.fn>).mockClear();

		await createStorage("/project/path");

		expect(kbResolver.resolveKBPath).toHaveBeenCalledWith(
			"test-repo",
			"https://github.com/test/repo.git",
			undefined,
		);
	});

	it("falls back to DualWriteStorage with warning when loadConfig fails", async () => {
		const warnSpy = vi.spyOn(console, "warn");
		mockLoadConfig.mockRejectedValue(new Error("config file corrupt"));

		const storage = await createStorage("/project/path");

		expect(DualWriteStorage).toHaveBeenCalledOnce();
		expect((storage as unknown as Record<string, unknown>).type).toBe("dual-write");
		// Verify that a warning was logged (our Logger writes to console.warn)
		expect(warnSpy).toHaveBeenCalled();
	});

	// Write-boundary gate. Before it existed, a nested agent's throwaway temp cwd
	// (or the Memory Bank folder itself) reached resolveKBPath and permanently
	// claimed `<localFolder>/<tempDirBasename>/` — 136 such folders accumulated
	// from local-agent summary calls alone.
	describe("non-claimable project degrades to orphan-only", () => {
		// `vi.clearAllMocks()` clears calls but keeps implementations, so a
		// `mockReturnValue(false)` set here would leak into later tests.
		afterEach(async () => {
			const kbResolver = await import("./KBPathResolver.js");
			(kbResolver.isClaimableProject as ReturnType<typeof vi.fn>).mockReturnValue(true);
		});

		async function withUnclaimable(): Promise<typeof import("./KBPathResolver.js")> {
			const kbResolver = await import("./KBPathResolver.js");
			(kbResolver.isClaimableProject as ReturnType<typeof vi.fn>).mockReturnValue(false);
			return kbResolver;
		}

		it("returns OrphanBranchStorage instead of DualWriteStorage", async () => {
			mockLoadConfig.mockResolvedValue({});
			const kbResolver = await withUnclaimable();

			const storage = await createStorage("/var/folders/xx/jolli-localagent-abc123");

			expect((storage as unknown as Record<string, unknown>).type).toBe("orphan");
			expect(DualWriteStorage).not.toHaveBeenCalled();
			// The claim never happens — nothing is written, so there is nothing to
			// clean up afterwards. This is the assertion that pins the whole fix.
			expect(kbResolver.resolveKBPath).not.toHaveBeenCalled();
			expect(FolderStorage).not.toHaveBeenCalled();
		});

		it("consults the gate on the SQLite routes before pairing the renderer", async () => {
			vi.mocked(resolveCutoverRoute).mockResolvedValue({ state: "legacy-fenced" });
			mockLoadConfig.mockResolvedValue({});
			const kbResolver = await import("./KBPathResolver.js");
			(kbResolver.isClaimableProject as ReturnType<typeof vi.fn>).mockClear();

			await createStorage("/project/path");

			expect(kbResolver.isClaimableProject).toHaveBeenCalled();
		});

		it("passes the configured localFolder to the gate so the nested-bank case is detectable", async () => {
			mockLoadConfig.mockResolvedValue({
				localFolder: "/Users/me/Documents/bank",
			} as unknown as Awaited<ReturnType<typeof loadConfig>>);
			const kbResolver = await import("./KBPathResolver.js");
			(kbResolver.isClaimableProject as ReturnType<typeof vi.fn>).mockReturnValue(true);

			await createStorage("/Users/me/Documents/bank");

			expect(kbResolver.isClaimableProject).toHaveBeenCalledWith(
				"/Users/me/Documents/bank",
				"/Users/me/Documents/bank",
			);
		});
	});

	it("createFolderStorageAtRoot builds a folder-only FolderStorage at the explicit kbRoot", async () => {
		// Multi-repo compile sweep path: the target repo has no git working tree,
		// so the kbRoot is passed in directly without going through
		// extractRepoName / getRemoteUrl / resolveKBPath.
		const kbResolver = await import("./KBPathResolver.js");

		const storage = createFolderStorageAtRoot("/explicit/kb/root");

		expect(FolderStorage).toHaveBeenCalledOnce();
		expect((storage as unknown as Record<string, unknown>).type).toBe("folder");
		// MetadataManager is constructed against the `<kbRoot>/.jolli` subfolder.
		// Built with `join` so the separator matches the host (production uses
		// `join(kbRoot, ".jolli")`, which yields `\` on Windows).
		expect(MetadataManager).toHaveBeenCalledWith(join("/explicit/kb/root", ".jolli"));
		// No git-derived resolution: the explicit-root path skips the resolver chain.
		expect(kbResolver.extractRepoName).not.toHaveBeenCalled();
		expect(kbResolver.getRemoteUrl).not.toHaveBeenCalled();
		expect(kbResolver.resolveKBPath).not.toHaveBeenCalled();
	});
});
