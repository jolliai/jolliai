import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isPluginBundleCwd = vi.fn<(cwd: string) => boolean>(() => false);
// Mocked at the LEAF module, which is where the proxy now imports it from —
// reaching into McpServer for this one predicate is what used to drag the whole
// server into the proxy's import graph.
vi.mock("./McpCwdGuard.js", () => ({
	isPluginBundleCwd: (cwd: string) => isPluginBundleCwd(cwd),
}));

const isLocalAgentChild = vi.fn(() => false);
vi.mock("../core/AgentReentry.js", () => ({
	isLocalAgentChild: (...args: unknown[]) => isLocalAgentChild(...(args as [])),
}));

// Only the ownership gate is faked; every other protocol helper stays real, so
// the handshake framing and the socket-path derivation under test are the
// actual ones.
const isManagedSocketDirSafe = vi.fn(() => true);
vi.mock("./McpDaemonProtocol.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./McpDaemonProtocol.js")>()),
	isManagedSocketDirSafe: () => isManagedSocketDirSafe(),
}));

// Only the OS-level spawn is stubbed, so the argv the proxy builds for its
// daemon is asserted for real. Every other test in this file injects
// `spawnDaemon` and never reaches this.
const spawnHidden = vi.fn(() => ({ pid: 4242, unref: vi.fn() }));
vi.mock("../util/Subprocess.js", () => ({ spawnHidden: (...args: unknown[]) => spawnHidden(...(args as [])) }));

// The real resolver answers `undefined` under `vitest`, which runs from the
// source tree where no `Cli.js` sits beside the proxy. The resolution rule
// itself is covered by `util/CliEntry.test.ts`.
vi.mock("../util/CliEntry.js", () => ({ resolveCliEntry: () => "/opt/jolli/dist/Cli.js" }));

const { runMcpProxy } = await import("./McpProxy.js");
const {
	cliCoreVersion,
	encodeHandshakeLine,
	ensureSocketParentDir,
	MCP_DAEMON_PROTOCOL,
	mcpSocketPath,
	parseClientGreeting,
	readHandshakeLine,
} = await import("./McpDaemonProtocol.js");

const CWD = "/repo/worktree";

/**
 * Windows cannot bind a listener at a filesystem path — see the same constant in
 * `McpDaemon.test.ts` for the full reasoning and what real Windows coverage
 * would take. The import-graph suite below is exempt: it only reads source text.
 */
const describeUnixSocket = describe.skipIf(process.platform === "win32");

let dir: string;
let socketPath: string;
let servers: NetServer[];
let sockets: Socket[];

interface FakeDaemon {
	readonly server: NetServer;
	/** Greetings the fake received, in order — `attach` / `retire`. */
	readonly greetings: string[];
	/** Bytes the proxy forwarded from stdin. */
	readonly received: string[];
}

/**
 * A daemon stand-in: greets, records the proxy's answer, and on `attach` echoes
 * everything back with an `echo:` prefix so both directions can be asserted.
 */
async function startFakeDaemon(
	options: { version?: string; cwd?: string; hello?: string; path?: string; deferRetire?: boolean } = {},
): Promise<FakeDaemon> {
	const greetings: string[] = [];
	const received: string[] = [];
	const server = createServer((socket) => {
		sockets.push(socket);
		socket.write(
			options.hello ??
				encodeHandshakeLine({
					t: "hello",
					protocol: MCP_DAEMON_PROTOCOL,
					version: options.version ?? cliCoreVersion(),
					pid: 4242,
					cwd: options.cwd ?? CWD,
				}),
		);
		void readHandshakeLine(socket).then((first) => {
			const greeting = first ? parseClientGreeting(first.line) : undefined;
			greetings.push(greeting?.t ?? "unparsed");
			if (greeting?.t !== "attach") {
				// A daemon that cannot give up its address says so and STAYS BOUND —
				// the Windows case, where the pipe name lives on its clients'
				// instances. Its listener must remain reachable, or the test could not
				// tell "moved to the next generation" from "the address freed up".
				if (greeting?.t === "retire" && options.deferRetire) {
					socket.end(encodeHandshakeLine({ t: "retire-deferred" }));
					return;
				}
				socket.end();
				// Mirror the real daemon: a retire request unbinds the listener, so
				// the proxy's next round finds the address quiet. Without this the
				// fake would keep accepting and the test could not tell a working
				// hand-off from the retire-loop bug it exists to catch.
				if (greeting?.t === "retire") server.close();
				return;
			}
			socket.on("data", (chunk: Buffer) => {
				received.push(chunk.toString());
				socket.write(`echo:${chunk.toString()}`);
			});
		});
	});
	servers.push(server);
	await new Promise<void>((r) => server.listen(options.path ?? socketPath, () => r()));
	return { server, greetings, received };
}

