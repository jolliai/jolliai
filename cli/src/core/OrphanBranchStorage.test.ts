import { beforeEach, describe, expect, it, vi } from "vitest";

// OrphanBranchStorage is a thin wrapper; every method just forwards to GitOps.
vi.mock("./GitOps.js", () => ({
	ensureOrphanBranch: vi.fn(),
	listFilesInBranch: vi.fn(),
	orphanBranchExists: vi.fn(),
	readFileFromBranch: vi.fn(),
	writeMultipleFilesToBranch: vi.fn(),
}));

import { ORPHAN_BRANCH } from "../Logger.js";
import {
	ensureOrphanBranch,
	listFilesInBranch,
	orphanBranchExists,
	readFileFromBranch,
	writeMultipleFilesToBranch,
} from "./GitOps.js";
import { OrphanBranchStorage } from "./OrphanBranchStorage.js";

const mockedReadFile = vi.mocked(readFileFromBranch);
const mockedWriteFiles = vi.mocked(writeMultipleFilesToBranch);
const mockedListFiles = vi.mocked(listFilesInBranch);
const mockedExists = vi.mocked(orphanBranchExists);
const mockedEnsure = vi.mocked(ensureOrphanBranch);

describe("OrphanBranchStorage", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("readFile forwards ORPHAN_BRANCH, path and cwd to readFileFromBranch", async () => {
		mockedReadFile.mockResolvedValueOnce("hello");
		const storage = new OrphanBranchStorage("/tmp/repo");

		const result = await storage.readFile("summaries/abc.json");

		expect(result).toBe("hello");
		expect(mockedReadFile).toHaveBeenCalledWith(ORPHAN_BRANCH, "summaries/abc.json", "/tmp/repo");
	});

	it("readFile passes undefined through when no cwd is provided", async () => {
		mockedReadFile.mockResolvedValueOnce(null);
		const storage = new OrphanBranchStorage();

		const result = await storage.readFile("missing.json");

		expect(result).toBeNull();
		expect(mockedReadFile).toHaveBeenCalledWith(ORPHAN_BRANCH, "missing.json", undefined);
	});

	it("writeFiles calls ensure before writing", async () => {
		const storage = new OrphanBranchStorage("/tmp/repo");
		const files = [{ path: "a.txt", content: "A" }];

		await storage.writeFiles(files, "commit msg");

		expect(mockedEnsure).toHaveBeenCalledWith(ORPHAN_BRANCH, "/tmp/repo");
		expect(mockedWriteFiles).toHaveBeenCalledWith(ORPHAN_BRANCH, files, "commit msg", "/tmp/repo");
		// ensure must run before write
		expect(mockedEnsure.mock.invocationCallOrder[0]).toBeLessThan(mockedWriteFiles.mock.invocationCallOrder[0]);
	});

	it("listFiles returns a mutable copy of the GitOps list", async () => {
		const frozen = Object.freeze(["a.json", "b.json"]) as readonly string[];
		mockedListFiles.mockResolvedValueOnce(frozen);
		const storage = new OrphanBranchStorage();

		const result = await storage.listFiles("summaries/");

		expect(result).toEqual(["a.json", "b.json"]);
		// must be a fresh array (not the readonly reference) so push() is safe
		expect(Object.isFrozen(result)).toBe(false);
		expect(mockedListFiles).toHaveBeenCalledWith(ORPHAN_BRANCH, "summaries/", undefined);
	});

	it("exists forwards to orphanBranchExists", async () => {
		mockedExists.mockResolvedValueOnce(true);
		const storage = new OrphanBranchStorage("/tmp/repo");

		await expect(storage.exists()).resolves.toBe(true);
		expect(mockedExists).toHaveBeenCalledWith(ORPHAN_BRANCH, "/tmp/repo");
	});

	it("ensure forwards to ensureOrphanBranch", async () => {
		const storage = new OrphanBranchStorage("/tmp/repo");

		await storage.ensure();

		expect(mockedEnsure).toHaveBeenCalledWith(ORPHAN_BRANCH, "/tmp/repo");
	});
});
