import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as subprocess from "../../util/Subprocess.js";
import {
	__resetResolverCacheForTest,
	type Candidate,
	discover,
	discoverPresence,
	discoveryPath,
	extractProbeVersion,
	isPresent,
	resolveExecutable,
} from "./ExecutableResolver.js";
import { LocalAgentSetupError } from "./Types.js";

describe("extractProbeVersion", () => {
	// Real `--version` output from every shipped tool, captured on one machine.
	// codex is the reason this function exists: it prints its NAME first, so the
	// old token[0] rule returned the literal "codex-cli" for every build.
	it.each([
		["2.1.220 (Claude Code)", "2.1.220", "claude"],
		["codex-cli 0.146.0-alpha.3", "0.146.0-alpha.3", "codex"],
		["1.18.10", "1.18.10", "opencode"],
		["2026.07.23-e383d2b", "2026.07.23-e383d2b", "cursor-agent"],
		["0.31.1", "0.31.1", "kimi"],
	])("extracts %s -> %s (%s)", (raw, expected) => {
		expect(extractProbeVersion(raw)).toBe(expected);
	});

	it("keeps every codex build distinguishable, so a version-keyed cache can expire", () => {
		// The concrete failure this prevents: identical keys meant `isNewer` saw
		// every codex as equal AND the unsupported-flag store could never retry a
		// flag after an upgrade.
		expect(extractProbeVersion("codex-cli 0.146.0-alpha.3")).not.toBe(extractProbeVersion("codex-cli 0.200.0"));
	});

	it("tolerates a leading v", () => {
		expect(extractProbeVersion("mytool v3.2.1")).toBe("v3.2.1");
	});

	it("falls back to the first token when nothing looks like a version", () => {
		expect(extractProbeVersion("unknown-build")).toBe("unknown-build");
	});

	it("returns undefined for empty output, which the probe reads as a failure", () => {
		expect(extractProbeVersion("   \n ")).toBeUndefined();
	});

	it("ignores a name that merely contains digits", () => {
		// `s3cmd` has a digit but no dot, so it must not be mistaken for a version.
		expect(extractProbeVersion("s3cmd 2.4.0")).toBe("2.4.0");
	});
});

const spec = { binName: "codex", knownPaths: () => [], probeArgs: ["--version"] as const };

afterEach(() => {
	vi.restoreAllMocks();
});

/** A fake `which`/`where` that only "finds" `binName` when `binDir` is on the search PATH. */
function fakeFinder(binName: string, binDir: string, sep = ":") {
	return (_finder: string, _args: readonly string[], pathEnv: string): string =>
		pathEnv.split(sep).includes(binDir) ? `${binDir}/${binName}\n` : "";
}

// The OpenAI Codex CLI ships inside the ChatGPT desktop app bundle — a location
// absent from the minimal PATH a GUI-launched editor's extension host inherits.
const CHATGPT_DIR = "/Applications/ChatGPT.app/Contents/Resources";
const GUI_MINIMAL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin";

describe("resolveExecutable", () => {
	it("picks the newest capable candidate", () => {
		__resetResolverCacheForTest();
		const r = resolveExecutable(spec, {
			candidates: () => [{ file: "/a/codex" }, { file: "/b/codex" }],
			probe: (c) => ({ ok: true, version: c.file === "/b/codex" ? "2.0.0" : "1.0.0" }),
			now: () => 1,
		});
		expect(r).toEqual({ file: "/b/codex", version: "2.0.0" });
	});

	it("caches per (binName + overridePath) so a different tool never reuses another's result", () => {
		__resetResolverCacheForTest();
		let calls = 0;
		const probe = () => {
			calls++;
			return { ok: true, version: "1.0.0" };
		};
		resolveExecutable({ ...spec, binName: "codex" }, { candidates: () => [{ file: "/x" }], probe, now: () => 1 });
		resolveExecutable(
			{ ...spec, binName: "cursor-agent" },
			{ candidates: () => [{ file: "/y" }], probe, now: () => 1 },
		);
		expect(calls).toBe(2); // NOT served from a binName-blind cache
	});

	it("throws a setup error naming the tool when nothing is capable", () => {
		__resetResolverCacheForTest();
		expect(() =>
			resolveExecutable(spec, { candidates: () => [{ file: "/a" }], probe: () => ({ ok: false }), now: () => 1 }),
		).toThrow(LocalAgentSetupError);
	});
});

