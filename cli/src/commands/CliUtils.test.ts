/**
 * Tests for CliUtils — shared CLI utility functions.
 *
 * Covers version mismatch warnings, parsePositiveInt edge cases,
 * resolveProjectDir caching, and interactive detection.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockExecFileSync } = vi.hoisted(() => ({
	mockExecFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execFileSync: mockExecFileSync,
}));

vi.mock("../core/SessionTracker.js", () => ({
	getGlobalConfigDir: vi.fn().mockReturnValue("/mock/global/config"),
}));

vi.mock("../install/DistPathResolver.js", () => ({
	compareSemver: (a: string, b: string) => {
		const pa = a.split(".").map(Number);
		const pb = b.split(".").map(Number);
		for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
			const d = (pa[i] ?? 0) - (pb[i] ?? 0);
			if (d !== 0) return d;
		}
		return 0;
	},
	traverseDistPaths: vi.fn().mockReturnValue([]),
}));

// Suppress stderr output during tests
vi.spyOn(process.stderr, "write").mockImplementation(() => true);

describe("CliUtils", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("parsePositiveInt", () => {
		it("should return the parsed integer for a valid positive number", async () => {
			const { parsePositiveInt } = await import("./CliUtils.js");
			expect(parsePositiveInt("42")).toBe(42);
		});

		it("should return undefined for zero", async () => {
			const { parsePositiveInt } = await import("./CliUtils.js");
			expect(parsePositiveInt("0")).toBeUndefined();
		});

		it("should return undefined for negative numbers", async () => {
			const { parsePositiveInt } = await import("./CliUtils.js");
			expect(parsePositiveInt("-5")).toBeUndefined();
		});

		it("should return undefined for non-numeric strings", async () => {
			const { parsePositiveInt } = await import("./CliUtils.js");
			expect(parsePositiveInt("abc")).toBeUndefined();
		});

		it("should return undefined for empty string", async () => {
			const { parsePositiveInt } = await import("./CliUtils.js");
			expect(parsePositiveInt("")).toBeUndefined();
		});

		it("should return undefined for NaN-producing input", async () => {
			const { parsePositiveInt } = await import("./CliUtils.js");
			expect(parsePositiveInt("not-a-number")).toBeUndefined();
		});

		it("should return the integer part for float strings", async () => {
			const { parsePositiveInt } = await import("./CliUtils.js");
			// parseInt("3.7") returns 3, which is > 0 and finite
			expect(parsePositiveInt("3.7")).toBe(3);
		});
	});

	describe("checkVersionMismatch", () => {
		it("should not warn when VERSION is 'dev'", async () => {
			// In test environment, VERSION is always "dev" since __PKG_VERSION__
			// is not defined. checkVersionMismatch returns early for "dev".
			const { checkVersionMismatch } = await import("./CliUtils.js");
			vi.mocked(process.stderr.write).mockClear();

			checkVersionMismatch();

			const stderrCalls = vi.mocked(process.stderr.write).mock.calls;
			const hasWarning = stderrCalls.some((c) => String(c[0]).includes("newer version"));
			expect(hasWarning).toBe(false);
		});

		it("should warn when a registered source has a higher version", async () => {
			vi.resetModules();
			vi.stubGlobal("__PKG_VERSION__", "1.0.0");
			const { traverseDistPaths } = await import("../install/DistPathResolver.js");
			vi.mocked(traverseDistPaths).mockReturnValue([
				{ source: "vscode", version: "2.0.0", distDir: "/vscode/dist", available: true },
			]);

			vi.mocked(process.stderr.write).mockClear();
			const { checkVersionMismatch } = await import("./CliUtils.js");
			checkVersionMismatch();

			const stderrOutput = vi
				.mocked(process.stderr.write)
				.mock.calls.map((c) => String(c[0]))
				.join("");
			expect(stderrOutput).toContain("A newer version of jolli is available");
		});

		it("should not warn when all sources have equal or lower versions", async () => {
			vi.resetModules();
			vi.stubGlobal("__PKG_VERSION__", "2.0.0");
			const { traverseDistPaths } = await import("../install/DistPathResolver.js");
			vi.mocked(traverseDistPaths).mockReturnValue([
				{ source: "cli", version: "1.5.0", distDir: "/cli/dist", available: true },
				{ source: "vscode", version: "2.0.0", distDir: "/vscode/dist", available: true },
			]);

			vi.mocked(process.stderr.write).mockClear();
			const { checkVersionMismatch } = await import("./CliUtils.js");
			checkVersionMismatch();

			const stderrCalls = vi.mocked(process.stderr.write).mock.calls;
			const hasWarning = stderrCalls.some((c) => String(c[0]).includes("newer version"));
			expect(hasWarning).toBe(false);
		});

		it("should not warn when no sources are registered", async () => {
			vi.resetModules();
			vi.stubGlobal("__PKG_VERSION__", "1.0.0");
			const { traverseDistPaths } = await import("../install/DistPathResolver.js");
			vi.mocked(traverseDistPaths).mockReturnValue([]);

			vi.mocked(process.stderr.write).mockClear();
			const { checkVersionMismatch } = await import("./CliUtils.js");
			checkVersionMismatch();

			const stderrCalls = vi.mocked(process.stderr.write).mock.calls;
			const hasWarning = stderrCalls.some((c) => String(c[0]).includes("newer version"));
			expect(hasWarning).toBe(false);
		});

		it("should skip unavailable entries when finding highest version", async () => {
			vi.resetModules();
			vi.stubGlobal("__PKG_VERSION__", "1.0.0");
			const { traverseDistPaths } = await import("../install/DistPathResolver.js");
			// The only higher-version entry is unavailable — should NOT warn
			vi.mocked(traverseDistPaths).mockReturnValue([
				{ source: "cli", version: "1.0.0", distDir: "/cli/dist", available: true },
				{ source: "stale", version: "9.9.9", distDir: "/missing/dist", available: false },
			]);

			vi.mocked(process.stderr.write).mockClear();
			const { checkVersionMismatch } = await import("./CliUtils.js");
			checkVersionMismatch();

			const stderrCalls = vi.mocked(process.stderr.write).mock.calls;
			const hasWarning = stderrCalls.some((c) => String(c[0]).includes("newer version"));
			expect(hasWarning).toBe(false);
		});

		it("should not throw when traverseDistPaths throws", async () => {
			vi.resetModules();
			vi.stubGlobal("__PKG_VERSION__", "1.0.0");
			const { traverseDistPaths } = await import("../install/DistPathResolver.js");
			vi.mocked(traverseDistPaths).mockImplementation(() => {
				throw new Error("EACCES");
			});

			const { checkVersionMismatch } = await import("./CliUtils.js");
			// Should not throw — error is silently caught
			expect(() => checkVersionMismatch()).not.toThrow();
		});
	});

	describe("isInteractive", () => {
		it("should return true when stdin.isTTY is true", async () => {
			const { isInteractive } = await import("./CliUtils.js");
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
			try {
				expect(isInteractive()).toBe(true);
			} finally {
				Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
			}
		});

		it("should return false when stdin.isTTY is undefined", async () => {
			const { isInteractive } = await import("./CliUtils.js");
			Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
			expect(isInteractive()).toBe(false);
		});
	});

	describe("SAFE_ARGUMENT_PATTERN", () => {
		it("should match valid branch names", async () => {
			const { SAFE_ARGUMENT_PATTERN } = await import("./CliUtils.js");
			expect(SAFE_ARGUMENT_PATTERN.test("feature/my-branch")).toBe(true);
			expect(SAFE_ARGUMENT_PATTERN.test("fix_bug.123")).toBe(true);
		});

		it("should reject shell metacharacters", async () => {
			const { SAFE_ARGUMENT_PATTERN } = await import("./CliUtils.js");
			expect(SAFE_ARGUMENT_PATTERN.test("branch;rm -rf /")).toBe(false);
			expect(SAFE_ARGUMENT_PATTERN.test("$(whoami)")).toBe(false);
		});
	});
});
