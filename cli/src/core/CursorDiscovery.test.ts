import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./CursorSessionDiscoverer.js", () => ({ discoverCursorSessions: vi.fn() }));
vi.mock("./CursorCliSessionDiscoverer.js", () => ({
	discoverCursorCliSessions: vi.fn(),
	isCursorCliInstalled: vi.fn(),
}));
vi.mock("./CursorDetector.js", () => ({ isCursorInstalled: vi.fn() }));
vi.mock("./SessionTracker.js", () => ({ loadConfig: vi.fn(), migrateDiscoveryCursors: vi.fn() }));
// The high-water-mark protocol is covered in TranscriptSkillDiscovery.test.ts; this
// suite asserts only which conversations are handed to it, and under what conditions.
vi.mock("./skills/TranscriptSkillDiscovery.js", () => ({ scanSkillsWithCursor: vi.fn() }));

import { setManuallyDisabled } from "../Logger.js";
import { discoverCursorCliSessions, isCursorCliInstalled } from "./CursorCliSessionDiscoverer.js";
import { isCursorInstalled } from "./CursorDetector.js";
import { discoverCursorConversations } from "./CursorDiscovery.js";
import { discoverCursorSessions } from "./CursorSessionDiscoverer.js";
import { loadConfig, migrateDiscoveryCursors } from "./SessionTracker.js";
import { scanSkillsWithCursor } from "./skills/TranscriptSkillDiscovery.js";

const CWD = "/repo";

const session = (id: string, path: string, source: "cursor" | "cursor-cli") => ({
	sessionId: id,
	transcriptPath: path,
	source,
	updatedAt: "t",
});

/** A JSONL-backed conversation — the only shape a line scanner can read. */
const jsonl = (id: string, source: "cursor" | "cursor-cli") =>
	session(id, `/home/dev/.cursor/projects/b/agent-transcripts/${id}/${id}.jsonl`, source);

beforeEach(() => {
	vi.clearAllMocks();
	setManuallyDisabled(false);
	vi.mocked(loadConfig).mockResolvedValue({} as never);
	vi.mocked(migrateDiscoveryCursors).mockResolvedValue(undefined);
	vi.mocked(isCursorInstalled).mockResolvedValue(true);
	vi.mocked(isCursorCliInstalled).mockResolvedValue(true);
	vi.mocked(discoverCursorSessions).mockResolvedValue([]);
	vi.mocked(discoverCursorCliSessions).mockResolvedValue([]);
	vi.mocked(scanSkillsWithCursor).mockResolvedValue(undefined);
});

describe("discoverCursorConversations", () => {
	it("scans BOTH sources, tagging each with its own source", async () => {
		// A user who works in the IDE and the CLI must not get half a picture; the tag
		// is what decides the registry key and the scanner dispatch.
		vi.mocked(discoverCursorSessions).mockResolvedValue([jsonl("ide-1", "cursor")]);
		vi.mocked(discoverCursorCliSessions).mockResolvedValue([jsonl("cli-1", "cursor-cli")]);

		await discoverCursorConversations(CWD);

		expect(vi.mocked(scanSkillsWithCursor).mock.calls.map((c) => [c[1], c[2]])).toEqual([
			[CWD, "cursor"],
			[CWD, "cursor-cli"],
		]);
	});

	it("skips a composer whose transcript is a synthetic store handle", async () => {
		// The skill envelope lives only in the JSONL, and a line scanner cannot read a
		// SQLite handle. Skipping is the difference between "no skills found" and a
		// per-session read error on every pass.
		vi.mocked(discoverCursorSessions).mockResolvedValue([
			session("no-jsonl", "/home/dev/state.vscdb#no-jsonl", "cursor"),
			jsonl("has-jsonl", "cursor"),
		]);

		await discoverCursorConversations(CWD);

		expect(vi.mocked(scanSkillsWithCursor).mock.calls.map((c) => c[0])).toEqual([
			expect.stringContaining("has-jsonl.jsonl"),
		]);
	});

	it("writes nothing when the project is manually disabled", async () => {
		// The sidebar's 60s tick keeps firing while the disabled panel is shown, and a
		// pass persists cursors and skills into .jolli/jollimemory/.
		setManuallyDisabled(true);
		vi.mocked(discoverCursorSessions).mockResolvedValue([jsonl("ide-1", "cursor")]);

		await discoverCursorConversations(CWD);

		expect(scanSkillsWithCursor).not.toHaveBeenCalled();
		expect(migrateDiscoveryCursors).not.toHaveBeenCalled();
	});

	it("honours the single shared cursorEnabled toggle for both sources", async () => {
		vi.mocked(loadConfig).mockResolvedValue({ cursorEnabled: false } as never);
		vi.mocked(discoverCursorSessions).mockResolvedValue([jsonl("ide-1", "cursor")]);
		vi.mocked(discoverCursorCliSessions).mockResolvedValue([jsonl("cli-1", "cursor-cli")]);

		await discoverCursorConversations(CWD);

		expect(scanSkillsWithCursor).not.toHaveBeenCalled();
	});

	it("gates each source on its own presence", async () => {
		// The common case is one surface installed, not both.
		vi.mocked(isCursorInstalled).mockResolvedValue(false);
		vi.mocked(discoverCursorCliSessions).mockResolvedValue([jsonl("cli-1", "cursor-cli")]);

		await discoverCursorConversations(CWD);

		expect(discoverCursorSessions).not.toHaveBeenCalled();
		expect(vi.mocked(scanSkillsWithCursor).mock.calls.map((c) => c[2])).toEqual(["cursor-cli"]);
	});

	it("keeps scanning the batch after one conversation throws", async () => {
		vi.mocked(discoverCursorSessions).mockResolvedValue([jsonl("bad", "cursor"), jsonl("good", "cursor")]);
		vi.mocked(scanSkillsWithCursor).mockRejectedValueOnce(new Error("unreadable"));

		await discoverCursorConversations(CWD);

		expect(vi.mocked(scanSkillsWithCursor).mock.calls).toHaveLength(2);
	});

	it("never rejects, so callers can void-call it", async () => {
		// The contract every driver relies on: the 60s tick fire-and-forgets this.
		vi.mocked(loadConfig).mockRejectedValue(new Error("config gone"));
		await expect(discoverCursorConversations(CWD)).resolves.toBeUndefined();
	});

	it("collapses overlapping calls for one cwd into a single in-flight pass", async () => {
		vi.mocked(discoverCursorSessions).mockResolvedValue([jsonl("ide-1", "cursor")]);

		const a = discoverCursorConversations(CWD);
		const b = discoverCursorConversations(CWD);
		expect(b).toBe(a);
		await a;

		// The re-entrant call marked the run dirty, so it runs ONE more pass — catching
		// conversations written after the in-flight run already listed them.
		expect(vi.mocked(discoverCursorSessions).mock.calls.length).toBe(2);
	});
});