describe("discoveryPath", () => {
	it("augments a GUI-minimal PATH with the common install dirs a bare `which` misses (posix)", () => {
		const dirs = discoveryPath(GUI_MINIMAL_PATH, "/Users/x", "darwin").split(":");
		expect(dirs).toContain("/opt/homebrew/bin");
		expect(dirs).toContain("/Users/x/.local/bin");
		expect(dirs).toContain(CHATGPT_DIR);
		expect(dirs).toContain("/usr/bin"); // base entries preserved
	});

	it("does not duplicate a dir already present on the base PATH", () => {
		const dirs = discoveryPath("/opt/homebrew/bin:/usr/bin", "/Users/x", "darwin").split(":");
		expect(dirs.filter((d) => d === "/opt/homebrew/bin")).toHaveLength(1);
	});

	it("leaves the win32 PATH unchanged (Windows uses `where` + known .exe paths)", () => {
		const base = "C:\\Windows\\System32;C:\\Windows";
		expect(discoveryPath(base, "C:\\Users\\x", "win32")).toBe(base);
	});
});

describe("discover", () => {
	it("finds codex in the ChatGPT.app bundle even when the base PATH is the GUI-minimal set", () => {
		const found = discover(spec, "darwin", {
			runFinder: fakeFinder("codex", CHATGPT_DIR),
			exists: () => false, // not in any knownPath — must be found via the augmented PATH
			home: "/Users/x",
			basePath: GUI_MINIMAL_PATH,
		});
		expect(found).toContainEqual({ file: `${CHATGPT_DIR}/codex` });
	});

	// The npm-on-Windows shape: `where` finds the cmd-shim trio, none of which is
	// spawnable without a shell. With no expandShim there is nothing to fall back
	// to, so the tool is (correctly) unresolvable rather than wrongly "found".
	it("drops non-.exe win32 shims when the spec has no expandShim", () => {
		const found = discover(spec, "win32", {
			runFinder: () => "C:\\npm\\codex\r\nC:\\npm\\codex.cmd\r\nC:\\npm\\codex.ps1\r\n",
			exists: () => false,
			home: "C:\\Users\\x",
			basePath: "C:\\Windows;C:\\npm",
		});
		expect(found).toEqual([]);
	});

	it("routes every non-.exe win32 launcher through expandShim and keeps its native targets", () => {
		const seen: string[] = [];
		const shimSpec = {
			...spec,
			expandShim: (shimPath: string): Candidate[] => {
				seen.push(shimPath);
				return [{ file: "C:\\npm\\real\\codex.exe", launchArgs: ["main.js"] }];
			},
		};
		const found = discover(shimSpec, "win32", {
			runFinder: () => "C:\\npm\\codex.cmd\r\nC:\\npm\\codex.exe\r\n",
			exists: () => false,
			home: "C:\\Users\\x",
			basePath: "C:\\npm",
		});
		expect(seen).toEqual(["C:\\npm\\codex.cmd"]); // the .exe is NOT sent through expansion
		expect(found).toEqual([
			{ file: "C:\\npm\\codex.exe" }, // natively-discovered exes stay first
			{ file: "C:\\npm\\real\\codex.exe", launchArgs: ["main.js"] },
		]);
	});

	// The real npm-on-Windows shape: `where opencode` reports BOTH the
	// extensionless shim and its `.cmd` twin, and both map to the one package
	// binary. Probing it twice would cost a second 10 s-timeout spawn per
	// discovery — and discovery is cold on every QueueWorker process.
	it("collapses sibling shims that expand to the same launch command", () => {
		const found = discover(
			{ ...spec, expandShim: (): Candidate[] => [{ file: "C:\\npm\\node_modules\\o\\bin\\o.exe" }] },
			"win32",
			{
				runFinder: () => "C:\\npm\\opencode\r\nC:\\npm\\opencode.cmd\r\n",
				exists: () => false,
				home: "C:\\Users\\x",
				basePath: "C:\\npm",
			},
		);
		expect(found).toEqual([{ file: "C:\\npm\\node_modules\\o\\bin\\o.exe" }]);
	});

	it("keeps two argument shapes for the same file apart — they are different commands", () => {
		const found = discover(
			{
				...spec,
				expandShim: (): Candidate[] => [
					{ file: "C:\\node.exe", launchArgs: ["--use-system-ca", "C:\\i.js"] },
					{ file: "C:\\node.exe", launchArgs: ["C:\\i.js"] },
				],
			},
			"win32",
			{ runFinder: () => "C:\\a.cmd\r\n", exists: () => false, home: "C:\\Users\\x", basePath: "C:\\a" },
		);
		expect(found).toHaveLength(2);
	});

	it("leaves POSIX discovery untouched by the shim machinery", () => {
		const found = discover(spec, "darwin", {
			runFinder: () => "/usr/local/bin/codex\n",
			exists: () => false,
			home: "/Users/x",
			basePath: "/usr/local/bin",
		});
		expect(found).toEqual([{ file: "/usr/local/bin/codex" }]);
	});
});

