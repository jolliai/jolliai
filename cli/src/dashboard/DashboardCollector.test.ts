import { describe, expect, it, vi } from "vitest";
import type { GitCommandResult, SessionInfo, TranscriptReadResult } from "../Types.js";

vi.mock("../core/GitOps.js", () => ({
	execGit: vi.fn(),
	getCurrentBranch: vi.fn(),
}));
vi.mock("../core/SummaryStore.js", () => ({
	getIndex: vi.fn(),
	getSummary: vi.fn(),
	readTranscriptsForCommits: vi.fn(),
}));
vi.mock("../core/TranscriptReader.js", () => ({
	readTranscript: vi.fn(),
}));
// The default session loader fans out to every discoverer; mock the registry
// loader so `loadAllSessions` has one deterministic success and the rest of
// the discoverers run for real against a directory that has none of their stores.
vi.mock("../core/SessionTracker.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../core/SessionTracker.js")>();
	return { ...original, loadAllSessions: vi.fn() };
});

import { execGit, getCurrentBranch } from "../core/GitOps.js";
import { loadAllSessions as loadRegistrySessions } from "../core/SessionTracker.js";
import { getIndex, getSummary, readTranscriptsForCommits } from "../core/SummaryStore.js";
import { readTranscript } from "../core/TranscriptReader.js";
import {
	collectCommitEvents,
	collectFilesForCommits,
	collectSessionEvents,
	collectSummaryEvents,
	collectWorktreeEvent,
	loadAllSessions,
	parseNumstatLog,
	summaryEventFromCommitSummary,
} from "./DashboardCollector.js";

const git = (stdout: string): GitCommandResult => ({ stdout, stderr: "", exitCode: 0 });
const gitFail = (stderr: string): GitCommandResult => ({ stdout: "", stderr, exitCode: 128 });

const claudeSession = (over: Partial<SessionInfo> = {}): SessionInfo => ({
	sessionId: "s1",
	transcriptPath: "/t/s1.jsonl",
	updatedAt: "2026-07-30T08:00:00.000Z",
	source: "claude",
	...over,
});

const transcript = (over: Partial<TranscriptReadResult> = {}): TranscriptReadResult => ({
	entries: [
		{ role: "human", content: "hi", timestamp: "2026-07-30T07:00:00.000Z" },
		{ role: "assistant", content: "hello", timestamp: "2026-07-30T07:30:00.000Z" },
	],
	newCursor: { transcriptPath: "/t/s1.jsonl", lineNumber: 2, updatedAt: "t" },
	totalLinesRead: 2,
	usageByModel: [{ model: "claude-opus-4-8", provider: "anthropic", input: 100, output: 50, cached: 10 }],
	...over,
});

