import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readHandshakeLine } from "../core/DaemonHandshake.js";
import { resolveCliInvocation } from "../util/CliEntry.js";
import { spawnHidden } from "../util/Subprocess.js";
import {
	ensureGlobalDaemon,
	GLOBAL_DAEMON_ENSURE_COMMAND,
	probeGlobalDaemon,
	retireGlobalDaemon,
	shouldSkipGlobalDaemon,
	triggerEnsureGlobalDaemon,
} from "./EnsureGlobalDaemon.js";
import { GLOBAL_DAEMON_PROTOCOL, globalSocketPath } from "./GlobalDaemonProtocol.js";

// A spy wrapping the real `connect` by default, so every other test in this
// file keeps talking to real sockets. Individual tests below override it
// once with `mockImplementationOnce` to drive `tryConnect`'s two paths a real
// unix socket cannot be coaxed into deterministically: a connect that never
// settles (the CONNECT_TIMEOUT_MS branch) and a connect that throws.
vi.mock("node:net", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:net")>();
	return { ...actual, connect: vi.fn(actual.connect) };
});

// A spy wrapping the real `globalSocketPath` by default, so every test that
// passes its own `socketPath` never touches it. The handful of tests below
// that exercise the `??` fallback for a MISSING `socketPath` override this
// once with `mockReturnValueOnce` to redirect it to a scratch path instead:
// this same machine's real derived path (`$TMPDIR/.jolli-global-<uid>/`) may
// have an actual daemon bound on it, and letting the real function run there
// would make `ensureGlobalDaemon`/`retireGlobalDaemon`/`probeGlobalDaemon`
// spawn, retire, or otherwise disturb the developer's live daemon.
vi.mock("./GlobalDaemonProtocol.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./GlobalDaemonProtocol.js")>();
	return { ...actual, globalSocketPath: vi.fn(actual.globalSocketPath) };
});

// `spawnDetachedGlobalDaemon` is exercised for real, with only the OS-level
// spawn stubbed out, so the `spawnDaemon ?? spawnDetachedGlobalDaemon` fallback
// AND the argv it builds are both covered without starting a real process.
vi.mock("../util/Subprocess.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../util/Subprocess.js")>();
	return { ...actual, spawnHidden: vi.fn() };
});

// The real resolver answers `undefined` under `vitest`, which runs from the
// source tree where no `Cli.js` sits beside this module. Stubbing it is what
// lets the tests below assert on the argv the spawn actually builds; the
// resolution rule itself is covered by `util/CliEntry.test.ts`.
vi.mock("../util/CliEntry.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../util/CliEntry.js")>();
	return {
		...actual,
		resolveCliInvocation: vi.fn(() => ({ entry: "/opt/jolli/dist/Cli.js", nodeArgs: [] })),
	};
});

/**
 * Guards the three suites that reach a real FILESYSTEM socket path — `fakeDaemon`
 * binds one, and every remaining test `connect()`s to one. Windows can only bind
 * `\\.\pipe\`, and since `fakeDaemon` awaits the `listen` callback (which the
 * error path never invokes) a win32 run HANGS rather than failing red.
 *
 * The bind/connect line is drawn deliberately wide: `connect()` to a Win32 path
 * is expected to fail fast rather than stall, but that is unverified here, and
 * the whole point of this guard is that a stall is the failure mode nothing
 * reports. Same stopgap as `GlobalDaemon.test.ts`; the real fix is a
 * pipe-addressed harness.
 */
const describeUnixSocket = describe.skipIf(process.platform === "win32");

let scratch: string;
let servers: Server[] = [];

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "jolli-ensure-"));
	servers = [];
});
afterEach(async () => {
	for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
	await rm(scratch, { recursive: true, force: true });
});

/**
 * A fake daemon that greets with `version` and records the greeting it is sent.
 * `silent: true` accepts the connection but never sends hello — the VACUUM case.
 */
