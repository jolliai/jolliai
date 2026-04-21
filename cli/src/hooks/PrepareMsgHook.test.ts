import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock fs/promises so we can control readFile results without touching disk
vi.mock("node:fs/promises", () => ({
	readFile: vi.fn(),
}));

vi.mock("../core/SessionTracker.js", () => ({
	saveSquashPending: vi.fn(),
	loadSquashPending: vi.fn().mockResolvedValue(null),
}));

vi.mock("../core/GitOps.js", () => ({
	getHeadHash: vi.fn(),
	getLastReflogAction: vi.fn().mockResolvedValue(""),
	readOrigHead: vi.fn().mockResolvedValue(null),
	isAncestor: vi.fn().mockResolvedValue(false),
	getCommitRange: vi.fn().mockResolvedValue([]),
}));

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import { readFile } from "node:fs/promises";
import { getCommitRange, getHeadHash, getLastReflogAction, isAncestor, readOrigHead } from "../core/GitOps.js";
import { loadSquashPending, saveSquashPending } from "../core/SessionTracker.js";
import { handlePrepareMsgHook, parseSquashMsg } from "./PrepareMsgHook.js";

// A realistic SQUASH_MSG with 3 commits
const SAMPLE_SQUASH_MSG = `Squashed commit of the following:

commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0
Author: John Doe <john@example.com>

	Add dark mode toggle

commit b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0a1
Author: Jane Doe <jane@example.com>

	Fix login bug

commit c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0a1b2
Author: Bob Smith <bob@example.com>

	Refactor auth module
`;

describe("parseSquashMsg", () => {
	it("should extract all 40-char hex hashes from SQUASH_MSG", () => {
		const hashes = parseSquashMsg(SAMPLE_SQUASH_MSG);
		expect(hashes).toHaveLength(3);
		expect(hashes[0]).toBe("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0");
		expect(hashes[1]).toBe("b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0a1");
		expect(hashes[2]).toBe("c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0a1b2");
	});

	it("should return empty array for empty content", () => {
		const hashes = parseSquashMsg("");
		expect(hashes).toHaveLength(0);
	});

	it("should return empty array when no commit lines found", () => {
		const hashes = parseSquashMsg("Squashed commit of the following:\nAuthor: John <john@example.com>");
		expect(hashes).toHaveLength(0);
	});

	it("should ignore lines with short (non-40-char) hashes", () => {
		const content = "commit abc123\ncommit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\n";
		const hashes = parseSquashMsg(content);
		expect(hashes).toHaveLength(1);
		expect(hashes[0]).toBe("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0");
	});

	it("should handle extra whitespace before 'commit' keyword", () => {
		const content = "  commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\n";
		const hashes = parseSquashMsg(content);
		expect(hashes).toHaveLength(1);
	});

	it("should not match non-hex characters in hash position", () => {
		// 'g' is not a valid hex char
		const content = "commit g1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\n";
		const hashes = parseSquashMsg(content);
		expect(hashes).toHaveLength(0);
	});

	it("should handle lines with extra content after the hash", () => {
		// The regex uses \b so extra chars after hash should still match
		const content = "commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 extra-stuff\n";
		const hashes = parseSquashMsg(content);
		expect(hashes).toHaveLength(1);
	});
});

