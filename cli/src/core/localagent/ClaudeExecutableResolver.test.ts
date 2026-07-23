import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSyncHidden } from "../../util/Subprocess.js";
import {
	__resetResolverCacheForTest,
	isClaudeCodeUsable,
	resolveClaudeExecutable,
} from "./ClaudeExecutableResolver.js";
import { LocalAgentSetupError } from "./Types.js";

vi.mock("../../util/Subprocess.js", () => ({ execFileSyncHidden: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: vi.fn() }));

describe("resolveClaudeExecutable", () => {
	it("picks the newest capable candidate", () => {
		__resetResolverCacheForTest();
		const out = resolveClaudeExecutable({
			candidates: () => ["/a/claude", "/b/claude"],
			probe: (f) => (f === "/a/claude" ? { ok: true, version: "2.0.0" } : { ok: true, version: "2.1.210" }),
			now: () => 1000,
		});
		expect(out).toEqual({ file: "/b/claude", version: "2.1.210" });
	});

	it("keeps the first candidate found when versions compare equal", () => {
		__resetResolverCacheForTest();
		const out = resolveClaudeExecutable({
			candidates: () => ["/a/claude", "/b/claude"],
			probe: () => ({ ok: true, version: "2.1.210" }),
			now: () => 1000,
		});
		expect(out.file).toBe("/a/claude");
	});

	it("compares versions with differing segment counts (e.g. '2' vs '2.0.1')", () => {
		__resetResolverCacheForTest();
		const out = resolveClaudeExecutable({
			candidates: () => ["/a/claude", "/b/claude"],
			probe: (f) => (f === "/a/claude" ? { ok: true, version: "2" } : { ok: true, version: "2.0.1" }),
			now: () => 1000,
		});
		expect(out.file).toBe("/b/claude");
	});

	it("compares versions with differing segment counts, longer-first order", () => {
		__resetResolverCacheForTest();
		const out = resolveClaudeExecutable({
			candidates: () => ["/a/claude", "/b/claude"],
			probe: (f) => (f === "/a/claude" ? { ok: true, version: "2.0.1" } : { ok: true, version: "2" }),
			now: () => 1000,
		});
		expect(out.file).toBe("/a/claude");
	});

	it("treats an ok probe with a missing/garbage version as version '0'", () => {
		__resetResolverCacheForTest();
		const out = resolveClaudeExecutable({
			candidates: () => ["/a/claude", "/b/claude"],
			probe: (f) => (f === "/a/claude" ? { ok: true } : { ok: true, version: "not-a-version" }),
			now: () => 1000,
		});
		// Neither candidate reports a real version, so the first capable one wins.
		expect(out.file).toBe("/a/claude");
		expect(out.version).toBe("0");
	});

	it("does not let a later ok-but-versionless candidate replace an earlier versioned one", () => {
		__resetResolverCacheForTest();
		const out = resolveClaudeExecutable({
			candidates: () => ["/a/claude", "/b/claude"],
			probe: (f) => (f === "/a/claude" ? { ok: true, version: "1.0.0" } : { ok: true }),
			now: () => 1000,
		});
		expect(out).toEqual({ file: "/a/claude", version: "1.0.0" });
	});

	it("falls back to the real clock when `now` is not injected", () => {
		__resetResolverCacheForTest();
		const out = resolveClaudeExecutable({
			candidates: () => ["/a/claude"],
			probe: () => ({ ok: true, version: "2.1.210" }),
		});
		expect(out.file).toBe("/a/claude");
	});

	it("skips incompatible (probe not ok) candidates", () => {
		__resetResolverCacheForTest();
		const out = resolveClaudeExecutable({
			candidates: () => ["/old/claude", "/new/claude"],
			probe: (f) => (f === "/old/claude" ? { ok: false } : { ok: true, version: "2.1.210" }),
			now: () => 1000,
		});
		expect(out.file).toBe("/new/claude");
	});

	it("throws a setup error when nothing is capable", () => {
		__resetResolverCacheForTest();
		expect(() =>
			resolveClaudeExecutable({ candidates: () => ["/x/claude"], probe: () => ({ ok: false }), now: () => 1000 }),
		).toThrowError(LocalAgentSetupError);
	});

	it("honors an explicit override path and probes it", () => {
		__resetResolverCacheForTest();
		const out = resolveClaudeExecutable({
			overridePath: "/custom/claude",
			candidates: () => [],
			probe: (f) => ({ ok: f === "/custom/claude", version: "2.1.210" }),
			now: () => 1000,
		});
		expect(out.file).toBe("/custom/claude");
	});

	it("throws a setup error naming the override path when it is incompatible", () => {
		__resetResolverCacheForTest();
		expect(() =>
			resolveClaudeExecutable({
				overridePath: "/custom/claude",
				candidates: () => [],
				probe: () => ({ ok: false }),
				now: () => 1000,
			}),
		).toThrowError(/custom\/claude/);
	});

	it("caches a successful resolution for 15 minutes, not failures", () => {
		__resetResolverCacheForTest();
		let calls = 0;
		const probe = () => {
			calls++;
			return { ok: true, version: "2.1.210" };
		};
		resolveClaudeExecutable({ candidates: () => ["/a/claude"], probe, now: () => 0 });
		resolveClaudeExecutable({ candidates: () => ["/a/claude"], probe, now: () => 60_000 });
		expect(calls).toBe(1); // second call served from cache
	});

	it("does not serve a cached default-discovery result to an override-path lookup", () => {
		__resetResolverCacheForTest();
		let calls = 0;
		const probe = () => {
			calls++;
			return { ok: true, version: "2.1.210" };
		};
		const first = resolveClaudeExecutable({ candidates: () => ["/a/claude"], probe, now: () => 0 });
		expect(first.file).toBe("/a/claude");
		// Different cache key (override path) within the TTL must re-probe rather
		// than leak the default-discovery binary — the cross-repo/config bug.
		const second = resolveClaudeExecutable({ overridePath: "/custom/claude", probe, now: () => 1 });
		expect(second.file).toBe("/custom/claude");
		expect(calls).toBe(2);
	});

	it("re-probes once the 15-minute cache TTL has elapsed", () => {
		__resetResolverCacheForTest();
		let calls = 0;
		const probe = () => {
			calls++;
			return { ok: true, version: "2.1.210" };
		};
		resolveClaudeExecutable({ candidates: () => ["/a/claude"], probe, now: () => 0 });
		resolveClaudeExecutable({ candidates: () => ["/a/claude"], probe, now: () => 15 * 60_000 + 1 });
		expect(calls).toBe(2);
	});

	it("does not cache a failed resolution", () => {
		__resetResolverCacheForTest();
		let calls = 0;
		const probe = () => {
			calls++;
			return { ok: false };
		};
		expect(() => resolveClaudeExecutable({ candidates: () => ["/a/claude"], probe, now: () => 0 })).toThrow();
		expect(() => resolveClaudeExecutable({ candidates: () => ["/a/claude"], probe, now: () => 1 })).toThrow();
		expect(calls).toBe(2);
	});

	describe("default candidates/probe (Subprocess and fs mocked, never a real binary)", () => {
		const mockedExecFileSync = vi.mocked(execFileSyncHidden);
		const mockedExistsSync = vi.mocked(existsSync);

		beforeEach(() => {
			__resetResolverCacheForTest();
			mockedExecFileSync.mockReset();
			mockedExistsSync.mockReset();
			mockedExistsSync.mockReturnValue(false);
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("resolves via `which -a claude` and parses the probe's version output", () => {
			mockedExecFileSync.mockImplementation((file: unknown, ...rest: unknown[]) => {
				if (file === "which") return "/usr/local/bin/claude\n";
				const args = rest[0] as string[];
				expect(args).toEqual(["--permission-mode", "dontAsk", "--version"]);
				return "2.1.210\n";
			});

			const out = resolveClaudeExecutable({ platform: "linux", now: () => 1000 });

			expect(out).toEqual({ file: "/usr/local/bin/claude", version: "2.1.210" });
		});

		it("dedupes duplicate `which -a` lines before probing", () => {
			mockedExecFileSync.mockImplementation((file: unknown) => {
				if (file === "which") return "/usr/local/bin/claude\n/usr/local/bin/claude\n\n";
				return "2.1.210\n";
			});

			resolveClaudeExecutable({ platform: "linux", now: () => 1000 });

			const probeCalls = mockedExecFileSync.mock.calls.filter((c) => c[0] !== "which");
			expect(probeCalls).toHaveLength(1);
		});

		it("falls through to known install locations when `which` finds nothing", () => {
			const knownPath = join(homedir(), ".local/bin/claude");
			mockedExecFileSync.mockImplementation((file: unknown) => {
				if (file === "which") throw new Error("not found");
				return "2.1.210\n";
			});
			mockedExistsSync.mockImplementation((p: unknown) => p === knownPath);

			const out = resolveClaudeExecutable({ platform: "linux", now: () => 1000 });

			expect(out.file).toBe(knownPath);
		});

		it("classifies a probe that throws (old CLI rejecting the flags) as incompatible", () => {
			mockedExecFileSync.mockImplementation((file: unknown) => {
				if (file === "which") return "/usr/local/bin/claude\n";
				throw new Error("unknown option --permission-mode");
			});

			expect(() => resolveClaudeExecutable({ platform: "linux", now: () => 1000 })).toThrowError(
				LocalAgentSetupError,
			);
		});

		it("classifies an empty probe stdout as incompatible", () => {
			mockedExecFileSync.mockImplementation((file: unknown) => {
				if (file === "which") return "/usr/local/bin/claude\n";
				return "";
			});

			expect(() => resolveClaudeExecutable({ platform: "linux", now: () => 1000 })).toThrowError(
				LocalAgentSetupError,
			);
		});
	});

	describe("windows discovery (platform injected, Subprocess and fs mocked)", () => {
		const mockedExecFileSync = vi.mocked(execFileSyncHidden);
		const mockedExistsSync = vi.mocked(existsSync);

		beforeEach(() => {
			__resetResolverCacheForTest();
			mockedExecFileSync.mockReset();
			mockedExistsSync.mockReset();
			mockedExistsSync.mockReturnValue(false);
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("discovers claude.exe via `where` and never probes a .cmd shim", () => {
			const exe = "C:\\Program Files\\claude\\claude.exe";
			mockedExecFileSync.mockImplementation((file: unknown) => {
				// `where` (win32), NOT `which`; CRLF output with a .cmd shim mixed in.
				if (file === "where") return `${exe}\r\nC:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd\r\n`;
				return "2.1.210\n";
			});

			const out = resolveClaudeExecutable({ platform: "win32", now: () => 1000 });

			expect(out).toEqual({ file: exe, version: "2.1.210" });
			// The .cmd shim is filtered before probing — only the .exe is executed.
			const probed = mockedExecFileSync.mock.calls.filter((c) => c[0] !== "where").map((c) => c[0]);
			expect(probed).toEqual([exe]);
		});

		it("falls back to a known .exe install location when `where` finds nothing", () => {
			const knownExe = join(homedir(), ".local", "bin", "claude.exe");
			mockedExecFileSync.mockImplementation((file: unknown) => {
				if (file === "where") throw new Error("INFO: Could not find files for the given pattern(s).");
				return "2.1.210\n";
			});
			mockedExistsSync.mockImplementation((p: unknown) => p === knownExe);

			const out = resolveClaudeExecutable({ platform: "win32", now: () => 1000 });

			expect(out.file).toBe(knownExe);
		});

		it("yields no candidate (setup error) when only a .cmd shim is on PATH", () => {
			mockedExecFileSync.mockImplementation((file: unknown) => {
				if (file === "where") return "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd\r\n";
				return "2.1.210\n";
			});

			expect(() => resolveClaudeExecutable({ platform: "win32", now: () => 1000 })).toThrowError(
				LocalAgentSetupError,
			);
			// Proves the win32 branch ran (`where`, not `which`) and filtered the .cmd out.
			expect(mockedExecFileSync.mock.calls.some((c) => c[0] === "where")).toBe(true);
		});
	});
});

describe("isClaudeCodeUsable", () => {
	it("true when a candidate resolves", () => {
		__resetResolverCacheForTest();
		expect(
			isClaudeCodeUsable({
				candidates: () => ["/a/claude"],
				probe: () => ({ ok: true, version: "1.0.0" }),
				now: () => 1000,
			}),
		).toBe(true);
	});

	it("false when nothing resolves (resolveClaudeExecutable throws)", () => {
		__resetResolverCacheForTest();
		expect(isClaudeCodeUsable({ candidates: () => [], probe: () => ({ ok: false }), now: () => 1000 })).toBe(false);
	});
});