describe("collectSessionEvents", () => {
	it("emits a full-coverage event for a Claude session with usage and duration", async () => {
		vi.mocked(readTranscript).mockResolvedValue(transcript());
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w",
			loadSessions: async () => [claudeSession({ title: "Fix the bug" })],
		});
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			source: "claude",
			sessionId: "s1",
			title: "Fix the bug",
			messageCount: 2,
			startedAtMs: Date.parse("2026-07-30T07:00:00.000Z"),
			durationMs: 30 * 60 * 1000,
			tokenCoverage: "full",
		});
		expect(events[0].models).toEqual([
			expect.objectContaining({ model: "claude-opus-4-8", inputTokens: 100, outputTokens: 50, cachedTokens: 10 }),
		]);
		// claude-opus-4-8 is priced — the estimate must be present and positive.
		expect(events[0].models?.[0].estCostUsd).toBeGreaterThan(0);
	});

	it("labels a Claude session with no usage as sessions-only", async () => {
		vi.mocked(readTranscript).mockResolvedValue(transcript({ usageByModel: [] }));
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w",
			loadSessions: async () => [claudeSession()],
		});
		expect(events[0].tokenCoverage).toBe("sessions-only");
		expect(events[0].models).toBeUndefined();
	});

	it("keeps a session whose transcript is unreadable, with what the discoverer knew", async () => {
		vi.mocked(readTranscript).mockRejectedValue(new Error("moved"));
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w",
			loadSessions: async () => [claudeSession()],
		});
		expect(events).toHaveLength(1);
		expect(events[0].messageCount).toBeUndefined();
	});

	it("does not read transcripts for non-Claude sources — no per-turn usage exists there", async () => {
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w",
			loadSessions: async () => [claudeSession({ source: "cursor", sessionId: "c1" })],
		});
		expect(events).toEqual([
			expect.objectContaining({
				source: "cursor",
				sessionId: "c1",
				updatedAtMs: Date.parse("2026-07-30T08:00:00.000Z"),
			}),
		]);
		expect(readTranscript).not.toHaveBeenCalled();
	});

	it("dedupes (source, sessionId), keeping the newest, and drops unparseable timestamps", async () => {
		vi.mocked(readTranscript).mockResolvedValue(transcript({ usageByModel: [] }));
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w",
			loadSessions: async () => [
				claudeSession({ updatedAt: "2026-07-29T00:00:00.000Z" }),
				claudeSession({ updatedAt: "2026-07-30T00:00:00.000Z" }),
				claudeSession({ sessionId: "junk", updatedAt: "not-a-date" }),
			],
		});
		expect(events).toHaveLength(1);
		expect(events[0].updatedAtMs).toBe(Date.parse("2026-07-30T00:00:00.000Z"));
	});

	it("omits start/duration when the transcript carries no timestamps", async () => {
		vi.mocked(readTranscript).mockResolvedValue(
			transcript({
				entries: [
					{ role: "human", content: "hi" },
					{ role: "assistant", content: "yo" },
				],
				usageByModel: [
					{ model: "totally-unpriced-model", provider: "unknown", input: 1, output: 1, cached: 0 },
				],
			}),
		);
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w",
			loadSessions: async () => [claudeSession()],
		});
		expect(events[0]).not.toHaveProperty("startedAtMs");
		expect(events[0]).not.toHaveProperty("durationMs");
		// Unpriced model: usage recorded, cost honestly absent (not zero).
		expect(events[0].models?.[0]).not.toHaveProperty("estCostUsd");
	});

	it("treats a missing source as claude (registry back-compat)", async () => {
		vi.mocked(readTranscript).mockResolvedValue(transcript({ usageByModel: [] }));
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w",
			loadSessions: async () => {
				const { source: _omit, ...noSource } = claudeSession();
				return [noSource];
			},
		});
		expect(events[0].source).toBe("claude");
	});
});

describe("loadAllSessions (default loader)", () => {
	it("aggregates across discoverers and survives one of them throwing", async () => {
		vi.mocked(loadRegistrySessions).mockRejectedValue(new Error("registry unreadable"));
		// Every other discoverer scans a directory with no agent stores → empty.
		const sessions = await loadAllSessions("/tmp/definitely-no-agents-here");
		expect(Array.isArray(sessions)).toBe(true);
	});

	it("returns registry sessions when that loader succeeds", async () => {
		vi.mocked(loadRegistrySessions).mockResolvedValue([claudeSession()]);
		const sessions = await loadAllSessions("/tmp/definitely-no-agents-here");
		expect(sessions).toContainEqual(claudeSession());
	});
});

