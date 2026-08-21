import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareMcpRuntime = vi.fn();
const createMcpServer = vi.fn();
const rebuildPlatformHalf = vi.fn();

vi.mock("./McpServer.js", () => ({
	prepareMcpRuntime: (...args: unknown[]) => prepareMcpRuntime(...args),
	createMcpServer: (...args: unknown[]) => createMcpServer(...args),
	rebuildPlatformHalf: (...args: unknown[]) => rebuildPlatformHalf(...args),
	isPluginBundleCwd: () => false,
	startMcpServer: vi.fn(),
}));

// Only the ownership gate is faked; every other protocol helper stays real so
// the tests exercise the actual framing.
const isManagedSocketDirSafe = vi.fn(() => true);
vi.mock("./McpDaemonProtocol.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./McpDaemonProtocol.js")>()),
	isManagedSocketDirSafe: () => isManagedSocketDirSafe(),
}));

const { runMcpDaemon } = await import("./McpDaemon.js");
const {
	encodeHandshakeLine,
	MCP_DAEMON_PROTOCOL,
	mcpSocketPath,
	parseDaemonHello,
	parseRetireAnswer,
	readHandshakeLine,
} = await import("./McpDaemonProtocol.js");

const CWD = "/repo/worktree";

/**
 * Every suite below binds a real listener at a FILESYSTEM path, which Windows
 * cannot do: its local-domain transport is named pipes, so `listen()` on
 * `<tmpdir>/d.sock` fails — and because these suites await `onListening`, which
 * the error path never fires, the failure presents as a HANG rather than a red
 * test. CI is ubuntu-only, so nothing catches it; a Windows contributor running
 * `npm run all` just watches it stop.
 *
 * Skipping is a stopgap, not the answer. Real Windows coverage needs the harness
 * to bind `\\.\pipe\<unique>` instead, plus separate handling for the two suites
 * whose subject is unix-only anyway (the socket-directory ownership gate, which
 * short-circuits to "safe" on win32, and the on-exit unlink, which has no file to
 * remove). Doing that blind — with no Windows machine to run it on — would only
 * trade a known hang for an unknown one.
 */
const describeUnixSocket = describe.skipIf(process.platform === "win32");

let dir: string;
let socketPath: string;
/** Sockets and servers opened by a test, torn down unconditionally afterwards. */
let openSockets: Socket[];
let openServers: NetServer[];

/** A stand-in for the ~100 MB runtime the daemon exists to share. */
function fakeRuntime(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		cwd: CWD,
		toolDefinitions: [],
		platformByName: new Map(),
		menu: [],
		platformDegraded: false,
		...overrides,
	};
}

/** An MCP `Server` double that records the transport it was connected to. */
function fakeMcpServer(): { connect: ReturnType<typeof vi.fn> } {
	return { connect: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(async () => {
	openSockets = [];
	openServers = [];
	dir = await mkdtemp(join(tmpdir(), "jolli-mcp-daemon-"));
	socketPath = join(dir, "d.sock");
	prepareMcpRuntime.mockReset().mockResolvedValue(fakeRuntime());
	createMcpServer.mockReset().mockImplementation(() => fakeMcpServer());
	rebuildPlatformHalf.mockReset().mockResolvedValue(fakeRuntime());
	isManagedSocketDirSafe.mockReset().mockReturnValue(true);
});

afterEach(async () => {
	for (const s of openSockets) s.destroy();
	for (const s of openServers) await new Promise<void>((r) => s.close(() => r()));
	await rm(dir, { recursive: true, force: true });
});

/** Starts the daemon and resolves once it is listening, keeping the run promise. */
async function startDaemon(
	overrides: Record<string, unknown> = {},
): Promise<{ done: Promise<string>; socketPath: string }> {
	let ready: () => void = () => {};
	const listening = new Promise<void>((r) => {
		ready = r;
	});
	const done = runMcpDaemon({
		cwd: CWD,
		socketPath,
		idleTimeoutMs: 50,
		firstClientTimeoutMs: 5000,
		onListening: () => ready(),
		...overrides,
	}) as Promise<string>;
	// Race the listen against the run promise so a daemon that exits before
	// binding (refused / address-in-use) fails the test instead of hanging it.
	await Promise.race([listening, done]);
	return { done, socketPath };
}

/** Connects a client and reads the daemon's hello line. */
async function connectClient(
	path = socketPath,
): Promise<{ socket: Socket; hello: ReturnType<typeof parseDaemonHello> }> {
	const socket = connect(path);
	openSockets.push(socket);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", () => resolve());
		socket.once("error", reject);
	});
	const first = await readHandshakeLine(socket);
	return { socket, hello: first ? parseDaemonHello(first.line) : undefined };
}