async function fakeDaemon(
	socketPath: string,
	version: string,
	opts: { silent?: boolean } = {},
): Promise<{ greetings: string[] }> {
	const greetings: string[] = [];
	const server = createServer((socket) => {
		if (!opts.silent) {
			// Written as raw NDJSON rather than through `encodeHandshakeLine`: that
			// helper's parameter is `{ readonly t: string }`, and TypeScript's
			// excess-property check rejects an object literal carrying the other
			// hello fields. The wire format is one JSON object plus a newline.
			const hello = { t: "hello", protocol: GLOBAL_DAEMON_PROTOCOL, version, pid: 999, startedAt: 1 };
			socket.write(`${JSON.stringify(hello)}\n`);
		}
		void readHandshakeLine(socket, 2_000).then((read) => {
			if (read) greetings.push(read.line);
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	return { greetings };
}

describe("shouldSkipGlobalDaemon", () => {
	it.each(["global-daemon", "global-daemon-ensure", "mcp", "mcp-serve", "daemon", "uninstall", "disable"])(
		"skips %s",
		(command) => {
			expect(shouldSkipGlobalDaemon(command)).toBe(true);
		},
	);

	it.each(["status", "recall", "search", "enable", "dashboard"])("does not skip %s", (command) => {
		expect(shouldSkipGlobalDaemon(command)).toBe(false);
	});

	it("does not skip when no command was resolved", () => {
		expect(shouldSkipGlobalDaemon(null)).toBe(false);
	});
});

describe("triggerEnsureGlobalDaemon", () => {
	it("spawns the detached ensure helper for supported invocations", () => {
		const socketPath = join(scratch, "d.sock");
		const fakeChild = Object.assign(new EventEmitter(), { pid: 4242, unref: vi.fn() });
		vi.mocked(spawnHidden).mockReturnValueOnce(fakeChild as unknown as ReturnType<typeof spawnHidden>);

		expect(triggerEnsureGlobalDaemon({ socketPath, command: "status", nodeVersion: "22.13.0" })).toBe(true);
		expect(spawnHidden).toHaveBeenCalledWith(
			process.execPath,
			["/opt/jolli/dist/Cli.js", GLOBAL_DAEMON_ENSURE_COMMAND, "--socket", socketPath],
			expect.objectContaining({ detached: true, stdio: "ignore" }),
		);
	});

	it("does not spawn for excluded commands or unsupported runtimes", () => {
		expect(triggerEnsureGlobalDaemon({ command: "disable", nodeVersion: "22.13.0" })).toBe(false);
		expect(triggerEnsureGlobalDaemon({ command: "status", nodeVersion: "20.19.0" })).toBe(false);
		expect(spawnHidden).not.toHaveBeenCalled();
	});
});

describeUnixSocket("ensureGlobalDaemon", () => {
	it("spawns when nothing is listening", async () => {
		const socketPath = join(scratch, "d.sock");
		const spawnDaemon = vi.fn();

		await expect(ensureGlobalDaemon({ socketPath, spawnDaemon, nodeVersion: "22.13.0" })).resolves.toBe("spawned");
		expect(spawnDaemon).toHaveBeenCalledWith(socketPath);
	});

	it("attaches to an equal-versioned daemon instead of retiring it", async () => {
		const socketPath = join(scratch, "d.sock");
		const daemon = await fakeDaemon(socketPath, "0.99.3");
		const spawnDaemon = vi.fn();

		// A TIE must attach. Were ties to count as newer, two same-version
		// triggers would retire each other in turn and never share anything.
		const outcome = await ensureGlobalDaemon({
			socketPath,
			spawnDaemon,
			nodeVersion: "22.13.0",
			ownVersion: "0.99.3",
		});

		expect(outcome).toBe("already-running");
		expect(spawnDaemon).not.toHaveBeenCalled();
		expect(daemon.greetings).toEqual([]);
	});

	it("attaches when either version is the unrankable dev sentinel", async () => {
		const socketPath = join(scratch, "d.sock");
		await fakeDaemon(socketPath, "0.99.3");

		// A released trigger must not retire a developer's dev daemon on sight —
		// the replacement it spawns would be the same dev bundle, forever.
		await expect(ensureGlobalDaemon({ socketPath, nodeVersion: "22.13.0", ownVersion: "dev" })).resolves.toBe(
			"already-running",
		);
	});

	it("does not retire a NEWER daemon", async () => {
		const socketPath = join(scratch, "d.sock");
		const daemon = await fakeDaemon(socketPath, "1.2.0");

		await expect(ensureGlobalDaemon({ socketPath, nodeVersion: "22.13.0", ownVersion: "1.1.0" })).resolves.toBe(
			"already-running",
		);
		expect(daemon.greetings).toEqual([]);
	});

	it("retires a strictly older daemon but does NOT spawn the replacement", async () => {
		const socketPath = join(scratch, "d.sock");
		const daemon = await fakeDaemon(socketPath, "0.0.1");
		const spawnDaemon = vi.fn();

		const outcome = await ensureGlobalDaemon({
			socketPath,
			spawnDaemon,
			nodeVersion: "22.13.0",
			ownVersion: "9.9.9",
		});

		expect(outcome).toBe("retired-incumbent");
		// The retired daemon still holds the socket, and the trigger never waits
		// for its spawn — so an immediate replacement would die address-in-use,
		// silently. The next trigger respawns.
		expect(spawnDaemon).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(daemon.greetings).toEqual([JSON.stringify({ t: "retire" })]));
	});

	it("assumes alive and does nothing when hello never arrives", async () => {
		const socketPath = join(scratch, "d.sock");
		await fakeDaemon(socketPath, "unused", { silent: true });
		const spawnDaemon = vi.fn();

		// connect() succeeded, which already proves something is listening. Only
		// the version refinement was lost, so the correct answer is to do nothing.
		await expect(
			ensureGlobalDaemon({ socketPath, spawnDaemon, nodeVersion: "22.13.0", helloTimeoutMs: 50 }),
		).resolves.toBe("already-running");
		expect(spawnDaemon).not.toHaveBeenCalled();
	});

	it("leaves an error handler on the socket it hands back", async () => {
		const socketPath = join(scratch, "d.sock");
		// A bare EventEmitter is exactly the right stand-in: `emit("error")` on one
		// with no listener THROWS, which is precisely what a real socket does — Node
		// re-raises it as an uncaughtException. The write/end/destroy stubs are the
		// only socket surface the code under test touches.
		const fake = Object.assign(new EventEmitter(), {
			write: vi.fn(),
			end: vi.fn(),
			destroy: vi.fn(),
		});
		vi.mocked(connect).mockImplementationOnce(() => {
			setImmediate(() => fake.emit("connect"));
			return fake as unknown as Socket;
		});

		await expect(
			ensureGlobalDaemon({ socketPath, spawnDaemon: vi.fn(), nodeVersion: "22.13.0", helloTimeoutMs: 20 }),
		).resolves.toBe("already-running");

		// The retire and probe paths both write and `end()` on this socket, and a
		// peer daemon retired by a racing trigger answers EPIPE. With no handler
		// left that kills the process — and four of the five triggers are hooks, so
		// it would kill SessionStart or a plugin bootstrap BEFORE it writes the
		// stdout envelope its host is waiting for.
		expect(fake.listenerCount("error")).toBeGreaterThan(0);
		expect(() => fake.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }))).not.toThrow();
	});

	it("does not spawn on a runtime that cannot open the database", async () => {
		const socketPath = join(scratch, "d.sock");
		const spawnDaemon = vi.fn();

		await expect(ensureGlobalDaemon({ socketPath, spawnDaemon, nodeVersion: "20.19.0" })).resolves.toBe(
			"skipped-unsupported-node",
		);
		expect(spawnDaemon).not.toHaveBeenCalled();
	});

	it("does not spawn for an excluded command", async () => {
		const socketPath = join(scratch, "d.sock");
		const spawnDaemon = vi.fn();

		await expect(
			ensureGlobalDaemon({ socketPath, spawnDaemon, nodeVersion: "22.13.0", command: "uninstall" }),
		).resolves.toBe("skipped-excluded-command");
		expect(spawnDaemon).not.toHaveBeenCalled();
	});

	it("never throws when the spawn itself fails", async () => {
		const socketPath = join(scratch, "d.sock");
		const spawnDaemon = vi.fn(() => {
			throw new Error("ENOENT");
		});

		await expect(ensureGlobalDaemon({ socketPath, spawnDaemon, nodeVersion: "22.13.0" })).resolves.toBe("failed");
	});

	it("falls back to the real Node version and a derived socket path when neither is supplied", async () => {
		const spawnDaemon = vi.fn();
		const fallbackPath = join(scratch, "fallback.sock");
		vi.mocked(globalSocketPath).mockReturnValueOnce(fallbackPath);

		// Exercises the `??` defaults for both `nodeVersion` and `socketPath`
		// against a scratch path rather than this machine's real global socket —
		// a real daemon may be bound there, and this suite must never disturb it.
		await expect(ensureGlobalDaemon({ spawnDaemon })).resolves.toBe("spawned");
		expect(spawnDaemon).toHaveBeenCalledWith(fallbackPath);
	});

	it("falls back to this build's own core version when ownVersion is not supplied", async () => {
		const socketPath = join(scratch, "d.sock");
		// Higher than any real published `@jolli.ai/cli` version, so whatever
		// `cliCoreVersion()` resolves to in THIS test run — the real package
		// version under the vite-driven `vitest` config, "dev" under bare tsx —
		// is never newer than the incumbent.
		const daemon = await fakeDaemon(socketPath, "999.0.0");

		await expect(ensureGlobalDaemon({ socketPath, nodeVersion: "22.13.0" })).resolves.toBe("already-running");
		expect(daemon.greetings).toEqual([]);
	});

	it("falls back to spawnDetachedGlobalDaemon when spawnDaemon is not supplied", async () => {
		const socketPath = join(scratch, "d.sock");
		const fakeChild = Object.assign(new EventEmitter(), { pid: 4242, unref: vi.fn() });
		vi.mocked(spawnHidden).mockReturnValueOnce(fakeChild as unknown as ReturnType<typeof spawnHidden>);

		// No `spawnDaemon` in deps: exercises the real `spawnDetachedGlobalDaemon`.
		// `spawnHidden` is mocked above so this never starts a real process.
		await expect(ensureGlobalDaemon({ socketPath, nodeVersion: "22.13.0" })).resolves.toBe("spawned");
		expect(spawnHidden).toHaveBeenCalled();
	});

	it("spawns the CLI entry beside this bundle, never the script that triggered it", async () => {
		const socketPath = join(scratch, "d.sock");
		const fakeChild = Object.assign(new EventEmitter(), { pid: 4242, unref: vi.fn() });
		vi.mocked(spawnHidden).mockReturnValueOnce(fakeChild as unknown as ReturnType<typeof spawnHidden>);

		await expect(ensureGlobalDaemon({ socketPath, nodeVersion: "22.13.0" })).resolves.toBe("spawned");

		// Four of the five triggers run from a HOOK entry (`run-hook` execs
		// `node <dist>/PostCommitHook.js`; both plugin manifests exec
		// `PluginBootstrapHook.js`), so `process.argv[1]` names the hook there.
		// Spawning that re-runs the hook against `homedir()` — its basename entry
		// guard matches — which reaches this trigger again and spawns again,
		// forever, while the daemon never starts.
		expect(spawnHidden).toHaveBeenCalledWith(
			process.execPath,
			["/opt/jolli/dist/Cli.js", "global-daemon", "--socket", socketPath],
			expect.objectContaining({ detached: true, stdio: "ignore" }),
		);
		const [, argv] = vi.mocked(spawnHidden).mock.calls[0] as [string, string[], unknown];
		expect(argv[0]).not.toBe(process.argv[1]);
	});

	it("reuses the current loader args when the invocation resolves to src/Cli.ts", async () => {
		const socketPath = join(scratch, "d.sock");
		const fakeChild = Object.assign(new EventEmitter(), { pid: 4242, unref: vi.fn() });
		vi.mocked(spawnHidden).mockReturnValueOnce(fakeChild as unknown as ReturnType<typeof spawnHidden>);
		vi.mocked(resolveCliInvocation).mockReturnValueOnce({
			entry: "/repo/cli/src/Cli.ts",
			nodeArgs: ["--import", "tsx"],
		});

		await expect(ensureGlobalDaemon({ socketPath, nodeVersion: "22.13.0" })).resolves.toBe("spawned");
		expect(spawnHidden).toHaveBeenCalledWith(
			process.execPath,
			["--import", "tsx", "/repo/cli/src/Cli.ts", "global-daemon", "--socket", socketPath],
			expect.objectContaining({ detached: true, stdio: "ignore" }),
		);
	});

	it("does not spawn when this bundle ships no CLI invocation", async () => {
		const socketPath = join(scratch, "d.sock");
		vi.mocked(resolveCliInvocation).mockReturnValueOnce(undefined);

		// An incomplete runtime still answers "spawned": the outcome describes what
		// this trigger decided, and the warning is the only trace such a run can
		// leave.
		await expect(ensureGlobalDaemon({ socketPath, nodeVersion: "22.13.0" })).resolves.toBe("spawned");
		expect(spawnHidden).not.toHaveBeenCalled();
	});

	it("does nothing when connect() neither succeeds nor errors before the timeout", async () => {
		const socketPath = join(scratch, "d.sock");
		const spawnDaemon = vi.fn();
		// A unix socket has no portable way to make a real connect() hang, so this
		// substitutes a socket that never emits `connect` or `error` — the only way
		// to drive tryConnect's CONNECT_TIMEOUT_MS branch deterministically.
		const stuck = Object.assign(new EventEmitter(), { destroy: vi.fn() });
		vi.mocked(connect).mockImplementationOnce(() => stuck as unknown as Socket);

		await expect(ensureGlobalDaemon({ socketPath, spawnDaemon, nodeVersion: "22.13.0" })).resolves.toBe("spawned");
		expect(stuck.destroy).toHaveBeenCalled();
	});

	it("removes a stale socket file when nothing is listening on it before spawning", async () => {
		const socketPath = join(scratch, "d.sock");
		const spawnDaemon = vi.fn();
		// A real leftover unix socket file, exactly what a `kill -9`'d daemon (or a
		// reboot that kept tmpdir) leaves behind: bind it, then close the server
		// WITHOUT deleting the file, so the path still exists but nothing answers —
		// a real connect() to it gives ECONNREFUSED, same as production.
		const stale = createServer(() => {});
		await new Promise<void>((resolve) => stale.listen(socketPath, resolve));
		await new Promise<void>((resolve) => stale.close(() => resolve()));

		await expect(ensureGlobalDaemon({ socketPath, spawnDaemon, nodeVersion: "22.13.0" })).resolves.toBe("spawned");
		expect(spawnDaemon).toHaveBeenCalledWith(socketPath);
		await expect(stat(socketPath)).rejects.toThrow();
	});

	it("does NOT remove the socket file when connect() only times out", async () => {
		const socketPath = join(scratch, "d.sock");
		const spawnDaemon = vi.fn();
		// A file at the path, but the connect is forced to time out rather than
		// fail — proof only of a SLOW peer, never of an absent one. Unlinking here
		// would delete a live, merely-busy daemon's endpoint out from under it.
		await writeFile(socketPath, "");
		const stuck = Object.assign(new EventEmitter(), { destroy: vi.fn() });
		vi.mocked(connect).mockImplementationOnce(() => stuck as unknown as Socket);

		await expect(ensureGlobalDaemon({ socketPath, spawnDaemon, nodeVersion: "22.13.0" })).resolves.toBe("spawned");
		expect(spawnDaemon).toHaveBeenCalledWith(socketPath);
		await expect(stat(socketPath)).resolves.toBeDefined();
	});
});

