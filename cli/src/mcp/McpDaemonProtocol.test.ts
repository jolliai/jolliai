import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	canReleaseAddress,
	encodeHandshakeLine,
	ensureSocketParentDir,
	isCoreVersionNewer,
	isInManagedSocketDir,
	isManagedSocketDirSafe,
	MCP_DAEMON_PROTOCOL,
	mcpSocketDir,
	mcpSocketPath,
	nextScanAction,
	parseClientGreeting,
	parseDaemonHello,
	parseRetireAnswer,
	readHandshakeLine,
	sameWorktreeRoot,
	socketGenerationCount,
} from "./McpDaemonProtocol.js";

describe("mcpSocketPath", () => {
	it("gives sibling worktrees of one repo DIFFERENT sockets", () => {
		// The central identity decision: MCP tools are worktree-scoped (recall and
		// get_pr_description answer for the CURRENT branch), so collapsing siblings
		// onto one daemon would answer for the wrong branch.
		const a = mcpSocketPath("/repo/wt-main", { platform: "darwin", uid: 501 });
		const b = mcpSocketPath("/repo/wt-feature", { platform: "darwin", uid: 501 });
		expect(a).not.toBe(b);
	});

	it("gives one worktree a stable socket across calls", () => {
		const a = mcpSocketPath("/repo/wt", { platform: "darwin", uid: 501 });
		const b = mcpSocketPath("/repo/wt", { platform: "darwin", uid: 501 });
		expect(a).toBe(b);
	});

	it("maps two spellings of one path to ONE socket", () => {
		// A case-insensitive filesystem hands the same worktree to different hosts
		// under different spellings; two daemons for one worktree would defeat the
		// singleton and double the memory this ticket exists to reclaim.
		const lower = mcpSocketPath("/Repo/WT/", { platform: "darwin", uid: 501 });
		const upper = mcpSocketPath("/repo/wt", { platform: "darwin", uid: 501 });
		expect(lower).toBe(upper);
	});

	it("keeps two spellings APART on a case-sensitive platform", () => {
		// The mirror of the case above, and the reason folding follows the passed
		// `platform` rather than the host's: on Linux these are genuinely two
		// directories, so collapsing them would point two worktrees at one daemon.
		// Pinned in both directions so the option cannot go back to answering one
		// way on a macOS laptop and another on a Linux runner.
		const lower = mcpSocketPath("/Repo/WT/", { platform: "linux", uid: 501 });
		const upper = mcpSocketPath("/repo/wt", { platform: "linux", uid: 501 });
		expect(lower).not.toBe(upper);
	});

	it("stays inside the unix socket path limit for a deep worktree", () => {
		// macOS caps sun_path at 104 bytes; a real worktree path is far longer than
		// that, which is why the path is a hash rather than the root itself.
		const deep = `/Users/someone/work/company/monorepo-worktrees/${"nested/".repeat(20)}feature-branch`;
		expect(mcpSocketPath(deep, { platform: "darwin", uid: 501 }).length).toBeLessThan(104);
	});

	it("uses a named pipe on Windows, with no directory to create", () => {
		const path = mcpSocketPath("C:\\repo\\wt", { platform: "win32", uid: 0 });
		expect(path.startsWith("\\\\.\\pipe\\jolli-mcp-")).toBe(true);
	});

	it("derives the platform and uid from the process when not told", () => {
		// Production never passes either; the options exist so the tests above can
		// assert both platforms from one machine.
		//
		// Asserted per-platform rather than with one loose `toContain`: the unix
		// directory is `.jolli-mcp-<uid>` while the pipe is `\\.\pipe\jolli-mcp-<key>`
		// with NO leading dot, so a substring that spans both does not exist and the
		// version that looked like it did simply failed on Windows.
		const derived = mcpSocketPath("/repo/wt");
		if (process.platform === "win32") {
			expect(derived.startsWith("\\\\.\\pipe\\jolli-mcp-")).toBe(true);
		} else {
			expect(derived).toContain(".jolli-mcp-");
			expect(derived.endsWith(".sock")).toBe(true);
		}
	});

	it("puts the uid in the directory NAME, not only its mode", () => {
		// On Linux /tmp is shared. Without the uid in the name, the first user to
		// create the directory would own its mode bits for every other user.
		expect(mcpSocketDir(501)).toContain("501");
		expect(mcpSocketDir(502)).not.toBe(mcpSocketDir(501));
	});
});

