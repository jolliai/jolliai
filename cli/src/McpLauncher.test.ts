import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, resolveMcpCli } from "./McpLauncher.js";

// The launcher's whole job is to spawn the resolved CLI, so `main()` cannot be
// covered without stubbing the spawn. Everything else about it stays real.
vi.mock("./util/Subprocess.js", () => ({ spawnHidden: vi.fn() }));

/**
 * `resolveMcpCli` is exercised against a real dist-paths registry on disk rather
 * than a mocked resolver: the whole point of the launcher is that it agrees with
 * what `traverseDistPaths` / `pickBestDistPath` actually do, so mocking them would
 * test nothing worth testing.
 */
describe("resolveMcpCli", () => {
	let globalDir: string;
	let selfDir: string;

	/** Registers a source in dist-paths/ pointing at a dist dir containing Cli.js. */
	async function registerDist(source: string, version: string, distDir: string, withCli = true): Promise<void> {
		if (withCli) await writeFile(join(distDir, "Cli.js"), "// stub", "utf-8");
		await writeFile(join(globalDir, "dist-paths", source), `${version}\n${distDir}\n`, "utf-8");
	}

	beforeEach(async () => {
		globalDir = await mkdtemp(join(tmpdir(), "jolli-mcp-launcher-global-"));
		selfDir = await mkdtemp(join(tmpdir(), "jolli-mcp-launcher-self-"));
		await writeFile(join(selfDir, "Cli.js"), "// bundled stub", "utf-8");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(globalDir, "dist-paths"), { recursive: true });
	});

	afterEach(async () => {
		await rm(globalDir, { recursive: true, force: true });
		await rm(selfDir, { recursive: true, force: true });
	});

	// The reason the launcher exists: a newer CLI must serve MCP even though the
	// manifest that launched us lives in the plugin bundle.
	it("prefers a higher-versioned dist over the bundle it was launched from", async () => {
		const newer = await mkdtemp(join(tmpdir(), "jolli-mcp-launcher-cli-"));
		try {
			await registerDist("cli", "1.2.3", newer);
			await registerDist("codex-plugin", "0.1.0", selfDir);

			expect(resolveMcpCli(selfDir, globalDir)).toBe(join(newer, "Cli.js"));
		} finally {
			await rm(newer, { recursive: true, force: true });
		}
	});

	// A plugin-only install whose bootstrap has not run yet has no registry at all —
	// its own bundle is then genuinely the only runtime present.
	it("falls back to the bundled CLI when nothing is registered", () => {
		expect(resolveMcpCli(selfDir, globalDir)).toBe(join(selfDir, "Cli.js"));
	});

	// A stale entry pointing at a deleted dist must degrade to "serve from here"
	// rather than handing the host a path that cannot be spawned.
	it("falls back when the winning entry's Cli.js is gone", async () => {
		const ghost = await mkdtemp(join(tmpdir(), "jolli-mcp-launcher-ghost-"));
		try {
			await registerDist("cli", "9.9.9", ghost, false);

			expect(resolveMcpCli(selfDir, globalDir)).toBe(join(selfDir, "Cli.js"));
		} finally {
			await rm(ghost, { recursive: true, force: true });
		}
	});

	it("falls back when the registry directory does not exist at all", async () => {
		const empty = await mkdtemp(join(tmpdir(), "jolli-mcp-launcher-empty-"));
		try {
			expect(resolveMcpCli(selfDir, empty)).toBe(join(selfDir, "Cli.js"));
		} finally {
			await rm(empty, { recursive: true, force: true });
		}
	});

	it("serves from the plugin's own dist when it is the registered winner", async () => {
		await registerDist("codex-plugin", "0.1.0", selfDir);

		expect(resolveMcpCli(selfDir, globalDir)).toBe(join(selfDir, "Cli.js"));
	});

	it("resolves from a Codex version-stamped plugin cache path without depending on the session cwd", async () => {
		const cachePlugin = join(globalDir, ".codex", "plugins", "cache", "jolli-marketplace", "jolli", "1.0.0");
		const cachedDist = join(cachePlugin, "dist");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(cachedDist, { recursive: true });
		await writeFile(join(cachedDist, "Cli.js"), "// cached bundled stub", "utf-8");

		const unrelatedSessionCwd = await mkdtemp(join(tmpdir(), "jolli-mcp-launcher-session-"));
		const previousCwd = process.cwd();
		try {
			process.chdir(unrelatedSessionCwd);
			expect(resolveMcpCli(dirname(join(cachedDist, "McpLauncher.js")), globalDir)).toBe(
				join(cachedDist, "Cli.js"),
			);
		} finally {
			process.chdir(previousCwd);
			await rm(unrelatedSessionCwd, { recursive: true, force: true });
		}
	});
});

/**
 * `main()` is the half of the launcher that is pure plumbing, and every part of it
 * is a promise made to the MCP host: byte-transparent stdio, the child's real exit
 * status, and no orphaned server when the host terminates us. None of that is
 * observable from `resolveMcpCli`, so it is covered here against a fake child.
 *
 * The resolved path is asserted by SHAPE, not value: `main()` reads the real
 * `~/.jolli/jollimemory/dist-paths`, so the winner depends on what the developer
 * happens to have installed. What must hold on every machine is that we spawn
 * *some* `Cli.js` with `mcp` — `resolveMcpCli`'s own suite pins which one.
 */