describeUnixSocket("retireGlobalDaemon", () => {
	it("sends retire and resolves true", async () => {
		const socketPath = join(scratch, "d.sock");
		const daemon = await fakeDaemon(socketPath, "1.0.0");

		await expect(retireGlobalDaemon({ socketPath })).resolves.toBe(true);
		await vi.waitFor(() => expect(daemon.greetings).toEqual([JSON.stringify({ t: "retire" })]));
	});

	it("resolves false when nothing is listening", async () => {
		const socketPath = join(scratch, "d.sock");

		await expect(retireGlobalDaemon({ socketPath })).resolves.toBe(false);
	});

	it("falls back to a derived socket path when no deps are supplied", async () => {
		// Exercises both the default `deps` parameter and its `socketPath` `??`
		// fallback, against a scratch path rather than this machine's real global
		// socket — a real daemon may be bound there, and `retireGlobalDaemon` must
		// never send it a `retire` it never asked for.
		const fallbackPath = join(scratch, "fallback.sock");
		vi.mocked(globalSocketPath).mockReturnValueOnce(fallbackPath);

		await expect(retireGlobalDaemon()).resolves.toBe(false);
	});

	it("resolves false when connect() itself throws", async () => {
		// A throw inside tryConnect's Promise executor rejects the promise it
		// returns, which is the only way to drive retireGlobalDaemon's own
		// catch — `tryConnect` otherwise guarantees it never rejects.
		vi.mocked(connect).mockImplementationOnce(() => {
			throw new Error("boom");
		});

		await expect(retireGlobalDaemon({ socketPath: join(scratch, "d.sock") })).resolves.toBe(false);
	});
});