/** Ends a long-lived test daemon without waiting for its idle reap timeout. */
async function retireDaemon(done: Promise<string>): Promise<void> {
	const { socket } = await connectClient();
	socket.write(encodeHandshakeLine({ t: "retire" }));
	await expect(done).resolves.toBe("retired");
}

describeUnixSocket("runMcpDaemon — refusal", () => {
	it("binds NO socket when a cwd guard declines the directory", async () => {
		// A bound-then-refusing daemon would look reachable to every future proxy,
		// which would attach and get nothing. Leaving no socket is what makes the
		// proxy's documented in-process fallback the outcome instead.
		prepareMcpRuntime.mockResolvedValue(undefined);
		await expect(runMcpDaemon({ cwd: CWD, socketPath })).resolves.toBe("refused");
		expect(existsSync(socketPath)).toBe(false);
	});

	it("runs the guards BEFORE binding, not after a client connects", async () => {
		prepareMcpRuntime.mockResolvedValue(undefined);
		await runMcpDaemon({ cwd: CWD, socketPath });
		expect(prepareMcpRuntime).toHaveBeenCalledWith(CWD, {});
	});
});

describeUnixSocket("runMcpDaemon — socket directory safety", () => {
	it("refuses to bind in a directory that is not exclusively this user's", async () => {
		// On a shared /tmp another user can win the race to create the directory,
		// and a socket bound inside one they control would let them answer this
		// repo's recall/status calls. The proxy's fallback makes refusing cheap.
		isManagedSocketDirSafe.mockReturnValue(false);
		await expect(runMcpDaemon({ cwd: CWD, firstClientTimeoutMs: 50 })).resolves.toBe("unsafe-socket-dir");
	});

	it("applies the gate to an explicitly supplied path INSIDE the managed directory", async () => {
		// The production case, and the one the first version missed: the proxy
		// ALWAYS spawns the daemon with `--socket`, and the path it supplies is the
		// derived one. Keying the gate on "did the caller supply a path" therefore
		// made it dead code — the shared-/tmp protection existed only in the
		// docstring. The gate follows the PATH now.
		isManagedSocketDirSafe.mockReturnValue(false);
		await expect(
			runMcpDaemon({ cwd: CWD, socketPath: mcpSocketPath(CWD), firstClientTimeoutMs: 50 }),
		).resolves.toBe("unsafe-socket-dir");
	});

	it("does NOT apply the gate to a path outside the managed directory", async () => {
		// A caller that chose its own location has taken responsibility for it;
		// second-guessing would reject any scratch dir not created 0700.
		isManagedSocketDirSafe.mockReturnValue(false);
		const { done } = await startDaemon({ firstClientTimeoutMs: 30, idleTimeoutMs: 30 });
		await expect(done).resolves.toBe("no-first-client");
	});
});

