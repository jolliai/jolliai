import type { ReadStream } from "node:fs";
import type { Interface as ReadlineInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock SessionTracker — includes both original and new plan-discovery functions
vi.mock("../core/SessionTracker.js", () => ({
	saveSession: vi.fn(),
	loadConfig: vi.fn().mockResolvedValue({}),
	loadDiscoveryCursor: vi.fn().mockResolvedValue(null),
	saveDiscoveryCursor: vi.fn().mockResolvedValue(undefined),
	migrateDiscoveryCursors: vi.fn().mockResolvedValue(undefined),
	loadPlansRegistry: vi.fn().mockResolvedValue({ version: 1, plans: {} }),
	savePlansRegistry: vi.fn().mockResolvedValue(undefined),
	upsertReferenceEntry: vi.fn().mockResolvedValue(undefined),
}));

// Mock ReferenceExtractor — pure-function module called from StopHook.
vi.mock("../core/references/ReferenceExtractor.js", () => ({
	extractReferencesFromTranscript: vi.fn().mockResolvedValue({ references: [], lastLineNumberScanned: 0 }),
}));

// Mock Locks — these unit tests run with synthetic cwds (e.g. "/project"), so
// the real per-worktree lock would create junk dirs off the drive root. Run the
// plans.json RMW body inline; the lock contract is covered in Locks.test.ts.
vi.mock("../core/Locks.js", () => ({
	withPlansLock: (_cwd: string | undefined, fn: () => Promise<unknown>) => fn(),
}));

// Mock node:fs so we can control existsSync / readFileSync / createReadStream
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: vi.fn().mockReturnValue(false),
		readFileSync: vi.fn().mockReturnValue("# Plan Title\n\nContent"),
		createReadStream: vi.fn().mockReturnValue({} as ReadStream),
	};
});

// Pin homedir() so fixtures' "/home/user/.claude/plans/<slug>.md" sourcePaths
// align with what the implementation computes via join(homedir(), ...) — keeps
// tests deterministic across Windows local and POSIX CI environments.
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return {
		...actual,
		homedir: vi.fn().mockReturnValue("/home/user"),
	};
});

// Mock node:readline so we can simulate line-by-line transcript scanning
vi.mock("node:readline", () => ({
	createInterface: vi.fn(),
}));

// Note: getCurrentBranch uses require("node:child_process") dynamically inside StopHook,
// which is not intercepted by vi.mock in ESM context. Tests should use expect.any(String)
// for branch assertions rather than checking for a specific branch name.

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { extractReferencesFromTranscript } from "../core/references/ReferenceExtractor.js";
import {
	loadConfig,
	loadDiscoveryCursor,
	loadPlansRegistry,
	saveDiscoveryCursor,
	savePlansRegistry,
	saveSession,
	upsertReferenceEntry,
} from "../core/SessionTracker.js";
import type { PlanEntry } from "../Types.js";
import { withPlatform } from "../testUtils/withPlatform.js";
import { handleStopHook } from "./StopHook.js";

/** Helper to mock stdin with given content */
function mockStdin(content: string): void {
	const mockStream = {
		setEncoding: vi.fn(),
		destroy: vi.fn(),
		on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
			if (event === "data") {
				callback(content);
			}
			if (event === "end") {
				setTimeout(() => callback(), 0);
			}
			return mockStream;
		}),
	};
	Object.defineProperty(process, "stdin", { value: mockStream, writable: true, configurable: true });
}

/** Helper to mock stdin that emits an error */
function mockStdinError(errorMessage: string): void {
	const mockStream = {
		setEncoding: vi.fn(),
		destroy: vi.fn(),
		on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
			if (event === "error") {
				setTimeout(() => callback(new Error(errorMessage)), 0);
			}
			return mockStream;
		}),
	};
	Object.defineProperty(process, "stdin", { value: mockStream, writable: true, configurable: true });
}

/** Helper to mock empty stdin */
function mockEmptyStdin(): void {
	const mockStream = {
		setEncoding: vi.fn(),
		destroy: vi.fn(),
		on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
			if (event === "end") {
				setTimeout(() => callback(), 0);
			}
			return mockStream;
		}),
	};
	Object.defineProperty(process, "stdin", { value: mockStream, writable: true, configurable: true });
}

/**
 * Helper to mock createReadStream + createInterface with a sequence of transcript lines.
 * Lines are emitted asynchronously (via microtask) after all rl.on() handlers are registered.
 */
function mockTranscriptWithLines(lines: string[]): void {
	const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

	const mockRl = {
		on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			if (!handlers[event]) {
				handlers[event] = [];
			}
			handlers[event].push(handler);
			// Schedule line emission as microtask after "line" handler is registered.
			// By the time it runs, all rl.on() calls ("line", "close", "error") are done.
			if (event === "line") {
				Promise.resolve().then(() => {
					for (const line of lines) {
						for (const h of handlers.line ?? []) h(line);
					}
					for (const h of handlers.close ?? []) h();
				});
			}
			return mockRl;
		}),
	};

	vi.mocked(createInterface).mockReturnValueOnce(mockRl as unknown as ReadlineInterface);
	vi.mocked(createReadStream).mockReturnValueOnce({} as ReadStream);
}

/**
 * Helper to mock createReadStream + createInterface where the readline emits an error.
 * Exercises the `rl.on("error", ...)` handler in scanTranscriptForPlans.
 */
function mockTranscriptWithError(): void {
	const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

	const mockRl = {
		on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			if (!handlers[event]) {
				handlers[event] = [];
			}
			handlers[event].push(handler);
			// Fire "error" event after all handlers are registered
			if (event === "error") {
				Promise.resolve().then(() => {
					for (const h of handlers.error ?? []) h(new Error("read error"));
				});
			}
			return mockRl;
		}),
	};

	vi.mocked(createInterface).mockReturnValueOnce(mockRl as unknown as ReadlineInterface);
	vi.mocked(createReadStream).mockReturnValueOnce({} as ReadStream);
}

/** Returns a valid hook input JSON string */
function hookJson(transcriptPath = "/path/to/session.jsonl", cwd = "/my/project"): string {
	return JSON.stringify({ session_id: "test-session-123", transcript_path: transcriptPath, cwd });
}

