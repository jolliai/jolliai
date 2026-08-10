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

	it("excludes Jolli's own storage refs from both log passes and from attribution", async () => {
		// The orphan branch is a local branch like any other, so every ref-scoped
		// call here picks it up unless told not to — and it holds one commit PER
		// MEMORY. Measured on this repo before the exclusion: 1800 of 2468 stored
		// commits were `Add summary for …`, and `jollimemory/summaries/v3` outranked
		// `main` in the branch attribution.
		const calls: string[][] = [];
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			calls.push([...args]);
			if (args[0] === "log") return git(`aaa${SEP}2026-07-30T08:00:00+08:00${SEP}F${SEP}f@x.com${SEP}one`);
			// Sorted by committerdate, so the orphan branch — written on every memory
			// — is realistically the FIRST entry, not an afterthought at the end.
			if (args[0] === "for-each-ref") return git("jollimemory/summaries/v3\nmain\n");
			if (args[0] === "rev-list" && args[1] === "main") return git("aaa\n");
			return git("");
		});
		vi.mocked(getIndex).mockResolvedValue(null);
		const events = await collectCommitEvents({ repoIdentity: "r", cwd: "/w" });
		// Two ways to get this wrong silently, so both are pinned. `--exclude` is
		// positional — it applies only to the selector that FOLLOWS it — and its
		// pattern is relative to that selector, so the `refs/heads/`-prefixed form
		// matches nothing under `--branches` and is ignored without a word.
		for (const pass of calls.filter((c) => c[0] === "log" || c[0] === "-c")) {
			expect(pass.indexOf("--exclude=jollimemory/*")).toBe(pass.indexOf("--branches") - 1);
		}
		// Never walked, so it can never be attributed either.
		expect(calls.filter((c) => c[0] === "rev-list").map((c) => c[1])).toEqual(["main"]);
		expect(events[0]?.branches).toEqual(["main"]);
	});

	it("keeps a branch merely NAMED like the internal namespace", async () => {
		// Excluded by namespace (`jollimemory/`), not by prefix match — a user's
		// own `jollimemory-notes` branch is ordinary work and must stay attributed.
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			if (args[0] === "log") return git(`aaa${SEP}2026-07-30T08:00:00+08:00${SEP}F${SEP}f@x.com${SEP}one`);
			if (args[0] === "for-each-ref") return git("jollimemory-notes\n");
			if (args[0] === "rev-list" && args[1] === "jollimemory-notes") return git("aaa\n");
			return git("");
		});
		vi.mocked(getIndex).mockResolvedValue(null);
		const events = await collectCommitEvents({ repoIdentity: "r", cwd: "/w" });
		expect(events[0]?.branches).toEqual(["jollimemory-notes"]);
	});

	it("scans --numstat only for commits the caller has not stored", async () => {
		// The one expensive step in this collection (6.3 s → 0.44 s on a real 2.5k
		// commit history), and the reason a moved branch tip no longer costs a
		// whole-history scan. A commit's diff is immutable, so a stored hash can
		// never need re-scanning.
		const calls: string[][] = [];
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			calls.push([...args]);
			if (args[0] === "log") {
				return git(
					[
						`aaa${SEP}2026-07-30T08:00:00+08:00${SEP}F${SEP}f@x.com${SEP}new`,
						`bbb${SEP}2026-07-29T08:00:00+08:00${SEP}F${SEP}f@x.com${SEP}old`,
					].join("\n"),
				);
			}
			if (args[0] === "for-each-ref") return git("main\n");
			if (args[0] === "rev-list") return git("aaa\nbbb\n");
			if (args[0] === "-c") return git([`${REC}aaa`, "1\t0\tsrc/a.ts"].join("\n"));
			throw new Error(`unexpected git ${args.join(" ")}`);
		});
		vi.mocked(getIndex).mockResolvedValue(null);

		const events = await collectCommitEvents({
			repoIdentity: "r",
			cwd: "/w",
			knownHashes: new Set(["bbb"]),
		});

		// `--no-walk <hash>` for the new commit only — never the whole-history form.
		const numstat = calls.find((c) => c[0] === "-c");
		expect(numstat).toContain("--no-walk");
		expect(numstat).toContain("aaa");
		expect(numstat).not.toContain("bbb");
		// Both commits are still emitted: the commit list is what the prune is
		// computed against, and branch reachability changes for OLD commits every
		// time a branch moves — neither may be narrowed to the new arrivals.
		expect(events.map((e) => e.hash)).toEqual(["aaa", "bbb"]);
		expect(events[0].files).toHaveLength(1);
		// ABSENT, not empty: absent means "keep the stored rows", while `[]` would
		// claim the commit touches no files and delete them.
		expect(events[1]).not.toHaveProperty("files");
	});

	it("never re-asks numstat for a merge commit, which has no file rows to find", async () => {
		// A merge shows no diff under `git log --numstat`, so it can never acquire
		// `commit_files` rows — and the caller's "which commits have file rows" set
		// therefore never contains it. Retrying it on every sweep would be pure
		// waste, and in a merge-heavy history enough of them to push past
		// INCREMENTAL_NUMSTAT_LIMIT and drag the whole-history scan back in.
		const calls: string[][] = [];
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			calls.push([...args]);
			if (args[0] === "log") {
				return git(
					[
						// %P rides last: two parents = merge, one = ordinary commit.
						`mmm${SEP}2026-07-30T08:00:00+08:00${SEP}F${SEP}f@x.com${SEP}merge${SEP}p1 p2`,
						`aaa${SEP}2026-07-29T08:00:00+08:00${SEP}F${SEP}f@x.com${SEP}new${SEP}p1`,
					].join("\n"),
				);
			}
			if (args[0] === "for-each-ref") return git("main\n");
			if (args[0] === "rev-list") return git("mmm\naaa\n");
			if (args[0] === "-c") return git([`${REC}aaa`, "1\t0\tsrc/a.ts"].join("\n"));
			throw new Error(`unexpected git ${args.join(" ")}`);
		});
		vi.mocked(getIndex).mockResolvedValue(null);

		const events = await collectCommitEvents({ repoIdentity: "r", cwd: "/w", knownHashes: new Set() });

		const numstat = calls.find((c) => c[0] === "-c");
		expect(numstat).toContain("aaa");
		expect(numstat).not.toContain("mmm");
		// Still emitted, and still ABSENT rather than `[]` — the merge keeps whatever
		// the projection holds instead of claiming it touches nothing.
		expect(events.map((e) => e.hash)).toEqual(["mmm", "aaa"]);
		expect(events[0]).not.toHaveProperty("files");
		// The subject stays intact with the parent field appended after it.
		expect(events[0]?.message).toBe("merge");
	});

	it("falls back to the whole-history scan when too many commits are new", async () => {
		// The incremental form passes every hash as an argv entry, and Windows caps a
		// command line at ~32 KB — so past the limit it does not run slower, it fails
		// to spawn.
		const many = Array.from({ length: 401 }, (_, i) => `h${i}`);
		const calls: string[][] = [];
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			calls.push([...args]);
			if (args[0] === "log") {
				return git(
					many.map((h) => `${h}${SEP}2026-07-30T08:00:00+08:00${SEP}F${SEP}f@x.com${SEP}m`).join("\n"),
				);
			}
			if (args[0] === "for-each-ref") return git("main\n");
			return git("");
		});
		vi.mocked(getIndex).mockResolvedValue(null);
		await collectCommitEvents({ repoIdentity: "r", cwd: "/w", knownHashes: new Set() });
		const numstat = calls.find((c) => c[0] === "-c");
		expect(numstat).not.toContain("--no-walk");
		expect(numstat).toContain("--branches");
	});

	// The `MAX_BRANCHES` cap is a documented reachability gap, but it must not be
	// expressed as the CLAIM `branches: []` — that array is replace-when-present,
	// so a commit only the branches past the cap reach would have its correct
	// stored attribution deleted on every pass.
	it("omits branches for a commit no listed branch reaches when the ref list was truncated", async () => {
		const listed = Array.from({ length: 51 }, (_, i) => `b${i}`);
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			if (args[0] === "log") {
				return git(
					[
						`aaa${SEP}2026-07-30T08:00:00+08:00${SEP}F${SEP}f@x${SEP}one`,
						`bbb${SEP}2026-07-29T08:00:00+08:00${SEP}F${SEP}f@x${SEP}two`,
					].join("\n"),
				);
			}
			// Listed in full and capped in JS — asking git for one past the cap would
			// spend that slot on Jolli's own refs, which are filtered out here.
			if (args[0] === "for-each-ref") {
				expect(args).not.toContain("--count=51");
				return git(`${listed.join("\n")}\n`);
			}
			if (args[0] === "rev-list" && args[1] === "b0") return git("aaa\n");
			return git("");
		});
		vi.mocked(getIndex).mockResolvedValue(null);
		const events = await collectCommitEvents({ repoIdentity: "r", cwd: "/w" });
		// Reached by a listed branch → its (capped) attribution still refreshes.
		expect(events[0]).toMatchObject({ hash: "aaa", branches: ["b0"] });
		// Reached by nothing listed → could be on a branch past the cap, so the
		// stored value is left alone rather than claimed empty.
		expect(events[1]).not.toHaveProperty("branches");
		// Only the branches WITHIN the cap are walked.
		expect(vi.mocked(execGit).mock.calls.filter((c) => c[0][0] === "rev-list")).toHaveLength(50);
	});

	it("still emits an empty branches array when the ref list exactly fills the cap", async () => {
		// 50 listed is not truncation — asking for 51 and getting 50 proves it.
		const listed = Array.from({ length: 50 }, (_, i) => `b${i}`);
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			if (args[0] === "log") return git(`aaa${SEP}2026-07-30T08:00:00+08:00${SEP}F${SEP}f@x${SEP}one`);
			if (args[0] === "for-each-ref") return git(`${listed.join("\n")}\n`);
			return git("");
		});
		vi.mocked(getIndex).mockResolvedValue(null);
		const events = await collectCommitEvents({ repoIdentity: "r", cwd: "/w" });
		expect(events[0]?.branches).toEqual([]);
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

	// `branches` is REPLACE-when-present in the projection, so the distinction
	// this asserts is the whole guard: `[]` claims no branch reaches the commit
	// (and deletes its rows), `undefined` says "not observed" and leaves them.
	it("omits branches entirely when a per-branch rev-list failed", async () => {
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			if (args[0] === "log") return git(`aaa${SEP}2026-07-30T08:00:00+08:00${SEP}F${SEP}f@x${SEP}feat: one`);
			if (args[0] === "for-each-ref") return git("main\n");
			// The per-branch reachability pass fails; the commit survives, but its
			// stored attribution must not be replaced by a partial union.
			return gitFail("rev-list exploded");
		});
		vi.mocked(getIndex).mockResolvedValue(null);
		const events = await collectCommitEvents({ repoIdentity: "r", cwd: "/w" });
		expect(events).toHaveLength(1);
		expect(events[0]).not.toHaveProperty("branches");
	});

	// The worse half of the same bug: one failed ref listing used to emit `[]`
	// for EVERY commit, wiping the repo's whole branch attribution in one pass.
	it("omits branches entirely when the ref listing itself failed", async () => {
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			if (args[0] === "log") return git(`aaa${SEP}2026-07-30T08:00:00+08:00${SEP}F${SEP}f@x${SEP}feat: one`);
			if (args[0] === "for-each-ref") return gitFail("boom");
			return git("");
		});
		vi.mocked(getIndex).mockResolvedValue(null);
		const events = await collectCommitEvents({ repoIdentity: "r", cwd: "/w" });
		expect(events).toHaveLength(1);
		expect(events[0]).not.toHaveProperty("branches");
	});

	// And the case that must keep emitting `[]`: a clean scan where no branch
	// reaches the commit is a real answer, and the only thing that can prune a
	// branch the commit has genuinely left.
	it("emits an empty branches array when the scan succeeded and found none", async () => {
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			if (args[0] === "log") return git(`aaa${SEP}2026-07-30T08:00:00+08:00${SEP}F${SEP}f@x${SEP}feat: one`);
			if (args[0] === "for-each-ref") return git("main\n");
			if (args[0] === "rev-list") return git("zzz\n"); // reaches some other commit
			return git("");
		});
		vi.mocked(getIndex).mockResolvedValue(null);
		const events = await collectCommitEvents({ repoIdentity: "r", cwd: "/w" });
		expect(events[0].branches).toEqual([]);
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
	const REC = "\u0001";

	it("returns an empty map for no hashes without spawning git", async () => {
		vi.mocked(execGit).mockClear();
		expect((await collectFilesForCommits([], "/w")).size).toBe(0);
		expect(execGit).not.toHaveBeenCalled();
	});

	it("returns an empty map when git fails, so the caller omits files rather than clearing them", async () => {
		vi.mocked(execGit).mockResolvedValue(gitFail("bad object"));
		expect((await collectFilesForCommits(["aaa"], "/w")).size).toBe(0);
		// One hash has nothing to bisect: exactly one call, no retry.
		expect(execGit).toHaveBeenCalledTimes(1);
	});

	it("bisects a failing batch so one unreadable commit does not blank the rest", async () => {
		// The failure mode this exists for: a diff past execGit's maxBuffer fails
		// the whole `--no-walk` call, identically on every retry. Returning empty
		// for the batch denies file rows to the other commits, and since the next
		// sweep asks which commits HAVE file rows, the same doomed batch comes back
		// forever. Here `poison` fails whenever it is in the argv.
		vi.mocked(execGit).mockClear();
		vi.mocked(execGit).mockImplementation(async (args) => {
			const hashes = args.filter((a) => /^[a-z]\d$/.test(a));
			if (hashes.includes("p1")) return gitFail("stdout maxBuffer length exceeded");
			return git(hashes.map((h) => `${REC}${h}\n1\t0\tf-${h}.ts`).join("\n"));
		});

		const files = await collectFilesForCommits(["a1", "b1", "p1", "c1"], "/w");

		expect([...files.keys()].sort()).toEqual(["a1", "b1", "c1"]);
		expect(files.get("a1")?.[0]?.path).toBe("f-a1.ts");
	});

	it("stops bisecting a wholly broken repo instead of one call per commit", async () => {
		// Same failure shape covers "git is broken here", where splitting can only
		// spend subprocesses. The budget caps the damage at a flat handful rather
		// than ~2N on every sweep, forever.
		vi.mocked(execGit).mockClear();
		vi.mocked(execGit).mockResolvedValue(gitFail("not a git repository"));
		const hashes = Array.from({ length: 200 }, (_, i) => `h${i}`);

		expect((await collectFilesForCommits(hashes, "/w")).size).toBe(0);

		expect(vi.mocked(execGit).mock.calls.length).toBeLessThan(30);
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

		const { events, complete } = await collectSummaryEvents({ repoIdentity: "repo-1", cwd: "/w" });

		expect(events).toHaveLength(1);
		expect(events[0].hash).toBe("abc123");
		expect(getSummary).toHaveBeenCalledTimes(2); // roots only, never the child
		// The whole point of surviving it: the caller must NOT advance its cursor,
		// or this sweep's blind spot becomes permanent.
		expect(complete).toBe(false);
	});

	it("collectSummaryEvents reports a clean sweep as complete", async () => {
		vi.mocked(getIndex).mockResolvedValue({
			version: 3,
			// biome-ignore lint/suspicious/noExplicitAny: minimal index fixture
			entries: [{ commitHash: "abc123", parentCommitHash: null }] as any,
		});
		vi.mocked(getSummary).mockResolvedValue(baseSummary);
		vi.mocked(readTranscriptsForCommits).mockResolvedValue(new Map());

		const { events, complete } = await collectSummaryEvents({ repoIdentity: "repo-1", cwd: "/w" });
		expect(events).toHaveLength(1);
		expect(complete).toBe(true);
	});

	// A root the index names but the store no longer has is "not there", not a
	// failure — pruning is normal, and treating it as a failure would stall the
	// cursor forever on a repo that has one.
	it("collectSummaryEvents treats a null summary as absent, not a failed read", async () => {
		vi.mocked(getIndex).mockResolvedValue({
			version: 3,
			// biome-ignore lint/suspicious/noExplicitAny: minimal index fixture
			entries: [{ commitHash: "gone", parentCommitHash: null }] as any,
		});
		vi.mocked(getSummary).mockResolvedValue(null);

		const { events, complete } = await collectSummaryEvents({ repoIdentity: "repo-1", cwd: "/w" });
		expect(events).toEqual([]);
		expect(complete).toBe(true);
	});

	it("collectSummaryEvents returns empty and incomplete when there is no index", async () => {
		vi.mocked(getIndex).mockResolvedValue(null);
		// Incomplete, not complete-and-empty: an unreadable index says nothing
		// about what is stored, so the cursor must not move past it.
		expect(await collectSummaryEvents({ repoIdentity: "repo-1", cwd: "/w" })).toEqual({
			events: [],
			complete: false,
		});
	});
});