describeUnixSocket("runMcpDaemon — handshake", () => {
	it("greets a new client with its protocol, version, pid and cwd", async () => {
		const { done } = await startDaemon();
		const { hello, socket } = await connectClient();
		expect(hello).toMatchObject({ protocol: MCP_DAEMON_PROTOCOL, pid: process.pid, cwd: CWD });
		expect(typeof hello?.version).toBe("string");
		socket.destroy();
		await done;
	});

	it("speaks FIRST, so the proxy can judge the version before committing", async () => {
		// The daemon greets unprompted: the alternative (proxy announces, daemon
		// judges) would put the retire decision in the process being retired.
		const { done } = await startDaemon();
		const socket = connect(socketPath);
		openSockets.push(socket);
		const first = await readHandshakeLine(socket);
		expect(parseDaemonHello(first?.line ?? "")).toBeDefined();
		socket.destroy();
		await done;
	});

	it("builds one MCP server per CONNECTION over one shared runtime", async () => {
		// The whole design: `prepareMcpRuntime` once, `createMcpServer` per client,
		// because each MCP client runs its own initialize handshake.
		const { done } = await startDaemon();
		const a = await connectClient();
		a.socket.write(encodeHandshakeLine({ t: "attach" }));
		const b = await connectClient();
		b.socket.write(encodeHandshakeLine({ t: "attach" }));
		await vi.waitFor(() => expect(createMcpServer).toHaveBeenCalledTimes(2));
		expect(prepareMcpRuntime).toHaveBeenCalledTimes(1);
		expect(createMcpServer).toHaveBeenNthCalledWith(1, expect.objectContaining({ cwd: CWD }));
		a.socket.destroy();
		b.socket.destroy();
		await done;
	});

	it("does not lose MCP bytes that arrive in the SAME chunk as the greeting", async () => {
		// The reason the rest-of-buffer is replayed into a PassThrough instead of
		// `socket.unshift`: the socket is in flowing mode during the handshake, where
		// unshift is a documented no-op-with-loss. A client that pipelines its
		// `initialize` behind `attach` must still be understood.
		const { done } = await startDaemon({ idleTimeoutMs: 5000 });
		const { socket } = await connectClient();
		let transportInput: NodeJS.ReadableStream | undefined;
		createMcpServer.mockImplementation(() => ({
			connect: vi.fn(async (transport: { _stdin?: NodeJS.ReadableStream }) => {
				transportInput = transport._stdin;
			}),
		}));

		socket.write(`${encodeHandshakeLine({ t: "attach" })}{"jsonrpc":"2.0","id":1}\n`);
		await vi.waitFor(() => expect(transportInput).toBeDefined());
		const seen = await new Promise<string>((resolve) => {
			transportInput?.once("data", (chunk: Buffer) => resolve(chunk.toString()));
		});
		expect(seen).toContain('{"jsonrpc":"2.0","id":1}');

		socket.destroy();
		await retireDaemon(done);
	});

	it("drops a client that sends an unrecognised greeting, and keeps serving", async () => {
		const { done } = await startDaemon({ idleTimeoutMs: 5000 });
		const bad = await connectClient();
		bad.socket.write('{"t":"shutdown"}\n');
		await vi.waitFor(() => expect(bad.socket.destroyed || bad.socket.readableEnded).toBe(true));
		// The daemon must still be reachable for a well-behaved client.
		const good = await connectClient();
		expect(good.hello).toBeDefined();
		good.socket.destroy();
		await retireDaemon(done);
	});
});

