import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	loadAllSessions: vi.fn(),
	loadDiscoveryCursor: vi.fn(),
	saveDiscoveryCursor: vi.fn(),
	migrateDiscoveryCursors: vi.fn(),
	scanPlansFrom: vi.fn(),
	scanReferencesFrom: vi.fn(),
	scanSkillsWithCursor: vi.fn(),
	existsSync: vi.fn(),
}));

vi.mock("./SessionTracker.js", () => ({
	loadAllSessions: mocks.loadAllSessions,
	loadDiscoveryCursor: mocks.loadDiscoveryCursor,
	saveDiscoveryCursor: mocks.saveDiscoveryCursor,
	migrateDiscoveryCursors: mocks.migrateDiscoveryCursors,
}));

vi.mock("./plans/TranscriptPlanDiscovery.js", () => ({
	scanPlansFrom: mocks.scanPlansFrom,
}));

vi.mock("./references/TranscriptReferenceDiscovery.js", () => ({
	scanReferencesFrom: mocks.scanReferencesFrom,
}));

vi.mock("./skills/TranscriptSkillDiscovery.js", () => ({
	scanSkillsWithCursor: mocks.scanSkillsWithCursor,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, existsSync: mocks.existsSync };
});

import { setManuallyDisabled } from "../Logger.js";
import { catchUpTranscriptDiscovery } from "./DiscoveryCatchUp.js";