describe("StopHook", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		vi.clearAllMocks();
		process.env = { ...originalEnv };
		process.env.CLAUDE_PROJECT_DIR = undefined;
		// Default: transcript file does not exist → plan discovery exits early
		vi.mocked(existsSync).mockReturnValue(false);
		// Default: loadPlansRegistry returns empty registry
		vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {} });
		// Default: loadDiscoveryCursor returns null (no prior scan)
		vi.mocked(loadDiscoveryCursor).mockResolvedValue(null);
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("should save session info from valid stdin using cwd", async () => {
		const hookData = {
			session_id: "test-session-123",
			transcript_path: "/home/user/.claude/projects/abc/session.jsonl",
			cwd: "/my/project",
		};

		mockStdin(JSON.stringify(hookData));
		await handleStopHook();

		expect(saveSession).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "test-session-123",
				transcriptPath: "/home/user/.claude/projects/abc/session.jsonl",
				source: "claude",
			}),
			"/my/project",
		);
	});

	it("should prefer CLAUDE_PROJECT_DIR over hookData.cwd", async () => {
		process.env.CLAUDE_PROJECT_DIR = "/stable/project/root";

		const hookData = {
			session_id: "test-session-456",
			transcript_path: "/path/to/transcript.jsonl",
			cwd: "/different/cwd",
		};

		mockStdin(JSON.stringify(hookData));
		await handleStopHook();

		expect(saveSession).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "test-session-456",
			}),
			"/stable/project/root",
		);
	});

	it("should handle invalid JSON gracefully", async () => {
		mockStdin("not valid json");
		await handleStopHook();
		expect(saveSession).not.toHaveBeenCalled();
	});

	it("should handle missing fields gracefully", async () => {
		mockStdin(JSON.stringify({ some_other_field: true }));
		await handleStopHook();
		expect(saveSession).not.toHaveBeenCalled();
	});

	it("should handle empty stdin gracefully", async () => {
		mockEmptyStdin();
		await handleStopHook();
		expect(saveSession).not.toHaveBeenCalled();
	});

	it("should handle stdin read error gracefully", async () => {
		mockStdinError("stream error");
		await handleStopHook();
		expect(saveSession).not.toHaveBeenCalled();
	});

	it("should handle saveSession failure gracefully", async () => {
		const hookData = {
			session_id: "test-session",
			transcript_path: "/path/to/transcript.jsonl",
			cwd: "/project",
		};

		mockStdin(JSON.stringify(hookData));
		vi.mocked(saveSession).mockRejectedValueOnce(new Error("disk full"));

		await handleStopHook();
		expect(saveSession).toHaveBeenCalled();
	});

	it("should log error code when saveSession fails with ErrnoException", async () => {
		const hookData = {
			session_id: "test-session",
			transcript_path: "/path/to/transcript.jsonl",
			cwd: "/project",
		};

		mockStdin(JSON.stringify(hookData));
		const err = new Error("no space left on device") as NodeJS.ErrnoException;
		err.code = "ENOSPC";
		vi.mocked(saveSession).mockRejectedValueOnce(err);

		await handleStopHook();
		expect(saveSession).toHaveBeenCalled();
	});

	it("should log error without stack when saveSession fails with a stackless error", async () => {
		const hookData = {
			session_id: "test-session",
			transcript_path: "/path/to/transcript.jsonl",
			cwd: "/project",
		};

		mockStdin(JSON.stringify(hookData));
		const err = new Error("disk full") as NodeJS.ErrnoException;
		err.code = "EIO";
		// Remove the stack property so the `if (err.stack)` branch is skipped
		delete err.stack;
		vi.mocked(saveSession).mockRejectedValueOnce(err);

		await handleStopHook();
		expect(saveSession).toHaveBeenCalled();
	});

	it("should skip session tracking when claudeEnabled is false", async () => {
		vi.mocked(loadConfig).mockResolvedValueOnce({ claudeEnabled: false });
		const hookData = {
			session_id: "test-session",
			transcript_path: "/path/to/transcript.jsonl",
			cwd: "/project",
		};

		mockStdin(JSON.stringify(hookData));
		await handleStopHook();
		expect(saveSession).not.toHaveBeenCalled();
	});
});