describe("main", () => {
	/** Minimal ChildProcess stand-in: emits what the launcher listens for. */
	class FakeChild extends EventEmitter {
		killed = false;
		readonly kill = vi.fn((signal?: NodeJS.Signals) => {
			this.killed = true;
			void signal;
			return true;
		});
	}

	let child: FakeChild;
	let exitSpy: ReturnType<typeof vi.spyOn>;
	/** Signal listeners `main()` installed, so each case can undo its own. */
	let installed: Array<[NodeJS.Signals, (...args: unknown[]) => void]>;

	const SIGNALS: ReadonlyArray<NodeJS.Signals> = ["SIGINT", "SIGTERM", "SIGHUP"];

	beforeEach(async () => {
		child = new FakeChild();
		const { spawnHidden } = await import("./util/Subprocess.js");
		vi.mocked(spawnHidden).mockReturnValue(child as never);
		// Recorded, not thrown: `process.exit(...)` is the last statement in both
		// handlers, so letting them return is faithful and keeps the emit synchronous.
		exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

		const before = new Map(SIGNALS.map((s) => [s, new Set(process.listeners(s))]));
		main();
		// Diff rather than emitting a real signal: `process.emit("SIGTERM")` would also
		// wake vitest's own handlers and tear the run down. Calling the exact listener
		// we installed tests our code and nothing else.
		installed = SIGNALS.flatMap((s) =>
			process
				.listeners(s)
				.filter((fn) => !before.get(s)?.has(fn))
				.map((fn) => [s, fn as (...args: unknown[]) => void] as [NodeJS.Signals, (...args: unknown[]) => void]),
		);
	});

	afterEach(() => {
		for (const [signal, fn] of installed) process.off(signal, fn);
		exitSpy.mockRestore();
		vi.mocked(child.kill).mockClear();
	});

	it("spawns the resolved CLI in mcp mode with inherited stdio", async () => {
		const { spawnHidden } = await import("./util/Subprocess.js");
		expect(spawnHidden).toHaveBeenCalledTimes(1);
		const [exe, args, opts] = vi.mocked(spawnHidden).mock.calls[0];
		expect(exe).toBe(process.execPath);
		expect(args?.[0]).toMatch(/Cli\.js$/);
		expect(args?.[1]).toBe("mcp");
		// Load-bearing: the JSON-RPC stream must pass through untouched. A pipe here
		// would silently corrupt every MCP session.
		expect(opts?.stdio).toBe("inherit");
	});

	it("mirrors the child's exit code", () => {
		child.emit("exit", 3, null);
		expect(exitSpy).toHaveBeenCalledWith(3);
	});

	it("reports a null exit code as success", () => {
		child.emit("exit", null, null);
		expect(exitSpy).toHaveBeenCalledWith(0);
	});

	it("encodes a signalled exit as 128+n", () => {
		child.emit("exit", null, "SIGTERM");
		expect(exitSpy).toHaveBeenCalledWith(143);
	});

	// 128+0 is exactly 128, which a host could read as its own value — an unknown
	// signal must still land on a nonzero "did not exit cleanly" code.
	it("encodes an unrecognized signal as 128+1 rather than a bare 128", () => {
		child.emit("exit", null, "SIGWINCH");
		expect(exitSpy).toHaveBeenCalledWith(129);
	});

	it("exits nonzero when the CLI cannot be spawned", () => {
		child.emit("error", new Error("ENOENT"));
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	// Without this the real MCP server survives a host that signals only the
	// launcher's PID, holding the stdio of a process the host believes is gone.
	it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("forwards %s to the child", (signal) => {
		const handler = installed.find(([s]) => s === signal)?.[1];
		expect(handler, `no ${signal} handler installed`).toBeDefined();
		handler?.();
		expect(child.kill).toHaveBeenCalledWith(signal);
		// The child's own exit decides ours; forwarding must not pre-empt it.
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("does not re-kill a child that is already gone", () => {
		child.killed = true;
		for (const [, handler] of installed) handler();
		expect(child.kill).not.toHaveBeenCalled();
	});
});

// A source-shape assertion, because no unit test can reach this guard: `VITEST`
// short-circuits it, and the failure it prevents only exists inside an esbuild
// bundle (`import.meta.url` rewritten to the bundle, which is also `argv[1]`, so a
// path-only comparison is true for every inlined module). `QueueWorker` and
// `SessionStartHook` both shipped that bug; this pins the fix for this launcher, which would otherwise spawn a stray MCP child on import.
describe("entry-point guard shape", () => {
	it("gates auto-run on the entry file's basename, not just its path", async () => {
		const { readFile } = await import("node:fs/promises");
		const source = await readFile(new URL("./McpLauncher.ts", import.meta.url), "utf-8");

		expect(source).toMatch(/entryName === "mcplauncher\.js"/);
		expect(source).toMatch(/entryName === "mcplauncher\.ts"/);
		expect(source).toMatch(/basename\(argv1\)\.toLowerCase\(\)/);
	});
});