describeUnixSocket("probeGlobalDaemon", () => {
	it("reads a running daemon's hello without disturbing it", async () => {
		const socketPath = join(scratch, "d.sock");
		const daemon = await fakeDaemon(socketPath, "0.99.3");

		await expect(probeGlobalDaemon(socketPath)).resolves.toEqual({
			t: "hello",
			protocol: GLOBAL_DAEMON_PROTOCOL,
			version: "0.99.3",
			pid: 999,
			startedAt: 1,
		});
		// A read-only probe for `doctor`: it must never send `retire` or anything
		// else — the daemon it just inspected has to keep running afterwards.
		expect(daemon.greetings).toEqual([]);
	});

	it("resolves undefined when nothing is listening", async () => {
		const socketPath = join(scratch, "d.sock");

		await expect(probeGlobalDaemon(socketPath)).resolves.toBeUndefined();
	});

	it("resolves undefined when the peer closes before sending hello", async () => {
		const socketPath = join(scratch, "d.sock");
		// Closes the connection immediately rather than going silent forever, so
		// this drives the same "no hello" outcome as a busy/foreign peer without
		// the test itself waiting out the probe's 5s read budget.
		const server = createServer((socket) => socket.end());
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));

		await expect(probeGlobalDaemon(socketPath)).resolves.toBeUndefined();
	});

	it("resolves undefined when connect() itself throws", async () => {
		vi.mocked(connect).mockImplementationOnce(() => {
			throw new Error("boom");
		});

		await expect(probeGlobalDaemon(join(scratch, "d.sock"))).resolves.toBeUndefined();
	});

	it("falls back to a derived socket path when none is supplied", async () => {
		// Same reasoning as `retireGlobalDaemon`'s equivalent test: redirect the
		// `??` fallback to a scratch path so this read-only probe cannot land on a
		// real daemon this machine happens to have running.
		const fallbackPath = join(scratch, "fallback.sock");
		vi.mocked(globalSocketPath).mockReturnValueOnce(fallbackPath);

		await expect(probeGlobalDaemon()).resolves.toBeUndefined();
	});
});