beforeEach(async () => {
	servers = [];
	sockets = [];
	dir = await mkdtemp(join(tmpdir(), "jolli-mcp-proxy-"));
	socketPath = join(dir, "d.sock");
	isPluginBundleCwd.mockReturnValue(false);
	isLocalAgentChild.mockReturnValue(false);
	isManagedSocketDirSafe.mockReturnValue(true);
});

afterEach(async () => {
	for (const s of sockets) s.destroy();
	for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
	await rm(dir, { recursive: true, force: true });
});

describeUnixSocket("runMcpProxy — cwd guards", () => {
	it.each([
		["a local-agent child", () => isLocalAgentChild.mockReturnValue(true)],
		["a plugin-bundle cwd", () => isPluginBundleCwd.mockReturnValue(true)],
	])("refuses without spawning a daemon for %s", async (_label, arrange) => {
		// A refused cwd must not leave a daemon behind: the guards are consulted
		// here only to skip a spawn that would immediately refuse anyway.
		arrange();
		const spawnDaemon = vi.fn();
		const fallback = vi.fn().mockResolvedValue(undefined);
		await expect(runMcpProxy({ cwd: CWD, socketPath, spawnDaemon, fallback })).resolves.toBe("refused");
		expect(spawnDaemon).not.toHaveBeenCalled();
		expect(fallback).toHaveBeenCalledWith(CWD);
	});

	it("refuses without spawning a daemon when the cwd is not a git worktree root", async () => {
		// Measured on a real machine: VS Code Copilot Chat's user-profile MCP entry
		// is spawned with cwd `/`, so `resolveProjectDir` falls back to
		// `process.cwd()` and every such session hashes to the SAME key — one
		// daemon serving a directory that is not a repository. A daemon is keyed on
		// a worktree root by construction (five of the ten tools are branch- or
		// worktree-scoped), so anything else must serve in-process instead.
		const spawnDaemon = vi.fn();
		const fallback = vi.fn().mockResolvedValue(undefined);
		await expect(runMcpProxy({ cwd: "/", socketPath, spawnDaemon, fallback, isWorktreeRoot: false })).resolves.toBe(
			"refused",
		);
		expect(spawnDaemon).not.toHaveBeenCalled();
		expect(fallback).toHaveBeenCalledWith("/");
	});

	it("explains on stderr why a non-repo cwd gets no daemon", async () => {
		// The host's MCP server log (VS Code's output channel) is the only surface a
		// user can see this on, and silence is what kept the defect alive: a server
		// that starts cleanly and answers every memory tool with nothing.
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			await runMcpProxy({
				cwd: "/",
				socketPath,
				spawnDaemon: vi.fn(),
				fallback: vi.fn().mockResolvedValue(undefined),
				isWorktreeRoot: false,
			});
			expect(stderr).toHaveBeenCalledTimes(1);
			expect(String(stderr.mock.calls[0]?.[0])).toContain("not a git repository");
		} finally {
			stderr.mockRestore();
		}
	});

	it.each([
		["a local-agent child", () => isLocalAgentChild.mockReturnValue(true)],
		["a plugin-bundle cwd", () => isPluginBundleCwd.mockReturnValue(true)],
	])("stays silent for %s, whose cwd is not a repo either", async (_label, arrange) => {
		// A local-agent child runs in a scratch cwd by construction, and a
		// plugin-bundle cwd is a cache directory — neither is a repository, so both
		// arrive here with `isWorktreeRoot: false`. Their refusal is deliberately
		// silent (the guards' own text belongs to `startMcpServer`), and telling
		// them to "point this MCP server at a workspace directory" describes a
		// misconfiguration that does not exist.
		arrange();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			await runMcpProxy({
				cwd: "/tmp/scratch",
				socketPath,
				spawnDaemon: vi.fn(),
				fallback: vi.fn().mockResolvedValue(undefined),
				isWorktreeRoot: false,
			});
			expect(stderr).not.toHaveBeenCalled();
		} finally {
			stderr.mockRestore();
		}
	});

	it("never writes that explanation to stdout", async () => {
		// stdout is this session's JSON-RPC stream. One stray byte desynchronises
		// the host's framing for the whole session, which is strictly worse than
		// the empty answers the message exists to explain.
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const stdout = new PassThrough();
		const out: string[] = [];
		stdout.on("data", (c: Buffer) => out.push(c.toString()));
		try {
			await runMcpProxy({
				cwd: "/",
				socketPath,
				stdout,
				spawnDaemon: vi.fn(),
				fallback: vi.fn().mockResolvedValue(undefined),
				isWorktreeRoot: false,
			});
			expect(out).toEqual([]);
		} finally {
			stderr.mockRestore();
		}
	});

	it("stays silent for the other two guards, whose message startMcpServer owns", async () => {
		// Those refusals already have exactly one message and one place that decides
		// it; a second copy here would double-print for the cases that were fine.
		isPluginBundleCwd.mockReturnValue(true);
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			await runMcpProxy({
				cwd: CWD,
				socketPath,
				spawnDaemon: vi.fn(),
				fallback: vi.fn().mockResolvedValue(undefined),
			});
			expect(stderr).not.toHaveBeenCalled();
		} finally {
			stderr.mockRestore();
		}
	});

	it("treats an omitted isWorktreeRoot as a worktree root, so a daemon is still shared", async () => {
		// The option is the caller RETRACTING the claim the cwd already carries.
		// Defaulting the other way would silently turn every session in-process and
		// undo the shared daemon wholesale.
		const daemon = await startFakeDaemon();
		const spawnDaemon = vi.fn();
		const run = runMcpProxy({
			cwd: CWD,
			socketPath,
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			spawnDaemon,
		});
		await vi.waitFor(() => expect(daemon.greetings).toEqual(["attach"]));
		for (const s of sockets) s.destroy();
		await expect(run).resolves.toBe("proxied");
		expect(spawnDaemon).not.toHaveBeenCalled();
	});

	it("routes the refusal MESSAGE through the fallback, not a second copy", async () => {
		// The refusal text and its stderr write stay owned by startMcpServer, so
		// there is exactly one place that decides and one message a user can see.
		isPluginBundleCwd.mockReturnValue(true);
		const fallback = vi.fn().mockResolvedValue(undefined);
		await runMcpProxy({ cwd: CWD, socketPath, fallback, spawnDaemon: vi.fn() });
		expect(fallback).toHaveBeenCalledTimes(1);
	});
});

