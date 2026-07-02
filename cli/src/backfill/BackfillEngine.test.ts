import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────
vi.mock("../core/StorageFactory.js", () => ({
	createStorage: vi.fn().mockResolvedValue({ id: "store" }),
}));
vi.mock("../core/SummaryStore.js", () => ({
	getIndexEntryMap: vi.fn(),
	setActiveStorage: vi.fn(),
	storeSummary: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../core/Summarizer.js", () => ({
	generateSummary: vi.fn(),
}));
vi.mock("../core/SessionTracker.js", () => ({
	loadConfig: vi.fn(),
}));
vi.mock("../core/GitOps.js", () => ({
	execGit: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
	getCommitInfo: vi.fn().mockResolvedValue({ hash: "h", message: "m", author: "a", date: "2026-06-01" }),
	getDiffContent: vi.fn().mockResolvedValue("diff"),
	getDiffStats: vi.fn().mockResolvedValue({ filesChanged: 1, insertions: 2, deletions: 0 }),
	getCurrentBranch: vi.fn().mockResolvedValue("main"),
}));
vi.mock("../core/TranscriptReader.js", () => ({
	buildMultiSessionContext: vi.fn().mockReturnValue("conversation"),
}));
vi.mock("./RawTranscriptScanner.js", () => ({
	scanClaudeTranscripts: vi.fn().mockResolvedValue(new Map()),
	cwdInRoots: vi.fn().mockReturnValue(() => true),
}));
vi.mock("./CommitTargetIndex.js", () => ({
	buildCommitTargetIndex: vi.fn().mockResolvedValue({
		commitMeta: new Map(),
		commitFiles: new Map(),
		fileToCommits: new Map(),
		baseToCommits: new Map(),
	}),
}));
vi.mock("./CommitAttributor.js", () => ({
	attributeCommits: vi.fn(),
}));
vi.mock("../core/IngestTrigger.js", () => ({
	enqueueIngestOperation: vi.fn().mockResolvedValue(true),
}));
vi.mock("../hooks/QueueWorker.js", () => ({
	launchWorker: vi.fn(),
}));

import { getCurrentBranch } from "../core/GitOps.js";
import { enqueueIngestOperation } from "../core/IngestTrigger.js";
import { loadConfig } from "../core/SessionTracker.js";
import { generateSummary } from "../core/Summarizer.js";
import { getIndexEntryMap, storeSummary } from "../core/SummaryStore.js";
import { launchWorker } from "../hooks/QueueWorker.js";
import { countMissingSummaries, runBackfill } from "./BackfillEngine.js";
import { attributeCommits } from "./CommitAttributor.js";

const CWD = "e:/repo";

const TIER_METHOD = {
	high: "file-overlap",
	medium: "branch-match",
	low: "time-window",
} as const;

function attrFor(hash: string, confidence: "high" | "medium" | "low" = "high") {
	return {
		commitHash: hash,
		confidence,
		method: TIER_METHOD[confidence],
		branch: "feat",
		sessions: [
			{
				sessionId: "S1",
				transcriptPath: "/p/S1.jsonl",
				source: "claude" as const,
				entries: [{ role: "human" as const, content: "hi" }],
			},
		],
		transcriptEntries: 1,
		conversationTurns: 1,
	};
}

const summaryResult = {
	transcriptEntries: 1,
	conversationTurns: 1,
	llm: { model: "m", inputTokens: 1, outputTokens: 1, apiLatencyMs: 1, stopReason: "end_turn" },
	stats: { filesChanged: 1, insertions: 2, deletions: 0 },
	topics: [{ title: "T", trigger: "x", response: "y", decisions: "z" }],
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getIndexEntryMap).mockResolvedValue(new Map());
	vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-ant-test" } as never);
	vi.mocked(generateSummary).mockResolvedValue(summaryResult as never);
	vi.mocked(getCurrentBranch).mockResolvedValue("main");
});
afterEach(() => {
	delete process.env.ANTHROPIC_API_KEY;
});

