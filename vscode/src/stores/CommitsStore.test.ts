import { describe, expect, it, vi } from "vitest";
import type {
	BranchCommit,
	BranchCommitsResult,
	CommitFileInfo,
} from "../Types.js";
import { CommitsStore } from "./CommitsStore.js";

function makeCommit(
	hash: string,
	overrides: Partial<BranchCommit> = {},
): BranchCommit {
	return {
		hash,
		shortHash: hash.substring(0, 8),
		message: "msg",
		author: "T",
		authorEmail: "t@t",
		date: "2026-01-01T00:00:00Z",
		shortDate: "01-01",
		topicCount: 0,
		insertions: 0,
		deletions: 0,
		filesChanged: 0,
		isPushed: false,
		hasSummary: false,
		...overrides,
	};
}

function makeResult(
	commits: Array<BranchCommit>,
	isMerged = false,
): BranchCommitsResult {
	return { commits, isMerged };
}

function makeBridge(
	resultFn: () => BranchCommitsResult,
	filesFn: () => Promise<Array<CommitFileInfo>> = async () => [],
) {
	return {
		listBranchCommits: vi.fn(resultFn),
		listCommitFiles: vi.fn(filesFn),
	};
}

describe("CommitsStore — initial state", () => {
	it("starts empty with init reason", () => {
		const store = new CommitsStore(makeBridge(() => makeResult([])) as never);
		const snap = store.getSnapshot();
		expect(snap.commits).toEqual([]);
		expect(snap.isMerged).toBe(false);
		expect(snap.changeReason).toBe("init");
	});
});

describe("CommitsStore — refresh", () => {
	it("loads commits and isMerged from bridge", async () => {
		const store = new CommitsStore(
			makeBridge(() => makeResult([makeCommit("aaa1")], true)) as never,
		);
		await store.refresh();
		const snap = store.getSnapshot();
		expect(snap.commits).toHaveLength(1);
		expect(snap.isMerged).toBe(true);
		expect(snap.singleCommitMode).toBe(true);
		expect(snap.changeReason).toBe("refresh");
	});

	it("clears selection when the commit sequence changes", async () => {
		let commits = [makeCommit("aaa1"), makeCommit("bbb2")];
		const store = new CommitsStore(
			makeBridge(() => makeResult(commits)) as never,
		);
		await store.refresh();
		store.onCheckboxToggle("aaa1", true);
		expect(store.getSnapshot().selectedCommits).toHaveLength(1);

		commits = [makeCommit("ccc3"), makeCommit("bbb2")];
		await store.refresh();
		expect(store.getSnapshot().selectedCommits).toHaveLength(0);
	});

	it("preserves selection when the commit sequence is unchanged", async () => {
		const commits = [makeCommit("aaa1"), makeCommit("bbb2")];
		const store = new CommitsStore(
			makeBridge(() => makeResult(commits)) as never,
		);
		await store.refresh();
		store.onCheckboxToggle("aaa1", true);
		await store.refresh();
		expect(store.getSnapshot().selectedCommits).toHaveLength(1);
	});
});

describe("CommitsStore — checkbox behaviour", () => {
	it("range-checks all commits newer than the target (0..index)", async () => {
		const store = new CommitsStore(
			makeBridge(() =>
				makeResult([
					makeCommit("aaa1"),
					makeCommit("bbb2"),
					makeCommit("ccc3"),
				]),
			) as never,
		);
		await store.refresh();
		store.onCheckboxToggle("ccc3", true);
		expect(store.getSnapshot().selectedCommits.map((c) => c.hash)).toEqual([
			"aaa1",
			"bbb2",
			"ccc3",
		]);
	});

	it("range-unchecks the target and everything older (index..end)", async () => {
		const store = new CommitsStore(
			makeBridge(() =>
				makeResult([
					makeCommit("aaa1"),
					makeCommit("bbb2"),
					makeCommit("ccc3"),
				]),
			) as never,
		);
		await store.refresh();
		store.onCheckboxToggle("ccc3", true);
		store.onCheckboxToggle("bbb2", false);
		expect(store.getSnapshot().selectedCommits.map((c) => c.hash)).toEqual([
			"aaa1",
		]);
	});

	it("ignores toggles for unknown hashes", async () => {
		const store = new CommitsStore(
			makeBridge(() => makeResult([makeCommit("aaa1")])) as never,
		);
		await store.refresh();
		const listener = vi.fn();
		store.onChange(listener);
		store.onCheckboxToggle("not-a-hash", true);
		expect(listener).not.toHaveBeenCalled();
	});

	it("toggleSelectAll selects then clears", async () => {
		const store = new CommitsStore(
			makeBridge(() =>
				makeResult([makeCommit("aaa1"), makeCommit("bbb2")]),
			) as never,
		);
		await store.refresh();
		store.toggleSelectAll();
		expect(store.getSnapshot().selectedCommits).toHaveLength(2);
		store.toggleSelectAll();
		expect(store.getSnapshot().selectedCommits).toHaveLength(0);
	});
});

