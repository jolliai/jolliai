import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
	appendFile: vi.fn(),
	stat: vi.fn(),
	writeFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
	appendFile: fsMocks.appendFile,
	stat: fsMocks.stat,
	writeFile: fsMocks.writeFile,
}));

import {
	createLogger,
	formatLogMessage,
	getJolliMemoryDir,
	resetLogDir,
	setLogDir,
	setLogLevel,
	setSilentConsole,
} from "./Logger.js";

describe("Logger", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		// Disable silent mode so tests can verify console output
		setSilentConsole(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fsMocks.stat.mockReset();
		fsMocks.appendFile.mockReset();
		fsMocks.writeFile.mockReset();
		resetLogDir();
		setSilentConsole(true);
	});

	describe("formatLogMessage", () => {
		it("should format message with timestamp and module", () => {
			const result = formatLogMessage("info", "TestModule", "hello world", []);
			expect(result).toMatch(/^\[\d{4}-\d{2}-\d{2}T/);
			expect(result).toContain("INFO ");
			expect(result).toContain("[TestModule]");
			expect(result).toContain("hello world");
		});

		it("should replace %s with string args", () => {
			const result = formatLogMessage("info", "Test", "name is %s", ["Alice"]);
			expect(result).toContain("name is Alice");
		});

		it("should replace %d with number args", () => {
			const result = formatLogMessage("info", "Test", "count: %d", [42]);
			expect(result).toContain("count: 42");
		});

		it("should replace %j with JSON args", () => {
			const result = formatLogMessage("info", "Test", "data: %j", [{ a: 1 }]);
			expect(result).toContain('data: {"a":1}');
		});

		it("should pad level to 5 chars", () => {
			const info = formatLogMessage("info", "T", "x", []);
			expect(info).toContain("INFO ");
			const warn = formatLogMessage("warn", "T", "x", []);
			expect(warn).toContain("WARN ");
			const error = formatLogMessage("error", "T", "x", []);
			expect(error).toContain("ERROR");
		});

		it("should handle excess format specifiers gracefully", () => {
			const result = formatLogMessage("info", "Test", "%s and %s", ["only-one"]);
			expect(result).toContain("only-one and %s");
		});
	});

	describe("getJolliMemoryDir", () => {
		it("should return .jolli/jollimemory under cwd", () => {
			const result = getJolliMemoryDir("/test/project");
			expect(result).toMatch(/\.jolli[/\\]jollimemory$/);
		});

		it("should use process.cwd when no cwd provided and no logDir set", () => {
			const result = getJolliMemoryDir();
			expect(result).toContain(".jolli");
		});

		it("should use setLogDir value when no explicit cwd is provided", () => {
			setLogDir("/my/project");
			const result = getJolliMemoryDir();
			expect(result).toMatch(/my[/\\]project[/\\]\.jolli[/\\]jollimemory$/);
		});

		it("should prefer explicit cwd over setLogDir value", () => {
			setLogDir("/my/project");
			const result = getJolliMemoryDir("/explicit/path");
			expect(result).toMatch(/explicit[/\\]path[/\\]\.jolli[/\\]jollimemory$/);
		});
	});

	describe("setLogLevel", () => {
		it("should configure global log level and module overrides", () => {
			// Just exercises the function — no throw means it works
			setLogLevel("warn", { Summarizer: "debug" });
			// Reset to default for other tests
			setLogLevel("info");
		});

		it("should configure global log level without overrides", () => {
			setLogLevel("error");
			setLogLevel("info");
		});
	});

	describe("createLogger", () => {
		it("should log info messages to console.error (stderr)", () => {
			const logger = createLogger("TestMod");
			logger.info("test message");
			expect(console.error).toHaveBeenCalledOnce();
			const call = vi.mocked(console.error).mock.calls[0][0] as string;
			expect(call).toContain("[TestMod]");
			expect(call).toContain("test message");
		});

		it("should log error messages to console.error", () => {
			const logger = createLogger("TestMod");
			logger.error("bad thing");
			expect(console.error).toHaveBeenCalledOnce();
		});

		it("should log warn messages to console.warn", () => {
			const logger = createLogger("TestMod");
			logger.warn("caution");
			expect(console.warn).toHaveBeenCalledOnce();
		});

		it("should log debug messages to console.error (stderr)", () => {
			const logger = createLogger("TestMod");
			logger.debug("detail");
			expect(console.error).toHaveBeenCalledOnce();
		});

		it("should format args in messages", () => {
			const logger = createLogger("TestMod");
			logger.info("count: %d, name: %s", 5, "test");
			const call = vi.mocked(console.error).mock.calls[0][0] as string;
			expect(call).toContain("count: 5, name: test");
		});

		it("should handle appendToLogFile failure gracefully", async () => {
			// Set global log dir to invalid path containing null bytes (causes filesystem error)
			setLogDir("/\0invalid/path");
			const logger = createLogger("TestMod");
			// warn/error trigger appendToLogFile which should silently fail
			logger.error("test error");
			logger.warn("test warning");
			// Should not throw — the catch block silently ignores the error
			expect(console.error).toHaveBeenCalledOnce();
			expect(console.warn).toHaveBeenCalledOnce();
			// Give the async appendToLogFile time to settle
			await new Promise((resolve) => setTimeout(resolve, 50));
		});

		it("should append to the log file when not running under vitest mode", async () => {
			const envSpy = vi.spyOn(process, "env", "get");
			fsMocks.stat.mockResolvedValue({});
			fsMocks.appendFile.mockResolvedValue(undefined);
			envSpy.mockReturnValue({ ...process.env, VITEST: "" });
			setLogDir("/tmp/project");

			const logger = createLogger("TestMod");
			logger.info("persist %s", "me");

			await new Promise((resolve) => setTimeout(resolve, 0));

			// stat is called twice: once for the directory check, once for log rotation
			expect(fsMocks.stat).toHaveBeenCalledTimes(2);
			expect(fsMocks.appendFile).toHaveBeenCalledOnce();
			expect(fsMocks.appendFile.mock.calls[0]?.[0]).toMatch(/debug\.log$/);
			expect(fsMocks.appendFile.mock.calls[0]?.[1]).toContain("persist me");
		});

		it("should rotate log file when it exceeds size limit", async () => {
			const envSpy = vi.spyOn(process, "env", "get");
			// First stat call: directory exists; second stat call: file exceeds max size (512KB)
			fsMocks.stat
				.mockResolvedValueOnce({}) // directory check
				.mockResolvedValueOnce({ size: 600_000 }); // file size > 512 * 1024
			fsMocks.writeFile.mockResolvedValue(undefined);
			fsMocks.appendFile.mockResolvedValue(undefined);
			envSpy.mockReturnValue({ ...process.env, VITEST: "" });
			setLogDir("/tmp/project");

			const logger = createLogger("TestMod");
			logger.info("after rotation");

			await new Promise((resolve) => setTimeout(resolve, 0));

			// writeFile should be called for log rotation
			expect(fsMocks.writeFile).toHaveBeenCalledOnce();
			expect(fsMocks.writeFile.mock.calls[0]?.[0]).toMatch(/debug\.log$/);
			expect(fsMocks.writeFile.mock.calls[0]?.[1]).toContain("[log rotated at");
			// appendFile should also be called to write the new log line
			expect(fsMocks.appendFile).toHaveBeenCalledOnce();
		});

		it("should suppress info/debug console output when silentConsole is enabled", () => {
			setSilentConsole(true);
			const logger = createLogger("TestMod");

			logger.info("suppressed info");
			logger.debug("suppressed debug");

			// info and debug should NOT appear on console
			expect(console.error).not.toHaveBeenCalled();
			expect(console.warn).not.toHaveBeenCalled();

			// warn and error should still appear
			logger.warn("visible warning");
			expect(console.warn).toHaveBeenCalledOnce();

			logger.error("visible error");
			expect(console.error).toHaveBeenCalledOnce();

			setSilentConsole(false);
		});

		it("should swallow file write failures when not running under vitest mode", async () => {
			const envSpy = vi.spyOn(process, "env", "get");
			fsMocks.stat.mockRejectedValue(new Error("missing dir"));
			fsMocks.appendFile.mockResolvedValue(undefined);
			envSpy.mockReturnValue({ ...process.env, VITEST: "" });
			setLogDir("/tmp/project");

			const logger = createLogger("TestMod");
			expect(() => logger.error("persist failure")).not.toThrow();

			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(fsMocks.stat).toHaveBeenCalledOnce();
			expect(fsMocks.appendFile).not.toHaveBeenCalled();
		});
	});
});