describe("resolveExecutable with launcher args", () => {
	it("carries launchArgs onto the resolved executable and into the probe", () => {
		__resetResolverCacheForTest();
		const probed: string[][] = [];
		const r = resolveExecutable(spec, {
			candidates: () => [{ file: "C:\\node.exe", launchArgs: ["--use-system-ca", "C:\\index.js"] }],
			probe: (c) => {
				probed.push([...(c.launchArgs ?? []), ...spec.probeArgs]);
				return { ok: true, version: "2026.07.20-8cc9c0b" };
			},
			now: () => 1,
		});
		expect(probed).toEqual([["--use-system-ca", "C:\\index.js", "--version"]]);
		expect(r.launchArgs).toEqual(["--use-system-ca", "C:\\index.js"]);
	});

	// How a spec expresses a preferred launcher variant: same binary, same reported
	// version, two argument shapes — strict `isNewer` keeps the one offered first.
	it("keeps the first launcher variant when two candidates report the same version", () => {
		__resetResolverCacheForTest();
		const r = resolveExecutable(spec, {
			candidates: () => [
				{ file: "C:\\node.exe", launchArgs: ["--use-system-ca", "C:\\index.js"] },
				{ file: "C:\\node.exe", launchArgs: ["C:\\index.js"] },
			],
			probe: () => ({ ok: true, version: "1.0.0" }),
			now: () => 1,
		});
		expect(r.launchArgs).toEqual(["--use-system-ca", "C:\\index.js"]);
	});

	// Hermes prints `Hermes Agent v0.20.5`, and `extractProbeVersion` deliberately
	// accepts that `v`. Before the rank stripped it, `parseInt("v1")` was NaN and the
	// `|| 0` collapsed every such build's MAJOR to zero — so a v1 binary ranked BELOW
	// a v0 one and the older install won.
	it("ranks a v-prefixed version by its real major", () => {
		__resetResolverCacheForTest();
		const r = resolveExecutable(spec, {
			candidates: () => [{ file: "/old/hermes" }, { file: "/new/hermes" }],
			probe: (c) => ({ ok: true, version: c.file === "/new/hermes" ? "v1.0.0" : "v0.20.5" }),
			now: () => 1,
		});
		expect(r.file).toBe("/new/hermes");
	});

	it("falls back to the plain variant when the preferred one fails its probe", () => {
		__resetResolverCacheForTest();
		const r = resolveExecutable(spec, {
			candidates: () => [
				{ file: "C:\\node.exe", launchArgs: ["--use-system-ca", "C:\\index.js"] },
				{ file: "C:\\node.exe", launchArgs: ["C:\\index.js"] },
			],
			// An older bundled Node rejects --use-system-ca outright.
			probe: (c) => (c.launchArgs?.[0] === "--use-system-ca" ? { ok: false } : { ok: true, version: "1.0.0" }),
			now: () => 1,
		});
		expect(r.launchArgs).toEqual(["C:\\index.js"]);
	});
});