describe("isCoreVersionNewer", () => {
	it("answers false for a TIE so same-version proxies share one daemon", () => {
		// The load-bearing case. Were a tie 'newer', two same-version sessions would
		// retire each other in turn and never share anything.
		expect(isCoreVersionNewer("0.99.11", "0.99.11")).toBe(false);
	});

	it.each([
		["0.99.12", "0.99.11", true],
		["0.99.11", "0.99.12", false],
		["1.0.0", "0.99.99", true],
		["0.100.0", "0.99.0", true],
	])("ranks %s against %s as newer=%s", (candidate, incumbent, expected) => {
		expect(isCoreVersionNewer(candidate, incumbent)).toBe(expected);
	});

	it("ranks an unbuilt 'dev' build equal to itself so dev sessions share", () => {
		expect(isCoreVersionNewer("dev", "dev")).toBe(false);
	});

	it("never lets 'dev' retire a released daemon", () => {
		// A tsx run must not evict a real install's daemon.
		expect(isCoreVersionNewer("dev", "0.99.11")).toBe(false);
	});

	it("never lets a released build retire a 'dev' daemon either", () => {
		// The direction that was wrong. Leaving "dev" to `parseInt(…) || 0` looks
		// symmetric and is not: it yields the one-element [0], and against
		// [0, 99, 0] the SECOND component decides, so a released proxy retired a
		// developer's dev daemon on sight — then respawned the same dev bundle and
		// retired it again, every session, forever.
		expect(isCoreVersionNewer("0.99.11", "dev")).toBe(false);
		expect(isCoreVersionNewer("1.0.0", "dev")).toBe(false);
	});

	it.each(["", "v1.2.3", "1.2.3-rc.1+build"])("treats the unrankable %j as equal in both directions", (odd) => {
		// A sentinel must never sort as zero. `1.2.3-rc.1+build` is the one case
		// here that IS ranked (it starts with a digit) — pinned so a future
		// prerelease scheme is a deliberate decision rather than a silent one.
		const ranked = /^\d/.test(odd);
		expect(isCoreVersionNewer(odd, "0.99.11")).toBe(ranked);
		expect(isCoreVersionNewer("0.99.11", odd)).toBe(false);
	});
});

describe("isInManagedSocketDir", () => {
	const UID = 501;

	it("recognises the path the daemon actually binds", () => {
		// The production case the safety gate used to miss: the proxy always spawns
		// with an explicit `--socket`, and this is the path it supplies.
		expect(isInManagedSocketDir(mcpSocketPath("/repo/wt", { platform: "darwin", uid: UID }), UID, "darwin")).toBe(
			true,
		);
	});

	it("rejects a scratch path outside the managed directory", () => {
		expect(isInManagedSocketDir("/tmp/some-test-dir/d.sock", UID, "darwin")).toBe(false);
	});

	it("rejects another uid's managed directory", () => {
		expect(isInManagedSocketDir(mcpSocketPath("/repo/wt", { platform: "darwin", uid: 502 }), UID, "darwin")).toBe(
			false,
		);
	});

	it("is not fooled by a differently-cased spelling of the same directory", () => {
		// Same reason mcpSocketPath hashes a NORMALISED root: on a case-insensitive
		// filesystem these are one directory, and a case-sensitive test would let a
		// path that is inside it present itself as an unpoliced scratch path.
		const inside = mcpSocketPath("/repo/wt", { platform: "darwin", uid: UID });
		expect(isInManagedSocketDir(inside.toUpperCase(), UID, "darwin")).toBe(true);
	});

	it("does distinguish spellings on a case-sensitive platform", () => {
		// Same reason as the mcpSocketPath pair: folding follows the passed
		// platform, so the gate answers about the directory that actually exists on
		// the host it is describing.
		const inside = mcpSocketPath("/repo/wt", { platform: "linux", uid: UID });
		expect(isInManagedSocketDir(inside, UID, "linux")).toBe(true);
		expect(isInManagedSocketDir(inside.toUpperCase(), UID, "linux")).toBe(false);
	});

	it("is always false on Windows, whose named pipes have no directory to police", () => {
		expect(isInManagedSocketDir(mcpSocketPath("/repo/wt", { platform: "win32" }), UID, "win32")).toBe(false);
	});
});