describe("collectCommitEvents", () => {
	const SEP = "\u001f";
	const REC = "\u0001";

	it("combines git log, branch reachability and summary-index enrichment", async () => {
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			if (args[0] === "log") {
				return git(
					[
						`aaa${SEP}2026-07-30T08:00:00+08:00${SEP}Foster${SEP}f@x.com${SEP}feat: one`,
						`bbb${SEP}2026-07-29T08:00:00+08:00${SEP}Foster${SEP}f@x.com${SEP}fix: two`,
					].join("\n"),
				);
			}
			if (args[0] === "for-each-ref") return git("main\nfeature/x\n");
			if (args[0] === "rev-list" && args[1] === "main") return git("aaa\nbbb\n");
			if (args[0] === "rev-list" && args[1] === "feature/x") return git("aaa\n");
			// The numstat pass is a separate `git log`, prefixed with -c.
			if (args[0] === "-c") {
				return git(
					[`${REC}aaa`, "10\t2\tsrc/a.ts", "-\t-\tdocs/logo.png", `${REC}bbb`, "1\t0\tsrc/a.ts"].join("\n"),
				);
			}
			throw new Error(`unexpected git ${args.join(" ")}`);
		});
		vi.mocked(getIndex).mockResolvedValue({
			version: 3,
			entries: [
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "feat: one",
					commitDate: "2026-07-30",
					branch: "feature/x",
					generatedAt: "t",
					diffStats: { filesChanged: 3, insertions: 10, deletions: 2 },
				},
			],
		});

		const events = await collectCommitEvents({ repoIdentity: "r", cwd: "/w" });
		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({
			hash: "aaa",
			message: "feat: one",
			authorName: "Foster",
			branch: "feature/x", // recorded branch from the summary index
			branches: ["main", "feature/x"],
			filesChanged: 3,
			insertions: 10,
			deletions: 2,
		});
		expect(events[0]?.files).toEqual([
			{ path: "src/a.ts", insertions: 10, deletions: 2 },
			// Binary: git prints "-", so neither count is recorded rather than 0.
			{ path: "docs/logo.png" },
		]);
		expect(events[1]).toMatchObject({ hash: "bbb", branches: ["main"] });
		expect(events[1]?.files).toEqual([{ path: "src/a.ts", insertions: 1, deletions: 0 }]);
		expect(events[1]).not.toHaveProperty("filesChanged");
	});

	it("passes --since through to log and rev-list when given", async () => {
		const calls: string[][] = [];
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			calls.push([...args]);
			if (args[0] === "log") return git("");
			if (args[0] === "for-each-ref") return git("main\n");
			return git("");
		});
		vi.mocked(getIndex).mockResolvedValue(null);
		await collectCommitEvents({ repoIdentity: "r", cwd: "/w", sinceMs: 1_700_000_000_000 });
		const logCall = calls.find((c) => c[0] === "log");
		expect(logCall?.join(" ")).toContain("--since=2023-11-14T22:13:20.000Z");
	});

	it("scopes both log passes to local branches and HEAD, never --all", async () => {
		// The commit pass and the file-stats pass must agree with the attribution
		// loop, which walks refs/heads. Under `--all` a commit living only on a
		// remote-tracking ref or a tag was imported as this machine's work and then
		// displayed with no branch, because refs/heads could not explain it.
		const calls: string[][] = [];
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			calls.push([...args]);
			if (args[0] === "for-each-ref") return git("main\n");
			return git("");
		});
		vi.mocked(getIndex).mockResolvedValue(null);
		await collectCommitEvents({ repoIdentity: "r", cwd: "/w" });
		const logPasses = calls.filter((c) => c[0] === "log" || c[0] === "-c");
		expect(logPasses).toHaveLength(2);
		for (const pass of logPasses) {
			expect(pass).toContain("--branches");
			expect(pass).toContain("HEAD");
			expect(pass).not.toContain("--all");
		}
	});

	it("still emits commits when only the numstat pass fails, without a files field", async () => {
		// The numstat pass is deliberately separate so its failure costs file
		// detail and nothing else — this is the test that pins that down.
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			if (args[0] === "-c") return gitFail("numstat exploded");
			if (args[0] === "log") return git(`aaa${SEP}2026-07-30T08:00:00+08:00${SEP}F${SEP}f@x${SEP}feat: one`);
			if (args[0] === "for-each-ref") return git("main\n");
			return git("aaa\n");
		});
		vi.mocked(getIndex).mockResolvedValue(null);
		const events = await collectCommitEvents({ repoIdentity: "r", cwd: "/w" });
		expect(events).toHaveLength(1);
		// Absent, not empty — an empty array would delete rows a previous pass got.
		expect(events[0]).not.toHaveProperty("files");
	});

	it("THROWS when git log fails rather than reporting an empty history", async () => {
		// [] is a claim, not an absence: the caller prunes every stored commit the
		// collection did not list. `execGit` reports a >10 MB stdout overflow as
		// exit 1, so a large history reached this branch and wiped the commit layer.
		vi.mocked(execGit).mockResolvedValue(gitFail("not a repo"));
		vi.mocked(getIndex).mockResolvedValue(null);
		await expect(collectCommitEvents({ repoIdentity: "r", cwd: "/w" })).rejects.toThrow(/git log failed/);
	});

	it("still tolerates a rev-list failure per branch once the log itself succeeded", async () => {
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			if (args[0] === "log") return git(`aaa${SEP}2026-07-30T08:00:00+08:00${SEP}F${SEP}f@x${SEP}feat: one`);
			if (args[0] === "for-each-ref") return git("main\n");
			// The per-branch reachability pass fails; the commit survives unattributed.
			return gitFail("rev-list exploded");
		});
		vi.mocked(getIndex).mockResolvedValue(null);
		const events = await collectCommitEvents({ repoIdentity: "r", cwd: "/w" });
		expect(events).toHaveLength(1);
		expect(events[0].branches ?? []).toEqual([]);
	});

	it("skips malformed log lines and survives a missing summary index", async () => {
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			if (args[0] === "log") return git(`ccc${SEP}not-a-date${SEP}a${SEP}b${SEP}subject\n\n`);
			if (args[0] === "for-each-ref") return gitFail("boom");
			return git("");
		});
		vi.mocked(getIndex).mockRejectedValue(new Error("no orphan branch"));
		expect(await collectCommitEvents({ repoIdentity: "r", cwd: "/w" })).toEqual([]);
	});
});