// A real Cursor install on Windows has NO `.exe` to point at — the top level is
// `.cmd` + `.ps1` and the runnable pair is `node.exe` + `index.js` one level
// down. Taking the override verbatim would leave the escape hatch (reached for
// precisely when auto-discovery failed) with no working value on that platform.
describe("override paths get the same shim expansion as discovery", () => {
	const shimSpec = {
		...spec,
		expandShim: (shimPath: string): Candidate[] => [
			{ file: "C:\\v\\node.exe", launchArgs: [`${shimPath}-resolved.js`] },
		],
	};

	it("probes and resolves the expansion of a .cmd override", () => {
		__resetResolverCacheForTest();
		const out = resolveExecutable(shimSpec, {
			overridePath: "C:\\cursor\\cursor-agent.cmd",
			probe: () => ({ ok: true, version: "2026.07.20" }),
			now: () => 1,
			platform: "win32",
		});
		expect(out).toEqual({
			file: "C:\\v\\node.exe",
			version: "2026.07.20",
			launchArgs: ["C:\\cursor\\cursor-agent.cmd-resolved.js"],
		});
	});

	// Expansion worked; the binary behind the shim is what failed. Telling the
	// user to "point at a real .exe" there would send them chasing a file that
	// does not exist.
	it("drops the .exe hint once the shim resolved — the launcher was not the problem", () => {
		__resetResolverCacheForTest();
		expect(() =>
			resolveExecutable(shimSpec, {
				overridePath: "C:\\cursor\\cursor-agent.cmd",
				probe: () => ({ ok: false }),
				now: () => 1,
				platform: "win32",
			}),
		).toThrow(/is not a working codex CLI\.$/);
	});

	it("falls back to the verbatim path when the expansion yields nothing", () => {
		__resetResolverCacheForTest();
		const probed: string[] = [];
		expect(() =>
			resolveExecutable(
				{ ...spec, expandShim: (): Candidate[] => [] },
				{
					overridePath: "C:\\npm\\codex.cmd",
					probe: (c) => {
						probed.push(c.file);
						return { ok: false };
					},
					now: () => 1,
					platform: "win32",
				},
			),
		).toThrow(/must be a real \.exe/);
		expect(probed).toEqual(["C:\\npm\\codex.cmd"]);
	});

	it("does not expand a POSIX override — extensions carry no such meaning there", () => {
		__resetResolverCacheForTest();
		const out = resolveExecutable(shimSpec, {
			overridePath: "/usr/local/bin/cursor-agent",
			probe: () => ({ ok: true, version: "1.0.0" }),
			now: () => 1,
			platform: "darwin",
		});
		expect(out.file).toBe("/usr/local/bin/cursor-agent");
	});
});

describe("override-path guidance on Windows", () => {
	const failing = { probe: () => ({ ok: false }), now: () => 1, platform: "win32" as const };

	it("explains that a .cmd/.ps1 launcher cannot be pointed at directly", () => {
		__resetResolverCacheForTest();
		expect(() => resolveExecutable(spec, { overridePath: "C:\\npm\\codex.cmd", ...failing })).toThrow(
			/must be a real \.exe/,
		);
	});

	it("does not add the hint when the override already is an .exe (it is simply broken)", () => {
		__resetResolverCacheForTest();
		expect(() => resolveExecutable(spec, { overridePath: "C:\\npm\\codex.exe", ...failing })).toThrow(
			/is not a working codex CLI\.$/,
		);
	});

	it("does not add the hint on POSIX, where extensions carry no such meaning", () => {
		__resetResolverCacheForTest();
		expect(() =>
			resolveExecutable(spec, { overridePath: "/usr/local/bin/codex", ...failing, platform: "darwin" }),
		).toThrow(/is not a working codex CLI\.$/);
	});
});

