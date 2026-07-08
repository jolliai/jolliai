import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../backfill/BackfillEngine.js", () => ({
	runBackfill: vi.fn(),
	recentCommitHashes: vi.fn(),
	repoHasAnyMemory: vi.fn(),
	countMissingSummaries: vi.fn(),
	listMissingCommits: vi.fn(),
	DEFAULT_BACKFILL_TIER: "low",
}));
vi.mock("../Logger.js", () => ({
	setLogDir: vi.fn(),
	createLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() }),
}));

import {
	countMissingSummaries,
	listMissingCommits,
	recentCommitHashes,
	repoHasAnyMemory,
	runBackfill,
} from "../backfill/BackfillEngine.js";
import { registerBackfillCommand } from "./BackfillCommand.js";

function makeProgram(): Command {
	const program = new Command();
	program.exitOverride(); // throw instead of process.exit in tests
	registerBackfillCommand(program);
	return program;
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	process.exitCode = undefined;
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
});

const report = {
	total: 1,
	generated: 1,
	skipped: 0,
	errors: 0,
	outcomes: [
		{
			commitHash: "abcdef1234",
			status: "generated" as const,
			confidence: "high" as const,
			method: "file-overlap" as const,
			topics: 2,
		},
	],
};

describe("jolli backfill command", () => {
	it("passes --last / --dry-run / --min-confidence through to runBackfill", async () => {
		vi.mocked(recentCommitHashes).mockResolvedValue(["h1", "h2"]);
		vi.mocked(runBackfill).mockResolvedValue({ ...report, outcomes: [] });

		await makeProgram().parseAsync(
			["backfill", "--cwd", "e:/r", "--last", "5", "--dry-run", "--min-confidence", "high"],
			{ from: "user" },
		);

		expect(vi.mocked(recentCommitHashes)).toHaveBeenCalledWith("e:/r", 5);
		expect(vi.mocked(runBackfill)).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "e:/r", hashes: ["h1", "h2"], dryRun: true, minTier: "high" }),
		);
	});

	it("defaults minTier to 'low' (window-collect-all) when --min-confidence is omitted", async () => {
		vi.mocked(recentCommitHashes).mockResolvedValue(["h1"]);
		vi.mocked(runBackfill).mockResolvedValue({ ...report, outcomes: [] });
		await makeProgram().parseAsync(["backfill"], { from: "user" });
		expect(vi.mocked(runBackfill)).toHaveBeenCalledWith(expect.objectContaining({ minTier: "low" }));
	});

	it("rejects an invalid --min-confidence value", async () => {
		vi.mocked(recentCommitHashes).mockResolvedValue(["h1"]);
		await expect(
			makeProgram().parseAsync(["backfill", "--min-confidence", "bogus"], { from: "user" }),
		).rejects.toThrow(/min-confidence must be one of/);
	});

	it("--all considers every reachable commit (no cap)", async () => {
		vi.mocked(recentCommitHashes).mockResolvedValue(["h1"]);
		vi.mocked(runBackfill).mockResolvedValue({ ...report, outcomes: [] });
		await makeProgram().parseAsync(["backfill", "--all"], { from: "user" });
		expect(vi.mocked(recentCommitHashes)).toHaveBeenCalledWith(expect.any(String), undefined);
	});

	it("renders a text report by default", async () => {
		vi.mocked(recentCommitHashes).mockResolvedValue(["h1"]);
		vi.mocked(runBackfill).mockResolvedValue(report);
		await makeProgram().parseAsync(["backfill"], { from: "user" });
		const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
		expect(out).toContain("generated");
		expect(out).toContain("1 candidate(s)");
	});

	it("renders mixed outcomes (diff-only, error, skipped) in the text report", async () => {
		vi.mocked(recentCommitHashes).mockResolvedValue(["h1", "h2", "h3", "h4"]);
		vi.mocked(runBackfill).mockResolvedValue({
			total: 4,
			generated: 2,
			skipped: 1,
			errors: 1,
			outcomes: [
				{
					commitHash: "aaaaaaaa11",
					status: "generated",
					confidence: "high",
					method: "file-overlap",
					topics: 3,
				},
				{ commitHash: "bbbbbbbb22", status: "generated", method: "diff-only", topics: 1 },
				{ commitHash: "cccccccc33", status: "skipped-has-summary" },
				{ commitHash: "dddddddd44", status: "error", message: "boom" },
			],
		});
		await makeProgram().parseAsync(["backfill"], { from: "user" });
		const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
		expect(out).toContain("file-overlap");
		expect(out).toContain("diff-only");
		expect(out).toContain("already summarized");
		expect(out).toContain("boom");
	});

	it("emits JSON with --format json", async () => {
		vi.mocked(recentCommitHashes).mockResolvedValue(["h1"]);
		vi.mocked(runBackfill).mockResolvedValue(report);
		await makeProgram().parseAsync(["backfill", "--format", "json"], { from: "user" });
		const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
		expect(JSON.parse(out).generated).toBe(1);
	});

	it("exits non-zero when there are no commits", async () => {
		vi.mocked(recentCommitHashes).mockResolvedValue([]);
		await makeProgram().parseAsync(["backfill"], { from: "user" });
		expect(process.exitCode).toBe(1);
		expect(vi.mocked(runBackfill)).not.toHaveBeenCalled();
	});

	it("--stream with no commits emits an empty report and does NOT exit non-zero", async () => {
		vi.mocked(recentCommitHashes).mockResolvedValue([]);
		await makeProgram().parseAsync(["backfill", "--stream"], { from: "user" });
		expect(process.exitCode).toBeUndefined();
		expect(vi.mocked(runBackfill)).not.toHaveBeenCalled();
		const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
		expect(JSON.parse(out)).toMatchObject({ type: "report", total: 0, generated: 0, skipped: 0, errors: 0 });
	});

	it("--hashes passes an explicit subset and skips recentCommitHashes", async () => {
		vi.mocked(runBackfill).mockResolvedValue({ ...report, outcomes: [] });
		await makeProgram().parseAsync(["backfill", "--hashes", " h1 , h2 ,,h3 "], { from: "user" });
		expect(vi.mocked(recentCommitHashes)).not.toHaveBeenCalled();
		expect(vi.mocked(runBackfill)).toHaveBeenCalledWith(expect.objectContaining({ hashes: ["h1", "h2", "h3"] }));
	});

	it("--hashes with only blanks falls back to the --last range", async () => {
		vi.mocked(recentCommitHashes).mockResolvedValue(["h1"]);
		vi.mocked(runBackfill).mockResolvedValue({ ...report, outcomes: [] });
		await makeProgram().parseAsync(["backfill", "--hashes", " , ,"], { from: "user" });
		expect(vi.mocked(recentCommitHashes)).toHaveBeenCalled();
	});

	it("--stream emits NDJSON progress events then a final report line", async () => {
		vi.mocked(recentCommitHashes).mockResolvedValue(["h1", "h2"]);
		vi.mocked(runBackfill).mockImplementation(async (opts) => {
			opts.onProgress?.(1, 2, { commitHash: "h1", status: "generated" });
			opts.onProgress?.(2, 2, { commitHash: "h2", status: "error", message: "boom" });
			return report;
		});
		await makeProgram().parseAsync(["backfill", "--stream"], { from: "user" });
		const lines = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		const parsed = lines.map((l: string) => JSON.parse(l));
		expect(parsed[0]).toMatchObject({ type: "progress", done: 1, total: 2 });
		expect(parsed[1]).toMatchObject({ type: "progress", done: 2, total: 2 });
		expect(parsed[2]).toMatchObject({ type: "report", generated: 1 });
	});

	it("--list-candidates emits cold-start signals as one JSON line and skips runBackfill", async () => {
		vi.mocked(repoHasAnyMemory).mockResolvedValue(false);
		vi.mocked(countMissingSummaries).mockResolvedValue({ missing: 3, total: 5 });
		vi.mocked(listMissingCommits).mockResolvedValue([{ commitHash: "h1", subject: "fix x", ts: 1000 }]);

		await makeProgram().parseAsync(
			["backfill", "--cwd", "e:/r", "--list-candidates", "--since-days", "30", "--limit", "10"],
			{ from: "user" },
		);

		expect(vi.mocked(runBackfill)).not.toHaveBeenCalled();
		expect(vi.mocked(listMissingCommits)).toHaveBeenCalledWith("e:/r", 30 * 24 * 60 * 60 * 1000, 10);
		const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
		expect(JSON.parse(out)).toEqual({
			hasAnyMemory: false,
			total: 5,
			missing: 3,
			candidates: [{ commitHash: "h1", subject: "fix x", ts: 1000 }],
		});
	});

	it("--list-candidates without --since-days passes undefined window", async () => {
		vi.mocked(repoHasAnyMemory).mockResolvedValue(true);
		vi.mocked(countMissingSummaries).mockResolvedValue({ missing: 0, total: 2 });
		vi.mocked(listMissingCommits).mockResolvedValue([]);
		await makeProgram().parseAsync(["backfill", "--list-candidates"], { from: "user" });
		expect(vi.mocked(listMissingCommits)).toHaveBeenCalledWith(expect.any(String), undefined, undefined);
	});
});