describe("StopHook — plan discovery", () => {
	const TRANSCRIPT_PATH = "/path/to/session.jsonl";
	const PROJECT_DIR = "/my/project";

	beforeEach(() => {
		vi.clearAllMocks();
		process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
		vi.mocked(loadDiscoveryCursor).mockResolvedValue(null);
		vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {} });
		// Default: reference discovery finds nothing. Each cursor-assertion test
		// overrides lastLineNumberScanned — the reference scan reads to the same
		// EOF as the plan scan, so its return value drives the merged cursor.
		vi.mocked(extractReferencesFromTranscript).mockResolvedValue({ references: [], lastLineNumberScanned: 0 });
		// Default: files don't exist
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(readFileSync).mockReturnValue(
			"# Plan Title\n\nContent" as unknown as ReturnType<typeof readFileSync>,
		);
	});

	afterEach(() => {
		process.env.CLAUDE_PROJECT_DIR = undefined;
	});

	it("should skip plan discovery when transcript file does not exist", async () => {
		// existsSync returns false (default) → transcript not found
		vi.mocked(existsSync).mockReturnValue(false);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(loadPlansRegistry).not.toHaveBeenCalled();
		expect(savePlansRegistry).not.toHaveBeenCalled();
	});

	it("should update cursor but not write plans.json when no plan slugs found", async () => {
		// Transcript exists
		vi.mocked(existsSync).mockReturnValue(true);
		// Transcript has no plan-related lines
		mockTranscriptWithLines([
			'{"role":"assistant","content":"Hello world"}',
			'{"role":"human","content":"Please help me"}',
		]);
		// Plan + reference discovery share one cursor; the reference scan reads
		// to the same EOF, so its lastLineNumberScanned drives the merged cursor.
		vi.mocked(extractReferencesFromTranscript).mockResolvedValue({ references: [], lastLineNumberScanned: 2 });

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(saveDiscoveryCursor).toHaveBeenCalledWith(
			expect.objectContaining({
				transcriptPath: `${TRANSCRIPT_PATH}`,
				lineNumber: 2,
			}),
			PROJECT_DIR,
		);
		expect(savePlansRegistry).not.toHaveBeenCalled();
	});

	it("does not advance the merged cursor past a window the plan scan failed to process", async () => {
		// P2 regression: if plan discovery throws (e.g. a transient FS error during
		// guard revival) while reference discovery reaches EOF, the shared cursor
		// must NOT jump to EOF — otherwise those lines are never re-scanned for
		// plans. min(planLine=fromLine, refLine=EOF) = fromLine ⇒ no advance.
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(loadDiscoveryCursor).mockResolvedValue(null); // fromLine = 0
		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Write","input":{"file_path":"/home/user/.claude/plans/p.md"}}',
		]);
		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: {
				p: {
					slug: "p",
					title: "P",
					sourcePath: "/home/user/.claude/plans/p.md",
					addedAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					commitHash: "abc12345",
					contentHashAtCommit: "guard-hash",
				},
			},
		});
		// Guard revival reads the plan file to hash it — make that read throw so
		// scanPlansFrom rejects. (The reference scan uses the mocked
		// extractReferencesFromTranscript, which does no readFileSync.)
		vi.mocked(readFileSync).mockImplementation((() => {
			throw new Error("EBUSY: transient");
		}) as unknown as typeof readFileSync);
		// Reference scan succeeds and reaches EOF (line 5).
		vi.mocked(extractReferencesFromTranscript).mockResolvedValue({ references: [], lastLineNumberScanned: 5 });

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(saveDiscoveryCursor).not.toHaveBeenCalled();
	});

	it("should not update cursor when transcript has no new lines since last scan", async () => {
		// Last scan was at line 5, transcript still only has 5 lines
		vi.mocked(loadDiscoveryCursor).mockResolvedValue({
			transcriptPath: `${TRANSCRIPT_PATH}`,
			lineNumber: 5,
			updatedAt: new Date().toISOString(),
		});
		vi.mocked(existsSync).mockReturnValue(true);
		// Emit only 5 lines (same as cursor position)
		mockTranscriptWithLines(["line1", "line2", "line3", "line4", "line5"]);
		// Reference scan reaches the same line 5 — no new lines past the cursor.
		vi.mocked(extractReferencesFromTranscript).mockResolvedValue({ references: [], lastLineNumberScanned: 5 });

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(saveDiscoveryCursor).not.toHaveBeenCalled();
		expect(savePlansRegistry).not.toHaveBeenCalled();
	});

	it("should create new plan entry when plan-mode slug detected", async () => {
		// Transcript exists
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // plan file exists

		mockTranscriptWithLines(['{"type":"tool_result","slug":"my-test-plan","content":"..."}']);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(savePlansRegistry).toHaveBeenCalledWith(
			expect.objectContaining({
				plans: expect.objectContaining({
					"my-test-plan": expect.objectContaining({
						slug: "my-test-plan",
						title: "Plan Title",
						commitHash: null,
					}),
				}),
			}),
			PROJECT_DIR,
		);
	});

	it("should fall back to the file name when plan title cannot be read", async () => {
		vi.mocked(existsSync).mockReturnValueOnce(true).mockReturnValueOnce(true);
		vi.mocked(readFileSync).mockImplementationOnce(() => {
			throw new Error("read failed");
		});

		mockTranscriptWithLines(['{"type":"tool_result","slug":"fallback-plan","content":"..."}']);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(savePlansRegistry).toHaveBeenCalledWith(
			expect.objectContaining({
				plans: expect.objectContaining({
					"fallback-plan": expect.objectContaining({
						title: "fallback-plan.md",
					}),
				}),
			}),
			PROJECT_DIR,
		);
	});

	it("should fall back to the file name when the plan has no markdown heading", async () => {
		vi.mocked(existsSync).mockReturnValueOnce(true).mockReturnValueOnce(true);
		vi.mocked(readFileSync).mockReturnValueOnce("plain text only" as unknown as ReturnType<typeof readFileSync>);

		mockTranscriptWithLines(['{"type":"tool_result","slug":"untitled-plan","content":"..."}']);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(savePlansRegistry).toHaveBeenCalledWith(
			expect.objectContaining({
				plans: expect.objectContaining({
					"untitled-plan": expect.objectContaining({
						title: "untitled-plan.md",
					}),
				}),
			}),
			PROJECT_DIR,
		);
	});

	it("should create new plan entry when Write tool targets ~/.claude/plans/ dir", async () => {
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // plan file exists

		// JSON-encoded Windows path (double backslash)
		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Write","input":{"file_path":"C:\\\\Users\\\\user\\\\.claude\\\\plans\\\\direct-write-plan.md"}}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(savePlansRegistry).toHaveBeenCalledWith(
			expect.objectContaining({
				plans: expect.objectContaining({
					"direct-write-plan": expect.objectContaining({
						slug: "direct-write-plan",
						commitHash: null,
					}),
				}),
			}),
			PROJECT_DIR,
		);
	});

	it("should create new plan entry when Edit tool targets ~/.claude/plans/ dir", async () => {
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // plan file exists

		// Unix-style path
		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Edit","input":{"file_path":"/home/user/.claude/plans/unix-style-plan.md"}}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(savePlansRegistry).toHaveBeenCalledWith(
			expect.objectContaining({
				plans: expect.objectContaining({
					"unix-style-plan": expect.objectContaining({
						slug: "unix-style-plan",
					}),
				}),
			}),
			PROJECT_DIR,
		);
	});

	it("should ignore Write/Edit tool calls targeting non-.md files", async () => {
		// Pure non-.md paths must not be registered. (External .md handling has its own
		// suite below; the original `/tmp/not-a-plan.md` style path is now accepted as
		// an external plan by design — see "External .md path detection" tests.)
		vi.mocked(existsSync).mockReturnValue(true);

		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Write","input":{"file_path":"/repo/src/index.ts"}}',
			'{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/config.json"}}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(savePlansRegistry).not.toHaveBeenCalled();
	});

	it("should not duplicate a slug discovered multiple times in plan mode", async () => {
		vi.mocked(existsSync).mockReturnValueOnce(true).mockReturnValueOnce(true);

		mockTranscriptWithLines([
			'{"type":"tool_result","slug":"duplicate-plan","content":"first"}',
			'{"type":"tool_result","slug":"duplicate-plan","content":"second"}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(savePlansRegistry).toHaveBeenCalledWith(
			expect.objectContaining({
				plans: expect.objectContaining({
					"duplicate-plan": expect.objectContaining({}),
				}),
			}),
			PROJECT_DIR,
		);
	});

	it("should ignore malformed slug lines that contain the slug key but no value", async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		mockTranscriptWithLines(['{"type":"tool_result","slug":"","content":"broken"}']);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(savePlansRegistry).not.toHaveBeenCalled();
	});

	it("should update existing uncommitted plan", async () => {
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // plan file exists

		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: {
				"existing-plan": {
					slug: "existing-plan",
					title: "Existing Plan",
					sourcePath: "/home/user/.claude/plans/existing-plan.md",
					addedAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					commitHash: null,
				},
			},
		});

		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Write","input":{"file_path":"/home/user/.claude/plans/existing-plan.md"}}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(savePlansRegistry).toHaveBeenCalledWith(
			expect.objectContaining({
				plans: expect.objectContaining({
					"existing-plan": expect.objectContaining({
						sourcePath: "/home/user/.claude/plans/existing-plan.md",
					}),
				}),
			}),
			PROJECT_DIR,
		);
	});

	it("should skip committed plans", async () => {
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // plan file

		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: {
				"committed-plan": {
					slug: "committed-plan",
					title: "Committed Plan",
					sourcePath: "/home/user/.claude/plans/committed-plan.md",
					addedAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					commitHash: "abc12345",
				},
			},
		});

		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Edit","input":{"file_path":"/home/user/.claude/plans/committed-plan.md"}}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(savePlansRegistry).not.toHaveBeenCalled();
	});

	it("should skip plan when plan file does not exist on disk", async () => {
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file exists
			.mockReturnValueOnce(false); // plan file does NOT exist

		mockTranscriptWithLines(['{"type":"tool_result","slug":"missing-plan","content":"..."}']);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(savePlansRegistry).not.toHaveBeenCalled();
	});

	it("should skip archive-guarded plan when content hash matches", async () => {
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // plan file

		// readFileSync mock returns "# Plan Title\n\nContent" — SHA-256 of that value is the real hash below
		// (sha256("# Plan Title\n\nContent") = 1ab12ceb7fdd12641cbcefc8a5b7816c447423966a5b9976a4e004b6ae49fe6d)
		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: {
				"archived-plan": {
					slug: "archived-plan",
					title: "Archived Plan",
					sourcePath: "/home/user/.claude/plans/archived-plan.md",
					addedAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					commitHash: "abc12345",
					// Real SHA-256 of "# Plan Title\n\nContent" (what readFileSync mock returns)
					contentHashAtCommit: "1ab12ceb7fdd12641cbcefc8a5b7816c447423966a5b9976a4e004b6ae49fe6d",
				},
			},
		});

		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Write","input":{"file_path":"/home/user/.claude/plans/archived-plan.md"}}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		// Hash matches — guard still active, no save
		expect(savePlansRegistry).not.toHaveBeenCalled();
	});

	it("should create fresh entry for archive-guarded plan when content changed", async () => {
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // plan file

		// hash mock returns "current-file-hash" — differs from contentHashAtCommit
		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: {
				"reused-plan": {
					slug: "reused-plan",
					title: "Old Title",
					sourcePath: "/home/user/.claude/plans/reused-plan.md",
					addedAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					commitHash: "abc12345",
					contentHashAtCommit: "old-content-hash", // differs from "current-file-hash"
				},
			},
		});

		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Write","input":{"file_path":"/home/user/.claude/plans/reused-plan.md"}}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		// Hash differs — fresh entry created
		expect(savePlansRegistry).toHaveBeenCalledWith(
			expect.objectContaining({
				plans: expect.objectContaining({
					"reused-plan": expect.objectContaining({
						slug: "reused-plan",
						commitHash: null, // fresh uncommitted entry
					}),
				}),
			}),
			PROJECT_DIR,
		);
	});

	it("should only scan new transcript lines since last cursor position", async () => {
		// Cursor at line 1 — only line 2 is new
		vi.mocked(loadDiscoveryCursor).mockResolvedValue({
			transcriptPath: `${TRANSCRIPT_PATH}`,
			lineNumber: 1,
			updatedAt: new Date().toISOString(),
		});

		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // plan file

		mockTranscriptWithLines([
			// Line 1 (already scanned): contains slug that should be ignored
			'{"type":"tool_result","slug":"old-plan","content":"..."}',
			// Line 2 (new): contains a different slug
			'{"type":"tool_result","slug":"new-plan","content":"..."}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		// Only "new-plan" should be discovered (line 1 was already scanned)
		expect(savePlansRegistry).toHaveBeenCalledWith(
			expect.objectContaining({
				plans: expect.objectContaining({
					"new-plan": expect.any(Object),
				}),
			}),
			PROJECT_DIR,
		);
		const call = vi.mocked(savePlansRegistry).mock.calls[0]?.[0];
		expect(call?.plans).not.toHaveProperty("old-plan");
	});

	it("should handle plan discovery failure gracefully without crashing", async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		// Simulate createReadStream throwing
		vi.mocked(createReadStream).mockImplementationOnce(() => {
			throw new Error("disk error");
		});

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		// Should complete without throwing
		await expect(handleStopHook()).resolves.toBeUndefined();
	});

	it("should register a plan once when targeted by multiple Write calls", async () => {
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // plan file

		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Write","input":{"file_path":"/home/user/.claude/plans/multi-edit-plan.md"}}',
			'{"type":"tool_use","name":"Edit","input":{"file_path":"/home/user/.claude/plans/multi-edit-plan.md"}}',
			'{"type":"tool_use","name":"Write","input":{"file_path":"/home/user/.claude/plans/multi-edit-plan.md"}}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(savePlansRegistry).toHaveBeenCalledWith(
			expect.objectContaining({
				plans: expect.objectContaining({
					"multi-edit-plan": expect.objectContaining({ slug: "multi-edit-plan" }),
				}),
			}),
			PROJECT_DIR,
		);
	});

	it("should accept the fresh registry's archive-guard state when QueueWorker wins the race", async () => {
		// Race: PostCommitHook / QueueWorker archives the plan between StopHook's
		// two loadPlansRegistry calls. The fresh entry now has BOTH commitHash and
		// contentHashAtCommit — the archive-guard pair. StopHook's merge must
		// take the fresh entry wholesale rather than overlay just commitHash on
		// its stale local copy: dropping contentHashAtCommit would cause
		// PlanService.toPlanInfo to misclassify the entry as a snapshot copy.
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // plan file

		// First load: plan is still uncommitted
		vi.mocked(loadPlansRegistry)
			.mockResolvedValueOnce({
				version: 1,
				plans: {
					"race-plan": {
						slug: "race-plan",
						title: "Race Plan",
						sourcePath: "/home/user/.claude/plans/race-plan.md",
						addedAt: "2026-01-01T00:00:00Z",
						updatedAt: "2026-01-01T00:00:00Z",
						commitHash: null,
					},
				},
			})
			// Fresh load: QueueWorker has archived → both commitHash AND
			// contentHashAtCommit are present (this is what associatePlansWithCommit
			// actually writes in production).
			.mockResolvedValueOnce({
				version: 1,
				plans: {
					"race-plan": {
						slug: "race-plan",
						title: "Race Plan",
						sourcePath: "/home/user/.claude/plans/race-plan.md",
						addedAt: "2026-01-01T00:00:00Z",
						updatedAt: "2026-01-01T00:00:00Z",
						commitHash: "abc12345",
						contentHashAtCommit: "deadbeefhash",
					},
				},
			});

		// StopHook scans the transcript and, under the old per-field overlay, would
		// have overwritten just commitHash on its stale local copy; the
		// wholesale-fresh fix takes the fresh archive-guard entry instead.
		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Edit","input":{"file_path":"/home/user/.claude/plans/race-plan.md"}}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		const saved = vi.mocked(savePlansRegistry).mock.calls[0]?.[0];
		expect(saved?.plans["race-plan"]?.commitHash).toBe("abc12345");
		// Critical: contentHashAtCommit must come through so the archive-guard
		// branch in upsertEntry can revive this entry on the next file edit.
		expect(saved?.plans["race-plan"]?.contentHashAtCommit).toBe("deadbeefhash");
	});

	it("should preserve concurrent slugs added between load and save (no per-slug clobber)", async () => {
		// Race regression: while StopHook scans the transcript for `current-plan`,
		// a sibling writer (QueueWorker, parallel StopHook, extension) appends
		// `other-plan` to plans.json. The save-time merge must include the
		// concurrent slug, not overwrite the whole plans map with our local
		// snapshot that's missing it.
		vi.mocked(existsSync).mockReturnValueOnce(true).mockReturnValueOnce(true);

		vi.mocked(loadPlansRegistry)
			.mockResolvedValueOnce({
				version: 1,
				plans: {
					"current-plan": {
						slug: "current-plan",
						title: "Current Plan",
						sourcePath: "/home/user/.claude/plans/current-plan.md",
						addedAt: "2026-01-01T00:00:00Z",
						updatedAt: "2026-01-01T00:00:00Z",
						commitHash: null,
					},
				},
			})
			.mockResolvedValueOnce({
				version: 1,
				plans: {
					"current-plan": {
						slug: "current-plan",
						title: "Current Plan",
						sourcePath: "/home/user/.claude/plans/current-plan.md",
						addedAt: "2026-01-01T00:00:00Z",
						updatedAt: "2026-01-01T00:00:00Z",
						commitHash: null,
					},
					"other-plan": {
						slug: "other-plan",
						title: "Other Plan",
						sourcePath: "/home/user/.claude/plans/other-plan.md",
						addedAt: "2026-01-01T00:00:00Z",
						updatedAt: "2026-01-01T00:00:00Z",
						commitHash: "abc12345",
					},
				},
			});

		mockTranscriptWithLines(['{"type":"tool_result","slug":"current-plan","content":"..."}']);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		const saved = vi.mocked(savePlansRegistry).mock.calls[0]?.[0];
		// We don't touch `other-plan`, so its concurrent state passes through unchanged.
		expect(saved?.plans["other-plan"]).toBeDefined();
		expect(saved?.plans["other-plan"]?.commitHash).toBe("abc12345");
		expect(saved?.plans["current-plan"]?.commitHash).toBeNull();
	});

	it("should preserve a QueueWorker archive entry written between load and save", async () => {
		// Race scenario: AI edits docs/refactor-api.md → StopHook starts. User
		// commits in parallel → QueueWorker promotes the plan to an archive
		// guard and adds `refactor-api-abc12345`. StopHook's writeback must
		// preserve both the guard upgrade and the new archive entry.
		vi.mocked(existsSync).mockReturnValueOnce(true).mockReturnValueOnce(true);

		// First load: uncommitted state (before QueueWorker's writes)
		vi.mocked(loadPlansRegistry)
			.mockResolvedValueOnce({
				version: 1,
				plans: {
					"refactor-api": {
						slug: "refactor-api",
						title: "Refactor API",
						sourcePath: "/repo/docs/refactor-api.md",
						addedAt: "2026-01-01T00:00:00Z",
						updatedAt: "2026-01-01T00:00:00Z",
						commitHash: null,
					},
				},
			})
			// Second load (freshRegistry): QueueWorker has run, guard installed + archive added
			.mockResolvedValueOnce({
				version: 1,
				plans: {
					"refactor-api": {
						slug: "refactor-api",
						title: "Refactor API",
						sourcePath: "/repo/docs/refactor-api.md",
						addedAt: "2026-01-01T00:00:00Z",
						updatedAt: "2026-01-01T00:00:00Z",
						commitHash: "abc12345cafebabe",
						contentHashAtCommit: "deadbeefhash",
					},
					"refactor-api-abc12345": {
						slug: "refactor-api-abc12345",
						title: "Refactor API",
						sourcePath: "/repo/docs/refactor-api.md",
						addedAt: "2026-01-01T00:00:00Z",
						updatedAt: "2026-01-01T00:00:00Z",
						commitHash: "abc12345cafebabe",
					},
				},
			});

		// AI edited the external .md → our local plans will touch `refactor-api`
		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/docs/refactor-api.md"}}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		const saved = vi.mocked(savePlansRegistry).mock.calls[0]?.[0];
		// 1. Archive entry from QueueWorker must NOT be dropped.
		expect(saved?.plans["refactor-api-abc12345"]).toBeDefined();
		expect(saved?.plans["refactor-api-abc12345"]?.commitHash).toBe("abc12345cafebabe");
		// 2. Our edit on `refactor-api` should carry the concurrent commitHash through.
		expect(saved?.plans["refactor-api"]?.commitHash).toBe("abc12345cafebabe");
		// 3. Critical: contentHashAtCommit must come through too. Without it,
		//    PlanService.toPlanInfo's snapshot-copy filter (commitHash != null
		//    && !contentHashAtCommit) catches the entry and hides it from the
		//    panel, AND the upsertEntry archive-guard revive branch can never
		//    fire because it gates on `existing.contentHashAtCommit`.
		expect(saved?.plans["refactor-api"]?.contentHashAtCommit).toBe("deadbeefhash");
	});

	it("should let a subsequent file edit revive after QueueWorker won an earlier race", async () => {
		// Integration regression: simulates two consecutive Stop events.
		// Event 1: QueueWorker wins → freshRegistry has archive guard. After
		//   our merge, plans.json's refactor-api carries the full guard pair.
		// Event 2: user edits the file again → StopHook runs against the
		//   post-merge registry. The upsertEntry archive-guard branch should
		//   detect that the file content no longer matches contentHashAtCommit
		//   and revive the entry as fresh uncommitted (commitHash back to null).
		const planPath = "/repo/docs/refactor-api.md";

		// ── Event 1: QueueWorker-wins race ──
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(loadPlansRegistry)
			.mockResolvedValueOnce({
				version: 1,
				plans: {
					"refactor-api": {
						slug: "refactor-api",
						title: "Refactor API",
						sourcePath: planPath,
						addedAt: "2026-01-01T00:00:00Z",
						updatedAt: "2026-01-01T00:00:00Z",
						commitHash: null,
					},
				},
			})
			.mockResolvedValueOnce({
				version: 1,
				plans: {
					"refactor-api": {
						slug: "refactor-api",
						title: "Refactor API",
						sourcePath: planPath,
						addedAt: "2026-01-01T00:00:00Z",
						updatedAt: "2026-01-01T00:00:00Z",
						commitHash: "abc12345cafebabe",
						contentHashAtCommit: "snapshot-hash",
					},
				},
			});

		mockTranscriptWithLines([`{"type":"tool_use","name":"Edit","input":{"file_path":"${planPath}"}}`]);
		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		const afterEvent1 = vi.mocked(savePlansRegistry).mock.calls[0]?.[0];
		expect(afterEvent1?.plans["refactor-api"]?.contentHashAtCommit).toBe("snapshot-hash");

		// ── Event 2: user edits the file again ──
		// File content changed → sha256 of new content differs from
		// "snapshot-hash". Mock readFileSync to return content whose hash will
		// definitely not equal "snapshot-hash" (the mock default already does
		// this — content "# Plan Title\n\nContent" hashes to a different value).
		vi.mocked(loadDiscoveryCursor).mockResolvedValue(null);
		vi.mocked(loadPlansRegistry).mockReset();
		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: { "refactor-api": afterEvent1?.plans["refactor-api"] as PlanEntry },
		});
		vi.mocked(savePlansRegistry).mockClear();
		mockTranscriptWithLines([`{"type":"tool_use","name":"Edit","input":{"file_path":"${planPath}"}}`]);
		mockStdin(hookJson("/path/to/session-2.jsonl", PROJECT_DIR));
		await handleStopHook();

		// upsertEntry archive-guard branch should fire: contentHashAtCommit
		// present → compute file hash → mismatch → resurrect as fresh
		// uncommitted entry with commitHash null.
		const afterEvent2 = vi.mocked(savePlansRegistry).mock.calls[0]?.[0];
		expect(afterEvent2?.plans["refactor-api"]?.commitHash).toBeNull();
		expect(afterEvent2?.plans["refactor-api"]?.contentHashAtCommit).toBeUndefined();
	});

	it("should preserve a slug added by a parallel StopHook between load and save", async () => {
		// Race scenario: two Claude Code sessions open on the same repo. Both
		// StopHooks fire near-simultaneously. Session A registers `plan-a`,
		// Session B registers `plan-b`. Neither's save should drop the other's.
		vi.mocked(existsSync).mockReturnValueOnce(true).mockReturnValueOnce(true);

		vi.mocked(loadPlansRegistry)
			.mockResolvedValueOnce({ version: 1, plans: {} })
			.mockResolvedValueOnce({
				version: 1,
				plans: {
					"plan-b": {
						slug: "plan-b",
						title: "Plan B (from sibling)",
						sourcePath: "/repo/docs/plan-b.md",
						addedAt: "2026-01-01T00:00:00Z",
						updatedAt: "2026-01-01T00:00:00Z",
						commitHash: null,
					},
				},
			});

		// Our session is registering `plan-a`
		mockTranscriptWithLines(['{"type":"tool_use","name":"Write","input":{"file_path":"/repo/docs/plan-a.md"}}']);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		const saved = vi.mocked(savePlansRegistry).mock.calls[0]?.[0];
		expect(saved?.plans["plan-a"]).toBeDefined();
		expect(saved?.plans["plan-b"]).toBeDefined();
		expect(saved?.plans["plan-b"]?.title).toBe("Plan B (from sibling)");
	});

	it("should respect a concurrent hard delete of a touched slug (no revival)", async () => {
		// Race scenario: a tick (or Stop) re-touches an already-registered
		// uncommitted plan `foo` (e.g. the AI edited docs/foo.md again). Between our
		// outside-lock load and the in-lock re-read, the user clicks "Remove" in the
		// sidebar → removePlan deletes `foo` under the lock. Our writeback must NOT
		// resurrect it — the explicit delete wins over the racing auto-registration.
		vi.mocked(existsSync).mockReturnValue(true);

		vi.mocked(loadPlansRegistry)
			// Outside-lock load: `foo` is present (uncommitted).
			.mockResolvedValueOnce({
				version: 1,
				plans: {
					foo: {
						slug: "foo",
						title: "Foo",
						sourcePath: "/repo/docs/foo.md",
						addedAt: "2026-01-01T00:00:00Z",
						updatedAt: "2026-01-01T00:00:00Z",
						commitHash: null,
					},
				},
			})
			// In-lock re-read: a sibling (sidebar Remove) deleted `foo`.
			.mockResolvedValueOnce({ version: 1, plans: {} });

		// Our run re-touches `foo` (AI edited docs/foo.md again).
		mockTranscriptWithLines(['{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/docs/foo.md"}}']);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		const saved = vi.mocked(savePlansRegistry).mock.calls[0]?.[0];
		// `foo` must stay deleted — not revived from our local snapshot.
		expect(saved?.plans.foo).toBeUndefined();
		expect(Object.keys(saved?.plans ?? {})).toHaveLength(0);
	});

	it("should still write a slug newly created this run when fresh lacks it (not mistaken for a delete)", async () => {
		// Control for the hard-delete guard: a brand-new plan this run is absent
		// from the fresh re-read simply because no sibling has it yet — NOT because
		// it was deleted (the deleter never saw it). It must still be written.
		vi.mocked(existsSync).mockReturnValue(true);

		vi.mocked(loadPlansRegistry)
			.mockResolvedValueOnce({ version: 1, plans: {} }) // outside-lock: empty
			.mockResolvedValueOnce({ version: 1, plans: {} }); // in-lock: still empty

		// Our run creates a brand-new external plan.
		mockTranscriptWithLines(['{"type":"tool_use","name":"Write","input":{"file_path":"/repo/docs/brand-new.md"}}']);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		const saved = vi.mocked(savePlansRegistry).mock.calls[0]?.[0];
		expect(saved?.plans["brand-new"]).toBeDefined();
		expect(saved?.plans["brand-new"]?.sourcePath).toBe("/repo/docs/brand-new.md");
	});

	it("should resolve gracefully when readline emits an error during transcript scan", async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		mockTranscriptWithError();

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		// The error handler resolves the promise (does not reject).
		// Cursor should still be updated (totalLines = 0 since no lines were read).
		expect(savePlansRegistry).not.toHaveBeenCalled();
	});

	// ─── External .md path detection ────────────────────────────────────────

	it("should register external .md file (docs/foo.md) as a plan", async () => {
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // external plan file

		mockTranscriptWithLines(['{"type":"tool_use","name":"Write","input":{"file_path":"/repo/docs/foo-plan.md"}}']);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(savePlansRegistry).toHaveBeenCalledWith(
			expect.objectContaining({
				plans: expect.objectContaining({
					"foo-plan": expect.objectContaining({
						slug: "foo-plan",
						sourcePath: "/repo/docs/foo-plan.md",
						commitHash: null,
					}),
				}),
			}),
			PROJECT_DIR,
		);
	});

	it("should not register .md files under .claude/ (memory, skill, agent)", async () => {
		vi.mocked(existsSync).mockReturnValue(true);

		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Write","input":{"file_path":"/home/user/.claude/memory/feedback_x.md"}}',
			'{"type":"tool_use","name":"Edit","input":{"file_path":"/home/user/.claude/skill/foo.md"}}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(savePlansRegistry).not.toHaveBeenCalled();
	});

	it("should not register .md files under node_modules/", async () => {
		vi.mocked(existsSync).mockReturnValue(true);

		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Write","input":{"file_path":"/repo/node_modules/pkg/README.md"}}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(savePlansRegistry).not.toHaveBeenCalled();
	});

	it("should not register common non-plan basenames (README.md / CLAUDE.md / case-insensitive variants)", async () => {
		vi.mocked(existsSync).mockReturnValue(true);

		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Write","input":{"file_path":"/repo/README.md"}}',
			'{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/CLAUDE.md"}}',
			'{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/Claude.md"}}',
			'{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/claude.md"}}',
			'{"type":"tool_use","name":"Write","input":{"file_path":"/repo/AGENTS.md"}}',
			'{"type":"tool_use","name":"Write","input":{"file_path":"/repo/CHANGELOG.md"}}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(savePlansRegistry).not.toHaveBeenCalled();
	});

	it("should not register agent scratch review markdown (pr320-review.md / code-review.md / pr_review.md)", async () => {
		vi.mocked(existsSync).mockReturnValue(true);

		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Write","input":{"file_path":"/repo/pr320-review.md"}}',
			'{"type":"tool_use","name":"Write","input":{"file_path":"/repo/docs/code-review.md"}}',
			'{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/pr_review.md"}}',
			'{"type":"tool_use","name":"Write","input":{"file_path":"/repo/review.md"}}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(savePlansRegistry).not.toHaveBeenCalled();
	});

	it("should not register agent scratch report markdown (task-report.md / task_report.md / report.md)", async () => {
		vi.mocked(existsSync).mockReturnValue(true);

		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Write","input":{"file_path":"/repo/task-report.md"}}',
			'{"type":"tool_use","name":"Write","input":{"file_path":"/repo/docs/task_report.md"}}',
			'{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/report.md"}}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(savePlansRegistry).not.toHaveBeenCalled();
	});

	it("should not register .md files written under temp dirs (/tmp, /private/tmp scratchpad)", async () => {
		vi.mocked(existsSync).mockReturnValue(true);

		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Write","input":{"file_path":"/tmp/scratch-plan.md"}}',
			'{"type":"tool_use","name":"Write","input":{"file_path":"/private/tmp/claude-501/session/scratchpad/notes.md"}}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(savePlansRegistry).not.toHaveBeenCalled();
	});

	it("should register an external .md edited multiple times as a single plan entry", async () => {
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // external plan file

		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Write","input":{"file_path":"/repo/docs/multi.md"}}',
			'{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/docs/multi.md"}}',
			'{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/docs/multi.md"}}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(savePlansRegistry).toHaveBeenCalledWith(
			expect.objectContaining({
				plans: expect.objectContaining({
					multi: expect.objectContaining({ sourcePath: "/repo/docs/multi.md" }),
				}),
			}),
			PROJECT_DIR,
		);
	});

	it("should disambiguate external .md whose basename collides with an existing ~/.claude/plans/ slug", async () => {
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // external plan file

		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: {
				foo: {
					slug: "foo",
					title: "Canonical Foo",
					sourcePath: "/home/user/.claude/plans/foo.md",
					addedAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					commitHash: null,
				},
			},
		});

		mockTranscriptWithLines(['{"type":"tool_use","name":"Write","input":{"file_path":"/repo/docs/foo.md"}}']);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		const saved = vi.mocked(savePlansRegistry).mock.calls[0]?.[0];
		// Original `foo` is untouched, new slug is `foo-<hash8>`
		expect(saved?.plans.foo?.sourcePath).toBe("/home/user/.claude/plans/foo.md");
		const externalSlug = Object.keys(saved?.plans ?? {}).find((s) => /^foo-[0-9a-f]{8}$/.test(s));
		expect(externalSlug).toBeDefined();
		expect(saved?.plans[externalSlug as string]?.sourcePath).toBe("/repo/docs/foo.md");
	});

	it("should reuse hash-suffixed slug on subsequent edits (idempotent reverse-lookup)", async () => {
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // external plan file

		// Registry has ONLY the hash-suffixed entry — base `foo` slot was cleaned up.
		// Reverse-lookup by sourcePath must still find this entry and reuse its slug,
		// rather than naively registering a fresh `foo` entry.
		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: {
				"foo-a3b7c2d1": {
					slug: "foo-a3b7c2d1",
					title: "External Foo",
					sourcePath: "/repo/docs/foo.md",
					addedAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					commitHash: null,
				},
			},
		});

		mockTranscriptWithLines(['{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/docs/foo.md"}}']);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		const saved = vi.mocked(savePlansRegistry).mock.calls[0]?.[0];
		// Same slug reused (reverse-lookup by sourcePath); no spurious `foo` entry created
		expect(saved?.plans["foo-a3b7c2d1"]?.sourcePath).toBe("/repo/docs/foo.md");
		expect(saved?.plans.foo).toBeUndefined();
	});

	it("should advance cursor + write registry when transcript has only external .md plans (no slug)", async () => {
		// Regression guard: the early-exit must consider externalPlans, not just slugs.
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // external plan file

		mockTranscriptWithLines(['{"type":"tool_use","name":"Write","input":{"file_path":"/repo/docs/lonely.md"}}']);
		// Reference scan reaches the same single line — drives the merged cursor.
		vi.mocked(extractReferencesFromTranscript).mockResolvedValue({ references: [], lastLineNumberScanned: 1 });

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(savePlansRegistry).toHaveBeenCalled();
		expect(saveDiscoveryCursor).toHaveBeenCalledWith(
			expect.objectContaining({
				transcriptPath: `${TRANSCRIPT_PATH}`,
				lineNumber: 1,
			}),
			PROJECT_DIR,
		);
	});

	it("should accept .md paths outside the workspace (e.g. cross-project plans directory)", async () => {
		// Cross-project plan directories (notes/specs stored outside the repo's
		// own workspace) are a primary supported use case — auto-discovery
		// must not reject absolute paths simply because they live outside cwd.
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // external plan file

		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Edit","input":{"file_path":"E:\\\\jm-docs\\\\some-plan.md"}}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		// The slug is the basename ("some-plan"); sourcePath is the un-escaped Windows path.
		expect(savePlansRegistry).toHaveBeenCalledWith(
			expect.objectContaining({
				plans: expect.objectContaining({
					"some-plan": expect.objectContaining({
						sourcePath: "E:\\jm-docs\\some-plan.md",
					}),
				}),
			}),
			PROJECT_DIR,
		);
	});

	it("should NOT register external .md as a plan when it is already a markdown note", async () => {
		// Product-regression guard: a user added `docs/design.md` via "Add Markdown
		// File" (note semantics, manual selection). The AI then edits the same
		// file in a session. StopHook must not also register it as a plan — that
		// would shadow the user's note semantics, double-archive into the orphan
		// branch, and surface the same file twice in the panel.
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // .md file on disk

		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: {},
			notes: {
				"n-abc123": {
					id: "n-abc123",
					title: "Design Doc",
					format: "markdown",
					sourcePath: "/repo/docs/design.md",
					addedAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					// "unknown" matches getCurrentBranch() default in tests (no git repo)
					commitHash: null,
				},
			},
		});

		mockTranscriptWithLines(['{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/docs/design.md"}}']);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(savePlansRegistry).not.toHaveBeenCalled();
	});

	it("ignores notes without a sourcePath in the shadow set (covers `note.sourcePath` falsy arm)", async () => {
		// A note created via the "snippet" path can lack `sourcePath` (it's
		// stored inline). The plan-shadow guard must skip such entries — they
		// have no file to compare against the in-progress plan candidates.
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // .md file on disk

		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: {},
			notes: {
				"n-snippet": {
					id: "n-snippet",
					title: "Inline snippet",
					format: "snippet",
					// no sourcePath — falls through the `if (note.sourcePath)` guard
					addedAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					commitHash: null,
				} as never,
			},
		});

		mockTranscriptWithLines(['{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/docs/standalone.md"}}']);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		// Plan registration proceeds — the note had no path to shadow against.
		expect(savePlansRegistry).toHaveBeenCalled();
	});

	it("should treat any note's sourcePath as a shadowing source regardless of branch", async () => {
		// Notes are no longer branch-scoped — every note's sourcePath suppresses
		// plan auto-registration for the same file, regardless of which branch
		// the note was authored on. Pins that the shadow set ignores branch.
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // .md file on disk

		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: {},
			notes: {
				"n-shadow": {
					id: "n-shadow",
					title: "Global note",
					format: "markdown",
					sourcePath: "/repo/docs/legacy.md",
					addedAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					commitHash: null,
				},
			},
		});

		mockTranscriptWithLines(['{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/docs/legacy.md"}}']);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		// Branch-less note still shadows: no plan auto-registration.
		expect(savePlansRegistry).not.toHaveBeenCalled();
	});

	it("should match note sourcePath case-insensitively on Windows (and Darwin)", async () => {
		// Filesystem case mismatch (Note registered as "Design.md", AI edits "design.md"
		// referring to same file on case-insensitive FS) must still trigger the
		// note-shadowing guard. Asserts normalizePathForCompare is being applied
		// to both sides of the lookup. Pinned to win32 via withPlatform so the
		// case-folding branch runs on the Linux CI runner as well.
		await withPlatform("win32", async () => {
			vi.mocked(existsSync)
				.mockReturnValueOnce(true) // transcript file
				.mockReturnValueOnce(true); // .md file on disk

			vi.mocked(loadPlansRegistry).mockResolvedValue({
				version: 1,
				plans: {},
				notes: {
					"n-abc": {
						id: "n-abc",
						title: "Design",
						format: "markdown",
						sourcePath: "C:\\Repo\\Docs\\Design.md",
						addedAt: "2026-01-01T00:00:00Z",
						updatedAt: "2026-01-01T00:00:00Z",
						commitHash: null,
					},
				},
			});

			mockTranscriptWithLines([
				// AI used lowercase form
				'{"type":"tool_use","name":"Edit","input":{"file_path":"c:\\\\repo\\\\docs\\\\design.md"}}',
			]);

			mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
			await handleStopHook();

			expect(savePlansRegistry).not.toHaveBeenCalled();
		});
	});

	it("should NOT register a canonical ~/.claude/plans/ plan when it is already a note (L2)", async () => {
		// L2 regression: a user can pick a file under ~/.claude/plans/ via the
		// "Add Markdown File" picker, registering it as a note. The note guard
		// must apply to the canonical loop too, not just the external loop.
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // canonical plan file

		const canonicalPath = join("/home/user", ".claude", "plans", "shared.md");
		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: {},
			notes: {
				"n-shared": {
					id: "n-shared",
					title: "Shared",
					format: "markdown",
					sourcePath: canonicalPath,
					addedAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					commitHash: null,
				},
			},
		});

		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Write","input":{"file_path":"/home/user/.claude/plans/shared.md"}}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		// Canonical loop matched the slug but the note guard suppressed the upsert.
		expect(savePlansRegistry).not.toHaveBeenCalled();
	});

	it("should preserve notes and references fields when writing back to plans.json (C1)", async () => {
		// C1 regression: an earlier plan-discovery writeback wrote
		// `{ version: 1, plans }` which silently dropped sibling fields
		// (notes / references). loadPlansRegistry's contract is "spread to
		// preserve optional fields"; the writeback must honor that.
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // external plan file

		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: {},
			notes: {
				"n-keep": {
					id: "n-keep",
					title: "Keep me",
					format: "snippet",
					sourcePath: "/repo/.jolli/jollimemory/notes/n-keep.md",
					addedAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					commitHash: null,
				},
			},
			references: {
				"linear:PROJ-1": {
					source: "linear",
					nativeId: "PROJ-1",
					title: "Keep me too",
					url: "https://linear.app/x/PROJ-1",
					sourcePath: "/repo/.jolli/jollimemory/references/linear/PROJ-1.md",
					addedAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					sourceToolName: "mcp__linear__get_issue",
				},
			},
		});

		mockTranscriptWithLines(['{"type":"tool_use","name":"Write","input":{"file_path":"/repo/docs/new-plan.md"}}']);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		const saved = vi.mocked(savePlansRegistry).mock.calls[0]?.[0];
		expect(saved?.notes).toBeDefined();
		expect(saved?.notes?.["n-keep"]).toBeDefined();
		const savedRefs = saved?.references;
		expect(savedRefs).toBeDefined();
		expect(savedRefs?.["linear:PROJ-1"]).toBeDefined();
	});

	it("should skip external .md when source file no longer exists at upsert time", async () => {
		// Transcript exists but the .md was deleted between Edit and Stop.
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(false); // external plan file gone

		mockTranscriptWithLines(['{"type":"tool_use","name":"Write","input":{"file_path":"/repo/docs/gone.md"}}']);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(savePlansRegistry).not.toHaveBeenCalled();
	});

	it("should derive slug platform-agnostically from Windows-style transcript paths (CI regression)", async () => {
		// node:path.basename is platform-specific: on POSIX CI it does NOT
		// recognize `\` as a separator, so `basename("E:\\jm-docs\\some-plan.md", ".md")`
		// returns the entire string with `.md` stripped. The implementation must
		// use a separator-agnostic split so this case yields slug "some-plan"
		// regardless of the runtime platform.
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // external plan file

		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Edit","input":{"file_path":"E:\\\\jm-docs\\\\some-plan.md"}}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		const saved = vi.mocked(savePlansRegistry).mock.calls[0]?.[0];
		expect(saved?.plans["some-plan"]).toBeDefined();
		// Make sure the buggy full-path slug never appears
		const buggySlug = Object.keys(saved?.plans ?? {}).find((s) => s.includes("\\") || s.includes("/"));
		expect(buggySlug).toBeUndefined();
	});

	it("should hash-suffix a canonical ~/.claude/plans/ slug when an external entry already holds the base slug", async () => {
		// Collision-order regression: external `docs/foo.md` was registered first
		// at slug `foo`. Later, a canonical `~/.claude/plans/foo.md` edit must
		// NOT overwrite the external entry's sourcePath via upsertEntry — it
		// must claim a hash-suffixed slot.
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // canonical plan file

		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: {
				foo: {
					slug: "foo",
					title: "External Foo",
					sourcePath: "/repo/docs/foo.md", // external lives at base slug
					addedAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					commitHash: null,
				},
			},
		});

		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Write","input":{"file_path":"/home/user/.claude/plans/foo.md"}}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		const saved = vi.mocked(savePlansRegistry).mock.calls[0]?.[0];
		// External entry's sourcePath must be untouched
		expect(saved?.plans.foo?.sourcePath).toBe("/repo/docs/foo.md");
		// Canonical lands in a hash-suffixed slug; assert via join() so the
		// expected separators match what the implementation's `join(homedir(),
		// ...)` produces on the current platform.
		const canonicalSlug = Object.keys(saved?.plans ?? {}).find((s) => /^foo-[0-9a-f]{8}$/.test(s));
		expect(canonicalSlug).toBeDefined();
		expect(saved?.plans[canonicalSlug as string]?.sourcePath).toBe(
			join("/home/user", ".claude", "plans", "foo.md"),
		);
	});
});