describe("parseDaemonHello", () => {
	it("accepts a well-formed greeting", () => {
		const line = JSON.stringify({
			t: "hello",
			protocol: MCP_DAEMON_PROTOCOL,
			version: "0.99.11",
			pid: 42,
			cwd: "/repo",
		});
		expect(parseDaemonHello(line)).toEqual({
			t: "hello",
			protocol: MCP_DAEMON_PROTOCOL,
			version: "0.99.11",
			pid: 42,
			cwd: "/repo",
		});
	});

	it.each([
		["malformed JSON", "not json{"],
		["a null body", "null"],
		["a foreign protocol", JSON.stringify({ t: "hello", protocol: 999, version: "1", pid: 1, cwd: "/r" })],
		["a wrong tag", JSON.stringify({ t: "bye", protocol: MCP_DAEMON_PROTOCOL, version: "1", pid: 1, cwd: "/r" })],
		["a missing cwd", JSON.stringify({ t: "hello", protocol: MCP_DAEMON_PROTOCOL, version: "1", pid: 1 })],
		[
			"a non-numeric pid",
			JSON.stringify({ t: "hello", protocol: MCP_DAEMON_PROTOCOL, version: "1", pid: "1", cwd: "/r" }),
		],
	])("returns undefined rather than throwing for %s", (_label, line) => {
		// Total by design: after a tmpdir sweep something else can own the path, and
		// the caller answers every failure the same way — serve in-process.
		expect(parseDaemonHello(line)).toBeUndefined();
	});
});

describe("parseClientGreeting", () => {
	it.each([
		["attach", { t: "attach" }],
		["retire", { t: "retire" }],
	])("accepts %s", (_label, message) => {
		expect(parseClientGreeting(JSON.stringify(message))).toEqual(message);
	});

	it.each([["garbage"], ["null"], ['{"t":"shutdown"}']])("rejects %s", (line) => {
		expect(parseClientGreeting(line)).toBeUndefined();
	});
});

describe("readHandshakeLine", () => {
	it("returns the bytes that arrived BEHIND the greeting", async () => {
		// The reason this is hand-rolled instead of `readline`: whatever the reader
		// buffers past the first line is MCP traffic that must reach the transport.
		const stream = new PassThrough();
		const pending = readHandshakeLine(stream);
		stream.write(`${JSON.stringify({ t: "attach" })}\n{"jsonrpc":"2.0","id":1}\n`);
		const result = await pending;
		expect(result?.line).toBe('{"t":"attach"}');
		expect(result?.rest.toString()).toBe('{"jsonrpc":"2.0","id":1}\n');
	});

	it("reassembles a greeting split across chunks", async () => {
		const stream = new PassThrough();
		const pending = readHandshakeLine(stream);
		stream.write('{"t":"at');
		stream.write('tach"}\n');
		expect((await pending)?.line).toBe('{"t":"attach"}');
	});

	it("gives up on a peer that streams without ever sending a newline", async () => {
		// Bounded so a peer that is not speaking our protocol cannot grow the heap.
		const stream = new PassThrough();
		const pending = readHandshakeLine(stream);
		stream.write("x".repeat(5000));
		expect(await pending).toBeUndefined();
	});

	it("resolves undefined when the peer closes first", async () => {
		const stream = new PassThrough();
		const pending = readHandshakeLine(stream);
		stream.destroy();
		expect(await pending).toBeUndefined();
	});

	it("resolves undefined on timeout rather than hanging the caller", async () => {
		const stream = new PassThrough();
		expect(await readHandshakeLine(stream, 20)).toBeUndefined();
	});
});

describe("encodeHandshakeLine", () => {
	it("terminates with the newline the reader frames on", () => {
		expect(encodeHandshakeLine({ t: "attach" })).toBe('{"t":"attach"}\n');
	});
});

