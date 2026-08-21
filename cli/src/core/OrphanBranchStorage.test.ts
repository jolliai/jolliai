import { beforeEach, describe, expect, it, vi } from "vitest";

// OrphanBranchStorage is a thin wrapper; every method just forwards to GitOps.
// The write-time fence check reads profile.json; a mutable holder lets each
// test raise or drop the fence without re-mocking.
const fenceState: { fence: { reason: string; at: string } | null } = { fence: null };
vi.mock("./RepoProfile.js", () => ({
	readCutoverFence: vi.fn(async () => fenceState.fence),
}));

// The second witness (D6's shared-identity CAS row). Mocked so its true
// branch, and both of its own `.catch()` failure paths, can be driven without
// a real dashboard database.
const cutoverRowState: { hasRow: boolean } = { hasRow: false };
vi.mock("../dashboard/CutoverRouter.js", () => ({
	hasCutoverRow: vi.fn(async () => cutoverRowState.hasRow),
}));

vi.mock("./GitOps.js", () => ({
	batchReadFilesFromBranch: vi.fn(),
	ensureOrphanBranch: vi.fn(),
	listFilesInBranch: vi.fn(),
	orphanBranchExists: vi.fn(),
	readFileFromBranch: vi.fn(),
	writeMultipleFilesToBranch: vi.fn(),
}));

import { hasCutoverRow } from "../dashboard/CutoverRouter.js";
import { ORPHAN_BRANCH, setManuallyDisabled } from "../Logger.js";
import {
	batchReadFilesFromBranch,
	ensureOrphanBranch,
	listFilesInBranch,
	orphanBranchExists,
	readFileFromBranch,
	writeMultipleFilesToBranch,
} from "./GitOps.js";
import { OrphanBranchFrozenError, OrphanBranchStorage } from "./OrphanBranchStorage.js";
import { readCutoverFence } from "./RepoProfile.js";

const mockedReadFile = vi.mocked(readFileFromBranch);
const mockedBatchReadFiles = vi.mocked(batchReadFilesFromBranch);
const mockedWriteFiles = vi.mocked(writeMultipleFilesToBranch);
const mockedListFiles = vi.mocked(listFilesInBranch);
const mockedExists = vi.mocked(orphanBranchExists);
const mockedEnsure = vi.mocked(ensureOrphanBranch);

describe("OrphanBranchStorage", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// Minification-safe backend identity — `constructor.name` is mangled in both
	// shipping bundles, so diagnostics read this instead (JOLLI-2066).
	it("reports a stable kind that does not depend on the class name", () => {
		expect(new OrphanBranchStorage("/tmp/repo").kind).toBe("orphan-branch");
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

	it("batchReadFiles forwards ORPHAN_BRANCH, paths and cwd to batchReadFilesFromBranch", async () => {
		const map = new Map<string, string | null>([
			["summaries/a.json", "A"],
			["summaries/b.json", null],
		]);
		mockedBatchReadFiles.mockResolvedValueOnce(map);
		const storage = new OrphanBranchStorage("/tmp/repo");

		const result = await storage.batchReadFiles(["summaries/a.json", "summaries/b.json"]);

		expect(result).toBe(map);
		expect(mockedBatchReadFiles).toHaveBeenCalledWith(
			ORPHAN_BRANCH,
			["summaries/a.json", "summaries/b.json"],
			"/tmp/repo",
		);
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

	it("writeFiles is a no-op when manuallyDisabled is true", async () => {
		setManuallyDisabled(true);
		try {
			const storage = new OrphanBranchStorage("/tmp/repo");

			await storage.writeFiles([{ path: "summaries/abc.json", content: "{}" }], "test");

			expect(mockedEnsure).not.toHaveBeenCalled();
			expect(mockedWriteFiles).not.toHaveBeenCalled();
		} finally {
			setManuallyDisabled(false);
		}
	});
});

describe("cutover fence at write time", () => {
	it("refuses an orphan write while the fence is up — the frozen branch never moves", async () => {
		// The scenario the invariant exists for: a long-lived process holds a
		// pre-cutover storage object; routing can't reach it, only this check can.
		fenceState.fence = { reason: "cutover", at: "t" };
		try {
			const storage = new OrphanBranchStorage("/repo");
			// Typed, not a bare Error: the MCP dispatcher and the VS Code bridge both
			// key their self-heal retry on `instanceof OrphanBranchFrozenError`.
			await expect(storage.writeFiles([{ path: "summaries/x.json", content: "{}" }], "m")).rejects.toBeInstanceOf(
				OrphanBranchFrozenError,
			);
			expect(writeMultipleFilesToBranch).not.toHaveBeenCalled();
			expect(ensureOrphanBranch).not.toHaveBeenCalled();
		} finally {
			fenceState.fence = null;
		}
	});
});

describe("the second witness (CAS row) at write time", () => {
	it("refuses an orphan write once the CAS row exists — the branch is retired for this repo", async () => {
		// The clone-without-a-fence case the second witness exists for: nothing
		// local says "frozen", but the shared identity's cutover row does.
		cutoverRowState.hasRow = true;
		try {
			const storage = new OrphanBranchStorage("/repo");
			await expect(storage.writeFiles([{ path: "summaries/x.json", content: "{}" }], "m")).rejects.toBeInstanceOf(
				OrphanBranchFrozenError,
			);
			expect(writeMultipleFilesToBranch).not.toHaveBeenCalled();
			expect(ensureOrphanBranch).not.toHaveBeenCalled();
		} finally {
			cutoverRowState.hasRow = false;
		}
	});

	it("falls back to process.cwd() for both the fence and CAS-row checks when no cwd is given", async () => {
		const storage = new OrphanBranchStorage();

		await storage.writeFiles([{ path: "summaries/x.json", content: "{}" }], "m");

		expect(vi.mocked(readCutoverFence)).toHaveBeenCalledWith(process.cwd());
		expect(vi.mocked(hasCutoverRow)).toHaveBeenCalledWith(process.cwd());
	});

	it("treats a failed fence read as no fence — quiet and fail-open", async () => {
		vi.mocked(readCutoverFence).mockRejectedValueOnce(new Error("profile.json unreadable"));
		const storage = new OrphanBranchStorage("/repo");

		await storage.writeFiles([{ path: "summaries/x.json", content: "{}" }], "m");

		expect(ensureOrphanBranch).toHaveBeenCalled();
		expect(writeMultipleFilesToBranch).toHaveBeenCalled();
	});

	it("treats a failed CAS-row read as no row — quiet and fail-open", async () => {
		vi.mocked(hasCutoverRow).mockRejectedValueOnce(new Error("dashboard db unreadable"));
		const storage = new OrphanBranchStorage("/repo");

		await storage.writeFiles([{ path: "summaries/x.json", content: "{}" }], "m");

		expect(ensureOrphanBranch).toHaveBeenCalled();
		expect(writeMultipleFilesToBranch).toHaveBeenCalled();
	});
});
