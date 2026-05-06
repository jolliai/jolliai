import { describe, expect, it, vi } from "vitest";
import type { CommitSummary } from "../../../cli/src/Types.js";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import type { BranchCommit, BranchCommitsResult } from "../Types.js";

// Logger imports `vscode`; mock both to keep the loader test pure-Node.
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("vscode", () => ({}));
vi.mock("../util/Logger.js", () => ({
	log: { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { loadBranchSummaries } from "./BranchSummaryLoader.js";

function makeCommit(hash: string, message = `msg-${hash}`): BranchCommit {
	return {
		hash,
		shortHash: hash.substring(0, 7),
		message,
		author: "tester",
		authorEmail: "t@t",
		date: "2026-05-06T00:00:00Z",
		shortDate: "05-06",
		topicCount: 0,
		insertions: 0,
		deletions: 0,
		filesChanged: 0,
		isPushed: false,
		hasSummary: true,
	};
}

function makeSummary(hash: string, message?: string): CommitSummary {
	return {
		commitHash: hash,
		commitMessage: message ?? `summary-of-${hash}`,
		commitAuthor: "tester",
		commitAuthorEmail: "t@t",
		commitDate: "2026-05-06T00:00:00Z",
		branch: "feature/x",
	} as unknown as CommitSummary;
}

interface MockBridgeOptions {
	commits: ReadonlyArray<BranchCommit>;
	summaryByHash: Record<string, CommitSummary | null>;
}

function makeBridge(opts: MockBridgeOptions): JolliMemoryBridge {
	const result: BranchCommitsResult = {
		commits: opts.commits,
		isMerged: false,
	};
	const listBranchCommits = vi.fn().mockResolvedValue(result);
	const getSummary = vi.fn(async (hash: string) => {
		return opts.summaryByHash[hash] ?? null;
	});
	return {
		listBranchCommits,
		getSummary,
	} as unknown as JolliMemoryBridge;
}

describe("loadBranchSummaries", () => {
	it("returns all summaries chronologically (oldest first) when every commit is summarized", async () => {
		// listBranchCommits emits newest-first: [C, B, A]
		const bridge = makeBridge({
			commits: [makeCommit("CCCC"), makeCommit("BBBB"), makeCommit("AAAA")],
			summaryByHash: {
				CCCC: makeSummary("CCCC"),
				BBBB: makeSummary("BBBB"),
				AAAA: makeSummary("AAAA"),
			},
		});

		const result = await loadBranchSummaries(bridge, "main");

		expect(result.missingCount).toBe(0);
		expect(result.summaries.map((s) => s.commitHash)).toEqual([
			"AAAA",
			"BBBB",
			"CCCC",
		]);
	});

	it("counts and skips commits without a recorded summary", async () => {
		// 5 commits newest-first; B and D return null
		const bridge = makeBridge({
			commits: [
				makeCommit("EEEE"),
				makeCommit("DDDD"),
				makeCommit("CCCC"),
				makeCommit("BBBB"),
				makeCommit("AAAA"),
			],
			summaryByHash: {
				EEEE: makeSummary("EEEE"),
				DDDD: null,
				CCCC: makeSummary("CCCC"),
				BBBB: null,
				AAAA: makeSummary("AAAA"),
			},
		});

		const result = await loadBranchSummaries(bridge, "main");

		expect(result.missingCount).toBe(2);
		expect(result.summaries.map((s) => s.commitHash)).toEqual([
			"AAAA",
			"CCCC",
			"EEEE",
		]);
	});

	it("counts every commit as missing when none has a summary", async () => {
		const bridge = makeBridge({
			commits: [makeCommit("BBBB"), makeCommit("AAAA")],
			summaryByHash: { BBBB: null, AAAA: null },
		});

		const result = await loadBranchSummaries(bridge, "main");

		expect(result.summaries).toEqual([]);
		expect(result.missingCount).toBe(2);
	});

	it("returns empty result when the branch has no commits ahead of base", async () => {
		const bridge = makeBridge({
			commits: [],
			summaryByHash: {},
		});

		const result = await loadBranchSummaries(bridge, "main");

		expect(result).toEqual({ summaries: [], missingCount: 0 });
	});

	it("calls bridge.getSummary (not the CLI directly) — verified by mock invocation", async () => {
		const summaryAaaa = makeSummary("AAAA");
		const bridge = makeBridge({
			commits: [makeCommit("AAAA")],
			summaryByHash: { AAAA: summaryAaaa },
		});

		await loadBranchSummaries(bridge, "main");

		// listBranchCommits called once with mainBranch arg
		expect(bridge.listBranchCommits).toHaveBeenCalledTimes(1);
		expect(bridge.listBranchCommits).toHaveBeenCalledWith("main");
		// getSummary called per commit hash, going through the bridge wrapper
		expect(bridge.getSummary).toHaveBeenCalledTimes(1);
		expect(bridge.getSummary).toHaveBeenCalledWith("AAAA");
	});

	it("coerces non-Error rejection reasons to string when warn-logging", async () => {
		// `r.reason instanceof Error` is the false branch when getSummary rejects
		// with a plain string / number / object — the loader has to coerce.
		const bridge = {
			listBranchCommits: vi.fn().mockResolvedValue({
				commits: [makeCommit("AAAA")],
				isMerged: false,
			}),
			getSummary: vi.fn(async () => {
				throw "plain-string-reason"; // not an Error instance
			}),
		} as unknown as JolliMemoryBridge;

		const result = await loadBranchSummaries(bridge, "main");

		expect(result.missingCount).toBe(1);
		expect(warn).toHaveBeenCalledWith(
			expect.any(String),
			expect.stringContaining("plain-string-reason"),
		);
	});

	it("counts a rejected getSummary as missing (Promise.allSettled, not Promise.all)", async () => {
		// If the loader used Promise.all, one rejection would reject the whole
		// load and freeze the WebView's "Loading..." button. allSettled lets
		// transient `bridge.getSummary` failures (corrupt orphan ref, git flake)
		// degrade gracefully into "missing" entries with a warn-log breadcrumb.
		const bridge = {
			listBranchCommits: vi.fn().mockResolvedValue({
				commits: [makeCommit("BBBB"), makeCommit("AAAA")],
				isMerged: false,
			}),
			getSummary: vi.fn(async (hash: string) => {
				if (hash === "BBBB") {
					throw new Error("simulated transient git failure");
				}
				return makeSummary(hash);
			}),
		} as unknown as JolliMemoryBridge;

		const result = await loadBranchSummaries(bridge, "main");

		expect(result.missingCount).toBe(1);
		expect(result.summaries.map((s) => s.commitHash)).toEqual(["AAAA"]);
		expect(warn).toHaveBeenCalledWith(
			expect.any(String),
			expect.stringContaining("simulated transient git failure"),
		);
	});

	it("preserves chronological order even when getSummary resolves out of order", async () => {
		// Make getSummary resolve in reverse order to prove the loader reorders
		// based on the listBranchCommits sequence, not the resolution sequence.
		let resolveD!: (s: CommitSummary | null) => void;
		const dPromise = new Promise<CommitSummary | null>((r) => {
			resolveD = r;
		});
		const bridge = {
			listBranchCommits: vi.fn().mockResolvedValue({
				commits: [makeCommit("DDDD"), makeCommit("CCCC"), makeCommit("AAAA")],
				isMerged: false,
			}),
			getSummary: vi.fn(async (hash: string) => {
				if (hash === "DDDD") return dPromise;
				return makeSummary(hash);
			}),
		} as unknown as JolliMemoryBridge;

		const promise = loadBranchSummaries(bridge, "main");
		// Resolve DDDD last
		setTimeout(() => resolveD(makeSummary("DDDD")), 0);
		const result = await promise;

		expect(result.summaries.map((s) => s.commitHash)).toEqual([
			"AAAA",
			"CCCC",
			"DDDD",
		]);
	});
});