describe("ensureSocketParentDir", () => {
	it("creates a missing parent so listen() cannot fail ENOENT", async () => {
		// The daemon's first real bug: it skipped this whenever the proxy passed an
		// explicit --socket, and every bind failed with a bare "listen-failed".
		const base = await mkdtemp(join(tmpdir(), "jolli-mcp-dir-"));
		const socketPath = join(base, "nested", "deep", "x.sock");
		await ensureSocketParentDir(socketPath, "darwin");
		expect((await stat(dirname(socketPath))).isDirectory()).toBe(true);
	});

	it("derives the platform from the process when not told", async () => {
		const base = await mkdtemp(join(tmpdir(), "jolli-mcp-dir2-"));
		await ensureSocketParentDir(join(base, "nested", "x.sock"));
		// On Windows the derived answer is "do nothing", so asserting a directory
		// appeared asserts the opposite of the contract there.
		const created = await stat(join(base, "nested")).then(
			(s) => s.isDirectory(),
			() => false,
		);
		expect(created).toBe(process.platform !== "win32");
	});

	it("is a no-op on Windows, whose pipes have no directory", async () => {
		await expect(ensureSocketParentDir("\\\\.\\pipe\\jolli-mcp-abc", "win32")).resolves.toBeUndefined();
	});
});

describe("sameWorktreeRoot", () => {
	it("folds exactly what the socket hash folds, so the two cannot disagree", () => {
		// The bug this exists to prevent: the address folded case while the proxy's
		// post-handshake check was a raw `!==`, so on a case-insensitive filesystem
		// two spellings of one worktree reached the RIGHT daemon and were then
		// rejected as a hash collision — stranding that session in-process for good.
		for (const platform of ["darwin", "win32"] as const) {
			expect(mcpSocketPath("/Repo/WT", { platform, uid: 501 })).toBe(
				mcpSocketPath("/repo/wt", { platform, uid: 501 }),
			);
			expect(sameWorktreeRoot("/Repo/WT", "/repo/wt", platform)).toBe(true);
		}
	});

	it("keeps two genuinely different worktrees apart on a case-sensitive platform", () => {
		// Linux really does have two directories there, and the address agrees.
		expect(mcpSocketPath("/Repo/WT", { platform: "linux", uid: 501 })).not.toBe(
			mcpSocketPath("/repo/wt", { platform: "linux", uid: 501 }),
		);
		expect(sameWorktreeRoot("/Repo/WT", "/repo/wt", "linux")).toBe(false);
	});

	it("ignores a trailing separator on every platform", () => {
		expect(sameWorktreeRoot("/repo/wt/", "/repo/wt", "linux")).toBe(true);
	});

	it("still separates unrelated roots", () => {
		expect(sameWorktreeRoot("/repo/wt-main", "/repo/wt-feature", "linux")).toBe(false);
	});
});

describe("isManagedSocketDirSafe", () => {
	it("reports unsafe when the managed directory does not exist", () => {
		// An absent directory cannot be shown to be ours, and the caller's response
		// (serve in-process) is the safe one.
		//
		// Platform pinned explicitly: this asserts the UNIX rule, and on Windows the
		// function answers `true` unconditionally (there is no directory to police),
		// so a process-derived call would have quietly asserted the reverse of the
		// case's own name.
		expect(isManagedSocketDirSafe(999_999, "linux")).toBe(false);
	});

	it("is always true on Windows, which has no such directory", () => {
		expect(isManagedSocketDirSafe(0, "win32")).toBe(true);
	});
});

describe("mcpSocketPath — generations", () => {
	// Generation 0 is the rendezvous every bundle agrees on, including ones that
	// predate generations entirely. If its spelling ever moved, an upgraded proxy
	// and an already-running older daemon would sit on two addresses and neither
	// would ever find the other — two daemons per worktree, forever.
	it.each<NodeJS.Platform>(["darwin", "linux", "win32"])(
		"spells generation 0 exactly as no generation at all on %s",
		(platform) => {
			expect(mcpSocketPath("/repo/wt", { platform, uid: 501, generation: 0 })).toBe(
				mcpSocketPath("/repo/wt", { platform, uid: 501 }),
			);
		},
	);

	it("gives each generation its own pipe name on Windows", () => {
		// The whole point: a retiring daemon cannot release a named pipe while its
		// clients still hold instances of it, so the successor needs a DIFFERENT
		// address to bind rather than an eviction.
		const gens = [0, 1, 2, 3].map((generation) => mcpSocketPath("/repo/wt", { platform: "win32", generation }));
		expect(new Set(gens).size).toBe(gens.length);
	});

	it("gives each generation its own socket on unix too, so the scan is testable off Windows", () => {
		const a = mcpSocketPath("/repo/wt", { platform: "linux", uid: 501, generation: 1 });
		const b = mcpSocketPath("/repo/wt", { platform: "linux", uid: 501, generation: 2 });
		expect(a).not.toBe(b);
	});

	it("stays inside the unix socket path limit at the highest generation", () => {
		// The 104-byte cap is why the address is a hash in the first place; a
		// generation suffix must not be what pushes it over.
		const deep = "/Users/somebody/jolli/code/jollimemory-worktrees/feature/some-long-branch-name/nested";
		const path = mcpSocketPath(deep, { platform: "darwin", uid: 501, generation: 3 });
		expect(path.length).toBeLessThan(104);
	});
});