describe("handlePrepareMsgHook", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should skip when source is not 'squash'", async () => {
		await handlePrepareMsgHook("message", "/test/project");
		expect(readFile).not.toHaveBeenCalled();
		expect(saveSquashPending).not.toHaveBeenCalled();
	});

	it("should skip when source is undefined", async () => {
		await handlePrepareMsgHook(undefined, "/test/project");
		expect(readFile).not.toHaveBeenCalled();
		expect(saveSquashPending).not.toHaveBeenCalled();
	});

	it("should skip when source is 'commit' with no oldHash (plain commit)", async () => {
		await handlePrepareMsgHook("commit", "/test/project");
		expect(readFile).not.toHaveBeenCalled();
		expect(saveSquashPending).not.toHaveBeenCalled();
	});

	// Note: amend detection tests removed — amend is now handled by post-commit + post-rewrite.

	it("should parse SQUASH_MSG and save squash-pending when source is 'squash'", async () => {
		const PARENT_HASH = "deadbeef1234567890abcdef1234567890abcdef";
		vi.mocked(readFile).mockResolvedValueOnce(SAMPLE_SQUASH_MSG as never);
		vi.mocked(getHeadHash).mockResolvedValueOnce(PARENT_HASH);
		vi.mocked(saveSquashPending).mockResolvedValueOnce(undefined);

		await handlePrepareMsgHook("squash", "/test/project");

		expect(readFile).toHaveBeenCalledWith(expect.stringContaining("SQUASH_MSG"), "utf-8");
		expect(getHeadHash).toHaveBeenCalledWith("/test/project");
		expect(saveSquashPending).toHaveBeenCalledWith(
			expect.arrayContaining([
				"a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
				"b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0a1",
				"c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0a1b2",
			]),
			PARENT_HASH,
			"/test/project",
		);
	});

	it("should skip saving when no hashes found in SQUASH_MSG", async () => {
		vi.mocked(readFile).mockResolvedValueOnce("Squashed commit of the following:\n" as never);

		await handlePrepareMsgHook("squash", "/test/project");

		// No hashes → should not save
		expect(saveSquashPending).not.toHaveBeenCalled();
	});

	it("should handle readFile failure gracefully", async () => {
		vi.mocked(readFile).mockRejectedValueOnce(new Error("ENOENT: file not found"));

		// Should not throw
		await expect(handlePrepareMsgHook("squash", "/test/project")).resolves.toBeUndefined();
		expect(saveSquashPending).not.toHaveBeenCalled();
	});

	it("should pass .git/SQUASH_MSG path using the cwd", async () => {
		const PARENT_HASH = "deadbeef1234567890abcdef1234567890abcdef";
		vi.mocked(readFile).mockResolvedValueOnce(SAMPLE_SQUASH_MSG as never);
		vi.mocked(getHeadHash).mockResolvedValueOnce(PARENT_HASH);
		vi.mocked(saveSquashPending).mockResolvedValueOnce(undefined);

		await handlePrepareMsgHook("squash", "/my/repo");

		// Verify the path includes the cwd and .git/SQUASH_MSG
		const readFileCall = vi.mocked(readFile).mock.calls[0];
		const pathArg = readFileCall[0] as string;
		expect(pathArg).toContain("my");
		expect(pathArg).toContain("SQUASH_MSG");
	});
});