describe("StopHook — entity discovery (multi-source)", () => {
	const TRANSCRIPT_PATH = "/path/to/session.jsonl";
	const PROJECT_DIR = "/my/project";
	const REF = {
		mapKey: "linear:PROJ-1528",
		source: "linear" as const,
		nativeId: "PROJ-1528",
		title: "Treat referenced Linear issues",
		url: "https://linear.app/x/PROJ-1528",
		toolName: "mcp__linear__get_issue",
		referencedAt: "2026-05-14T06:06:01.123Z",
		description: "## Problem\nbody",
	} as const;

	beforeEach(() => {
		vi.clearAllMocks();
		process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
		vi.mocked(loadConfig).mockResolvedValue({});
		vi.mocked(loadDiscoveryCursor).mockResolvedValue(null);
		vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {} });
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(extractReferencesFromTranscript).mockResolvedValue({
			references: [],
			lastLineNumberScanned: 0,
		});
	});

	afterEach(() => {
		process.env.CLAUDE_PROJECT_DIR = undefined;
	});

	it("skips when transcript file does not exist", async () => {
		vi.mocked(existsSync).mockReturnValue(false);
		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();
		expect(extractReferencesFromTranscript).not.toHaveBeenCalled();
		expect(upsertReferenceEntry).not.toHaveBeenCalled();
	});

	it("upserts entity entry when a ref is extracted", async () => {
		// existsSync called twice: once for plan discovery (false), once for entity (true).
		// Use mockImplementation to return true only for the entity path.
		vi.mocked(existsSync).mockImplementation((p: unknown) => p === TRANSCRIPT_PATH);
		// Plan discovery emits no slugs (transcript stream returns no lines).
		mockTranscriptWithLines([]);
		vi.mocked(extractReferencesFromTranscript).mockResolvedValue({
			references: [REF],
			lastLineNumberScanned: 42,
		});

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(upsertReferenceEntry).toHaveBeenCalledWith(REF, PROJECT_DIR, expect.any(String));
		expect(saveDiscoveryCursor).toHaveBeenCalledWith(
			expect.objectContaining({
				transcriptPath: `${TRANSCRIPT_PATH}`,
				lineNumber: 42,
			}),
			PROJECT_DIR,
		);
	});

	it("advances cursor even when no entities found, as long as new lines were scanned", async () => {
		vi.mocked(existsSync).mockImplementation((p: unknown) => p === TRANSCRIPT_PATH);
		mockTranscriptWithLines([]);
		vi.mocked(extractReferencesFromTranscript).mockResolvedValue({
			references: [],
			lastLineNumberScanned: 10,
		});

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(upsertReferenceEntry).not.toHaveBeenCalled();
		expect(saveDiscoveryCursor).toHaveBeenCalledWith(
			expect.objectContaining({
				transcriptPath: `${TRANSCRIPT_PATH}`,
				lineNumber: 10,
			}),
			PROJECT_DIR,
		);
	});

	it("does not save cursor when there are no new lines since last scan", async () => {
		vi.mocked(existsSync).mockImplementation((p: unknown) => p === TRANSCRIPT_PATH);
		mockTranscriptWithLines([]);
		vi.mocked(loadDiscoveryCursor).mockResolvedValue({
			transcriptPath: `${TRANSCRIPT_PATH}`,
			lineNumber: 5,
			updatedAt: new Date().toISOString(),
		});
		vi.mocked(extractReferencesFromTranscript).mockResolvedValue({
			references: [],
			lastLineNumberScanned: 5,
		});

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		// saveDiscoveryCursor should not be called for the linear: prefix when lastLine === fromLine
		const linearSaves = vi
			.mocked(saveDiscoveryCursor)
			.mock.calls.filter((c) => (c[0] as { transcriptPath: string }).transcriptPath === `${TRANSCRIPT_PATH}`);
		expect(linearSaves).toHaveLength(0);
	});

	it("logs the error and continues when extractor throws", async () => {
		vi.mocked(existsSync).mockImplementation((p: unknown) => p === TRANSCRIPT_PATH);
		mockTranscriptWithLines([]);
		vi.mocked(extractReferencesFromTranscript).mockRejectedValue(new Error("boom"));

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		// Should not throw; handleStopHook swallows the error
		await expect(handleStopHook()).resolves.toBeUndefined();
		expect(upsertReferenceEntry).not.toHaveBeenCalled();
	});

	it("continues with the rest of the batch when one ref's upsert fails (cursor still advances)", async () => {
		// Per-ref persistence failures (upsertReferenceEntry throwing) must NOT
		// abort the loop — skipping cursor save on the first failure would put
		// the StopHook in a re-process loop hammering the same ref. The
		// cursor advance covers all three terminal paths: full success,
		// partial failure, and total failure.
		vi.mocked(existsSync).mockImplementation((p: unknown) => p === TRANSCRIPT_PATH);
		mockTranscriptWithLines([]);
		const okRef = { ...REF, mapKey: "linear:PROJ-OK", nativeId: "PROJ-OK" };
		const badRef = { ...REF, mapKey: "linear:PROJ-BAD", nativeId: "PROJ-BAD" };
		vi.mocked(extractReferencesFromTranscript).mockResolvedValue({
			references: [badRef, okRef],
			lastLineNumberScanned: 7,
		});
		// First upsert throws (per-batch failure path), second succeeds.
		vi.mocked(upsertReferenceEntry)
			.mockRejectedValueOnce(new Error("EACCES — write blocked"))
			.mockResolvedValueOnce(undefined);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		// Both refs reached upsert (the bad one threw, but the loop continued).
		const upsertCalls = vi.mocked(upsertReferenceEntry).mock.calls;
		expect(upsertCalls).toHaveLength(2);
		expect(upsertCalls[0]?.[0]).toMatchObject({ mapKey: "linear:PROJ-BAD" });
		expect(upsertCalls[1]?.[0]).toMatchObject({ mapKey: "linear:PROJ-OK" });
		// Cursor still advances — preventing the StopHook from re-processing
		// the same window on the next invocation.
		expect(saveDiscoveryCursor).toHaveBeenCalledWith(
			expect.objectContaining({
				transcriptPath: `${TRANSCRIPT_PATH}`,
				lineNumber: 7,
			}),
			PROJECT_DIR,
		);
	});
});
