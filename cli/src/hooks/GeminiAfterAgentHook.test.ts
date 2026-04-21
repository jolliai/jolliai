import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock SessionTracker
vi.mock("../core/SessionTracker.js", () => ({
	saveSession: vi.fn(),
}));

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import { saveSession } from "../core/SessionTracker.js";
import { handleGeminiAfterAgentHook } from "./GeminiAfterAgentHook.js";

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

/** Captures stdout writes */
function captureStdout(): string[] {
	const writes: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
		writes.push(String(chunk));
		return true;
	});
	return writes;
}

describe("GeminiAfterAgentHook", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		vi.clearAllMocks();
		process.env = { ...originalEnv };
		process.env.GEMINI_PROJECT_DIR = undefined;
		process.env.CLAUDE_PROJECT_DIR = undefined;
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("should save session with source='gemini' from valid stdin", async () => {
		const hookData = {
			session_id: "gemini-session-123",
			transcript_path: "/home/user/.gemini/tmp/abc/chats/session-2026.json",
			cwd: "/my/project",
		};

		mockStdin(JSON.stringify(hookData));
		const writes = captureStdout();
		await handleGeminiAfterAgentHook();

		expect(saveSession).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "gemini-session-123",
				transcriptPath: "/home/user/.gemini/tmp/abc/chats/session-2026.json",
				source: "gemini",
			}),
			"/my/project",
		);

		// Gemini hooks must write JSON to stdout
		expect(writes.some((w) => w.includes("{}"))).toBe(true);
	});

	it("should prefer GEMINI_PROJECT_DIR over hookData.cwd", async () => {
		process.env.GEMINI_PROJECT_DIR = "/stable/project/root";

		const hookData = {
			session_id: "gemini-456",
			transcript_path: "/path/to/session.json",
			cwd: "/different/cwd",
		};

		mockStdin(JSON.stringify(hookData));
		captureStdout();
		await handleGeminiAfterAgentHook();

		expect(saveSession).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "gemini-456",
				source: "gemini",
			}),
			"/stable/project/root",
		);
	});

	it("should fall back to CLAUDE_PROJECT_DIR when GEMINI_PROJECT_DIR is absent", async () => {
		process.env.CLAUDE_PROJECT_DIR = "/claude/project";

		const hookData = {
			session_id: "gemini-789",
			transcript_path: "/path/to/session.json",
			cwd: "/different/cwd",
		};

		mockStdin(JSON.stringify(hookData));
		captureStdout();
		await handleGeminiAfterAgentHook();

		expect(saveSession).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "gemini-789" }),
			"/claude/project",
		);
	});

	it("should write {} to stdout even on invalid JSON", async () => {
		mockStdin("not valid json");
		const writes = captureStdout();
		await handleGeminiAfterAgentHook();

		expect(saveSession).not.toHaveBeenCalled();
		expect(writes.some((w) => w.includes("{}"))).toBe(true);
	});

	it("should write {} to stdout on missing fields", async () => {
		mockStdin(JSON.stringify({ some_other_field: true }));
		const writes = captureStdout();
		await handleGeminiAfterAgentHook();

		expect(saveSession).not.toHaveBeenCalled();
		expect(writes.some((w) => w.includes("{}"))).toBe(true);
	});

	it("should write {} to stdout on empty stdin", async () => {
		mockEmptyStdin();
		const writes = captureStdout();
		await handleGeminiAfterAgentHook();

		expect(saveSession).not.toHaveBeenCalled();
		expect(writes.some((w) => w.includes("{}"))).toBe(true);
	});

	it("should write {} to stdout on stdin read error", async () => {
		mockStdinError("stream error");
		const writes = captureStdout();
		await handleGeminiAfterAgentHook();

		expect(saveSession).not.toHaveBeenCalled();
		expect(writes.some((w) => w.includes("{}"))).toBe(true);
	});

	it("should handle saveSession failure gracefully and still write stdout", async () => {
		const hookData = {
			session_id: "test-session",
			transcript_path: "/path/to/session.json",
			cwd: "/project",
		};

		mockStdin(JSON.stringify(hookData));
		vi.mocked(saveSession).mockRejectedValueOnce(new Error("disk full"));
		const writes = captureStdout();

		await handleGeminiAfterAgentHook();

		expect(saveSession).toHaveBeenCalled();
		expect(writes.some((w) => w.includes("{}"))).toBe(true);
	});
});
