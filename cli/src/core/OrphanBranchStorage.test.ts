import { beforeEach, describe, expect, it, vi } from "vitest";

// mock GitOps：OrphanBranchStorage 是个薄包装，所有方法都直接转发到 GitOps
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

	it("readFile 把 ORPHAN_BRANCH、path 和 cwd 转发给 readFileFromBranch", async () => {
		mockedReadFile.mockResolvedValueOnce("hello");
		const storage = new OrphanBranchStorage("/tmp/repo");

		const result = await storage.readFile("summaries/abc.json");

		expect(result).toBe("hello");
		expect(mockedReadFile).toHaveBeenCalledWith(ORPHAN_BRANCH, "summaries/abc.json", "/tmp/repo");
	});

	it("readFile 在没有传 cwd 时透传 undefined", async () => {
		mockedReadFile.mockResolvedValueOnce(null);
		const storage = new OrphanBranchStorage();

		const result = await storage.readFile("missing.json");

		expect(result).toBeNull();
		expect(mockedReadFile).toHaveBeenCalledWith(ORPHAN_BRANCH, "missing.json", undefined);
	});

	it("writeFiles 先 ensure 再写入", async () => {
		const storage = new OrphanBranchStorage("/tmp/repo");
		const files = [{ path: "a.txt", content: "A" }];

		await storage.writeFiles(files, "commit msg");

		expect(mockedEnsure).toHaveBeenCalledWith(ORPHAN_BRANCH, "/tmp/repo");
		expect(mockedWriteFiles).toHaveBeenCalledWith(ORPHAN_BRANCH, files, "commit msg", "/tmp/repo");
		// 顺序：ensure 必须在 write 之前
		expect(mockedEnsure.mock.invocationCallOrder[0]).toBeLessThan(mockedWriteFiles.mock.invocationCallOrder[0]);
	});

	it("listFiles 返回 GitOps 列表的可变副本", async () => {
		const frozen = Object.freeze(["a.json", "b.json"]) as readonly string[];
		mockedListFiles.mockResolvedValueOnce(frozen);
		const storage = new OrphanBranchStorage();

		const result = await storage.listFiles("summaries/");

		expect(result).toEqual(["a.json", "b.json"]);
		// 必须是新数组（不是只读引用），可以 push 不报错
		expect(Object.isFrozen(result)).toBe(false);
		expect(mockedListFiles).toHaveBeenCalledWith(ORPHAN_BRANCH, "summaries/", undefined);
	});

	it("exists 转发给 orphanBranchExists", async () => {
		mockedExists.mockResolvedValueOnce(true);
		const storage = new OrphanBranchStorage("/tmp/repo");

		await expect(storage.exists()).resolves.toBe(true);
		expect(mockedExists).toHaveBeenCalledWith(ORPHAN_BRANCH, "/tmp/repo");
	});

	it("ensure 转发给 ensureOrphanBranch", async () => {
		const storage = new OrphanBranchStorage("/tmp/repo");

		await storage.ensure();

		expect(mockedEnsure).toHaveBeenCalledWith(ORPHAN_BRANCH, "/tmp/repo");
	});
});
