import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("./SessionTracker.js", () => ({
	loadConfig: vi.fn(),
}));

vi.mock("./OrphanBranchStorage.js", () => {
	const OrphanBranchStorage = vi.fn();
	OrphanBranchStorage.prototype.type = "orphan";
	return { OrphanBranchStorage };
});

vi.mock("./StorageFactory.js", () => ({
	createFolderStorage: vi.fn(),
}));

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

import { OrphanBranchStorage } from "./OrphanBranchStorage.js";
import { createReadStorage } from "./ReadStorageResolver.js";
import { loadConfig } from "./SessionTracker.js";
import { createFolderStorage } from "./StorageFactory.js";

const mockLoadConfig = vi.mocked(loadConfig);
const mockCreateFolderStorage = vi.mocked(createFolderStorage);

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
});
