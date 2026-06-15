import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
	appendFile: vi.fn(),
	stat: vi.fn(),
	rename: vi.fn(),
	readdir: vi.fn(),
	unlink: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
	appendFile: fsMocks.appendFile,
	stat: fsMocks.stat,
	rename: fsMocks.rename,
	readdir: fsMocks.readdir,
	unlink: fsMocks.unlink,
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
		fsMocks.rename.mockReset();
		fsMocks.readdir.mockReset();
		fsMocks.unlink.mockReset();
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

			// stat is called twice: once for the directory check, once for the rotation size check
			expect(fsMocks.stat).toHaveBeenCalledTimes(2);
			expect(fsMocks.appendFile).toHaveBeenCalledOnce();
			expect(fsMocks.appendFile.mock.calls[0]?.[0]).toMatch(/debug\.log$/);
			expect(fsMocks.appendFile.mock.calls[0]?.[1]).toContain("persist me");
		});

		it("rotates: archives debug.log to debug_<timestamp>.log and keeps appending to a fresh file", async () => {
			const envSpy = vi.spyOn(process, "env", "get");
			fsMocks.stat
				.mockResolvedValueOnce({}) // directory check
				.mockResolvedValueOnce({ size: 3 * 1024 * 1024 }) // logPath size > 2 MB → rotate
				.mockRejectedValueOnce(new Error("ENOENT")); // archive name not taken
			fsMocks.rename.mockResolvedValue(undefined);
			fsMocks.readdir.mockResolvedValue(["debug_2026-06-15_09-24-32.log"]);
			fsMocks.appendFile.mockResolvedValue(undefined);
			envSpy.mockReturnValue({ ...process.env, VITEST: "" });
			setLogDir("/tmp/project");

			createLogger("TestMod").info("after rotation");
			await new Promise((resolve) => setTimeout(resolve, 0));

			// Renamed debug.log → debug_<UTC timestamp>.log (seconds precision, Windows-safe).
			expect(fsMocks.rename).toHaveBeenCalledOnce();
			const [from, to] = fsMocks.rename.mock.calls[0];
			expect(from).toMatch(/debug\.log$/);
			expect(to).toMatch(/debug_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log$/);
			// Fresh debug.log is recreated by the append.
			expect(fsMocks.appendFile).toHaveBeenCalledOnce();
			expect(fsMocks.appendFile.mock.calls[0]?.[0]).toMatch(/debug\.log$/);
			// Only one archive present → nothing pruned.
			expect(fsMocks.unlink).not.toHaveBeenCalled();
		});

		it("does NOT rotate (no rename) when under the size limit", async () => {
			const envSpy = vi.spyOn(process, "env", "get");
			fsMocks.stat
				.mockResolvedValueOnce({}) // directory check
				.mockResolvedValueOnce({ size: 600_000 }); // < 2 MB
			fsMocks.appendFile.mockResolvedValue(undefined);
			envSpy.mockReturnValue({ ...process.env, VITEST: "" });
			setLogDir("/tmp/project");

			createLogger("TestMod").info("no rotation");
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(fsMocks.rename).not.toHaveBeenCalled();
			// Under the limit, the prune path is never entered either.
			expect(fsMocks.readdir).not.toHaveBeenCalled();
			expect(fsMocks.unlink).not.toHaveBeenCalled();
			expect(fsMocks.appendFile).toHaveBeenCalledOnce();
		});

		it("prunes the oldest archives, keeping only the 10 most recent", async () => {
			const envSpy = vi.spyOn(process, "env", "get");
			fsMocks.stat
				.mockResolvedValueOnce({}) // directory check
				.mockResolvedValueOnce({ size: 3 * 1024 * 1024 }) // rotate
				.mockRejectedValueOnce(new Error("ENOENT")); // archive name free
			fsMocks.rename.mockResolvedValue(undefined);
			// 12 archives in unsorted order; lexical sort = chronological.
			const archives = [
				"debug_2026-06-15_09-00-05.log",
				"debug_2026-06-15_09-00-01.log", // oldest
				"debug_2026-06-15_09-00-12.log",
				"debug_2026-06-15_09-00-02.log", // 2nd oldest
				"debug_2026-06-15_09-00-11.log",
				"debug_2026-06-15_09-00-06.log",
				"debug_2026-06-15_09-00-07.log",
				"debug_2026-06-15_09-00-08.log",
				"debug_2026-06-15_09-00-09.log",
				"debug_2026-06-15_09-00-10.log",
				"debug_2026-06-15_09-00-03.log",
				"debug_2026-06-15_09-00-04.log",
				"debug.log", // live file — must be ignored by the archive filter
				"unrelated.txt",
			];
			fsMocks.readdir.mockResolvedValue(archives);
			// First unlink rejects (another process already deleted it) — must be swallowed
			// and not abort the remaining prune; second resolves.
			fsMocks.unlink.mockRejectedValueOnce(new Error("ENOENT")).mockResolvedValue(undefined);
			fsMocks.appendFile.mockResolvedValue(undefined);
			envSpy.mockReturnValue({ ...process.env, VITEST: "" });
			setLogDir("/tmp/project");

			createLogger("TestMod").info("after rotation");
			await new Promise((resolve) => setTimeout(resolve, 0));

			// 12 archives − keep 10 → delete the 2 oldest (by sorted name); a rejecting
			// unlink is swallowed, so both deletions are still attempted.
			expect(fsMocks.unlink).toHaveBeenCalledTimes(2);
			const deleted = fsMocks.unlink.mock.calls.map((c) => c[0] as string);
			expect(deleted[0]).toMatch(/debug_2026-06-15_09-00-01\.log$/);
			expect(deleted[1]).toMatch(/debug_2026-06-15_09-00-02\.log$/);
			// Never deletes the live log or unrelated files.
			expect(deleted.some((p) => /[/\\]debug\.log$/.test(p))).toBe(false);
			expect(deleted.some((p) => /unrelated\.txt$/.test(p))).toBe(false);
		});

		it("appends a _N suffix (sorting after the base) when an archive name is already taken", async () => {
			const envSpy = vi.spyOn(process, "env", "get");
			fsMocks.stat
				.mockResolvedValueOnce({}) // directory check
				.mockResolvedValueOnce({ size: 3 * 1024 * 1024 }) // rotate
				.mockResolvedValueOnce({}) // base archive name EXISTS
				.mockRejectedValueOnce(new Error("ENOENT")); // _1 variant is free
			fsMocks.rename.mockResolvedValue(undefined);
			fsMocks.readdir.mockResolvedValue([]);
			fsMocks.appendFile.mockResolvedValue(undefined);
			envSpy.mockReturnValue({ ...process.env, VITEST: "" });
			setLogDir("/tmp/project");

			createLogger("TestMod").info("after rotation");
			await new Promise((resolve) => setTimeout(resolve, 0));

			const [, to] = fsMocks.rename.mock.calls[0];
			// `_` (0x5F) > `.` (0x2E), so `..._09-24-32_1.log` sorts AFTER `..._09-24-32.log`.
			expect(to).toMatch(/debug_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_1\.log$/);
			// Pin the ordering invariant using the SAME comparator as the prune step (Array.sort).
			const base = "debug_2026-06-15_09-24-32.log";
			const collision = "debug_2026-06-15_09-24-32_1.log";
			expect([collision, base].sort()).toEqual([base, collision]);
		});

		it("tolerates a rename failure (already rotated by another process) without throwing", async () => {
			const envSpy = vi.spyOn(process, "env", "get");
			fsMocks.stat
				.mockResolvedValueOnce({}) // directory check
				.mockResolvedValueOnce({ size: 3 * 1024 * 1024 }) // rotate
				.mockRejectedValueOnce(new Error("ENOENT")); // archive name free
			fsMocks.rename.mockRejectedValue(new Error("ENOENT")); // source already moved
			fsMocks.appendFile.mockResolvedValue(undefined);
			envSpy.mockReturnValue({ ...process.env, VITEST: "" });
			setLogDir("/tmp/project");

			createLogger("TestMod").info("after rotation");
			await new Promise((resolve) => setTimeout(resolve, 0));

			// Rename attempted, failed, swallowed — prune skipped, append still recreates debug.log.
			expect(fsMocks.rename).toHaveBeenCalledOnce();
			expect(fsMocks.readdir).not.toHaveBeenCalled();
			expect(fsMocks.appendFile).toHaveBeenCalledOnce();
		});

		it("tolerates a readdir failure during prune without throwing", async () => {
			const envSpy = vi.spyOn(process, "env", "get");
			fsMocks.stat
				.mockResolvedValueOnce({}) // directory check
				.mockResolvedValueOnce({ size: 3 * 1024 * 1024 }) // rotate
				.mockRejectedValueOnce(new Error("ENOENT")); // archive name free
			fsMocks.rename.mockResolvedValue(undefined); // archive succeeds
			fsMocks.readdir.mockRejectedValue(new Error("EIO")); // prune listing fails
			fsMocks.appendFile.mockResolvedValue(undefined);
			envSpy.mockReturnValue({ ...process.env, VITEST: "" });
			setLogDir("/tmp/project");

			createLogger("TestMod").info("after rotation");
			await new Promise((resolve) => setTimeout(resolve, 0));

			// Archive happened; prune listing failed but was swallowed; nothing deleted; append still ran.
			expect(fsMocks.rename).toHaveBeenCalledOnce();
			expect(fsMocks.unlink).not.toHaveBeenCalled();
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

		it("should short-circuit the write queue when JOLLI_DISABLE_LOG_FILE is set, even outside vitest", async () => {
			// JOLLI_DISABLE_LOG_FILE is the stable contract for non-Vitest
			// contexts that still need to skip file I/O (e.g. the bundle
			// regression test in Api.bundle.test.ts, which imports the built
			// CLI in a clean Node subprocess and must not leave a stray
			// debug.log behind). Setting it must short-circuit BEFORE any fs
			// call — neither stat nor appendFile should run.
			const envSpy = vi.spyOn(process, "env", "get");
			fsMocks.stat.mockResolvedValue({});
			fsMocks.appendFile.mockResolvedValue(undefined);
			envSpy.mockReturnValue({ ...process.env, VITEST: "", JOLLI_DISABLE_LOG_FILE: "1" });
			setLogDir("/tmp/project");

			const logger = createLogger("TestMod");
			logger.error("should not be written");

			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(fsMocks.stat).not.toHaveBeenCalled();
			expect(fsMocks.appendFile).not.toHaveBeenCalled();
		});
	});
});