describe("socketGenerationCount", () => {
	it("scans several generations on Windows, where a retiring daemon keeps its address", () => {
		expect(socketGenerationCount("win32")).toBeGreaterThan(1);
	});

	it.each<NodeJS.Platform>(["darwin", "linux"])(
		"stays a single address on %s, where close() releases it at once",
		(platform) => {
			// Measured: unix `close()` unlinks synchronously and already-accepted
			// connections keep working, so a successor binds the SAME path. Scanning
			// higher generations there would only add failed connects to every
			// session's cold start.
			expect(socketGenerationCount(platform)).toBe(1);
		},
	);
});

describe("canReleaseAddress", () => {
	it.each<NodeJS.Platform>(["darwin", "linux"])(
		"is always true on %s, where accept() decouples the connection",
		(platform) => {
			expect(canReleaseAddress(platform, 7)).toBe(true);
		},
	);

	it.each([0, 1])("is true on Windows when only the retiring requester is attached (%i)", (connections) => {
		// The requester itself is still counted at the moment the daemon decides —
		// which is exactly why an idle handover works on Windows today.
		expect(canReleaseAddress("win32", connections)).toBe(true);
	});

	it.each([2, 5])("is false on Windows while another client still holds an instance (%i)", (connections) => {
		expect(canReleaseAddress("win32", connections)).toBe(false);
	});
});

describe("parseRetireAnswer", () => {
	it("accepts the deferral a daemon sends when it cannot release its address", () => {
		expect(parseRetireAnswer(JSON.stringify({ t: "retire-deferred" }))).toEqual({ t: "retire-deferred" });
	});

	it.each([["garbage"], ["null"], ['{"t":"attach"}'], ['{"t":"hello"}']])("rejects %s", (line) => {
		expect(parseRetireAnswer(line)).toBeUndefined();
	});
});

describe("nextScanAction", () => {
	it("probes generation 0 before anything else", () => {
		expect(nextScanAction([], "win32")).toEqual({ action: "probe", generation: 0 });
	});

	it("keeps probing higher generations before spawning anywhere", () => {
		// The failure this prevents: generation 0 drained and freed while a healthy
		// successor still serves at generation 1. Spawning at the first free address
		// would add a SECOND daemon for one worktree, ~100 MB, with neither aware of
		// the other — and nothing left to arbitrate it, since the OS can only police
		// one name at a time.
		expect(nextScanAction(["free"], "win32")).toEqual({ action: "probe", generation: 1 });
	});

	it("spawns at the LOWEST free generation so a drained one is reused", () => {
		// Without this the chain only ever creeps upward and hits the cap after a few
		// upgrades, with generation 0 abandoned for the life of the machine.
		expect(nextScanAction(["deferred", "free", "free", "free"], "win32")).toEqual({
			action: "spawn",
			generation: 1,
		});
	});

	it("spawns at generation 0 straight away on unix, where there is nothing else to scan", () => {
		expect(nextScanAction(["free"], "linux")).toEqual({ action: "spawn", generation: 0 });
	});

	it("falls back rather than answering from a superseded daemon when every generation is held", () => {
		expect(nextScanAction(["deferred", "deferred", "deferred", "deferred"], "win32")).toEqual({
			action: "fallback",
		});
	});

	it("falls back on unix when its single address is still held", () => {
		expect(nextScanAction(["deferred"], "linux")).toEqual({ action: "fallback" });
	});
});
