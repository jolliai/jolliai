import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./CodexSessionDiscoverer.js", () => ({
	discoverCodexSessions: vi.fn(),
	isCodexInstalled: vi.fn(),
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

import { discoverCodexConversations } from "./CodexDiscovery.js";
import { discoverCodexSessions, isCodexInstalled } from "./CodexSessionDiscoverer.js";
import { scanReferencesFrom } from "./references/TranscriptReferenceDiscovery.js";
import { loadConfig, loadDiscoveryCursor, migrateDiscoveryCursors, saveDiscoveryCursor } from "./SessionTracker.js";

const session = (id: string, path: string) => ({
	sessionId: id,
	transcriptPath: path,
	source: "codex" as const,
	updatedAt: "t",
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(loadConfig).mockResolvedValue({} as never);
	vi.mocked(isCodexInstalled).mockResolvedValue(true);
	vi.mocked(migrateDiscoveryCursors).mockResolvedValue(undefined);
	vi.mocked(discoverCodexSessions).mockResolvedValue([]);
	vi.mocked(loadDiscoveryCursor).mockResolvedValue(null);
	vi.mocked(scanReferencesFrom).mockResolvedValue(0);
	vi.mocked(saveDiscoveryCursor).mockResolvedValue(undefined);
});

describe("discoverCodexConversations", () => {
	it("early-returns when codexEnabled === false (no session scan)", async () => {
		vi.mocked(loadConfig).mockResolvedValue({ codexEnabled: false } as never);
		await discoverCodexConversations("/repo/a");
		expect(discoverCodexSessions).not.toHaveBeenCalled();
	});

	it("early-returns when Codex is not installed", async () => {
		vi.mocked(isCodexInstalled).mockResolvedValue(false);
		await discoverCodexConversations("/repo/b");
		expect(discoverCodexSessions).not.toHaveBeenCalled();
	});

	it("treats undefined codexEnabled as enabled", async () => {
		vi.mocked(loadConfig).mockResolvedValue({} as never);
		await discoverCodexConversations("/repo/c");
		expect(discoverCodexSessions).toHaveBeenCalledOnce();
	});

	it("scans each session and advances the cursor only when lastLine > fromLine", async () => {
		vi.mocked(discoverCodexSessions).mockResolvedValue([session("s1", "/t/1.jsonl"), session("s2", "/t/2.jsonl")]);
		vi.mocked(loadDiscoveryCursor).mockResolvedValue({ transcriptPath: "x", lineNumber: 5, updatedAt: "t" });
		vi.mocked(scanReferencesFrom).mockResolvedValueOnce(9).mockResolvedValueOnce(5); // s1 advanced, s2 unchanged
		await discoverCodexConversations("/repo/d");
		expect(scanReferencesFrom).toHaveBeenCalledTimes(2);
		expect(scanReferencesFrom).toHaveBeenCalledWith("/t/1.jsonl", 5, "/repo/d", "codex");
		expect(saveDiscoveryCursor).toHaveBeenCalledOnce(); // only s1
	});

	it("one session throwing does not abort the rest and never rejects", async () => {
		vi.mocked(discoverCodexSessions).mockResolvedValue([session("s1", "/t/1.jsonl"), session("s2", "/t/2.jsonl")]);
		vi.mocked(scanReferencesFrom).mockRejectedValueOnce(new Error("read fail")).mockResolvedValueOnce(7);
		await expect(discoverCodexConversations("/repo/e")).resolves.toBeUndefined();
		expect(scanReferencesFrom).toHaveBeenCalledTimes(2);
	});

	it("never rejects even when loadConfig throws", async () => {
		vi.mocked(loadConfig).mockRejectedValue(new Error("config boom"));
		await expect(discoverCodexConversations("/repo/f")).resolves.toBeUndefined();
	});

	it("single-flight: a re-entrant call shares the in-flight promise and triggers a dirty-rerun", async () => {
		let releaseFirst: (() => void) | undefined;
		vi.mocked(discoverCodexSessions)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						releaseFirst = () => resolve([]);
					}),
			)
			.mockResolvedValue([]);

		const p1 = discoverCodexConversations("/repo/g"); // starts run; will await the pending discoverCodexSessions
		// Wait until the first pass has actually reached (and is blocked on) discoverCodexSessions.
		await vi.waitFor(() => expect(releaseFirst).toBeDefined());
		const p2 = discoverCodexConversations("/repo/g"); // re-enter while in-flight → same promise + dirty
		expect(p2).toBe(p1);

		// biome-ignore lint/style/noNonNullAssertion: guaranteed defined by the waitFor above
		releaseFirst!(); // first pass completes → dirty → second pass runs
		await p1;
		expect(discoverCodexSessions).toHaveBeenCalledTimes(2); // dirty-rerun ran a second pass
	});

	it("a fresh call after completion starts a new run (single-flight entry cleared)", async () => {
		await discoverCodexConversations("/repo/h");
		await discoverCodexConversations("/repo/h");
		expect(discoverCodexSessions).toHaveBeenCalledTimes(2);
	});
});
