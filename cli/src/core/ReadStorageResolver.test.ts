import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("./OrphanBranchStorage.js", () => {
	const OrphanBranchStorage = vi.fn();
	OrphanBranchStorage.prototype.type = "orphan";
	return { OrphanBranchStorage };
});

vi.mock("./StorageFactory.js", () => ({
	createFolderStorage: vi.fn(),
}));

// Claimable by default — the gate's own conditions (git worktree, nested bank)
// are covered in KBPathResolver.test.ts against real git worktrees. Mocked here
// so these tests never shell out to git.
vi.mock("./KBPathResolver.js", () => ({
	isClaimableProject: vi.fn().mockReturnValue(true),
}));

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

import { resolveCutoverRoute } from "../dashboard/CutoverRouter.js";
import { isClaimableProject } from "./KBPathResolver.js";
import { OrphanBranchStorage } from "./OrphanBranchStorage.js";
import { createReadStorage } from "./ReadStorageResolver.js";
import { loadConfig } from "./SessionTracker.js";
import { SqliteStorage } from "./SqliteStorage.js";
import { createFolderStorage } from "./StorageFactory.js";

const mockLoadConfig = vi.mocked(loadConfig);
const mockCreateFolderStorage = vi.mocked(createFolderStorage);
const mockIsClaimableProject = vi.mocked(isClaimableProject);

// Minimal FolderStorage stub: only the methods ReadStorageResolver touches.
// biome-ignore lint/suspicious/noExplicitAny: minimal StorageProvider stub for read-resolver dispatch
function makeFolderStub(opts: { index?: unknown; isDirty?: boolean | undefined }): any {
	return {
		type: "folder",
		readFile: vi.fn().mockResolvedValue(opts.index ?? null),
		isDirty: opts.isDirty === undefined ? undefined : vi.fn().mockReturnValue(opts.isDirty),
	};
}