describe("runBackfill", () => {
	it("generates a summary for an attributed commit and triggers ONE ingest after the batch", async () => {
		vi.mocked(attributeCommits).mockReturnValue({ attributed: new Map([["c1", attrFor("c1")]]), skipped: [] });

		const report = await runBackfill({ cwd: CWD, hashes: ["c1"] });

		expect(report.generated).toBe(1);
		expect(vi.mocked(storeSummary)).toHaveBeenCalledTimes(1);
		const stored = vi.mocked(storeSummary).mock.calls[0][0];
		expect(stored.backfilled).toBe(true);
		expect(stored.backfillConfidence).toBe("high");
		expect(stored.backfillMethod).toBe("file-overlap");
		expect(stored.branch).toBe("feat");
		// Exactly one ingest trigger for the whole batch.
		expect(vi.mocked(enqueueIngestOperation)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(launchWorker)).toHaveBeenCalledTimes(1);
	});

	it("falls back to [cwd] when `git worktree list` fails", async () => {
		const { execGit } = await import("../core/GitOps.js");
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) =>
			args[0] === "worktree"
				? ({ exitCode: 1, stdout: "", stderr: "no worktrees" } as never)
				: ({ exitCode: 0, stdout: "", stderr: "" } as never),
		);
		vi.mocked(attributeCommits).mockReturnValue({ attributed: new Map([["c1", attrFor("c1")]]), skipped: [] });
		const report = await runBackfill({ cwd: CWD, hashes: ["c1"] });
		// worktree-list failure must not abort the run — roots defaults to just [cwd].
		expect(report.generated).toBe(1);
	});

	it("attaches the commit subject (from the target index) to the outcome", async () => {
		const { buildCommitTargetIndex } = await import("./CommitTargetIndex.js");
		vi.mocked(buildCommitTargetIndex).mockResolvedValue({
			commitMeta: new Map([["c1", { ts: 1, subject: "Fix the login bug" }]]),
			commitFiles: new Map(),
			fileToCommits: new Map(),
			baseToCommits: new Map(),
		} as never);
		vi.mocked(attributeCommits).mockReturnValue({ attributed: new Map([["c1", attrFor("c1")]]), skipped: [] });
		const report = await runBackfill({ cwd: CWD, hashes: ["c1"] });
		expect(report.outcomes[0].commitSubject).toBe("Fix the login bug");
	});

	it("dry-run reports would-generate without calling the LLM or triggering ingest", async () => {
		vi.mocked(attributeCommits).mockReturnValue({ attributed: new Map([["c1", attrFor("c1")]]), skipped: [] });

		const report = await runBackfill({ cwd: CWD, hashes: ["c1"], dryRun: true });

		expect(report.outcomes[0].status).toBe("would-generate");
		expect(vi.mocked(generateSummary)).not.toHaveBeenCalled();
		expect(vi.mocked(enqueueIngestOperation)).not.toHaveBeenCalled();
		expect(vi.mocked(launchWorker)).not.toHaveBeenCalled();
	});

	it("skips commits that already have a summary", async () => {
		vi.mocked(getIndexEntryMap).mockResolvedValue(new Map([["c1", {} as never]]));
		vi.mocked(attributeCommits).mockReturnValue({ attributed: new Map(), skipped: [] });

		const report = await runBackfill({ cwd: CWD, hashes: ["c1"] });
		expect(report.outcomes[0].status).toBe("skipped-has-summary");
		// All candidates already summarized → no attribution / ingest at all.
		expect(vi.mocked(attributeCommits)).not.toHaveBeenCalled();
	});

	it("generates a diff-only summary when no conversation is attributed (mirrors live no-session path)", async () => {
		vi.mocked(attributeCommits).mockReturnValue({ attributed: new Map(), skipped: ["c1"] });
		const report = await runBackfill({ cwd: CWD, hashes: ["c1"] });
		expect(report.outcomes[0].status).toBe("generated");
		expect(report.outcomes[0].method).toBe("diff-only");
		expect(report.generated).toBe(1);
		const stored = vi.mocked(storeSummary).mock.calls[0][0];
		expect(stored.backfilled).toBe(true);
		expect(stored.backfillMethod).toBe("diff-only");
		expect(stored.backfillConfidence).toBeUndefined();
		expect(stored.transcripts).toBeUndefined(); // no transcript artifact for diff-only
		// No transcript artifact passed to storeSummary.
		expect(vi.mocked(storeSummary).mock.calls[0][3]).toBeUndefined();
		// Diff-only summaries still count as generated → ingest fires once.
		expect(vi.mocked(enqueueIngestOperation)).toHaveBeenCalledTimes(1);
	});

	it("errors (not throws) when no LLM credentials are configured", async () => {
		vi.mocked(loadConfig).mockResolvedValue({} as never);
		vi.mocked(attributeCommits).mockReturnValue({ attributed: new Map([["c1", attrFor("c1")]]), skipped: [] });
		const report = await runBackfill({ cwd: CWD, hashes: ["c1"] });
		expect(report.errors).toBe(1);
		expect(report.outcomes[0].message).toMatch(/credentials/);
		expect(vi.mocked(generateSummary)).not.toHaveBeenCalled();
	});

	it("turns a per-commit LLM failure into an error outcome and keeps going", async () => {
		vi.mocked(attributeCommits).mockReturnValue({
			attributed: new Map([
				["c1", attrFor("c1")],
				["c2", attrFor("c2")],
			]),
			skipped: [],
		});
		vi.mocked(generateSummary)
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce(summaryResult as never);

		const report = await runBackfill({ cwd: CWD, hashes: ["c1", "c2"], onProgress: vi.fn() });
		expect(report.errors).toBe(1);
		expect(report.generated).toBe(1);
		// One generated → ingest still fires once.
		expect(vi.mocked(launchWorker)).toHaveBeenCalledTimes(1);
	});

	it("labels the branch 'backfilled' when no conversation branch is known (diff-only)", async () => {
		// A historical commit's dev branch can't be recovered after the fact, so a
		// diff-only summary uses an explicit "backfilled" marker rather than the
		// run-time HEAD (which would be wrong).
		vi.mocked(attributeCommits).mockReturnValue({ attributed: new Map(), skipped: ["c1"] });
		await runBackfill({ cwd: CWD, hashes: ["c1"] });
		expect(vi.mocked(storeSummary).mock.calls[0][0].branch).toBe("backfilled");
	});

	it("keeps the attributed conversation's branch when one was found", async () => {
		vi.mocked(attributeCommits).mockReturnValue({ attributed: new Map([["c1", attrFor("c1")]]), skipped: [] });
		await runBackfill({ cwd: CWD, hashes: ["c1"] });
		expect(vi.mocked(storeSummary).mock.calls[0][0].branch).toBe("feat"); // attrFor sets branch "feat"
	});

	it("passes cursor candidates (incl. an out-of-range neighbor), emitOnly, worktreeRoots and minTier", async () => {
		const c1Ts = Date.parse("2026-06-10T00:00:00Z");
		const c0Ts = Date.parse("2026-06-09T00:00:00Z"); // within [c1Ts − 7d, c1Ts]
		const { buildCommitTargetIndex } = await import("./CommitTargetIndex.js");
		vi.mocked(buildCommitTargetIndex).mockResolvedValue({
			commitMeta: new Map([["c1", { ts: c1Ts, subject: "s" }]]),
			commitFiles: new Map(),
			fileToCommits: new Map(),
			baseToCommits: new Map(),
		} as never);
		const { execGit } = await import("../core/GitOps.js");
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			if (args[0] === "worktree")
				return { exitCode: 0, stdout: "worktree e:/repo\nworktree e:/repo-wt2\n", stderr: "" } as never;
			// gatherCursorCandidates own-commit range query (author time in seconds).
			// Includes a malformed line (skipped) and an ancient out-of-range commit (filtered).
			if (args[0] === "log") {
				const ancient = Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000);
				return {
					exitCode: 0,
					stdout: `c1|${Math.floor(c1Ts / 1000)}\nc0|${Math.floor(c0Ts / 1000)}\ngarbage-no-pipe\ncAncient|${ancient}`,
					stderr: "",
				} as never;
			}
			return { exitCode: 0, stdout: "", stderr: "" } as never;
		});
		vi.mocked(attributeCommits).mockReturnValue({ attributed: new Map([["c1", attrFor("c1")]]), skipped: [] });

		await runBackfill({ cwd: CWD, hashes: ["c1"], minTier: "medium" });

		const call = vi.mocked(attributeCommits).mock.calls[0];
		// c0 (out of `--last N`, but in the 7-day range) is pulled in as a cursor boundary.
		expect(call[0]).toEqual(expect.arrayContaining(["c1", "c0"]));
		// The ancient commit is outside [minTs−7d, maxTs] and the garbage line is ignored.
		expect(call[0]).not.toContain("cAncient");
		expect(call[0]).not.toContain("garbage-no-pipe");
		const opts = call[3] as { minTier: string; emitOnly: Set<string>; worktreeRoots: string[] };
		expect(opts.minTier).toBe("medium");
		expect(opts.worktreeRoots).toEqual(["e:/repo", "e:/repo-wt2"]);
		expect([...opts.emitOnly]).toEqual(["c1"]); // only the missing commit is emitted
	});

	it("passes through low-confidence / branch-match attribution to storeSummary and outcome", async () => {
		vi.mocked(attributeCommits).mockReturnValue({
			attributed: new Map([["c1", attrFor("c1", "low")]]),
			skipped: [],
		});
		const report = await runBackfill({ cwd: CWD, hashes: ["c1"], minTier: "low" });
		const stored = vi.mocked(storeSummary).mock.calls[0][0];
		expect(stored.backfillConfidence).toBe("low");
		expect(stored.backfillMethod).toBe("time-window");
		expect(report.outcomes[0].confidence).toBe("low");
		expect(report.outcomes[0].method).toBe("time-window");

		vi.mocked(storeSummary).mockClear();
		vi.mocked(attributeCommits).mockReturnValue({
			attributed: new Map([["c2", attrFor("c2", "medium")]]),
			skipped: [],
		});
		await runBackfill({ cwd: CWD, hashes: ["c2"], minTier: "medium" });
		expect(vi.mocked(storeSummary).mock.calls[0][0].backfillMethod).toBe("branch-match");
		expect(vi.mocked(storeSummary).mock.calls[0][0].backfillConfidence).toBe("medium");
	});

	it("defaults minTier to the unified 'low' tier when the caller omits it", async () => {
		vi.mocked(attributeCommits).mockReturnValue({ attributed: new Map([["c1", attrFor("c1")]]), skipped: [] });
		await runBackfill({ cwd: CWD, hashes: ["c1"] });
		const opts = vi.mocked(attributeCommits).mock.calls[0][3] as { minTier: string };
		expect(opts.minTier).toBe("low");
	});

	it("discovers worktree roots and tolerates a failed tree-hash lookup", async () => {
		const { execGit } = await import("../core/GitOps.js");
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			if (args[0] === "worktree")
				return { exitCode: 0, stdout: "worktree e:/repo\nworktree e:/repo-wt2\n", stderr: "" } as never;
			if (args[0] === "rev-parse") return { exitCode: 1, stdout: "", stderr: "bad" } as never; // tree lookup fails
			return { exitCode: 0, stdout: "", stderr: "" } as never;
		});
		vi.mocked(attributeCommits).mockReturnValue({ attributed: new Map([["c1", attrFor("c1")]]), skipped: [] });
		await runBackfill({ cwd: CWD, hashes: ["c1"] });
		const stored = vi.mocked(storeSummary).mock.calls[0][0];
		expect(stored.treeHash).toBeUndefined(); // rev-parse failed → no treeHash
	});

	it("dry-run reports diff-only would-generate when no conversation is attributed", async () => {
		vi.mocked(attributeCommits).mockReturnValue({ attributed: new Map(), skipped: ["c1"] });
		const report = await runBackfill({ cwd: CWD, hashes: ["c1"], dryRun: true });
		expect(report.outcomes[0].status).toBe("would-generate");
		expect(report.outcomes[0].method).toBe("diff-only");
		expect(report.outcomes[0].confidence).toBeUndefined();
	});

	it("stamps treeHash, ticketId, and recap", async () => {
		const { execGit } = await import("../core/GitOps.js");
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			if (args[0] === "rev-parse") return { exitCode: 0, stdout: "treeSHA123", stderr: "" } as never;
			return { exitCode: 0, stdout: "", stderr: "" } as never;
		});
		vi.mocked(generateSummary).mockResolvedValue({
			...summaryResult,
			ticketId: "JOLLI-9",
			recap: "did stuff",
		} as never);
		const a = { ...attrFor("c1"), branch: "" };
		vi.mocked(attributeCommits).mockReturnValue({ attributed: new Map([["c1", a]]), skipped: [] });

		await runBackfill({ cwd: CWD, hashes: ["c1"] });
		const stored = vi.mocked(storeSummary).mock.calls[0][0];
		expect(stored.treeHash).toBe("treeSHA123");
		expect(stored.ticketId).toBe("JOLLI-9");
		expect(stored.recap).toBe("did stuff");
		// attribution has no branch → diff-only "backfilled" label.
		expect(stored.branch).toBe("backfilled");
	});
});

