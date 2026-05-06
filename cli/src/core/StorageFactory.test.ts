import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("./SessionTracker.js", () => ({
	loadConfig: vi.fn(),
}));

vi.mock("./KBPathResolver.js", () => ({
	extractRepoName: vi.fn().mockReturnValue("test-repo"),
	getRemoteUrl: vi.fn().mockReturnValue("https://github.com/test/repo.git"),
	resolveKBPath: vi.fn().mockReturnValue("/tmp/kb-test"),
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

import { DualWriteStorage } from "./DualWriteStorage.js";
import { FolderStorage } from "./FolderStorage.js";
import { OrphanBranchStorage } from "./OrphanBranchStorage.js";
import { loadConfig } from "./SessionTracker.js";
import { createStorage } from "./StorageFactory.js";

const mockLoadConfig = vi.mocked(loadConfig);

describe("StorageFactory", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns DualWriteStorage when no storageMode is configured (default)", async () => {
		mockLoadConfig.mockResolvedValue({});

		const storage = await createStorage("/project/path");

		expect(DualWriteStorage).toHaveBeenCalledOnce();
		expect((storage as unknown as Record<string, unknown>).type).toBe("dual-write");
	});

	it('returns OrphanBranchStorage when storageMode is "orphan"', async () => {
		// `storageMode` is read off the config via a cast in StorageFactory.ts;
		// the type doesn't declare the field but the implementation tolerates it.
		mockLoadConfig.mockResolvedValue({ storageMode: "orphan" } as unknown as Awaited<
			ReturnType<typeof loadConfig>
		>);

		const storage = await createStorage("/project/path");

		expect(OrphanBranchStorage).toHaveBeenCalledOnce();
		expect((storage as unknown as Record<string, unknown>).type).toBe("orphan");
	});

	it('returns FolderStorage when storageMode is "folder"', async () => {
		mockLoadConfig.mockResolvedValue({ storageMode: "folder" } as unknown as Awaited<
			ReturnType<typeof loadConfig>
		>);

		const storage = await createStorage("/project/path");

		expect(FolderStorage).toHaveBeenCalledOnce();
		expect((storage as unknown as Record<string, unknown>).type).toBe("folder");
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
});