describe("handlePrepareMsgHook — reset-squash detection", () => {
	const CWD = "/test/project";
	const HEAD_HASH = "aaaa000011112222333344445555666677778888";
	const ORIG_HEAD_HASH = "bbbb000011112222333344445555666677778888";
	const SQUASHED_HASHES = [
		"cccc000011112222333344445555666677778888",
		"dddd000011112222333344445555666677778888",
		"eeee000011112222333344445555666677778888",
	];

	beforeEach(() => {
		vi.clearAllMocks();
	});

	/**
	 * Configures all mocks for a successful reset-squash detection.
	 * Individual tests override specific mocks to test each validation layer.
	 */
	function setupResetSquashMocks(): void {
		vi.mocked(loadSquashPending).mockResolvedValueOnce(null);
		vi.mocked(getLastReflogAction).mockResolvedValueOnce("reset: moving to HEAD~3");
		vi.mocked(readOrigHead).mockResolvedValueOnce(ORIG_HEAD_HASH);
		vi.mocked(getHeadHash).mockResolvedValueOnce(HEAD_HASH);
		vi.mocked(isAncestor).mockResolvedValueOnce(true);
		vi.mocked(getCommitRange).mockResolvedValueOnce(SQUASHED_HASHES);
		vi.mocked(saveSquashPending).mockResolvedValueOnce(undefined);
	}

	it("should detect reset-squash and save squash-pending (happy path)", async () => {
		setupResetSquashMocks();

		// source=undefined simulates a normal `git commit` after `git reset --soft`
		await handlePrepareMsgHook(undefined, CWD);

		expect(loadSquashPending).toHaveBeenCalledWith(CWD);
		expect(getLastReflogAction).toHaveBeenCalledWith(CWD);
		expect(readOrigHead).toHaveBeenCalledWith(CWD);
		expect(getHeadHash).toHaveBeenCalledWith(CWD);
		expect(isAncestor).toHaveBeenCalledWith(HEAD_HASH, ORIG_HEAD_HASH, CWD);
		expect(getCommitRange).toHaveBeenCalledWith(HEAD_HASH, ORIG_HEAD_HASH, CWD);
		expect(saveSquashPending).toHaveBeenCalledWith([...SQUASHED_HASHES], HEAD_HASH, CWD);
	});

	it("should skip detection when squash-pending.json already exists (VSCode plugin pre-wrote it)", async () => {
		vi.mocked(loadSquashPending).mockResolvedValueOnce({
			sourceHashes: ["aaa"],
			expectedParentHash: "bbb",
		} as never);

		await handlePrepareMsgHook(undefined, CWD);

		// Step 0 guard: should not proceed to any further git checks
		expect(getLastReflogAction).not.toHaveBeenCalled();
		expect(readOrigHead).not.toHaveBeenCalled();
		expect(saveSquashPending).not.toHaveBeenCalled();
	});

	it("should skip detection when reflog is not a reset action", async () => {
		vi.mocked(loadSquashPending).mockResolvedValueOnce(null);
		vi.mocked(getLastReflogAction).mockResolvedValueOnce("commit: Add feature X");

		await handlePrepareMsgHook(undefined, CWD);

		// Step 1 guard: reflog doesn't start with "reset:", should not proceed
		expect(readOrigHead).not.toHaveBeenCalled();
		expect(saveSquashPending).not.toHaveBeenCalled();
	});

	it("should skip detection when ORIG_HEAD does not exist", async () => {
		vi.mocked(loadSquashPending).mockResolvedValueOnce(null);
		vi.mocked(getLastReflogAction).mockResolvedValueOnce("reset: moving to HEAD~3");
		vi.mocked(readOrigHead).mockResolvedValueOnce(null);

		await handlePrepareMsgHook(undefined, CWD);

		// Step 2 guard: ORIG_HEAD not found, should not proceed
		expect(isAncestor).not.toHaveBeenCalled();
		expect(saveSquashPending).not.toHaveBeenCalled();
	});

	it("should skip detection when HEAD is not an ancestor of ORIG_HEAD", async () => {
		vi.mocked(loadSquashPending).mockResolvedValueOnce(null);
		vi.mocked(getLastReflogAction).mockResolvedValueOnce("reset: moving to HEAD~3");
		vi.mocked(readOrigHead).mockResolvedValueOnce(ORIG_HEAD_HASH);
		vi.mocked(getHeadHash).mockResolvedValueOnce(HEAD_HASH);
		vi.mocked(isAncestor).mockResolvedValueOnce(false);

		await handlePrepareMsgHook(undefined, CWD);

		// Step 3 guard: not an ancestor, should not proceed
		expect(getCommitRange).not.toHaveBeenCalled();
		expect(saveSquashPending).not.toHaveBeenCalled();
	});

	it("should skip detection when commit range is empty (no-op reset)", async () => {
		vi.mocked(loadSquashPending).mockResolvedValueOnce(null);
		vi.mocked(getLastReflogAction).mockResolvedValueOnce("reset: moving to HEAD~0");
		vi.mocked(readOrigHead).mockResolvedValueOnce(ORIG_HEAD_HASH);
		vi.mocked(getHeadHash).mockResolvedValueOnce(HEAD_HASH);
		vi.mocked(isAncestor).mockResolvedValueOnce(true);
		vi.mocked(getCommitRange).mockResolvedValueOnce([]);

		await handlePrepareMsgHook(undefined, CWD);

		// Step 4 guard: empty range, should not save
		expect(saveSquashPending).not.toHaveBeenCalled();
	});

	it("should silently handle detection errors without throwing", async () => {
		vi.mocked(loadSquashPending).mockRejectedValueOnce(new Error("disk error"));

		// Should not throw even though loadSquashPending failed
		await expect(handlePrepareMsgHook(undefined, CWD)).resolves.toBeUndefined();
		expect(saveSquashPending).not.toHaveBeenCalled();
	});

	// Note: amend priority test removed — amend detection no longer in PrepareMsgHook.

	it("should not interfere with squash merge detection (source=squash takes priority)", async () => {
		// source="squash" → SQUASH_MSG path, never reaches reset-squash
		vi.mocked(readFile).mockResolvedValueOnce(SAMPLE_SQUASH_MSG as never);
		vi.mocked(getHeadHash).mockResolvedValueOnce(HEAD_HASH);
		vi.mocked(saveSquashPending).mockResolvedValueOnce(undefined);

		await handlePrepareMsgHook("squash", CWD);

		// SQUASH_MSG path was used, not reset-squash
		expect(readFile).toHaveBeenCalledWith(expect.stringContaining("SQUASH_MSG"), "utf-8");
		expect(loadSquashPending).not.toHaveBeenCalled();
		expect(getLastReflogAction).not.toHaveBeenCalled();
	});
});
