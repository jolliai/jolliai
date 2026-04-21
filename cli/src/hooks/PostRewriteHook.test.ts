import { beforeEach, describe, expect, it, vi } from "vitest";

// Use vi.hoisted so mockCreateInterface is available when vi.mock factory runs (hoisting issue)
const { mockCreateInterface, mockExistsSync, mockUnlinkSync } = vi.hoisted(() => ({
	mockCreateInterface: vi.fn(),
	mockExistsSync: vi.fn(),
	mockUnlinkSync: vi.fn(),
}));

// Mock readline so we can control stdin content in tests
vi.mock("node:readline", () => ({
	createInterface: mockCreateInterface,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, existsSync: mockExistsSync, unlinkSync: mockUnlinkSync };
});

vi.mock("../core/GitOps.js", () => ({
	getCommitInfo: vi.fn(),
}));

vi.mock("../core/SessionTracker.js", () => ({
	enqueueGitOperation: vi.fn(),
	isLockHeld: vi.fn(),
}));

// Mock QueueWorker's launchWorker (imported by PostRewriteHook for conditional spawn)
vi.mock("./QueueWorker.js", () => ({
	launchWorker: vi.fn(),
}));

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import { enqueueGitOperation, isLockHeld } from "../core/SessionTracker.js";
import { handlePostRewriteHook } from "./PostRewriteHook.js";
import { launchWorker } from "./QueueWorker.js";

/** Configures the readline mock to yield the given lines when iterated */
function setStdinLines(lines: string[]): void {
	mockCreateInterface.mockReturnValue({
		[Symbol.asyncIterator]: () => {
			let index = 0;
			return {
				next: () =>
					Promise.resolve(
						index < lines.length
							? { value: lines[index++], done: false }
							: { value: undefined, done: true },
					),
			};
		},
	});
}