describeUnixSocket("runMcpDaemon — degraded platform tools", () => {
	it("does NOT re-fetch the manifest on the normal path", async () => {
		// The shared runtime is the whole point; a per-connection network call
		// would give part of it back for nothing.
		const { done } = await startDaemon();
		const { socket } = await connectClient();
		socket.write(encodeHandshakeLine({ t: "attach" }));
		await vi.waitFor(() => expect(createMcpServer).toHaveBeenCalled());
		expect(rebuildPlatformHalf).not.toHaveBeenCalled();
		socket.destroy();
		await done;
	});

	it("retries the platform half when a fetch failed, and keeps the recovery", async () => {
		// A best-effort manifest fetch that blipped used to cost one session its
		// platform tools. Cached in a daemon it would cost EVERY session on the
		// worktree until the daemon reaps, with nothing in tools/list to say so.
		prepareMcpRuntime.mockResolvedValue(fakeRuntime({ platformDegraded: true }));
		const recovered = fakeRuntime({ toolDefinitions: [{ name: "platform_tool" }] });
		rebuildPlatformHalf.mockResolvedValue(recovered);

		const { done } = await startDaemon({ idleTimeoutMs: 5000 });
		const first = await connectClient();
		first.socket.write(encodeHandshakeLine({ t: "attach" }));
		await vi.waitFor(() => expect(createMcpServer).toHaveBeenCalledWith(recovered));

		// Second client must NOT trigger another fetch — the retry succeeded.
		const second = await connectClient();
		second.socket.write(encodeHandshakeLine({ t: "attach" }));
		await vi.waitFor(() => expect(createMcpServer).toHaveBeenCalledTimes(2));
		expect(rebuildPlatformHalf).toHaveBeenCalledTimes(1);

		first.socket.destroy();
		second.socket.destroy();
		await retireDaemon(done);
	});

	it("still serves the built-ins when the retry itself fails", async () => {
		// The manifest is an enhancement; refusing the connection over it would
		// turn a degraded server into no server.
		const degraded = fakeRuntime({ platformDegraded: true });
		prepareMcpRuntime.mockResolvedValue(degraded);
		rebuildPlatformHalf.mockRejectedValue(new Error("network down"));

		const { done } = await startDaemon({ idleTimeoutMs: 5000 });
		const { socket } = await connectClient();
		socket.write(encodeHandshakeLine({ t: "attach" }));
		await vi.waitFor(() => expect(createMcpServer).toHaveBeenCalledWith(degraded));
		socket.destroy();
		await retireDaemon(done);
	});

	it("logs a non-Error rejection from the platform retry without a `.message`", async () => {
		// The handler formats the reason for debug.log — a thrown string (or any
		// non-Error) has no `.message`, and assuming one would print `undefined`.
		const degraded = fakeRuntime({ platformDegraded: true });
		prepareMcpRuntime.mockResolvedValue(degraded);
		rebuildPlatformHalf.mockRejectedValue("plain string failure");

		const { done } = await startDaemon({ idleTimeoutMs: 5000 });
		const { socket } = await connectClient();
		socket.write(encodeHandshakeLine({ t: "attach" }));
		await vi.waitFor(() => expect(createMcpServer).toHaveBeenCalledWith(degraded));
		socket.destroy();
		await retireDaemon(done);
	});

	it("keeps serving the built-ins when the retry succeeds but is STILL degraded", async () => {
		// A retry that resolves without throwing is not the same as a retry that
		// fixed anything: a repeated network blip can answer a second empty
		// manifest without ever rejecting. `refreshIfDegraded` must not log a
		// bogus "recovered" line for that case.
		const degraded = fakeRuntime({ platformDegraded: true });
		prepareMcpRuntime.mockResolvedValue(degraded);
		const stillDegraded = fakeRuntime({ platformDegraded: true, toolDefinitions: [] });
		rebuildPlatformHalf.mockResolvedValue(stillDegraded);

		const { done } = await startDaemon({ idleTimeoutMs: 5000 });
		const { socket } = await connectClient();
		socket.write(encodeHandshakeLine({ t: "attach" }));
		await vi.waitFor(() => expect(createMcpServer).toHaveBeenCalledWith(stillDegraded));
		socket.destroy();
		await retireDaemon(done);
	});
});

describeUnixSocket("runMcpDaemon — uid resolution", () => {
	it("falls back to uid 0 when process.getuid is unavailable, as on Windows", async () => {
		const original = process.getuid;
		process.getuid = undefined;
		try {
			// A path OUTSIDE the managed directory so the fallback's actual value
			// cannot change the outcome — only that the line runs without throwing.
			const { done } = await startDaemon({ firstClientTimeoutMs: 30, idleTimeoutMs: 30 });
			await expect(done).resolves.toBe("no-first-client");
		} finally {
			process.getuid = original;
		}
	});
});

describeUnixSocket("runMcpDaemon — reaping", () => {
	it("exits 'idle' once its last client leaves", async () => {
		const { done } = await startDaemon({ idleTimeoutMs: 30 });
		const { socket } = await connectClient();
		socket.write(encodeHandshakeLine({ t: "attach" }));
		await vi.waitFor(() => expect(createMcpServer).toHaveBeenCalled());
		socket.destroy();
		await expect(done).resolves.toBe("idle");
	});

	it("removes the socket file on the way out so the next listen() is clean", async () => {
		// A unix socket path is a real directory entry that outlives its process; a
		// leftover one makes the next bind fail EADDRINUSE.
		const { done } = await startDaemon({ idleTimeoutMs: 20, firstClientTimeoutMs: 20 });
		await done;
		expect(existsSync(socketPath)).toBe(false);
	});

	it("exits 'no-first-client' when the proxy that spawned it never arrives", async () => {
		// Distinct from idle: nobody is coming, and there is no warm runtime worth
		// preserving yet.
		const { done } = await startDaemon({ firstClientTimeoutMs: 20, idleTimeoutMs: 60_000 });
		await expect(done).resolves.toBe("no-first-client");
	});

	it("does not reap while a client is still attached", async () => {
		const { done } = await startDaemon({ idleTimeoutMs: 30, firstClientTimeoutMs: 30 });
		const { socket } = await connectClient();
		socket.write(encodeHandshakeLine({ t: "attach" }));
		await new Promise((r) => setTimeout(r, 150));
		expect(socket.destroyed).toBe(false);
		socket.destroy();
		await done;
	});
});

