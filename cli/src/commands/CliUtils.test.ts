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
	// `printAmbiguousHash`'s tests import the real AmbiguousHashError from
	// SummaryStore.ts → which transitively imports GitOps.ts → which calls
	// `promisify(execFile)` at module load. Stub it to a no-op so the
	// import doesn't blow up; we don't actually invoke any git here.
	execFile: () => undefined,
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

	describe("formatShortDate", () => {
		it("formats a valid ISO date as 'Mon DD'", async () => {
			const { formatShortDate } = await import("./CliUtils.js");
			expect(formatShortDate("2026-04-15T10:00:00.000Z")).toMatch(/Apr 1[45]/);
		});

		it("falls back to substring(0, 10) for invalid dates", async () => {
			const { formatShortDate } = await import("./CliUtils.js");
			// "xx-not-a-date-longer" is Invalid Date; NaN path returns first 10 chars.
			expect(formatShortDate("xx-not-a-date-longer")).toBe("xx-not-a-d");
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

	describe("printAmbiguousHash", () => {
		// 40-char SHA fixtures matching production: AmbiguousHashError.matches
		// always carries `index.entries[].commitHash` values which are 40 chars.
		const SHA_A = "abc1234567890abc1234567890abc1234567890ab".slice(0, 40);
		const SHA_B = "abc9876543210abc9876543210abc9876543210ab".slice(0, 40);
		const SHA_C = "abc1111111111111111111111111111111111111ab".slice(0, 40);

		/** Captures console.error output of `fn` and returns the joined text. */
		async function captureStderr(fn: () => void): Promise<string> {
			const out: string[] = [];
			const origErr = console.error;
			console.error = (msg: string) => out.push(msg);
			try {
				fn();
			} finally {
				console.error = origErr;
			}
			return out.join("\n");
		}

		it("prints the prefix, count, and full match list when matches fit the display cap", async () => {
			const { printAmbiguousHash } = await import("./CliUtils.js");
			const { AmbiguousHashError } = await import("../core/SummaryStore.js");
			const matches = [SHA_A, SHA_B, SHA_C];
			const joined = await captureStderr(() => {
				printAmbiguousHash(new AmbiguousHashError("abc", matches));
			});
			expect(joined).toContain("abbreviation `abc` is ambiguous");
			expect(joined).toContain("Matched 3 commits");
			for (const hash of matches) expect(joined).toContain(hash);
			// No "and N more" line when under the cap.
			expect(joined).not.toContain("more");
		});

		it("includes every match (no '… and N more' tail) at exactly the display cap of 10", async () => {
			// Boundary regression: catches `>` vs `>=` bugs in the truncation
			// branch. With cap=10 and matches.length=10, the 10th element must
			// still be inlined and the "and N more" line must NOT appear.
			const { printAmbiguousHash } = await import("./CliUtils.js");
			const { AmbiguousHashError } = await import("../core/SummaryStore.js");
			const matches = Array.from({ length: 10 }, (_, i) => {
				const stem = `${String(i).padStart(2, "0")}`;
				return (stem + "f".repeat(40)).slice(0, 40);
			});
			const joined = await captureStderr(() => {
				printAmbiguousHash(new AmbiguousHashError("00", matches));
			});
			expect(joined).toContain("Matched 10 commits");
			for (const hash of matches) expect(joined).toContain(hash);
			expect(joined).not.toContain("more");
		});

		it("truncates long match lists and adds an 'and N more' tail", async () => {
			// A 1-2 char abbreviation in a large repo can collide with hundreds
			// of entries — printing them all floods the terminal. We cap the
			// visible list at 10 and summarize the rest. Use realistic 40-char
			// SHAs so the formatter sees production-shaped input.
			const { printAmbiguousHash } = await import("./CliUtils.js");
			const { AmbiguousHashError } = await import("../core/SummaryStore.js");
			const matches = Array.from({ length: 25 }, (_, i) => {
				const stem = `${String(i).padStart(2, "0")}`;
				return (stem + "0".repeat(40)).slice(0, 40); // 40-char hex
			});
			const joined = await captureStderr(() => {
				printAmbiguousHash(new AmbiguousHashError("00", matches));
			});
			expect(joined).toContain("Matched 25 commits");
			// First 10 are listed.
			for (let i = 0; i < 10; i++) {
				expect(joined).toContain(matches[i]);
			}
			// The 11th and beyond are NOT inlined.
			expect(joined).not.toContain(matches[10]);
			expect(joined).toContain("and 15 more");
		});

		it("does not write to stdout (clean for piped consumers)", async () => {
			// Caller convention: hint goes to stderr so `jolli view --commit
			// abc | tee file` keeps stdout clean. Without this guard a lazy
			// console.log slip would silently regress the pipe contract.
			const { printAmbiguousHash } = await import("./CliUtils.js");
			const { AmbiguousHashError } = await import("../core/SummaryStore.js");
			const stdoutLines: string[] = [];
			const origLog = console.log;
			console.log = (msg: string) => stdoutLines.push(msg);
			try {
				printAmbiguousHash(new AmbiguousHashError("abc", [SHA_A, SHA_B]));
			} finally {
				console.log = origLog;
			}
			expect(stdoutLines).toEqual([]);
		});
	});

	describe("AmbiguousHashError construction invariants", () => {
		it("rejects matches.length < 2 (use null/undefined for 'not found' instead)", async () => {
			const { AmbiguousHashError } = await import("../core/SummaryStore.js");
			expect(() => new AmbiguousHashError("abc", [])).toThrow(/requires ≥2 matches/);
			expect(() => new AmbiguousHashError("abc", ["only-one"])).toThrow(/requires ≥2 matches/);
		});

		it("rejects an empty prefix (would otherwise match every entry on prefix scan)", async () => {
			const { AmbiguousHashError } = await import("../core/SummaryStore.js");
			expect(() => new AmbiguousHashError("", ["a", "b"])).toThrow(/prefix must be 1\.\.39 chars/);
		});

		it("rejects a 40-char prefix (full SHA wouldn't be ambiguous in the index)", async () => {
			const { AmbiguousHashError } = await import("../core/SummaryStore.js");
			const fortyChar = "a".repeat(40);
			expect(() => new AmbiguousHashError(fortyChar, ["x", "y"])).toThrow(/prefix must be 1\.\.39 chars/);
		});
	});

	describe("AmbiguousHashError.is (duck-typed guard)", () => {
		it("matches both real instances and shape-equivalent objects across bundles", async () => {
			const { AmbiguousHashError } = await import("../core/SummaryStore.js");
			// Real instance — covers the common in-process case.
			const real = new AmbiguousHashError("ab", ["aaaa", "bbbb"]);
			expect(AmbiguousHashError.is(real)).toBe(true);

			// Cross-bundle simulation: an Error with the same name + fields but
			// a different prototype chain (what an IPC-deserialized error
			// payload would look like). instanceof would FAIL here; is() must
			// SUCCEED to keep callers forward-compatible.
			const crossBundle = Object.assign(new Error("..."), {
				name: "AmbiguousHashError",
				prefix: "ab",
				matches: ["aaaa", "bbbb"],
			});
			expect(AmbiguousHashError.is(crossBundle)).toBe(true);

			// Negative cases: not Error / wrong name / missing fields.
			expect(AmbiguousHashError.is(null)).toBe(false);
			expect(AmbiguousHashError.is(new Error("plain"))).toBe(false);
			expect(AmbiguousHashError.is({ name: "AmbiguousHashError", prefix: "ab", matches: [] })).toBe(false); // not Error
			expect(
				AmbiguousHashError.is(
					Object.assign(new Error("..."), { name: "AmbiguousHashError", prefix: "ab" }), // missing matches
				),
			).toBe(false);
		});
	});
});
