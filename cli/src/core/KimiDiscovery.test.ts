import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./KimiSessionDiscoverer.js", () => ({
	discoverKimiSessions: vi.fn(),
	isKimiInstalled: vi.fn(),
}));
vi.mock("./references/TranscriptReferenceDiscovery.js", () => ({
	scanReferencesFrom: vi.fn(),
}));
vi.mock("./SessionTracker.js", () => ({
	loadConfig: vi.fn(),
	loadDiscoveryCursor: vi.fn(),
	migrateDiscoveryCursors: vi.fn(),
	saveDiscoveryCursor: vi.fn(),
}));
// Skills own their high-water mark inside the shared cursor record; the helper that
// implements that protocol is covered in TranscriptSkillDiscovery.test.ts, so this
// suite asserts only that Kimi sessions are handed to it.
vi.mock("./skills/TranscriptSkillDiscovery.js", () => ({
	scanSkillsWithCursor: vi.fn(),
}));

import { setManuallyDisabled } from "../Logger.js";
import { discoverKimiConversations } from "./KimiDiscovery.js";
import { discoverKimiSessions, isKimiInstalled } from "./KimiSessionDiscoverer.js";
import { scanReferencesFrom } from "./references/TranscriptReferenceDiscovery.js";
import { loadConfig, loadDiscoveryCursor, migrateDiscoveryCursors, saveDiscoveryCursor } from "./SessionTracker.js";
import { scanSkillsWithCursor } from "./skills/TranscriptSkillDiscovery.js";

const session = (id: string, path: string) => ({
	sessionId: id,
	transcriptPath: path,
	source: "kimi" as const,
	updatedAt: "t",
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(loadConfig).mockResolvedValue({} as never);
	vi.mocked(isKimiInstalled).mockResolvedValue(true);
	vi.mocked(migrateDiscoveryCursors).mockResolvedValue(undefined);
	vi.mocked(discoverKimiSessions).mockResolvedValue([]);
	vi.mocked(loadDiscoveryCursor).mockResolvedValue(null);
	vi.mocked(scanReferencesFrom).mockResolvedValue(0);
	vi.mocked(saveDiscoveryCursor).mockResolvedValue(undefined);
	vi.mocked(scanSkillsWithCursor).mockResolvedValue(undefined);
});