describeUnixSocket("runMcpDaemon — retirement", () => {
	it("stops accepting new connections once asked to retire", async () => {
		// The dist-upgrade criterion: an old daemon must not keep serving new
		// sessions after a newer bundle has taken over.
		const { done } = await startDaemon({ idleTimeoutMs: 60_000 });
		const { socket } = await connectClient();
		socket.write(encodeHandshakeLine({ t: "retire" }));
		await expect(done).resolves.toBe("retired");
		await expect(connectClient()).rejects.toThrow();
	});

	it("lets an already-attached session finish rather than killing it", async () => {
		// Retirement is a hand-off, not a kill: an in-flight tool call on the old
		// daemon still completes.
		const { done } = await startDaemon({ idleTimeoutMs: 60_000 });
		const worker = await connectClient();
		worker.socket.write(encodeHandshakeLine({ t: "attach" }));
		await vi.waitFor(() => expect(createMcpServer).toHaveBeenCalled());

		const upgrader = await connectClient();
		upgrader.socket.write(encodeHandshakeLine({ t: "retire" }));
		// Give retirement time to unbind; the attached worker must survive it.
		await new Promise((r) => setTimeout(r, 100));
		expect(worker.socket.destroyed).toBe(false);

		worker.socket.destroy();
		await expect(done).resolves.toBe("retired");
	});

	it("exits immediately after retiring rather than waiting out the idle window", async () => {
		const { done } = await startDaemon({ idleTimeoutMs: 60_000 });
		const { socket } = await connectClient();
		socket.write(encodeHandshakeLine({ t: "retire" }));
		// Resolving at all proves it did not wait 60 s for the idle timer.
		await expect(done).resolves.toBe("retired");
	});

	it("leaves the SUCCESSOR's socket alone when its own last call finally drains", async () => {
		// The retiring daemon frees the path the instant it is asked to stand down
		// (`close()` unlinks synchronously) and only FINISHES seconds later, when its
		// last in-flight call drains. The successor binds a new file at the same path
		// in between, so anything path-based this daemon does on the way out deletes
		// THEIRS: the successor stays `listening` where nothing can reach it, every
		// later proxy spawns yet another daemon, and the unreachable one holds its
		// ~100 MB to its idle reap — this module's own waste, once per upgrade.
		const { done } = await startDaemon({ idleTimeoutMs: 60_000 });
		const worker = await connectClient();
		worker.socket.write(encodeHandshakeLine({ t: "attach" }));
		await vi.waitFor(() => expect(createMcpServer).toHaveBeenCalled());

		const upgrader = await connectClient();
		upgrader.socket.write(encodeHandshakeLine({ t: "retire" }));
		// Wait for the unbind rather than for a duration: it is what frees the path,
		// so this reproduces the real ordering instead of approximating it.
		await vi.waitFor(() => expect(existsSync(socketPath)).toBe(false));

		const successor = createServer();
		openServers.push(successor);
		await new Promise<void>((r) => successor.listen(socketPath, () => r()));

		worker.socket.destroy();
		await expect(done).resolves.toBe("retired");
		// `done` resolving is NOT the last thing the old daemon does — a pending
		// close-callback can still fire after it. An assertion taken at that instant
		// passes on timing luck: it is exactly what hid this bug behind a first
		// attempt at fixing it. Settle, then assert REACHABILITY, since surviving as
		// a directory entry is not the property that matters.
		await new Promise((r) => setTimeout(r, 200));
		expect(existsSync(socketPath)).toBe(true);
		const probe = connect(socketPath);
		openSockets.push(probe);
		await new Promise<void>((resolve, reject) => {
			probe.once("connect", () => resolve());
			probe.once("error", reject);
		});
	});
});