describe("PostRewriteHook", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(isLockHeld).mockResolvedValue(false);
		vi.mocked(enqueueGitOperation).mockResolvedValue(true);
		// Default: no plugin-source file
		mockExistsSync.mockReturnValue(false);
	});

	// ── amend ──────────────────────────────────────────────────────────────

	describe("amend", () => {
		it("should enqueue an amend operation with old→new hash mapping from stdin", async () => {
			setStdinLines(["aaaa1111 bbbb2222"]);

			await handlePostRewriteHook("amend", "/test/project");

			expect(enqueueGitOperation).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "amend",
					commitHash: "bbbb2222",
					sourceHashes: ["aaaa1111"],
				}),
				"/test/project",
			);
		});

		it("should spawn Worker when lock is free after amend enqueue", async () => {
			setStdinLines(["aaaa1111 bbbb2222"]);
			vi.mocked(isLockHeld).mockResolvedValue(false);

			await handlePostRewriteHook("amend", "/test/project");

			expect(launchWorker).toHaveBeenCalledWith("/test/project");
		});

		it("should NOT spawn Worker when lock is held after amend enqueue", async () => {
			setStdinLines(["aaaa1111 bbbb2222"]);
			vi.mocked(isLockHeld).mockResolvedValue(true);

			await handlePostRewriteHook("amend", "/test/project");

			expect(enqueueGitOperation).toHaveBeenCalled();
			expect(launchWorker).not.toHaveBeenCalled();
		});

		it("should not enqueue when amend has no stdin mappings", async () => {
			setStdinLines([]);

			await handlePostRewriteHook("amend", "/test/project");

			expect(enqueueGitOperation).not.toHaveBeenCalled();
		});
	});

	// ── rebase ─────────────────────────────────────────────────────────────

	describe("rebase", () => {
		it("should enqueue rebase-pick for 1:1 mapping", async () => {
			setStdinLines(["aaaa1111 bbbb2222"]);

			await handlePostRewriteHook("rebase", "/test/project");

			expect(enqueueGitOperation).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "rebase-pick",
					commitHash: "bbbb2222",
					sourceHashes: ["aaaa1111"],
				}),
				"/test/project",
			);
		});

		it("should enqueue rebase-squash for N:1 mapping", async () => {
			// Two old hashes map to the same new hash (squash/fixup)
			setStdinLines(["aaaa1111 cccc3333", "bbbb2222 cccc3333"]);

			await handlePostRewriteHook("rebase", "/test/project");

			expect(enqueueGitOperation).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "rebase-squash",
					commitHash: "cccc3333",
					sourceHashes: ["aaaa1111", "bbbb2222"],
				}),
				"/test/project",
			);
		});

		it("should enqueue multiple groups for mixed pick and squash", async () => {
			setStdinLines(["aaaa1111 xxxx0001", "bbbb2222 yyyy0002", "cccc3333 yyyy0002"]);

			await handlePostRewriteHook("rebase", "/test/project");

			// First group: 1:1 pick
			expect(enqueueGitOperation).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "rebase-pick",
					commitHash: "xxxx0001",
					sourceHashes: ["aaaa1111"],
				}),
				"/test/project",
			);
			// Second group: 2:1 squash
			expect(enqueueGitOperation).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "rebase-squash",
					commitHash: "yyyy0002",
					sourceHashes: ["bbbb2222", "cccc3333"],
				}),
				"/test/project",
			);
		});

		it("should spawn Worker when lock is free after rebase enqueue", async () => {
			setStdinLines(["aaaa1111 bbbb2222"]);
			vi.mocked(isLockHeld).mockResolvedValue(false);

			await handlePostRewriteHook("rebase", "/test/project");

			expect(launchWorker).toHaveBeenCalledWith("/test/project");
		});

		it("should NOT spawn Worker when lock is held after rebase enqueue", async () => {
			setStdinLines(["aaaa1111 bbbb2222"]);
			vi.mocked(isLockHeld).mockResolvedValue(true);

			await handlePostRewriteHook("rebase", "/test/project");

			expect(enqueueGitOperation).toHaveBeenCalled();
			expect(launchWorker).not.toHaveBeenCalled();
		});

		it("should not enqueue or spawn when rebase has no stdin mappings", async () => {
			setStdinLines([]);

			await handlePostRewriteHook("rebase", "/test/project");

			expect(enqueueGitOperation).not.toHaveBeenCalled();
			expect(launchWorker).not.toHaveBeenCalled();
		});
	});

	// ── rebase failure path ───────────────────────────────────────────────

	describe("rebase failure", () => {
		it("should log warning when some enqueues fail", async () => {
			setStdinLines(["aaaa1111 bbbb2222", "cccc3333 dddd4444"]);
			// First enqueue fails, second succeeds
			vi.mocked(enqueueGitOperation).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

			await handlePostRewriteHook("rebase", "/test/project");

			expect(enqueueGitOperation).toHaveBeenCalledTimes(2);
		});
	});

	// ── detectCommitSource ────────────────────────────────────────────────

	describe("detectCommitSource (via amend/rebase handler)", () => {
		it("should use 'plugin' source when plugin-source file exists", async () => {
			setStdinLines(["aaaa1111 bbbb2222"]);
			mockExistsSync.mockImplementation((p: string) => String(p).endsWith("plugin-source"));

			await handlePostRewriteHook("amend", "/test/project");

			expect(enqueueGitOperation).toHaveBeenCalledWith(
				expect.objectContaining({ commitSource: "plugin" }),
				"/test/project",
			);
			expect(mockUnlinkSync).toHaveBeenCalled();
		});

		it("should use 'cli' source when plugin-source file does not exist", async () => {
			setStdinLines(["aaaa1111 bbbb2222"]);
			mockExistsSync.mockReturnValue(false);

			await handlePostRewriteHook("amend", "/test/project");

			expect(enqueueGitOperation).toHaveBeenCalledWith(
				expect.objectContaining({ commitSource: "cli" }),
				"/test/project",
			);
		});

		it("should handle unlinkSync failure gracefully", async () => {
			setStdinLines(["aaaa1111 bbbb2222"]);
			mockExistsSync.mockImplementation((p: string) => String(p).endsWith("plugin-source"));
			mockUnlinkSync.mockImplementation(() => {
				throw new Error("EPERM");
			});

			await handlePostRewriteHook("amend", "/test/project");

			// Should still detect as plugin despite unlink failure
			expect(enqueueGitOperation).toHaveBeenCalledWith(
				expect.objectContaining({ commitSource: "plugin" }),
				"/test/project",
			);
		});
	});

	// ── malformed stdin ──────────────────────────────────────────────────

	describe("malformed stdin", () => {
		it("should skip lines that do not contain two hash parts", async () => {
			setStdinLines(["only-one-part", "", "  ", "aaaa1111 bbbb2222"]);

			await handlePostRewriteHook("amend", "/test/project");

			// Only the valid line should be processed
			expect(enqueueGitOperation).toHaveBeenCalledTimes(1);
			expect(enqueueGitOperation).toHaveBeenCalledWith(
				expect.objectContaining({ commitHash: "bbbb2222" }),
				"/test/project",
			);
		});
	});

	// ── unknown command ───────────────────────────────────────────────────

	it("should skip unknown commands", async () => {
		setStdinLines(["aaaa1111 bbbb2222"]);

		await handlePostRewriteHook("unknown-command", "/test/project");

		expect(enqueueGitOperation).not.toHaveBeenCalled();
	});
});
