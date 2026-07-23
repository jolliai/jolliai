import { describe, expect, it } from "vitest";
import {
	__resetResolverCacheForTest,
	type Candidate,
	discover,
	discoveryPath,
	resolveExecutable,
} from "./ExecutableResolver.js";
import { LocalAgentSetupError } from "./Types.js";

const spec = { binName: "codex", knownPaths: () => [], probeArgs: ["--version"] as const };

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