describe("catchUpTranscriptDiscovery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setManuallyDisabled(false);
		mocks.migrateDiscoveryCursors.mockResolvedValue(undefined);
		mocks.loadDiscoveryCursor.mockResolvedValue({ transcriptPath: "/t.jsonl", lineNumber: 0 });
		mocks.saveDiscoveryCursor.mockResolvedValue(undefined);
		mocks.scanPlansFrom.mockResolvedValue(10);
		mocks.scanReferencesFrom.mockResolvedValue(10);
		mocks.scanSkillsWithCursor.mockResolvedValue(undefined);
		mocks.existsSync.mockReturnValue(true);
	});

	afterEach(() => {
		setManuallyDisabled(false);
	});

	it("no-ops without scanning when the project is manually disabled", async () => {
		setManuallyDisabled(true);
		mocks.loadAllSessions.mockResolvedValue([{ transcriptPath: "/a.jsonl" }]);

		const result = await catchUpTranscriptDiscovery("/project");

		expect(result).toEqual({ scanned: 0 });
		expect(mocks.loadAllSessions).not.toHaveBeenCalled();
		expect(mocks.scanPlansFrom).not.toHaveBeenCalled();
	});

	it("returns scanned:0 and swallows a loadAllSessions failure", async () => {
		mocks.loadAllSessions.mockRejectedValue(new Error("read error"));

		const result = await catchUpTranscriptDiscovery("/project");

		expect(result).toEqual({ scanned: 0 });
		expect(mocks.scanPlansFrom).not.toHaveBeenCalled();
	});

	it("scans a claude transcript and advances the cursor when lines were unscanned", async () => {
		mocks.loadAllSessions.mockResolvedValue([{ transcriptPath: "/a.jsonl", source: "claude" }]);
		mocks.loadDiscoveryCursor.mockResolvedValue({ transcriptPath: "/a.jsonl", lineNumber: 3 });
		mocks.scanReferencesFrom.mockResolvedValue(12);

		const result = await catchUpTranscriptDiscovery("/project");

		expect(mocks.scanPlansFrom).toHaveBeenCalledWith("/a.jsonl", 3, "/project", "claude");
		expect(mocks.scanReferencesFrom).toHaveBeenCalledWith("/a.jsonl", 3, "/project", "claude");
		expect(mocks.saveDiscoveryCursor).toHaveBeenCalledWith(
			expect.objectContaining({ transcriptPath: "/a.jsonl", lineNumber: 12 }),
			"/project",
		);
		expect(result).toEqual({ scanned: 1 });
	});

	it("defaults the cursor to 0 when no cursor exists yet", async () => {
		mocks.loadAllSessions.mockResolvedValue([{ transcriptPath: "/a.jsonl" }]);
		mocks.loadDiscoveryCursor.mockResolvedValue(null);

		await catchUpTranscriptDiscovery("/project");

		expect(mocks.scanPlansFrom).toHaveBeenCalledWith("/a.jsonl", 0, "/project", "claude");
	});

	it("passes the gemini source through for gemini sessions", async () => {
		mocks.loadAllSessions.mockResolvedValue([{ transcriptPath: "/g.jsonl", source: "gemini" }]);
		mocks.scanReferencesFrom.mockResolvedValue(5);

		await catchUpTranscriptDiscovery("/project");

		expect(mocks.scanPlansFrom).toHaveBeenCalledWith("/g.jsonl", 0, "/project", "gemini");
	});

	it("skips codex sessions (they self-recover on the sidebar tick)", async () => {
		mocks.loadAllSessions.mockResolvedValue([{ transcriptPath: "/c.jsonl", source: "codex" }]);

		const result = await catchUpTranscriptDiscovery("/project");

		expect(mocks.scanPlansFrom).not.toHaveBeenCalled();
		expect(result).toEqual({ scanned: 0 });
	});

	it("skips sessions whose transcript file is missing", async () => {
		mocks.loadAllSessions.mockResolvedValue([{ transcriptPath: "/gone.jsonl" }]);
		mocks.existsSync.mockReturnValue(false);

		const result = await catchUpTranscriptDiscovery("/project");

		expect(mocks.scanPlansFrom).not.toHaveBeenCalled();
		expect(result).toEqual({ scanned: 0 });
	});

	it("does NOT advance the cursor when the plan scan throws", async () => {
		mocks.loadAllSessions.mockResolvedValue([{ transcriptPath: "/a.jsonl" }]);
		mocks.scanPlansFrom.mockRejectedValue(new Error("plan boom"));
		mocks.scanReferencesFrom.mockResolvedValue(20);

		const result = await catchUpTranscriptDiscovery("/project");

		expect(mocks.saveDiscoveryCursor).not.toHaveBeenCalled();
		expect(result).toEqual({ scanned: 0 });
	});

	it("does NOT advance the cursor when the reference scan throws (line stays at fromLine)", async () => {
		mocks.loadAllSessions.mockResolvedValue([{ transcriptPath: "/a.jsonl" }]);
		mocks.loadDiscoveryCursor.mockResolvedValue({ transcriptPath: "/a.jsonl", lineNumber: 7 });
		mocks.scanReferencesFrom.mockRejectedValue(new Error("ref boom"));

		const result = await catchUpTranscriptDiscovery("/project");

		expect(mocks.saveDiscoveryCursor).not.toHaveBeenCalled();
		expect(result).toEqual({ scanned: 0 });
	});

	it("does NOT advance when there are no new lines (referenceLine === fromLine)", async () => {
		mocks.loadAllSessions.mockResolvedValue([{ transcriptPath: "/a.jsonl" }]);
		mocks.loadDiscoveryCursor.mockResolvedValue({ transcriptPath: "/a.jsonl", lineNumber: 9 });
		mocks.scanReferencesFrom.mockResolvedValue(9);

		const result = await catchUpTranscriptDiscovery("/project");

		expect(mocks.saveDiscoveryCursor).not.toHaveBeenCalled();
		expect(result).toEqual({ scanned: 0 });
	});

	it("drains the skills backlog too, per source", async () => {
		// The backlog this function exists to drain is per-extractor. Skills were omitted,
		// so a session that saw no further turns after re-enable kept its skill window
		// unscanned forever — the same silent drop the plan/reference catch-up prevents.
		mocks.loadAllSessions.mockResolvedValue([
			{ transcriptPath: "/a.jsonl" },
			{ transcriptPath: "/g.jsonl", source: "gemini" },
		]);

		await catchUpTranscriptDiscovery("/project");

		expect(mocks.scanSkillsWithCursor).toHaveBeenCalledWith("/a.jsonl", "/project", "claude");
		expect(mocks.scanSkillsWithCursor).toHaveBeenCalledWith("/g.jsonl", "/project", "gemini");
	});

	it("does not count a skills-only pass as an advanced shared cursor", async () => {
		// `scanned` reports how many SHARED plan/reference cursors moved. Counting a
		// skills advance there would make the enable command claim a plan/reference
		// backlog it never drained.
		mocks.loadAllSessions.mockResolvedValue([{ transcriptPath: "/a.jsonl" }]);
		mocks.loadDiscoveryCursor.mockResolvedValue({ transcriptPath: "/a.jsonl", lineNumber: 9 });
		mocks.scanReferencesFrom.mockResolvedValue(9);

		const result = await catchUpTranscriptDiscovery("/project");

		expect(mocks.scanSkillsWithCursor).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ scanned: 0 });
	});

	it("skips skills for a Codex session, which the sidebar tick owns", async () => {
		mocks.loadAllSessions.mockResolvedValue([{ transcriptPath: "/c.jsonl", source: "codex" }]);

		await catchUpTranscriptDiscovery("/project");

		expect(mocks.scanSkillsWithCursor).not.toHaveBeenCalled();
	});

	it("swallows a per-session failure (loadDiscoveryCursor throws) and continues", async () => {
		mocks.loadAllSessions.mockResolvedValue([{ transcriptPath: "/bad.jsonl" }, { transcriptPath: "/good.jsonl" }]);
		mocks.loadDiscoveryCursor
			.mockRejectedValueOnce(new Error("cursor read boom"))
			.mockResolvedValueOnce({ transcriptPath: "/good.jsonl", lineNumber: 0 });
		mocks.scanReferencesFrom.mockResolvedValue(4);

		const result = await catchUpTranscriptDiscovery("/project");

		// First session failed, second succeeded.
		expect(result).toEqual({ scanned: 1 });
		expect(mocks.saveDiscoveryCursor).toHaveBeenCalledWith(
			expect.objectContaining({ transcriptPath: "/good.jsonl", lineNumber: 4 }),
			"/project",
		);
	});
});