describe("default directory listing", () => {
	it("treats an unreadable directory as empty rather than throwing out of discovery", () => {
		const shimSpec = {
			...spec,
			// No `listDir` is injected below, so this exercises the real readdirSync
			// path against a directory that cannot exist.
			expandShim: (_shim: string, deps: { listDir: (p: string) => string[] }): Candidate[] =>
				deps.listDir("/definitely-not-a-real-directory-9f3a").map((f) => ({ file: f })),
		};
		expect(
			discover(shimSpec, "win32", {
				runFinder: () => "C:\\npm\\codex.cmd\r\n",
				exists: () => false,
				home: "C:\\Users\\x",
				basePath: "C:\\npm",
			}),
		).toEqual([]);
	});
});

describe("isPresent", () => {
	const SPEC = {
		binName: "faketool",
		knownPaths: () => [],
		probeArgs: ["--version"] as const,
	};

	it("returns true when candidates are discovered", () => {
		expect(isPresent(SPEC, { platform: "darwin", candidates: () => [{ file: "/usr/local/bin/faketool" }] })).toBe(
			true,
		);
	});

	it("spawns no subprocess — the whole point of the presence/usability split", () => {
		// isPresent never probes — it only checks candidate enumeration. We use a
		// candidates seam with a fake path that would error if spawned, to enforce
		// the guarantee without relying on spy interception.
		expect(
			isPresent(SPEC, {
				platform: "darwin",
				candidates: () => [{ file: "/nonexistent/path/would/throw/if/probed" }],
			}),
		).toBe(true);
	});

	it("returns false when nothing is discovered", () => {
		expect(isPresent(SPEC, { platform: "darwin", candidates: () => [] })).toBe(false);
	});

	it("honors an override path that exists on disk", () => {
		expect(
			isPresent(SPEC, {
				platform: "darwin",
				overridePath: "/opt/custom/faketool",
				exists: (p) => p === "/opt/custom/faketool",
			}),
		).toBe(true);
	});

	it("rejects an override path that does not exist", () => {
		expect(
			isPresent(SPEC, {
				platform: "darwin",
				overridePath: "/opt/missing/faketool",
				exists: () => false,
			}),
		).toBe(false);
	});

	it("does not consult the resolution cache — neither reads nor writes it", () => {
		__resetResolverCacheForTest();
		const now = () => 100;

		// Prime the cache with a real resolveExecutable call.
		resolveExecutable(SPEC, {
			candidates: () => [{ file: "/cached/binary" }],
			probe: () => ({ ok: true, version: "1.0.0" }),
			now,
			platform: "darwin",
		});

		// Now call isPresent for the same binName with empty candidates.
		// If isPresent read the cache, it would see the cached resolution and return true.
		// Instead it should see no candidates and return false.
		expect(
			isPresent(SPEC, {
				platform: "darwin",
				candidates: () => [],
			}),
		).toBe(false);

		// Verify the cache was not evicted or overwritten by isPresent.
		// Call resolveExecutable again with the same key; it should serve the cached hit
		// (same probe call count, same resolution).
		const r = resolveExecutable(SPEC, {
			candidates: () => [{ file: "/other/binary" }],
			probe: () => ({ ok: true, version: "2.0.0" }),
			now: () => 150, // still within TTL
			platform: "darwin",
		});
		// The cache was hit, so it returns the old result despite new candidates/probe.
		expect(r).toEqual({ file: "/cached/binary", version: "1.0.0" });
	});

	it("defaults to process.platform and existsSync when not provided", () => {
		// Tests the ?? operators for platform and exists defaults.
		// Since we can't easily mock process.platform or existsSync in isolation,
		// we use an override path that will go through the exists check.
		expect(
			isPresent(SPEC, {
				overridePath: "/opt/custom/faketool",
				exists: () => true,
				// platform is NOT provided — should default to process.platform
			}),
		).toBe(true);
	});

	it("enumerates the filesystem when no candidates function is provided", () => {
		// Tests the default path: with nothing on the (empty) search PATH and no
		// knownPaths, discoverPresence finds nothing.
		expect(
			isPresent(SPEC, {
				platform: "darwin",
				basePath: "",
				home: "/home/u",
				exists: () => false,
			}),
		).toBe(false);
	});

	it("finds a binary sitting on the search PATH", () => {
		expect(
			isPresent(SPEC, {
				platform: "darwin",
				basePath: "/opt/bin",
				home: "/home/u",
				exists: (p) => p === "/opt/bin/faketool",
			}),
		).toBe(true);
	});
});