describe("CommitsStore — getCommitFiles cache", () => {
	it("dedupes concurrent requests for the same hash", async () => {
		const filesFn = vi.fn(async () => [
			{ relativePath: "a.ts", statusCode: "M" },
		]);
		const store = new CommitsStore(
			makeBridge(() => makeResult([makeCommit("aaa1")]), filesFn) as never,
		);
		const [a, b] = await Promise.all([
			store.getCommitFiles("aaa1"),
			store.getCommitFiles("aaa1"),
		]);
		expect(filesFn).toHaveBeenCalledTimes(1);
		expect(a).toBe(b);
	});

	it("evicts rejected promises so the next call retries", async () => {
		const filesFn = vi
			.fn()
			.mockRejectedValueOnce(new Error("nope"))
			.mockResolvedValueOnce([]);
		const store = new CommitsStore(
			makeBridge(() => makeResult([makeCommit("aaa1")]), filesFn) as never,
		);
		await expect(store.getCommitFiles("aaa1")).rejects.toThrow("nope");
		await store.getCommitFiles("aaa1");
		expect(filesFn).toHaveBeenCalledTimes(2);
	});
});

describe("CommitsStore — other mutations", () => {
	it("setMainBranch emits mainBranch reason and updates internal field", () => {
		const store = new CommitsStore(makeBridge(() => makeResult([])) as never);
		const listener = vi.fn();
		store.onChange(listener);
		store.setMainBranch("develop");
		expect(listener).toHaveBeenCalled();
		expect(store.getSnapshot().changeReason).toBe("mainBranch");
	});

	it("setMainBranch is idempotent", () => {
		const store = new CommitsStore(makeBridge(() => makeResult([])) as never);
		const listener = vi.fn();
		store.onChange(listener);
		store.setMainBranch("main"); // default value
		expect(listener).not.toHaveBeenCalled();
	});

	it("setEnabled and setMigrating broadcast the correct reason", () => {
		const store = new CommitsStore(makeBridge(() => makeResult([])) as never);
		store.setEnabled(false);
		expect(store.getSnapshot().changeReason).toBe("enabled");
		store.setMigrating(true);
		expect(store.getSnapshot().changeReason).toBe("migrating");
		expect(store.getSnapshot().isMigrating).toBe(true);
		expect(store.getSnapshot().isEnabled).toBe(false);
	});

	it("setEnabled and setMigrating are idempotent", () => {
		const store = new CommitsStore(makeBridge(() => makeResult([])) as never);
		const listener = vi.fn();
		store.onChange(listener);
		store.setEnabled(true); // default
		store.setMigrating(false); // default
		expect(listener).not.toHaveBeenCalled();
	});

	it("setEnabled(false) clears commits and isMerged so title cannot stick", async () => {
		const store = new CommitsStore(
			makeBridge(() => makeResult([makeCommit("aaa1")], true)) as never,
		);
		await store.refresh();
		store.onCheckboxToggle("aaa1", true);
		expect(store.getSnapshot().commits).toHaveLength(1);
		expect(store.getSnapshot().isMerged).toBe(true);
		expect(store.getSnapshot().selectedCommits).toHaveLength(1);

		store.setEnabled(false);

		const snap = store.getSnapshot();
		expect(snap.commits).toEqual([]);
		expect(snap.isMerged).toBe(false);
		expect(snap.selectedCommits).toEqual([]);
		expect(snap.isEnabled).toBe(false);
	});

	it("getSelectionDebugInfo reports head/tail and stale hashes", async () => {
		const store = new CommitsStore(
			makeBridge(() =>
				makeResult([makeCommit("aaaaaaaa1"), makeCommit("bbbbbbbb2")]),
			) as never,
		);
		await store.refresh();
		store.onCheckboxToggle("aaaaaaaa1", true);
		const info = store.getSelectionDebugInfo();
		expect(info.headHash).toBe("aaaaaaaa");
		expect(info.tailHash).toBe("bbbbbbbb");
		expect(info.selectedCommits).toContain("aaaaaaaa");
		expect(info.staleCheckedHashes).toEqual([]);
	});
});