describe("countMissingSummaries / own-commit scoping", () => {
	it("counts only commits whose hash is absent from the summary index", async () => {
		const { execGit } = await import("../core/GitOps.js");
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			if (args[0] === "config") return { exitCode: 0, stdout: "me@dev.io", stderr: "" } as never;
			return { exitCode: 0, stdout: "h1\nh2\nh3", stderr: "" } as never;
		});
		vi.mocked(getIndexEntryMap).mockResolvedValue(new Map([["h2", {} as never]]));
		const { missing, total } = await countMissingSummaries(CWD);
		expect(total).toBe(3);
		expect(missing).toBe(2);
	});

	it("matches the author literally via --fixed-strings (regex metachars are not escaped)", async () => {
		const { execGit } = await import("../core/GitOps.js");
		const calls: string[][] = [];
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			calls.push([...args]);
			// Gmail-style alias: '+' is a BRE literal — escaping it would match nothing.
			if (args[0] === "config") return { exitCode: 0, stdout: "me+tag@dev.io", stderr: "" } as never;
			return { exitCode: 0, stdout: "h1", stderr: "" } as never;
		});
		vi.mocked(getIndexEntryMap).mockResolvedValue(new Map());
		await countMissingSummaries(CWD);
		const revList = calls.find((c) => c[0] === "rev-list");
		// Literal substring match: no backslash escaping, and --fixed-strings present.
		expect(revList).toContain("--author=me+tag@dev.io");
		expect(revList).toContain("--fixed-strings");
	});

	it("scopes rev-list to BOTH author email and name (git --author OR, literal)", async () => {
		const { execGit } = await import("../core/GitOps.js");
		const calls: string[][] = [];
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			calls.push([...args]);
			if (args[0] === "config" && args[1] === "user.email")
				return { exitCode: 0, stdout: "me@dev.io", stderr: "" } as never;
			if (args[0] === "config" && args[1] === "user.name")
				return { exitCode: 0, stdout: "J. Doe (Acme)", stderr: "" } as never;
			return { exitCode: 0, stdout: "h1", stderr: "" } as never;
		});
		const { recentCommitHashes } = await import("./BackfillEngine.js");
		await recentCommitHashes(CWD, 10);
		const revList = calls.find((c) => c[0] === "rev-list");
		// Two --author patterns → git ORs them; both passed verbatim (name with '( )'
		// would match zero commits if regex-escaped, hence --fixed-strings).
		expect(revList).toContain("--author=me@dev.io");
		expect(revList).toContain("--author=J. Doe (Acme)");
		expect(revList).toContain("--fixed-strings");
	});

	it("uses the name filter alone when only user.name is set", async () => {
		const { execGit } = await import("../core/GitOps.js");
		const calls: string[][] = [];
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			calls.push([...args]);
			if (args[0] === "config" && args[1] === "user.name")
				return { exitCode: 0, stdout: "Me Dev", stderr: "" } as never;
			if (args[0] === "config") return { exitCode: 0, stdout: "", stderr: "" } as never; // no email
			return { exitCode: 0, stdout: "h1", stderr: "" } as never;
		});
		const { recentCommitHashes } = await import("./BackfillEngine.js");
		await recentCommitHashes(CWD, 10);
		const revList = calls.find((c) => c[0] === "rev-list");
		const authors = revList?.filter((a) => a.startsWith("--author=")) ?? [];
		expect(authors).toEqual(["--author=Me Dev"]);
		expect(revList).toContain("--fixed-strings");
	});

	it("returns [] when rev-list fails or is empty", async () => {
		const { execGit } = await import("../core/GitOps.js");
		vi.mocked(execGit).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "boom" } as never);
		const { recentCommitHashes } = await import("./BackfillEngine.js");
		expect(await recentCommitHashes(CWD)).toEqual([]);
		expect(await recentCommitHashes(CWD, 10)).toEqual([]);
	});

	it("drops the author filter when no git email is configured", async () => {
		const { execGit } = await import("../core/GitOps.js");
		const calls: string[][] = [];
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			calls.push([...args]);
			if (args[0] === "config") return { exitCode: 0, stdout: "", stderr: "" } as never;
			return { exitCode: 0, stdout: "h1", stderr: "" } as never;
		});
		vi.mocked(getIndexEntryMap).mockResolvedValue(new Map());
		await countMissingSummaries(CWD);
		const revList = calls.find((c) => c[0] === "rev-list");
		// No identity → neither --author nor the --fixed-strings that accompanies it.
		expect(revList?.some((a) => a.startsWith("--author="))).toBe(false);
		expect(revList).not.toContain("--fixed-strings");
	});
});