/**
 * Retirement when the address CANNOT be handed over — the Windows case.
 *
 * `platform: "win32"` is injected rather than detected: the behaviour under test
 * is decided by who owns a named pipe's name, but the transport here is a unix
 * socket, because that is the only kind this suite (and this project's CI) can
 * bind. So these cases pin the DECISION and its consequences for the daemon's
 * lifecycle; that a real pipe name behaves as `canReleaseAddress` claims is a
 * platform fact this harness cannot demonstrate.
 */
describeUnixSocket("runMcpDaemon — retirement it cannot honour", () => {
	it("answers retire-deferred instead of pretending the address was released", async () => {
		// Silence means "released" on this wire, and a proxy that believes it will
		// spawn a successor that cannot bind. On Windows that cost the session 15 s of
		// polling a daemon that had already died, then a full in-process server.
		const { done } = await startDaemon({ idleTimeoutMs: 60_000, platform: "win32" });
		const worker = await connectClient();
		worker.socket.write(encodeHandshakeLine({ t: "attach" }));
		await vi.waitFor(() => expect(createMcpServer).toHaveBeenCalled());

		const upgrader = await connectClient();
		upgrader.socket.write(encodeHandshakeLine({ t: "retire" }));
		const answer = await readHandshakeLine(upgrader.socket);
		expect(answer && parseRetireAnswer(answer.line)).toEqual({ t: "retire-deferred" });

		worker.socket.destroy();
		await expect(done).resolves.toBe("retired");
	});

	it("keeps its listener bound, since closing it would help nobody", async () => {
		// The pipe name survives on its clients' instances either way, so unbinding
		// would only strand the sessions still attached — while the successor STILL
		// could not bind. Staying reachable is what lets same-version sessions keep
		// sharing this daemon until it drains.
		const { done } = await startDaemon({ idleTimeoutMs: 60_000, platform: "win32" });
		const worker = await connectClient();
		worker.socket.write(encodeHandshakeLine({ t: "attach" }));
		await vi.waitFor(() => expect(createMcpServer).toHaveBeenCalled());

		const upgrader = await connectClient();
		upgrader.socket.write(encodeHandshakeLine({ t: "retire" }));
		await readHandshakeLine(upgrader.socket);

		const late = await connectClient();
		expect(late.hello?.t).toBe("hello");

		late.socket.destroy();
		worker.socket.destroy();
		await expect(done).resolves.toBe("retired");
	});

	it("still exits once the clients that held the address drain", async () => {
		// Deferring must not become "never": the superseded runtime has to leave, or
		// the upgrade never completes on that worktree.
		const { done } = await startDaemon({ idleTimeoutMs: 60_000, platform: "win32" });
		const worker = await connectClient();
		worker.socket.write(encodeHandshakeLine({ t: "attach" }));
		await vi.waitFor(() => expect(createMcpServer).toHaveBeenCalled());
		const upgrader = await connectClient();
		upgrader.socket.write(encodeHandshakeLine({ t: "retire" }));
		await readHandshakeLine(upgrader.socket);

		worker.socket.destroy();
		await expect(done).resolves.toBe("retired");
	});

	it("answers a SECOND retire request while already deferring", async () => {
		// Two proxies can arrive in a row — a session per host, or a bundle newer
		// still than the one that asked first. Since silence means "released" on this
		// wire, skipping the answer for the second would send that proxy off to bind
		// an address we are demonstrably still holding, which is the original bug with
		// one more step in front of it.
		const { done } = await startDaemon({ idleTimeoutMs: 60_000, platform: "win32" });
		const worker = await connectClient();
		worker.socket.write(encodeHandshakeLine({ t: "attach" }));
		await vi.waitFor(() => expect(createMcpServer).toHaveBeenCalled());

		for (let attempt = 0; attempt < 2; attempt++) {
			const upgrader = await connectClient();
			upgrader.socket.write(encodeHandshakeLine({ t: "retire" }));
			const answer = await readHandshakeLine(upgrader.socket);
			expect(answer && parseRetireAnswer(answer.line)).toEqual({ t: "retire-deferred" });
		}

		worker.socket.destroy();
		await expect(done).resolves.toBe("retired");
	});

	it("hands the address over normally when the requester is its only client", async () => {
		// The idle handover, which already works on Windows: the sole instance of the
		// name is the retire request about to close, so the name frees in
		// milliseconds and the successor binds the SAME generation. Deferring here
		// would push every upgrade onto a new address for no reason.
		const { done } = await startDaemon({ idleTimeoutMs: 60_000, platform: "win32" });
		const { socket } = await connectClient();
		socket.write(encodeHandshakeLine({ t: "retire" }));
		expect(await readHandshakeLine(socket)).toBeUndefined();
		await expect(done).resolves.toBe("retired");
	});

	it("releases the address on unix even with other clients attached", async () => {
		// The measured unix property this whole mechanism exists to work around:
		// `close()` unlinks at once and the attached worker keeps being served, so
		// there is nothing to defer and the wire stays byte-identical to before.
		const { done } = await startDaemon({ idleTimeoutMs: 60_000 });
		const worker = await connectClient();
		worker.socket.write(encodeHandshakeLine({ t: "attach" }));
		await vi.waitFor(() => expect(createMcpServer).toHaveBeenCalled());

		const upgrader = await connectClient();
		upgrader.socket.write(encodeHandshakeLine({ t: "retire" }));
		expect(await readHandshakeLine(upgrader.socket)).toBeUndefined();
		await vi.waitFor(() => expect(existsSync(socketPath)).toBe(false));

		worker.socket.destroy();
		await expect(done).resolves.toBe("retired");
	});
});