describe("parseNumstatLog", () => {
	const REC = "\u0001";

	it("keeps a merge commit as an empty list rather than dropping it", () => {
		// A merge shows no diff under --numstat, so its record has no rows. That
		// is "changed nothing", which is different from "not collected" — the
		// latter must stay expressible as an ABSENT map entry.
		const parsed = parseNumstatLog([`${REC}merge1`, `${REC}real1`, "3\t1\tsrc/a.ts"].join("\n"));
		expect(parsed.get("merge1")).toEqual([]);
		expect(parsed.get("real1")).toEqual([{ path: "src/a.ts", insertions: 3, deletions: 1 }]);
	});

	it("skips a line that did not split into three fields instead of storing a broken path", () => {
		const parsed = parseNumstatLog([`${REC}c1`, "1\t2", "", "4\t5\tsrc/ok.ts"].join("\n"));
		expect(parsed.get("c1")).toEqual([{ path: "src/ok.ts", insertions: 4, deletions: 5 }]);
	});

	it("caps a mechanical commit rather than storing thousands of paths", () => {
		const lines = [`${REC}huge`];
		for (let i = 0; i < 250; i++) lines.push(`1\t1\tvendor/f${i}.js`);
		const parsed = parseNumstatLog(lines.join("\n"));
		expect(parsed.get("huge")).toHaveLength(200);
	});

	it("keeps non-ASCII paths verbatim", () => {
		const parsed = parseNumstatLog([`${REC}c1`, "1\t0\t\u6587\u6863/\u8bf4\u660e.md"].join("\n"));
		expect(parsed.get("c1")?.[0]?.path).toBe("\u6587\u6863/\u8bf4\u660e.md");
	});
});

describe("collectFilesForCommits", () => {
	it("returns an empty map for no hashes without spawning git", async () => {
		vi.mocked(execGit).mockClear();
		expect((await collectFilesForCommits([], "/w")).size).toBe(0);
		expect(execGit).not.toHaveBeenCalled();
	});

	it("returns an empty map when git fails, so the caller omits files rather than clearing them", async () => {
		vi.mocked(execGit).mockResolvedValue(gitFail("bad object"));
		expect((await collectFilesForCommits(["aaa"], "/w")).size).toBe(0);
	});
});

describe("collectWorktreeEvent", () => {
	it("passes the current branch to the observation", async () => {
		vi.mocked(getCurrentBranch).mockResolvedValue("main");
		vi.mocked(execGit).mockResolvedValue(git(" 1 file changed, 2 insertions(+)"));
		const event = await collectWorktreeEvent("r", "/w", () => 7);
		expect(event).toMatchObject({ branch: "main", filesChanged: 1, insertions: 2, deletions: 0, observedAtMs: 7 });
	});

	it("maps detached HEAD to no branch (the '' sentinel downstream)", async () => {
		vi.mocked(getCurrentBranch).mockResolvedValue("HEAD");
		vi.mocked(execGit).mockResolvedValue(git(""));
		const event = await collectWorktreeEvent("r", "/w");
		expect(event).not.toHaveProperty("branch");
	});

	it("still observes when the branch lookup itself fails", async () => {
		vi.mocked(getCurrentBranch).mockRejectedValue(new Error("no HEAD"));
		vi.mocked(execGit).mockResolvedValue(git(""));
		const event = await collectWorktreeEvent("r", "/w");
		expect(event).toMatchObject({ filesChanged: 0 });
	});
});