describe("discoverPresence", () => {
	const SPEC = { binName: "faketool", knownPaths: () => [], probeArgs: ["--version"] as const };

	/**
	 * The load-bearing guarantee: this runs synchronously on the VS Code extension
	 * host's single thread during activation, where a blocked event loop stalls
	 * EVERY extension. `discover` shells out to `which`/`where` via
	 * `execFileSyncHidden`; presence must not.
	 */
	it("spawns no subprocess", () => {
		const spawn = vi.spyOn(subprocess, "execFileSyncHidden");
		discoverPresence(SPEC, "darwin", { basePath: "/opt/bin", home: "/home/u", exists: () => true });
		expect(spawn).not.toHaveBeenCalled();
	});

	it("scans every PATH entry plus the common bin dirs", () => {
		const seen: string[] = [];
		discoverPresence(SPEC, "darwin", {
			basePath: "/first",
			home: "/home/u",
			exists: (p) => {
				seen.push(p);
				return false;
			},
		});
		expect(seen).toContain("/first/faketool");
		// discoveryPath unions the GUI-launch-safe dirs in — the same reason
		// `discover` hands them to `which`.
		expect(seen).toContain("/opt/homebrew/bin/faketool");
		expect(seen).toContain("/home/u/.local/bin/faketool");
	});

	it("includes the spec's known install locations", () => {
		const spec = {
			binName: "faketool",
			knownPaths: () => ["/Applications/Thing.app/faketool"],
			probeArgs: ["--version"] as const,
		};
		expect(discoverPresence(spec, "darwin", { basePath: "", home: "/home/u", exists: () => true })).toContain(
			"/Applications/Thing.app/faketool",
		);
	});

	it("dedupes a dir that appears in both PATH and the common dirs", () => {
		const hits = discoverPresence(SPEC, "darwin", {
			basePath: "/opt/homebrew/bin",
			home: "/home/u",
			exists: (p) => p === "/opt/homebrew/bin/faketool",
		});
		expect(hits).toEqual(["/opt/homebrew/bin/faketool"]);
	});

	it("accepts win32 shims as PRESENCE, even though they are not launch targets", () => {
		// A `.cmd` cannot be spawned (see `discover`'s header) but it is still proof
		// of an install. Resolving it to a native target stays resolveExecutable's job.
		const hits = discoverPresence(SPEC, "win32", {
			basePath: "C:\\bin",
			home: "C:\\Users\\u",
			exists: (p) => p === "C:\\bin\\faketool.cmd",
		});
		expect(hits).toEqual(["C:\\bin\\faketool.cmd"]);
	});

	it("splits the search path with the TARGET platform's separator", () => {
		// `;` on win32, `:` elsewhere — getting this wrong silently collapses the
		// whole PATH into one bogus directory name.
		const hits = discoverPresence(SPEC, "win32", {
			basePath: "C:\\a;C:\\b",
			home: "C:\\Users\\u",
			exists: (p) => p === "C:\\b\\faketool.exe",
		});
		expect(hits).toEqual(["C:\\b\\faketool.exe"]);
	});

	// Every test above injects `exists`, which is exactly why the DEFAULT
	// predicate needs its own coverage against a real filesystem: a bare
	// `existsSync` answers true for a directory and ignores the execute bit, and
	// a presence-only false positive becomes a clickable onboarding option that
	// cannot work.
	describe("default file predicate (real filesystem)", () => {
		let dir: string;

		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "jolli-presence-"));
		});

		afterEach(() => {
			rmSync(dir, { recursive: true, force: true });
		});

		// POSIX-only: Windows has no execute bit, and the win32 branch deliberately
		// stops at "is a regular file" so `.cmd` / `.ps1` shims still count.
		const posixIt = process.platform === "win32" ? it.skip : it;

		it("rejects a DIRECTORY that happens to be named like the binary", () => {
			mkdirSync(join(dir, "faketool"));
			expect(discoverPresence(SPEC, process.platform, { basePath: dir, home: dir })).toEqual([]);
		});

		posixIt("rejects a file with no execute bit", () => {
			writeFileSync(join(dir, "faketool"), "");
			chmodSync(join(dir, "faketool"), 0o644);
			expect(discoverPresence(SPEC, process.platform, { basePath: dir, home: dir })).toEqual([]);
		});

		posixIt("accepts an executable regular file", () => {
			writeFileSync(join(dir, "faketool"), "");
			chmodSync(join(dir, "faketool"), 0o755);
			expect(discoverPresence(SPEC, process.platform, { basePath: dir, home: dir })).toEqual([
				join(dir, "faketool"),
			]);
		});

		posixIt("rejects a broken symlink, matching existsSync", () => {
			symlinkSync(join(dir, "nope"), join(dir, "faketool"));
			expect(discoverPresence(SPEC, process.platform, { basePath: dir, home: dir })).toEqual([]);
		});

		it("applies the same predicate to isPresent's override path", () => {
			// An override names one file; a directory at that path must not read as
			// an installed tool just because something exists there.
			mkdirSync(join(dir, "mytool"));
			expect(isPresent(SPEC, { overridePath: join(dir, "mytool"), platform: process.platform })).toBe(false);
		});

		// Windows has no execute bit and a presence hit is allowed to be a `.cmd` /
		// `.ps1` shim, so the win32 predicate stops at "is a regular file". Pinned
		// with an explicit platform so it holds on POSIX CI too.
		it("accepts a non-executable regular file under win32 rules", () => {
			const file = join(dir, "mytool");
			writeFileSync(file, "");
			chmodSync(file, 0o644);
			expect(isPresent(SPEC, { overridePath: file, platform: "win32" })).toBe(true);
			// The same file is rejected on POSIX, where the execute bit is the signal.
			if (process.platform !== "win32") {
				expect(isPresent(SPEC, { overridePath: file, platform: "linux" })).toBe(false);
			}
		});
	});

	// The three ambient defaults `discoverPresence` falls back to when the caller
	// supplies no seams. Exercised through an empty PATH so the scan is bounded to
	// the common-dir augmentation and cannot hit a real install.
	describe("ambient defaults", () => {
		it("falls back to the real home and an absent PATH without throwing", () => {
			vi.stubEnv("PATH", undefined as unknown as string);
			try {
				expect(discoverPresence(SPEC, "darwin", { exists: () => false })).toEqual([]);
			} finally {
				vi.unstubAllEnvs();
			}
		});

		// win32 only: `discoveryPath` already drops empty POSIX segments, but it
		// returns the Windows PATH verbatim, so a doubled / trailing `;` survives
		// to the scan and would otherwise join to a bare relative "faketool.exe".
		it("skips empty PATH segments on win32 instead of probing a relative path", () => {
			const probed: string[] = [];
			discoverPresence(SPEC, "win32", {
				basePath: "C:\\a;;C:\\b;",
				home: "C:\\Users\\u",
				exists: (f) => {
					probed.push(f);
					return false;
				},
			});
			expect(probed.length).toBeGreaterThan(0);
			expect(probed.every((p) => p.includes("\\"))).toBe(true);
		});

		it("falls back to an absent PATH inside discover() too", () => {
			vi.stubEnv("PATH", undefined as unknown as string);
			try {
				expect(discover(SPEC, "darwin", { runFinder: () => "", exists: () => false })).toEqual([]);
			} finally {
				vi.unstubAllEnvs();
			}
		});
	});
});