describeUnixSocket("runMcpDaemon — a failing client", () => {
	it("keeps serving everyone else when one client's attach rejects", async () => {
		// Without a `.catch` on the connection promise this is an UNHANDLED
		// rejection, and Node's default for that is to terminate the process — so a
		// single client's failed setup takes down the MCP server of every other
		// session on the worktree, from a detached daemon whose stdio is ignored.
		const { done } = await startDaemon();

		// Attached FIRST, and kept attached: it is the other session whose server
		// the crash must not take with it, and holding the connection count above
		// zero also keeps the idle reap out of the measurement.
		const survivor = await connectClient();
		survivor.socket.write(encodeHandshakeLine({ t: "attach" }));
		await vi.waitFor(() => expect(createMcpServer).toHaveBeenCalledTimes(1));

		createMcpServer.mockImplementationOnce(() => {
			throw new Error("transport setup blew up");
		});
		const doomed = await connectClient();
		doomed.socket.write(encodeHandshakeLine({ t: "attach" }));
		await vi.waitFor(() => expect(doomed.socket.destroyed).toBe(true));

		expect(survivor.socket.destroyed).toBe(false);
		// The listener has to have survived too, not just the process.
		const later = await connectClient();
		expect(later.hello).toBeDefined();

		later.socket.destroy();
		survivor.socket.destroy();
		await done;
	});

	it("survives a non-Error throw, which has no `.message` to log", async () => {
		// The handler formats the reason for debug.log — the daemon's only trace —
		// and a thrown string would make that read `undefined` if it assumed Error.
		createMcpServer.mockImplementationOnce(() => {
			throw "plain string failure";
		});
		const { done } = await startDaemon();
		const doomed = await connectClient();
		doomed.socket.write(encodeHandshakeLine({ t: "attach" }));
		await vi.waitFor(() => expect(doomed.socket.destroyed).toBe(true));
		await done;
	});
});

describeUnixSocket("runMcpDaemon — bind race", () => {
	it("reports 'address-in-use' rather than throwing when a sibling won", async () => {
		// Losing the race is the SUCCESS case from the proxy's point of view: a
		// server for this worktree exists, which is all it wanted.
		const incumbent = createServer();
		openServers.push(incumbent);
		await new Promise<void>((r) => incumbent.listen(socketPath, () => r()));
		await expect(runMcpDaemon({ cwd: CWD, socketPath, firstClientTimeoutMs: 50 })).resolves.toBe("address-in-use");
	});

	it("reports 'listen-failed' for a bind it cannot even attempt", async () => {
		await expect(
			runMcpDaemon({ cwd: CWD, socketPath: join(dir, "no", "such", "\0bad"), firstClientTimeoutMs: 50 }),
		).resolves.toBe("listen-failed");
	});
});