describe("summaryEventFromCommitSummary", () => {
	const baseSummary = {
		version: 5,
		commitHash: "abc123",
		commitMessage: "feat: dashboard\n\nlong body",
		commitAuthor: "Dev",
		commitDate: "2026-07-30T09:00:00Z",
		branch: "feature/dash",
		generatedAt: "2026-07-30T09:01:00Z",
		ticketId: "JOLLI-2069",
		conversationTurns: 12,
		conversationTokens: 34000,
		estimatedCostUsd: 2.5,
		topics: [
			{
				title: "Storage",
				trigger: "t",
				response: "r",
				decisions: "Use node:sqlite",
				todo: "add FTS later",
			},
			{ title: "Empty", trigger: "t", response: "r", decisions: "  " },
		],
		references: [
			{
				archivedKey: "linear:JOLLI-2069-abc1234",
				source: "linear",
				nativeId: "JOLLI-2069",
				title: "Dashboard",
				url: "https://linear.app/x",
				referencedAt: "t",
				sourceToolName: "Linear",
			},
		],
		transcripts: ["t1"],
		// biome-ignore lint/suspicious/noExplicitAny: minimal CommitSummary fixture
	} as any;

	const entry = { role: "human" as const, content: "x" };
	const transcripts = new Map([
		[
			"t1",
			{
				sessions: [
					{ sessionId: "s1", source: "claude" as const, entries: [entry, entry, entry] },
					{ sessionId: "s1", source: "claude" as const, entries: [entry] }, // duplicate — deduped
				],
			},
		],
	]);

	it("maps memory fields, insights, references and exact session links", () => {
		const event = summaryEventFromCommitSummary("repo-1", baseSummary, transcripts);
		expect(event).toMatchObject({
			type: "commit.summary",
			repoIdentity: "repo-1",
			hash: "abc123",
			branch: "feature/dash",
			message: "feat: dashboard",
			turns: 12,
			tokens: 34000,
			estCostUsd: 2.5,
			ticketId: "JOLLI-2069",
		});
		expect(event?.insights).toEqual([
			{ kind: "decision", text: "Use node:sqlite" },
			{ kind: "todo", text: "add FTS later" },
		]);
		expect(event?.references).toEqual([
			{ source: "linear", nativeId: "JOLLI-2069", title: "Dashboard", url: "https://linear.app/x" },
		]);
		expect(event?.sessionLinks).toEqual([
			{ source: "claude", sessionId: "s1", confidence: "exact", messageCount: 3 },
		]);
	});

	it("carries a stored session's own usageByModel into its link, priced", () => {
		const withUsage = new Map([
			[
				"t1",
				{
					sessions: [
						{
							sessionId: "s1",
							source: "claude" as const,
							entries: [entry],
							usageByModel: [
								{
									model: "claude-opus-4-8",
									provider: "anthropic" as const,
									input: 100,
									output: 50,
									cached: 10,
								},
							],
						},
					],
				},
			],
		]);
		const event = summaryEventFromCommitSummary("repo-1", baseSummary, withUsage);
		expect(event?.sessionLinks).toEqual([
			{
				source: "claude",
				sessionId: "s1",
				confidence: "exact",
				messageCount: 1,
				models: [
					expect.objectContaining({
						model: "claude-opus-4-8",
						inputTokens: 100,
						outputTokens: 50,
						cachedTokens: 10,
					}),
				],
			},
		]);
		expect(event?.sessionLinks?.[0].models?.[0].estCostUsd).toBeGreaterThan(0);
	});

	it("attributes an archived skill to the session its usage split names", () => {
		const withSession = new Map([
			["t1", { sessions: [{ sessionId: "s1", source: "claude" as const, entries: [entry] }] }],
		]);
		const event = summaryEventFromCommitSummary(
			"repo-1",
			{
				...baseSummary,
				skills: [
					{
						archivedKey: "claude:jolli-recall-abc",
						source: "claude" as const,
						skill: "jolli-recall",
						entryPaths: ["tool" as const],
						invocationCount: 3,
						firstUsedAt: "2026-08-06T01:24:50.313Z",
						lastUsedAt: "2026-08-06T01:24:50.313Z",
						usageBySession: {
							"claude:s1": { input: 8, cached: 13730, output: 5215, confidence: "attributed" as const },
						},
					},
				],
			},
			withSession,
		);
		expect(event?.sessionLinks?.[0].tools).toEqual([{ name: "jolli-recall", kind: "skill", calls: 3 }]);
	});

	it("falls back to the memory's single link of the ref's source when there is no usage split", () => {
		// codex archives a heuristic ref with no usageBySession — still unambiguous
		// when the memory has exactly one codex session.
		const withSession = new Map([
			["t1", { sessions: [{ sessionId: "cx", source: "codex" as const, entries: [entry] }] }],
		]);
		const event = summaryEventFromCommitSummary(
			"repo-1",
			{
				...baseSummary,
				skills: [
					{
						archivedKey: "codex:jolli-recall-f4f",
						source: "codex" as const,
						skill: "jolli-recall",
						entryPaths: ["tool" as const],
						invocationCount: 1,
						firstUsedAt: "2026-08-07T09:11:15.043Z",
						lastUsedAt: "2026-08-07T09:11:15.043Z",
						detection: "heuristic" as const,
					},
				],
			},
			withSession,
		);
		expect(event?.sessionLinks?.[0].tools).toEqual([{ name: "jolli-recall", kind: "skill", calls: 1 }]);
	});

	it("skips a skill no single session can own rather than splitting its call count", () => {
		const twoSessions = new Map([
			[
				"t1",
				{
					sessions: [
						{ sessionId: "s1", source: "claude" as const, entries: [entry] },
						{ sessionId: "s2", source: "claude" as const, entries: [entry] },
					],
				},
			],
		]);
		const skill = {
			archivedKey: "claude:dataviz-abc",
			source: "claude" as const,
			skill: "dataviz",
			entryPaths: ["tool" as const],
			invocationCount: 4,
			firstUsedAt: "2026-08-06T01:00:00.000Z",
			lastUsedAt: "2026-08-06T02:00:00.000Z",
		};
		// (a) a split naming two sessions — no per-session count exists
		const spanning = summaryEventFromCommitSummary(
			"repo-1",
			{
				...baseSummary,
				skills: [
					{
						...skill,
						usageBySession: {
							"claude:s1": { input: 1, cached: 0, output: 1, confidence: "attributed" as const },
							"claude:s2": { input: 1, cached: 0, output: 1, confidence: "attributed" as const },
						},
					},
				],
			},
			twoSessions,
		);
		// (b) no split at all, and the source names two candidates
		const ambiguous = summaryEventFromCommitSummary("repo-1", { ...baseSummary, skills: [skill] }, twoSessions);

		for (const event of [spanning, ambiguous]) {
			for (const link of event?.sessionLinks ?? []) expect(link).not.toHaveProperty("tools");
		}
	});

	it("never overwrites a transcript-derived skill count with the archived one", () => {
		// `parseToolUse` already emits kind:"skill" rows off the transcript's own
		// blocks; the archived ref is a gap-filler, not a competing source.
		const withTools = new Map([
			[
				"t1",
				{
					sessions: [
						{
							sessionId: "s1",
							source: "claude" as const,
							entries: [entry],
							toolUse: [{ name: "jolli-recall", kind: "skill" as const, calls: 7 }],
						},
					],
				},
			],
		]);
		const event = summaryEventFromCommitSummary(
			"repo-1",
			{
				...baseSummary,
				skills: [
					{
						archivedKey: "claude:jolli-recall-abc",
						source: "claude" as const,
						skill: "jolli-recall",
						entryPaths: ["tool" as const],
						invocationCount: 1,
						firstUsedAt: "2026-08-06T01:24:50.313Z",
						lastUsedAt: "2026-08-06T01:24:50.313Z",
						usageBySession: {
							"claude:s1": { input: 8, cached: 13730, output: 5215, confidence: "attributed" as const },
						},
					},
				],
			},
			withTools,
		);
		expect(event?.sessionLinks?.[0].tools).toEqual([{ name: "jolli-recall", kind: "skill", calls: 7 }]);
	});

	it("appends an archived skill alongside the transcript's other tools", () => {
		const withTools = new Map([
			[
				"t1",
				{
					sessions: [
						{
							sessionId: "s1",
							source: "claude" as const,
							entries: [entry],
							toolUse: [{ name: "Bash", kind: "builtin" as const, calls: 2 }],
						},
					],
				},
			],
		]);
		const event = summaryEventFromCommitSummary(
			"repo-1",
			{
				...baseSummary,
				skills: [
					{
						archivedKey: "claude:dataviz-abc",
						source: "claude" as const,
						skill: "dataviz",
						entryPaths: ["tool" as const],
						invocationCount: 2,
						firstUsedAt: "2026-08-06T01:00:00.000Z",
						lastUsedAt: "2026-08-06T02:00:00.000Z",
						usageBySession: {
							"claude:s1": { input: 1, cached: 0, output: 1, confidence: "attributed" as const },
						},
					},
				],
			},
			withTools,
		);
		expect(event?.sessionLinks?.[0].tools).toEqual([
			{ name: "Bash", kind: "builtin", calls: 2 },
			{ name: "dataviz", kind: "skill", calls: 2 },
		]);
	});

	it("carries a stored session's toolUse into its link", () => {
		const withTools = new Map([
			[
				"t1",
				{
					sessions: [
						{
							sessionId: "s1",
							source: "claude" as const,
							entries: [entry],
							toolUse: [
								{ name: "Bash", kind: "builtin" as const, calls: 3 },
								{
									name: "jollimemory.recall",
									kind: "mcp" as const,
									server: "jollimemory",
									calls: 1,
								},
							],
						},
					],
				},
			],
		]);
		const event = summaryEventFromCommitSummary("repo-1", baseSummary, withTools);
		expect(event?.sessionLinks?.[0].tools).toEqual([
			{ name: "Bash", kind: "builtin", calls: 3 },
			{ name: "jollimemory.recall", kind: "mcp", server: "jollimemory", calls: 1 },
		]);
	});

	it("forwards an empty toolUse but omits the field when the memory recorded none", () => {
		// `[]` is the recorded fact "called no tools" and must reach the projection so
		// it can replace stale rows; absent means the memory predates the field (or the
		// source cannot report tools) and must leave existing rows standing.
		const session = (toolUse?: ReadonlyArray<{ name: string; kind: "builtin"; calls: number }>) =>
			new Map([
				[
					"t1",
					{
						sessions: [
							{
								sessionId: "s1",
								source: "claude" as const,
								entries: [entry],
								...(toolUse && { toolUse }),
							},
						],
					},
				],
			]);

		expect(summaryEventFromCommitSummary("repo-1", baseSummary, session([]))?.sessionLinks?.[0].tools).toEqual([]);
		expect(summaryEventFromCommitSummary("repo-1", baseSummary, session())?.sessionLinks?.[0]).not.toHaveProperty(
			"tools",
		);
	});

	it("returns null for an unparseable commit date", () => {
		const event = summaryEventFromCommitSummary("repo-1", { ...baseSummary, commitDate: "nope" }, new Map());
		expect(event).toBeNull();
	});

	it("tolerates a summary with no topics, references or transcripts", () => {
		const bare = { ...baseSummary, topics: undefined, references: undefined, transcripts: [] };
		const event = summaryEventFromCommitSummary("repo-1", bare, new Map());
		expect(event?.insights).toEqual([]);
		expect(event?.references).toEqual([]);
		expect(event?.sessionLinks).toEqual([]);
	});

	it("collectSummaryEvents projects ROOT summaries only and survives an unreadable one", async () => {
		vi.mocked(getIndex).mockResolvedValue({
			version: 3,
			entries: [
				{ commitHash: "abc123", parentCommitHash: null },
				{ commitHash: "child1", parentCommitHash: "abc123" }, // child — skipped
				{ commitHash: "broken1", parentCommitHash: null },
				// biome-ignore lint/suspicious/noExplicitAny: minimal index fixture
			] as any,
		});
		vi.mocked(getSummary).mockImplementation(async (hash: string) => {
			if (hash === "abc123") return baseSummary;
			throw new Error("orphan read failed");
		});
		vi.mocked(readTranscriptsForCommits).mockResolvedValue(transcripts);

		const events = await collectSummaryEvents({ repoIdentity: "repo-1", cwd: "/w" });

		expect(events).toHaveLength(1);
		expect(events[0].hash).toBe("abc123");
		expect(getSummary).toHaveBeenCalledTimes(2); // roots only, never the child
	});

	it("collectSummaryEvents returns empty when there is no index", async () => {
		vi.mocked(getIndex).mockResolvedValue(null);
		expect(await collectSummaryEvents({ repoIdentity: "repo-1", cwd: "/w" })).toEqual([]);
	});
});
