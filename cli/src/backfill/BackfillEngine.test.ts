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

function attrFor(hash: string, confidence: "high" | "medium" = "high") {
	return {
		commitHash: hash,
		confidence,
		method: confidence === "high" ? ("file-overlap" as const) : ("time-window" as const),
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

	it("falls back to the current branch when attribution has no branch", async () => {
		const a = { ...attrFor("c1"), branch: "" };
		vi.mocked(attributeCommits).mockReturnValue({ attributed: new Map([["c1", a]]), skipped: [] });
		await runBackfill({ cwd: CWD, hashes: ["c1"] });
		expect(vi.mocked(storeSummary).mock.calls[0][0].branch).toBe("main");
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

	it("stamps treeHash, ticketId, and recap; tolerates getCurrentBranch failure", async () => {
		const { execGit, getCurrentBranch } = await import("../core/GitOps.js");
		vi.mocked(getCurrentBranch).mockRejectedValue(new Error("detached"));
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
		// attribution empty + getCurrentBranch threw → ORPHAN_BRANCH fallback (non-empty).
		expect(stored.branch).toMatch(/summaries/);
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

	it("scopes rev-list to the local author when git user.email is set", async () => {
		const { execGit } = await import("../core/GitOps.js");
		const calls: string[][] = [];
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			calls.push([...args]);
			if (args[0] === "config") return { exitCode: 0, stdout: "me@dev.io", stderr: "" } as never;
			return { exitCode: 0, stdout: "h1", stderr: "" } as never;
		});
		vi.mocked(getIndexEntryMap).mockResolvedValue(new Map());
		await countMissingSummaries(CWD);
		const revList = calls.find((c) => c[0] === "rev-list");
		expect(revList).toContain("--author=me@dev.io");
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
		expect(revList?.some((a) => a.startsWith("--author="))).toBe(false);
	});
});