describe("createReadStorage", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// `clearAllMocks` wipes recorded calls but keeps implementations, so a
		// per-test `mockReturnValue(false)` (or a cutover-state override below)
		// would otherwise leak forward.
		mockIsClaimableProject.mockReturnValue(true);
		vi.mocked(resolveCutoverRoute).mockResolvedValue({ state: "uncutover" });
	});

	describe("cutover routing", () => {
		it("routes legacy-fenced and cutover straight to SqliteStorage, ignoring storageMode", async () => {
			for (const state of ["legacy-fenced", "cutover"] as const) {
				vi.clearAllMocks();
				mockIsClaimableProject.mockReturnValue(true);
				vi.mocked(resolveCutoverRoute).mockResolvedValue(
					state === "cutover"
						? { state, record: { tips: {}, cutoverVersion: 1, committedAt: "t", schemaVersion: 1 } }
						: { state },
				);
				// A residual storageMode must not steer this route — the read side
				// answers straight off the cutover state, same as the write side.
				mockLoadConfig.mockResolvedValue({ storageMode: "folder" } as unknown as Awaited<
					ReturnType<typeof loadConfig>
				>);

				const storage = await createReadStorage("/project/path");

				expect(SqliteStorage).toHaveBeenCalledWith("https://github.com/test/repo.git");
				expect((storage as unknown as Record<string, unknown>).type).toBe("sqlite");
				expect(mockCreateFolderStorage).not.toHaveBeenCalled();
				expect(OrphanBranchStorage).not.toHaveBeenCalled();
				// The SQLite routes never touch createFolderStorage, so they don't
				// need the write-boundary claimable gate either.
				expect(mockIsClaimableProject).not.toHaveBeenCalled();
			}
		});

		it("throws on blocked instead of degrading to the frozen orphan branch", async () => {
			vi.mocked(resolveCutoverRoute).mockResolvedValue({
				state: "blocked",
				reason: "database file does not exist",
			});
			mockLoadConfig.mockResolvedValue({});

			await expect(createReadStorage("/project/path")).rejects.toThrow(/doctor --recover/);
			expect(OrphanBranchStorage).not.toHaveBeenCalled();
			expect(mockCreateFolderStorage).not.toHaveBeenCalled();
		});

		it("falls through to the storageMode dispatch on uncutover", async () => {
			vi.mocked(resolveCutoverRoute).mockResolvedValue({ state: "uncutover" });
			mockLoadConfig.mockResolvedValue({ storageMode: "orphan" } as unknown as Awaited<
				ReturnType<typeof loadConfig>
			>);

			const storage = await createReadStorage("/project/path");

			expect((storage as unknown as Record<string, unknown>).type).toBe("orphan");
			expect(SqliteStorage).not.toHaveBeenCalled();
		});
	});

	it('returns OrphanBranchStorage when storageMode is "orphan"', async () => {
		mockLoadConfig.mockResolvedValue({ storageMode: "orphan" } as unknown as Awaited<
			ReturnType<typeof loadConfig>
		>);

		const storage = await createReadStorage("/project/path");

		expect(OrphanBranchStorage).toHaveBeenCalledOnce();
		expect(OrphanBranchStorage).toHaveBeenCalledWith("/project/path");
		expect((storage as unknown as Record<string, unknown>).type).toBe("orphan");
		expect(mockCreateFolderStorage).not.toHaveBeenCalled();
	});

	it('returns FolderStorage when storageMode is "folder", passing localFolder', async () => {
		mockLoadConfig.mockResolvedValue({
			storageMode: "folder",
			localFolder: "/my/kb",
		} as unknown as Awaited<ReturnType<typeof loadConfig>>);
		const folder = makeFolderStub({});
		mockCreateFolderStorage.mockReturnValue(folder);

		const storage = await createReadStorage("/project/path");

		expect(mockCreateFolderStorage).toHaveBeenCalledWith("/project/path", "/my/kb");
		expect(storage).toBe(folder);
		expect(OrphanBranchStorage).not.toHaveBeenCalled();
	});

	it("defaults to dual-write and returns folder when index.json present and shadow clean", async () => {
		// No storageMode -> defaults to "dual-write".
		mockLoadConfig.mockResolvedValue({} as unknown as Awaited<ReturnType<typeof loadConfig>>);
		const folder = makeFolderStub({ index: "{}", isDirty: false });
		mockCreateFolderStorage.mockReturnValue(folder);

		const storage = await createReadStorage("/project/path");

		expect(folder.readFile).toHaveBeenCalledWith("index.json");
		expect(folder.isDirty).toHaveBeenCalled();
		expect(storage).toBe(folder);
		expect(OrphanBranchStorage).not.toHaveBeenCalled();
	});

	it("dual-write: returns folder when index.json present and isDirty hook is absent", async () => {
		// isDirty optional-chaining short-circuits to undefined (falsy) when the
		// provider doesn't implement the hook — folder is still used.
		mockLoadConfig.mockResolvedValue({ storageMode: "dual-write" } as unknown as Awaited<
			ReturnType<typeof loadConfig>
		>);
		const folder = makeFolderStub({ index: "{}", isDirty: undefined });
		mockCreateFolderStorage.mockReturnValue(folder);

		const storage = await createReadStorage("/project/path");

		expect(storage).toBe(folder);
		expect(OrphanBranchStorage).not.toHaveBeenCalled();
	});

	it("dual-write: falls back to orphan when index.json is missing", async () => {
		const warnSpy = vi.spyOn(console, "warn");
		mockLoadConfig.mockResolvedValue({ storageMode: "dual-write" } as unknown as Awaited<
			ReturnType<typeof loadConfig>
		>);
		const folder = makeFolderStub({ index: null, isDirty: false });
		mockCreateFolderStorage.mockReturnValue(folder);

		const storage = await createReadStorage("/project/path");

		expect(folder.readFile).toHaveBeenCalledWith("index.json");
		expect(OrphanBranchStorage).toHaveBeenCalledWith("/project/path");
		expect((storage as unknown as Record<string, unknown>).type).toBe("orphan");
		expect(warnSpy).toHaveBeenCalled();
	});

	it("dual-write: falls back to orphan when folder shadow is dirty", async () => {
		const warnSpy = vi.spyOn(console, "warn");
		mockLoadConfig.mockResolvedValue({ storageMode: "dual-write" } as unknown as Awaited<
			ReturnType<typeof loadConfig>
		>);
		const folder = makeFolderStub({ index: "{}", isDirty: true });
		mockCreateFolderStorage.mockReturnValue(folder);

		const storage = await createReadStorage("/project/path");

		expect(folder.isDirty).toHaveBeenCalled();
		expect(OrphanBranchStorage).toHaveBeenCalledWith("/project/path");
		expect((storage as unknown as Record<string, unknown>).type).toBe("orphan");
		expect(warnSpy).toHaveBeenCalled();
	});

	it("falls back to orphan with warning on unknown storageMode", async () => {
		const warnSpy = vi.spyOn(console, "warn");
		mockLoadConfig.mockResolvedValue({ storageMode: "sqlite" } as unknown as Awaited<
			ReturnType<typeof loadConfig>
		>);

		const storage = await createReadStorage("/project/path");

		expect(OrphanBranchStorage).toHaveBeenCalledWith("/project/path");
		expect((storage as unknown as Record<string, unknown>).type).toBe("orphan");
		expect(warnSpy).toHaveBeenCalled();
		expect(mockCreateFolderStorage).not.toHaveBeenCalled();
	});

	// The read side reaches `resolveKBPath` through `createFolderStorage`, which
	// CLAIMS the folder it resolves. Without this gate a read launched from a
	// non-project cwd (`cd /tmp && jolli generate …`, an agent's throwaway temp
	// dir) leaves a junk `<localFolder>/<basename>/` behind — the same failure the
	// write-side gate in StorageFactory prevents.
	describe("non-claimable cwd degrades to orphan-only", () => {
		it("dual-write: never constructs the FolderStorage", async () => {
			mockLoadConfig.mockResolvedValue({ storageMode: "dual-write" } as unknown as Awaited<
				ReturnType<typeof loadConfig>
			>);
			mockIsClaimableProject.mockReturnValue(false);

			const storage = await createReadStorage("/var/folders/xx/jolli-localagent-abc123");

			expect((storage as unknown as Record<string, unknown>).type).toBe("orphan");
			// The assertion that pins the fix: no createFolderStorage call means no
			// resolveKBPath call means nothing written to disk.
			expect(mockCreateFolderStorage).not.toHaveBeenCalled();
		});

		it("folder: never constructs the FolderStorage", async () => {
			mockLoadConfig.mockResolvedValue({ storageMode: "folder" } as unknown as Awaited<
				ReturnType<typeof loadConfig>
			>);
			mockIsClaimableProject.mockReturnValue(false);

			const storage = await createReadStorage("/var/folders/xx/jolli-localagent-abc123");

			expect((storage as unknown as Record<string, unknown>).type).toBe("orphan");
			expect(mockCreateFolderStorage).not.toHaveBeenCalled();
		});

		it("passes the configured localFolder to the gate so the nested-bank case is detectable", async () => {
			mockLoadConfig.mockResolvedValue({
				storageMode: "dual-write",
				localFolder: "/Users/me/Documents/bank",
			} as unknown as Awaited<ReturnType<typeof loadConfig>>);
			mockCreateFolderStorage.mockReturnValue(makeFolderStub({ index: "{}", isDirty: false }));

			await createReadStorage("/Users/me/Documents/bank/some-repo");

			expect(mockIsClaimableProject).toHaveBeenCalledWith(
				"/Users/me/Documents/bank/some-repo",
				"/Users/me/Documents/bank",
			);
		});

		it('does not consult the gate at all in "orphan" mode', async () => {
			// Orphan mode never touches the Memory Bank folder, so the git
			// subprocess the gate runs would be pure overhead on that path.
			mockLoadConfig.mockResolvedValue({ storageMode: "orphan" } as unknown as Awaited<
				ReturnType<typeof loadConfig>
			>);

			await createReadStorage("/project/path");

			expect(mockIsClaimableProject).not.toHaveBeenCalled();
		});
	});
});