describe("discoverKimiConversations", () => {
	it("early-returns when the project is manually disabled (no config read, no scan, no cursor write)", async () => {
		setManuallyDisabled(true);
		try {
			await discoverKimiConversations("/repo/disabled");
			expect(loadConfig).not.toHaveBeenCalled();
			expect(discoverKimiSessions).not.toHaveBeenCalled();
			expect(saveDiscoveryCursor).not.toHaveBeenCalled();
		} finally {
			setManuallyDisabled(false);
		}
	});

	it("early-returns when kimiEnabled === false (no session scan)", async () => {
		vi.mocked(loadConfig).mockResolvedValue({ kimiEnabled: false } as never);
		await discoverKimiConversations("/repo/a");
		expect(discoverKimiSessions).not.toHaveBeenCalled();
	});

	it("early-returns when Kimi is not installed", async () => {
		vi.mocked(isKimiInstalled).mockResolvedValue(false);
		await discoverKimiConversations("/repo/b");
		expect(discoverKimiSessions).not.toHaveBeenCalled();
	});

	it("treats undefined kimiEnabled as enabled", async () => {
		vi.mocked(loadConfig).mockResolvedValue({} as never);
		await discoverKimiConversations("/repo/c");
		expect(discoverKimiSessions).toHaveBeenCalledOnce();
	});

	it("scans each session and advances the cursor only when refLine > fromLine", async () => {
		vi.mocked(discoverKimiSessions).mockResolvedValue([session("s1", "/t/1.jsonl"), session("s2", "/t/2.jsonl")]);
		vi.mocked(loadDiscoveryCursor).mockResolvedValue({ transcriptPath: "x", lineNumber: 5, updatedAt: "t" });
		vi.mocked(scanReferencesFrom).mockResolvedValueOnce(9).mockResolvedValueOnce(5); // s1 advanced, s2 unchanged
		await discoverKimiConversations("/repo/d");
		expect(scanReferencesFrom).toHaveBeenCalledTimes(2);
		expect(scanReferencesFrom).toHaveBeenCalledWith("/t/1.jsonl", 5, "/repo/d", "kimi");
		expect(saveDiscoveryCursor).toHaveBeenCalledOnce(); // only s1
	});

	it("one session throwing does not abort the rest and never rejects", async () => {
		vi.mocked(discoverKimiSessions).mockResolvedValue([session("s1", "/t/1.jsonl"), session("s2", "/t/2.jsonl")]);
		vi.mocked(scanReferencesFrom).mockRejectedValueOnce(new Error("read fail")).mockResolvedValueOnce(7);
		await expect(discoverKimiConversations("/repo/e")).resolves.toBeUndefined();
		expect(scanReferencesFrom).toHaveBeenCalledTimes(2);
	});

	it("hands each session to skill discovery on its own mark", async () => {
		vi.mocked(discoverKimiSessions).mockResolvedValue([session("s1", "/t/1.jsonl"), session("s2", "/t/2.jsonl")]);
		await discoverKimiConversations("/repo/skills");
		expect(scanSkillsWithCursor).toHaveBeenCalledWith("/t/1.jsonl", "/repo/skills", "kimi");
		expect(scanSkillsWithCursor).toHaveBeenCalledWith("/t/2.jsonl", "/repo/skills", "kimi");
	});

	it("still runs skill discovery when the reference scan threw and held the shared cursor", async () => {
		vi.mocked(discoverKimiSessions).mockResolvedValue([session("s1", "/t/1.jsonl")]);
		vi.mocked(scanReferencesFrom).mockRejectedValue(new Error("ref boom"));
		await discoverKimiConversations("/repo/reffail");
		expect(scanSkillsWithCursor).toHaveBeenCalledWith("/t/1.jsonl", "/repo/reffail", "kimi");
		expect(saveDiscoveryCursor).not.toHaveBeenCalled(); // refDone false → held
	});

	it("a throw outside the inner scans (e.g. saveDiscoveryCursor) is caught per-session and never rejects", async () => {
		vi.mocked(discoverKimiSessions).mockResolvedValue([session("s1", "/t/1.jsonl"), session("s2", "/t/2.jsonl")]);
		vi.mocked(scanReferencesFrom).mockResolvedValue(9);
		vi.mocked(saveDiscoveryCursor).mockRejectedValueOnce(new Error("save boom")).mockResolvedValueOnce(undefined);
		await expect(discoverKimiConversations("/repo/savefail")).resolves.toBeUndefined();
		expect(scanReferencesFrom).toHaveBeenCalledTimes(2);
		expect(saveDiscoveryCursor).toHaveBeenCalledTimes(2);
	});

	it("never rejects even when loadConfig throws", async () => {
		vi.mocked(loadConfig).mockRejectedValue(new Error("config boom"));
		await expect(discoverKimiConversations("/repo/f")).resolves.toBeUndefined();
	});

	it("single-flight: a re-entrant call shares the in-flight promise and triggers a dirty-rerun", async () => {
		let releaseFirst: (() => void) | undefined;
		vi.mocked(discoverKimiSessions)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						releaseFirst = () => resolve([]);
					}),
			)
			.mockResolvedValue([]);

		const p1 = discoverKimiConversations("/repo/g"); // starts run; awaits pending discoverKimiSessions
		await vi.waitFor(() => expect(releaseFirst).toBeDefined());
		const p2 = discoverKimiConversations("/repo/g"); // re-enter while in-flight → same promise + dirty
		expect(p2).toBe(p1);

		// biome-ignore lint/style/noNonNullAssertion: guaranteed defined by the waitFor above
		releaseFirst!(); // first pass completes → dirty → second pass runs
		await p1;
		expect(discoverKimiSessions).toHaveBeenCalledTimes(2); // dirty-rerun ran a second pass
	});

	it("a fresh call after completion starts a new run (single-flight entry cleared)", async () => {
		await discoverKimiConversations("/repo/h");
		await discoverKimiConversations("/repo/h");
		expect(discoverKimiSessions).toHaveBeenCalledTimes(2);
	});
});