describeUnixSocket("runMcpProxy — attaching to an existing daemon", () => {
	it("attaches without spawning when a daemon is already listening", async () => {
		// The steady state this ticket is for: session 2..N cost one connect.
		const daemon = await startFakeDaemon();
		const spawnDaemon = vi.fn();
		const stdin = new PassThrough();
		const stdout = new PassThrough();

		const run = runMcpProxy({ cwd: CWD, socketPath, spawnDaemon, stdin, stdout });
		await vi.waitFor(() => expect(daemon.greetings).toEqual(["attach"]));
		expect(spawnDaemon).not.toHaveBeenCalled();

		stdin.end();
		await expect(run).resolves.toBe("proxied");
	});

	it("forwards bytes in BOTH directions verbatim", async () => {
		// Raw bytes, not parsed JSON-RPC: the proxy holds no session state and
		// cannot corrupt a message it does not understand.
		const daemon = await startFakeDaemon();
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const out: string[] = [];
		stdout.on("data", (c: Buffer) => out.push(c.toString()));

		const run = runMcpProxy({ cwd: CWD, socketPath, stdin, stdout, spawnDaemon: vi.fn() });
		await vi.waitFor(() => expect(daemon.greetings).toEqual(["attach"]));

		stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
		await vi.waitFor(() => expect(out.join("")).toContain("echo:"));
		expect(daemon.received.join("")).toBe('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
		expect(out.join("")).toBe('echo:{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');

		stdin.end();
		await run;
	});

	it("attaches when the daemon spells its cwd differently but names the same directory", async () => {
		// The address is derived from a NORMALISED root, so a spelling difference
		// lands on the right daemon; a raw `!==` on the handshake's cwd then read
		// that as a hash collision and stranded the session in-process for its whole
		// life, blaming a collision that never happened.
		//
		// A trailing separator rather than a case difference on purpose: case folding
		// is darwin/win32-only, so a case-based case would silently assert nothing on
		// the ubuntu CI this runs on.
		const daemon = await startFakeDaemon({ cwd: `${CWD}/` });
		const fallback = vi.fn().mockResolvedValue(undefined);
		const stdin = new PassThrough();

		const run = runMcpProxy({
			cwd: CWD,
			socketPath,
			stdin,
			stdout: new PassThrough(),
			spawnDaemon: vi.fn(),
			fallback,
		});
		await vi.waitFor(() => expect(daemon.greetings).toEqual(["attach"]));
		expect(fallback).not.toHaveBeenCalled();

		stdin.end();
		await expect(run).resolves.toBe("proxied");
	});

	it("applies backpressure instead of buffering a slow stdout without bound", async () => {
		// The proxy's whole value is staying at the bare-Node floor. The hand-rolled
		// `on("data") → write()` it replaced discarded `write`'s return value, so a
		// host reading its stdio slowly made this process buffer a multi-hundred-KB
		// `search` result in full. `pipe` pauses the source instead — observable as
		// the daemon's socket going non-writable while stdout stays unread.
		const daemon = await startFakeDaemon();
		const stdin = new PassThrough();
		// A 1-byte sink that is never read from: everything past the first write
		// stays queued, which is what the source must notice.
		const stdout = new PassThrough({ highWaterMark: 1 });

		const run = runMcpProxy({ cwd: CWD, socketPath, stdin, stdout, spawnDaemon: vi.fn() });
		await vi.waitFor(() => expect(daemon.greetings).toEqual(["attach"]));

		// The fake echoes each chunk back, so this drives ~256 KB at the unread sink.
		stdin.write("x".repeat(64 * 1024));
		stdin.write("y".repeat(64 * 1024));
		await vi.waitFor(() => expect(stdout.writableLength).toBeGreaterThan(0));
		// Bounded by the sink's watermark, NOT by how much was sent — the whole
		// point. Without backpressure every byte written would sit in this buffer.
		expect(stdout.writableLength).toBeLessThan(128 * 1024);

		stdin.end();
		stdout.resume();
		await run;
	});

	it("attaches to a daemon of the SAME version instead of retiring it", async () => {
		// The tie case, restated end-to-end: same-version sessions must share.
		const daemon = await startFakeDaemon({ version: cliCoreVersion() });
		const stdin = new PassThrough();
		const run = runMcpProxy({ cwd: CWD, socketPath, stdin, stdout: new PassThrough(), spawnDaemon: vi.fn() });
		await vi.waitFor(() => expect(daemon.greetings).toEqual(["attach"]));
		stdin.end();
		await run;
	});
});

describeUnixSocket("runMcpProxy — falling back in-process", () => {
	it("falls back when the peer is not a Jolli daemon", async () => {
		// Something else can inherit a swept tmpdir path. Serving ourselves beats
		// talking to a stranger.
		const foreign = createServer((socket) => socket.write("HTTP/1.1 200 OK\r\n\r\n"));
		servers.push(foreign);
		await new Promise<void>((r) => foreign.listen(socketPath, () => r()));

		const fallback = vi.fn().mockResolvedValue(undefined);
		await expect(runMcpProxy({ cwd: CWD, socketPath, fallback, spawnDaemon: vi.fn() })).resolves.toBe(
			"fallback-inprocess",
		);
		expect(fallback).toHaveBeenCalledWith(CWD);
	});

	it("falls back rather than serving a daemon bound to a DIFFERENT worktree", async () => {
		// The socket path is a hash, so a mismatch means a collision. Answering
		// anyway would return another worktree's branch — the exact silent wrong
		// answer the cwd guards exist to prevent.
		await startFakeDaemon({ cwd: "/some/other/worktree" });
		const fallback = vi.fn().mockResolvedValue(undefined);
		await expect(runMcpProxy({ cwd: CWD, socketPath, fallback, spawnDaemon: vi.fn() })).resolves.toBe(
			"fallback-inprocess",
		);
		expect(fallback).toHaveBeenCalledWith(CWD);
	});

	it("falls back WITHOUT connecting when the managed socket dir is not exclusively ours", async () => {
		// The daemon refuses to BIND in a directory another local user controls, but
		// a refusal it never gets to make protects nobody: on a shared /tmp their
		// listener is already there, and it looks legitimate to everything
		// downstream — `negotiate` can only check `protocol` and `cwd`, both fields
		// the peer writes. So the proxy has to ask the same question BEFORE it
		// connects to anything.
		isManagedSocketDirSafe.mockReturnValue(false);
		const impostor = createServer((socket) => {
			socket.write(
				encodeHandshakeLine({
					t: "hello",
					protocol: MCP_DAEMON_PROTOCOL,
					version: cliCoreVersion(),
					pid: 1,
					cwd: CWD, // an impostor can claim anything the proxy checks
				}),
			);
		});
		servers.push(impostor);
		const managedPath = mcpSocketPath(CWD);
		// This is the ONE test that binds inside the real managed directory — it has
		// to, because the gate under test is "is this path in the managed dir". The
		// proxy creates that directory itself, but only AFTER this listen: on a
		// machine where no daemon has ever run (every CI runner) it does not exist,
		// `listen` fails ENOENT, and the callback below never fires — a 60 s timeout
		// rather than an assertion, which is why it read as a hang and not a failure.
		await ensureSocketParentDir(managedPath);
		// Rejecting on `error` for the same reason: a bind that cannot succeed must
		// name itself, not stall until the suite's timeout and look like a slow test.
		await new Promise<void>((resolve, reject) => {
			impostor.once("error", reject);
			impostor.listen(managedPath, () => resolve());
		});

		const spawnDaemon = vi.fn();
		const fallback = vi.fn().mockResolvedValue(undefined);
		await expect(runMcpProxy({ cwd: CWD, socketPath: managedPath, fallback, spawnDaemon })).resolves.toBe(
			"fallback-inprocess",
		);
		expect(fallback).toHaveBeenCalledWith(CWD);
		expect(spawnDaemon).not.toHaveBeenCalled();
	});

	it("does NOT gate a socket path outside the managed directory", async () => {
		// A caller that chose its own location owns it; the gate answers about the
		// shared directory only. (Every other test in this file relies on this.)
		isManagedSocketDirSafe.mockReturnValue(false);
		const daemon = await startFakeDaemon();
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const run = runMcpProxy({ cwd: CWD, socketPath, stdin, stdout, spawnDaemon: vi.fn() });
		await vi.waitFor(() => expect(daemon.greetings).toEqual(["attach"]));
		stdin.end();
		await expect(run).resolves.toBe("proxied");
	});

	it("falls back when a spawned daemon never comes up", async () => {
		// The proxy can only make the server cheaper, never absent.
		const fallback = vi.fn().mockResolvedValue(undefined);
		await expect(
			runMcpProxy({ cwd: CWD, socketPath, fallback, spawnDaemon: vi.fn(), readyTimeoutMs: 50 }),
		).resolves.toBe("fallback-inprocess");
		expect(fallback).toHaveBeenCalledWith(CWD);
	});

	it("falls back when the peer accepts and then closes without greeting", async () => {
		// A daemon that dies between `accept` and its hello line. The handshake
		// reader answers `undefined` rather than throwing, and the proxy has to
		// treat that like any other unusable peer.
		const mute = createServer((socket) => socket.destroy());
		servers.push(mute);
		await new Promise<void>((r) => mute.listen(socketPath, () => r()));

		const fallback = vi.fn().mockResolvedValue(undefined);
		await expect(runMcpProxy({ cwd: CWD, socketPath, fallback, spawnDaemon: vi.fn() })).resolves.toBe(
			"fallback-inprocess",
		);
		expect(fallback).toHaveBeenCalledWith(CWD);
	});

	it("falls back when the peer greets with an unparseable line", async () => {
		await startFakeDaemon({ hello: "not-json\n" });
		const fallback = vi.fn().mockResolvedValue(undefined);
		await expect(runMcpProxy({ cwd: CWD, socketPath, fallback, spawnDaemon: vi.fn() })).resolves.toBe(
			"fallback-inprocess",
		);
	});
});

describeUnixSocket("runMcpProxy — spawning", () => {
	it("spawns a daemon when nothing is listening, then attaches to it", async () => {
		let daemon: FakeDaemon | undefined;
		const spawnDaemon = vi.fn(() => {
			void startFakeDaemon().then((d) => {
				daemon = d;
			});
		});
		const stdin = new PassThrough();
		const run = runMcpProxy({
			cwd: CWD,
			socketPath,
			spawnDaemon,
			stdin,
			stdout: new PassThrough(),
			readyTimeoutMs: 5000,
		});
		await vi.waitFor(() => expect(daemon?.greetings).toEqual(["attach"]));
		expect(spawnDaemon).toHaveBeenCalledWith(CWD, socketPath);
		stdin.end();
		await expect(run).resolves.toBe("proxied");
	});

	it("clears a STALE socket file before spawning", async () => {
		// A leftover entry after `kill -9` (or a reboot with a surviving tmpdir)
		// makes the daemon's own listen fail EADDRINUSE. The proxy has just proved
		// no live peer owns it by failing to connect.
		writeFileSync(socketPath, "");
		expect(existsSync(socketPath)).toBe(true);
		const spawnDaemon = vi.fn(() => {
			expect(existsSync(socketPath)).toBe(false);
		});
		await runMcpProxy({
			cwd: CWD,
			socketPath,
			spawnDaemon,
			fallback: vi.fn().mockResolvedValue(undefined),
			readyTimeoutMs: 50,
		});
		expect(spawnDaemon).toHaveBeenCalledTimes(1);
	});
});

describeUnixSocket("runMcpProxy — dist upgrade", () => {
	it("retires an OLDER daemon and takes over with its own", async () => {
		// The acceptance criterion "a dist upgrade does not leave the old daemon
		// serving new sessions", driven end-to-end.
		const old = await startFakeDaemon({ version: "0.0.1" });
		let replacement: FakeDaemon | undefined;

		// The old daemon unbinds itself on retire (see startFakeDaemon), so by the
		// time the proxy spawns, the address is free for the replacement to claim.
		const spawnDaemon = vi.fn(() => {
			void startFakeDaemon().then((d) => {
				replacement = d;
			});
		});
		const stdin = new PassThrough();
		const run = runMcpProxy({
			cwd: CWD,
			socketPath,
			spawnDaemon,
			stdin,
			stdout: new PassThrough(),
			readyTimeoutMs: 5000,
		});

		await vi.waitFor(() => expect(replacement?.greetings).toEqual(["attach"]));
		expect(old.greetings).toEqual(["retire"]);
		stdin.end();
		await expect(run).resolves.toBe("proxied");
	});

	it("attaches to a NEWER daemon rather than fighting it", async () => {
		// Highest version wins, matching resolve-dist-path. A lagging bundle must
		// not evict the newer runtime every session.
		const daemon = await startFakeDaemon({ version: "999.0.0" });
		const spawnDaemon = vi.fn();
		const stdin = new PassThrough();
		const run = runMcpProxy({ cwd: CWD, socketPath, spawnDaemon, stdin, stdout: new PassThrough() });
		await vi.waitFor(() => expect(daemon.greetings).toEqual(["attach"]));
		expect(spawnDaemon).not.toHaveBeenCalled();
		stdin.end();
		await run;
	});
});

// A source-shape assertion for the same reason the import-graph suite below is
// one: no runtime test can see this regress. `destroy()` drops queued write data,
// but a short handshake line on an idle socket almost always clears libuv's
// try-write synchronously — so a `write` + `destroy` regression passes every test
// in this file, including the retire acceptance test above, and only misbehaves on
// the machine where the write happened to queue. What it costs there is the whole
// upgrade: the incumbent never hears the request and keeps serving new sessions.
describe("retire frame delivery", () => {
	it("sends the retire frame with end(), never write()+destroy()", async () => {
		const { readFile } = await import("node:fs/promises");
		const source = await readFile(new URL("./McpProxy.ts", import.meta.url), "utf-8");

		expect(source).toContain('socket.end(encodeHandshakeLine({ t: "retire" }))');
		expect(source).not.toContain('socket.write(encodeHandshakeLine({ t: "retire" }))');
	});
});

/**
 * The Windows hand-over, where an incumbent cannot release its address.
 *
 * `platform: "win32"` is injected, and it governs ONLY the generation and
 * address-release rules — the transport underneath is still a unix socket,
 * because that is the only kind this harness can bind. So these cases pin what
 * the proxy DECIDES when a daemon defers; that a real named pipe forces the
 * deferral in the first place is a platform fact no test here can demonstrate.
 *
 * Scratch paths get generation N as `<socketPath>.gN`, which is part of the
 * `socketPath` override's contract.
 */
describeUnixSocket("runMcpProxy — socket generations", () => {
	it("moves the successor to the NEXT generation when the incumbent cannot release its address", async () => {
		// The measured Windows failure: the old daemon closes its listener but its
		// clients keep the pipe NAME alive, so the successor's listen fails
		// EADDRINUSE and dies — after which the proxy polled a dead daemon for 15 s
		// and served a full in-process server. Relocating the successor reproduces
		// what unix gets for free: two daemons briefly coexist, the old one serving
		// only the sessions it already had.
		const incumbent = await startFakeDaemon({ version: "0.0.1", deferRetire: true });
		let successor: FakeDaemon | undefined;
		const spawnDaemon = vi.fn((_cwd: string, path: string) => {
			void startFakeDaemon({ path }).then((d) => {
				successor = d;
			});
		});
		const stdin = new PassThrough();
		const run = runMcpProxy({
			cwd: CWD,
			socketPath,
			platform: "win32",
			spawnDaemon,
			stdin,
			stdout: new PassThrough(),
			readyTimeoutMs: 5000,
		});

		await vi.waitFor(() => expect(successor?.greetings).toEqual(["attach"]));
		expect(incumbent.greetings).toEqual(["retire"]);
		expect(spawnDaemon).toHaveBeenCalledWith(CWD, `${socketPath}.g1`);
		stdin.end();
		await expect(run).resolves.toBe("proxied");
	});

	it("attaches to a live successor at a higher generation instead of spawning a duplicate", async () => {
		// Generation 0 going quiet does NOT mean nobody is serving: its daemon may
		// have drained while the successor still answers one address up. Spawning at
		// the first free address would add a second ~100 MB daemon for one worktree,
		// and on Windows the OS can no longer notice — it only polices one name.
		const successor = await startFakeDaemon({ path: `${socketPath}.g1` });
		const spawnDaemon = vi.fn();
		const stdin = new PassThrough();
		const run = runMcpProxy({
			cwd: CWD,
			socketPath,
			platform: "win32",
			spawnDaemon,
			stdin,
			stdout: new PassThrough(),
			readyTimeoutMs: 5000,
		});

		await vi.waitFor(() => expect(successor.greetings).toEqual(["attach"]));
		expect(spawnDaemon).not.toHaveBeenCalled();
		stdin.end();
		await expect(run).resolves.toBe("proxied");
	});

	it("serves in-process rather than answering from a superseded daemon when every generation is held", async () => {
		// Exhausting the scan is the one place this design can run out of room. The
		// safe direction is the documented fallback — correct tools, unshared memory
		// — never attaching to a daemon we already know is out of date.
		for (let generation = 0; generation < 4; generation++) {
			await startFakeDaemon({
				version: "0.0.1",
				deferRetire: true,
				path: generation === 0 ? socketPath : `${socketPath}.g${generation}`,
			});
		}
		const spawnDaemon = vi.fn();
		const fallback = vi.fn().mockResolvedValue(undefined);

		const outcome = await runMcpProxy({
			cwd: CWD,
			socketPath,
			platform: "win32",
			spawnDaemon,
			fallback,
			readyTimeoutMs: 300,
		});

		expect(outcome).toBe("fallback-inprocess");
		expect(fallback).toHaveBeenCalledWith(CWD);
		expect(spawnDaemon).not.toHaveBeenCalled();
	});

	it("derives generation 0 from the worktree root when no path was supplied", async () => {
		// Production never passes `socketPath`, so the derived address is the one that
		// actually ships. Pinned here because every other case in this file overrides
		// it, which would leave the real spelling — and the whole hash-of-the-root
		// identity behind it — asserted nowhere.
		const spawnDaemon = vi.fn();
		await runMcpProxy({
			cwd: CWD,
			spawnDaemon,
			fallback: vi.fn().mockResolvedValue(undefined),
			readyTimeoutMs: 50,
		});
		expect(spawnDaemon).toHaveBeenCalledWith(CWD, mcpSocketPath(CWD));
	});

	it("stays on ONE address on unix, where a retiring daemon releases it immediately", async () => {
		// Measured: unix `close()` unlinks synchronously while already-accepted
		// connections keep working, so the successor binds the SAME path. Scanning
		// generations there would only add failed connects to every cold start.
		const incumbent = await startFakeDaemon({ version: "0.0.1" });
		const spawnedPaths: string[] = [];
		const spawnDaemon = vi.fn((_cwd: string, path: string) => {
			spawnedPaths.push(path);
			void startFakeDaemon({ path });
		});
		const stdin = new PassThrough();
		const run = runMcpProxy({
			cwd: CWD,
			socketPath,
			platform: "linux",
			spawnDaemon,
			stdin,
			stdout: new PassThrough(),
			readyTimeoutMs: 5000,
		});

		await vi.waitFor(() => expect(spawnedPaths).toEqual([socketPath]));
		expect(incumbent.greetings).toEqual(["retire"]);
		stdin.end();
		await expect(run).resolves.toBe("proxied");
	});
});

describeUnixSocket("runMcpProxy — bounded retries", () => {
	it("gives up and serves in-process when a superseded daemon keeps coming back", async () => {
		// The round bound is what stops an unbounded retire loop. Without it a
		// daemon that rebinds at the old version after every retire would spin
		// forever instead of degrading to a local server.
		let rebinds = 0;
		const spawnStale = async (): Promise<void> => {
			rebinds++;
			await startFakeDaemon({ version: "0.0.1" });
		};
		await spawnStale();

		const fallback = vi.fn().mockResolvedValue(undefined);
		const outcome = await runMcpProxy({
			cwd: CWD,
			socketPath,
			fallback,
			spawnDaemon: () => {
				void spawnStale();
			},
			readyTimeoutMs: 300,
		});

		expect(outcome).toBe("fallback-inprocess");
		expect(fallback).toHaveBeenCalledWith(CWD);
		expect(rebinds).toBeGreaterThan(1);
	});
});

describeUnixSocket("runMcpProxy — the daemon it spawns", () => {
	it("spawns the CLI entry beside this bundle, never the script that launched it", async () => {
		// `process.argv[1]` is the CLI only while `runMcpProxy` is reached solely
		// from `Cli.js` — an invariant nothing enforces, and the same assumption
		// that made the global daemon's trigger spawn hook entries in a loop. A
		// sibling lookup is correct whichever entry this code is inlined into.
		const fallback = vi.fn().mockResolvedValue(undefined);

		// `readyTimeoutMs: 0` — one connect attempt after the spawn, so nothing
		// waits out the real 15 s budget for a daemon this test never starts.
		await expect(runMcpProxy({ cwd: CWD, socketPath, fallback, readyTimeoutMs: 0 })).resolves.toBe(
			"fallback-inprocess",
		);

		expect(spawnHidden).toHaveBeenCalledWith(
			process.execPath,
			["/opt/jolli/dist/Cli.js", "mcp-serve", "--cwd", CWD, "--socket", socketPath],
			expect.objectContaining({ detached: true, stdio: "ignore", cwd: CWD }),
		);
		const [, argv] = spawnHidden.mock.calls[0] as unknown as [string, string[], unknown];
		expect(argv[0]).not.toBe(process.argv[1]);
	});
});

// A source-shape assertion, following `DaemonServer.test.ts`'s cold-start suite,
// because nothing else can see this regress: a new static import here type-checks,
// lints clean and leaves every test green — the only thing that changes is the
// resident set of a process that exists once per AI session on the machine.
// Reaching into `McpServer` for `startMcpServer` (the fallback) or
// `isPluginBundleCwd` (the guard) is the specific mistake this catches; both are
// available without it, one by dynamic import and one from a leaf.
describe("cold-start import graph", () => {
	it("statically imports only node builtins and leaf modules", async () => {
		const { readFile } = await import("node:fs/promises");
		const source = await readFile(new URL("./McpProxy.ts", import.meta.url), "utf-8");

		// Each entry's own transitive imports are node builtins or other leaves.
		// Widening this set is the decision the test exists to force on purpose.
		const ALLOWED_LEAF_MODULES = new Set([
			"../core/AgentReentry.js",
			"../Logger.js",
			"../util/CliEntry.js",
			"../util/Subprocess.js",
			"./McpCwdGuard.js",
			"./McpDaemonProtocol.js",
		]);

		// Counted separately so a regex that fails to match a new import shape (a
		// side-effect `import "./x.js"`, say) fails loudly instead of passing on an
		// empty result.
		const importStatements = [...source.matchAll(/^import\b/gm)].length;
		const specifiers = [...source.matchAll(/^import\b[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
		expect(specifiers).toHaveLength(importStatements);

		const offenders = specifiers.filter((s) => !s.startsWith("node:") && !ALLOWED_LEAF_MODULES.has(s));
		expect(offenders).toEqual([]);
	});

	it("reaches the in-process fallback by dynamic import only", async () => {
		const { readFile } = await import("node:fs/promises");
		const source = await readFile(new URL("./McpProxy.ts", import.meta.url), "utf-8");
		expect(source).toContain('await import("./McpServer.js")');
	});
});

describeUnixSocket("runMcpProxy — session teardown", () => {
	it("resolves when the daemon closes the connection", async () => {
		// A daemon death ends the session rather than hanging the host: MCP has no
		// resumption over stdio, so a silent reconnect would strand `initialize`.
		const daemon = await startFakeDaemon();
		const stdin = new PassThrough();
		const run = runMcpProxy({ cwd: CWD, socketPath, stdin, stdout: new PassThrough(), spawnDaemon: vi.fn() });
		await vi.waitFor(() => expect(daemon.greetings).toEqual(["attach"]));
		for (const s of sockets) s.destroy();
		await expect(run).resolves.toBe("proxied");
	});

	it("half-closes the socket when the host closes stdin", async () => {
		// end(), not destroy(): the daemon sees end-of-input and can flush a reply
		// already in flight instead of losing it.
		const daemon = await startFakeDaemon();
		const stdin = new PassThrough();
		const run = runMcpProxy({ cwd: CWD, socketPath, stdin, stdout: new PassThrough(), spawnDaemon: vi.fn() });
		await vi.waitFor(() => expect(daemon.greetings).toEqual(["attach"]));
		stdin.end();
		await expect(run).resolves.toBe("proxied");
	});
});
