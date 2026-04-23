import type { ReadStream } from "node:fs";
import type { Interface as ReadlineInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock SessionTracker — includes both original and new plan-discovery functions
vi.mock("../core/SessionTracker.js", () => ({
	saveSession: vi.fn(),
	loadConfig: vi.fn().mockResolvedValue({}),
	loadCursorForTranscript: vi.fn().mockResolvedValue(null),
	saveCursor: vi.fn().mockResolvedValue(undefined),
	loadPlansRegistry: vi.fn().mockResolvedValue({ version: 1, plans: {} }),
	savePlansRegistry: vi.fn().mockResolvedValue(undefined),
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
import { createInterface } from "node:readline";
import {
	loadConfig,
	loadCursorForTranscript,
	loadPlansRegistry,
	saveCursor,
	savePlansRegistry,
	saveSession,
} from "../core/SessionTracker.js";
import { handleStopHook } from "./StopHook.js";

/** Helper to mock stdin with given content */
function mockStdin(content: string): void {
	const mockStream = {
		setEncoding: vi.fn(),
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
		// Default: loadCursorForTranscript returns null (no prior scan)
		vi.mocked(loadCursorForTranscript).mockResolvedValue(null);
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
		vi.mocked(loadCursorForTranscript).mockResolvedValue(null);
		vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {} });
		// Default: files don't exist
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(readFileSync).mockReturnValue("# Plan Title\n\nContent" as unknown as Buffer);
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

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(saveCursor).toHaveBeenCalledWith(
			expect.objectContaining({
				transcriptPath: `plan:${TRANSCRIPT_PATH}`,
				lineNumber: 2,
			}),
			PROJECT_DIR,
		);
		expect(savePlansRegistry).not.toHaveBeenCalled();
	});

	it("should not update cursor when transcript has no new lines since last scan", async () => {
		// Last scan was at line 5, transcript still only has 5 lines
		vi.mocked(loadCursorForTranscript).mockResolvedValue({
			transcriptPath: `plan:${TRANSCRIPT_PATH}`,
			lineNumber: 5,
			updatedAt: new Date().toISOString(),
		});
		vi.mocked(existsSync).mockReturnValue(true);
		// Emit only 5 lines (same as cursor position)
		mockTranscriptWithLines(["line1", "line2", "line3", "line4", "line5"]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		expect(saveCursor).not.toHaveBeenCalled();
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
						editCount: 0,
						branch: expect.any(String),
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
		vi.mocked(readFileSync).mockReturnValueOnce("plain text only" as unknown as Buffer);

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
						editCount: 1,
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
						editCount: 1,
					}),
				}),
			}),
			PROJECT_DIR,
		);
	});

	it("should ignore Write/Edit tool calls that do not target the plans directory", async () => {
		vi.mocked(existsSync).mockReturnValue(true);

		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Write","input":{"file_path":"/tmp/not-a-plan.md"}}',
			'{"type":"tool_use","name":"Edit","input":{"file_path":"C:\\\\Users\\\\user\\\\Desktop\\\\note.md"}}',
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
					"duplicate-plan": expect.objectContaining({
						editCount: 0,
					}),
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

	it("should increment editCount for existing uncommitted plan", async () => {
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
					branch: "main",
					commitHash: null,
					editCount: 5,
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
						editCount: 6, // 5 + 1
					}),
				}),
			}),
			PROJECT_DIR,
		);
	});

	it("should skip updating editCount for committed plans", async () => {
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
					branch: "main",
					commitHash: "abc12345",
					editCount: 3,
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

	it("should skip updating editCount for ignored plans", async () => {
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // plan file

		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: {
				"ignored-plan": {
					slug: "ignored-plan",
					title: "Ignored Plan",
					sourcePath: "/home/user/.claude/plans/ignored-plan.md",
					addedAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					branch: "main",
					commitHash: null,
					editCount: 2,
					ignored: true,
				},
			},
		});

		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Edit","input":{"file_path":"/home/user/.claude/plans/ignored-plan.md"}}',
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
					branch: "main",
					commitHash: "abc12345",
					editCount: 2,
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
					branch: "main",
					commitHash: "abc12345",
					editCount: 5,
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
						editCount: 1,
					}),
				}),
			}),
			PROJECT_DIR,
		);
	});

	it("should not resurrect an ignored archive-guarded plan even when content changed", async () => {
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // plan file

		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: {
				"removed-plan": {
					slug: "removed-plan",
					title: "Removed Plan",
					sourcePath: "/home/user/.claude/plans/removed-plan.md",
					addedAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					branch: "main",
					commitHash: "abc12345",
					editCount: 3,
					contentHashAtCommit: "old-content-hash",
					ignored: true,
				},
			},
		});

		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Write","input":{"file_path":"/home/user/.claude/plans/removed-plan.md"}}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		// Even though content changed, ignored flag should prevent resurrection
		expect(savePlansRegistry).not.toHaveBeenCalled();
	});

	it("should only scan new transcript lines since last cursor position", async () => {
		// Cursor at line 1 — only line 2 is new
		vi.mocked(loadCursorForTranscript).mockResolvedValue({
			transcriptPath: `plan:${TRANSCRIPT_PATH}`,
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

	it("should accumulate editCount when same plan targeted by multiple Write calls", async () => {
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
					"multi-edit-plan": expect.objectContaining({
						editCount: 3,
					}),
				}),
			}),
			PROJECT_DIR,
		);
	});

	it("should preserve commitHash from PostCommitHook even when StopHook scans the same slug", async () => {
		// Simulates the race: PostCommitHook writes commitHash between StopHook's two
		// loadPlansRegistry calls. The second (fresh) read sees the commitHash, and
		// StopHook must not overwrite it — even though this slug was in its own scan.
		vi.mocked(existsSync)
			.mockReturnValueOnce(true) // transcript file
			.mockReturnValueOnce(true); // plan file

		// First loadPlansRegistry: plan is still uncommitted
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
						branch: "main",
						commitHash: null,
						editCount: 3,
					},
				},
			})
			// Second (fresh) loadPlansRegistry: PostCommitHook has now written commitHash
			.mockResolvedValueOnce({
				version: 1,
				plans: {
					"race-plan": {
						slug: "race-plan",
						title: "Race Plan",
						sourcePath: "/home/user/.claude/plans/race-plan.md",
						addedAt: "2026-01-01T00:00:00Z",
						updatedAt: "2026-01-01T00:00:00Z",
						branch: "main",
						commitHash: "abc12345", // PostCommitHook wrote this
						editCount: 3,
					},
				},
			});

		// StopHook scans the transcript and finds race-plan (editCount +1)
		mockTranscriptWithLines([
			'{"type":"tool_use","name":"Edit","input":{"file_path":"/home/user/.claude/plans/race-plan.md"}}',
		]);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		// commitHash from PostCommitHook must be preserved — not wiped by StopHook's write
		expect(savePlansRegistry).toHaveBeenCalledWith(
			expect.objectContaining({
				plans: expect.objectContaining({
					"race-plan": expect.objectContaining({
						commitHash: "abc12345",
						editCount: 4, // editCount still incremented by StopHook
					}),
				}),
			}),
			PROJECT_DIR,
		);
	});

	it("should ignore fresh registry commit hashes for slugs not present in the current scan result", async () => {
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
						branch: "main",
						commitHash: null,
						editCount: 0,
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
						branch: "main",
						commitHash: null,
						editCount: 0,
					},
					"other-plan": {
						slug: "other-plan",
						title: "Other Plan",
						sourcePath: "/home/user/.claude/plans/other-plan.md",
						addedAt: "2026-01-01T00:00:00Z",
						updatedAt: "2026-01-01T00:00:00Z",
						branch: "main",
						commitHash: "abc12345",
						editCount: 2,
					},
				},
			});

		mockTranscriptWithLines(['{"type":"tool_result","slug":"current-plan","content":"..."}']);

		mockStdin(hookJson(TRANSCRIPT_PATH, PROJECT_DIR));
		await handleStopHook();

		const saved = vi.mocked(savePlansRegistry).mock.calls[0]?.[0];
		expect(saved?.plans["current-plan"]?.commitHash).toBeNull();
		expect(saved?.plans["other-plan"]).toBeUndefined();
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
});
