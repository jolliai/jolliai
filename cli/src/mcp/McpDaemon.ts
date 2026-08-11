/**
 * McpDaemon — the per-worktree MCP server process.
 *
 * One of these serves every session open on one worktree, replacing the N
 * independent `jolli mcp` servers that each re-ran `createStorage`, re-read the
 * summary store and re-fetched the platform manifest. Measured against a real
 * repo: ~100 MB physical footprint per session before, ~11 MB (a bare-Node
 * proxy) after, with the ~100 MB paid once.
 *
 * Owned by NO session. That is the whole point — the machine this ticket came
 * from had 44 host sessions alive for 26 h, any of which can be closed at
 * random, so a daemon parented to one of them (leader election) would reproduce
 * the failure it was meant to fix. It is spawned detached, and it reaps itself:
 * idle after its last client leaves, or on demand when a newer bundle asks it to
 * retire.
 *
 * Lifecycle in one line: bind → hello → attach|retire → serve → drain → exit.
 */

import { createServer, type Server as NetServer, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLogger } from "../Logger.js";
import {
	canReleaseAddress,
	cliCoreVersion,
	encodeHandshakeLine,
	ensureSocketParentDir,
	isInManagedSocketDir,
	isManagedSocketDirSafe,
	MCP_DAEMON_PROTOCOL,
	mcpSocketPath,
	parseClientGreeting,
	readHandshakeLine,
} from "./McpDaemonProtocol.js";
import {
	createMcpServer,
	type McpRuntime,
	prepareMcpRuntime,
	rebuildPlatformHalf,
	type StartMcpServerDeps,
} from "./McpServer.js";

const log = createLogger("McpDaemon");

/**
 * How long the daemon survives with zero clients before exiting.
 *
 * Not zero: a host that restarts its MCP server (a reload, a settings change, a
 * crashed session) reconnects within seconds, and tearing down a ~100 MB warm
 * runtime only to rebuild it moments later is the expensive half of what this
 * ticket removes. Five minutes keeps a reconnect free while bounding how long a
 * closed editor's memory outlives it.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

/**
 * How long a freshly-bound daemon waits for its FIRST client before giving up.
 *
 * Separate from the idle timeout, and much shorter, because the two answer
 * different questions. A daemon reaching this one was spawned by a proxy that
 * then died (the host gave up, the user closed the window mid-launch) — nobody
 * is coming, and there is no warm runtime worth preserving yet.
 */
export const DEFAULT_FIRST_CLIENT_TIMEOUT_MS = 60_000;

export interface RunMcpDaemonOptions {
	/** Worktree root this daemon answers for; every tool derives its repo from it. */
	readonly cwd: string;
	/** Override the derived socket path. Tests pass a scratch path. */
	readonly socketPath?: string;
	readonly idleTimeoutMs?: number;
	readonly firstClientTimeoutMs?: number;
	/** Forwarded to {@link prepareMcpRuntime}; lets tests inject a fake platform client. */
	readonly deps?: StartMcpServerDeps;
	/**
	 * Which platform's address-ownership rules apply — see {@link canReleaseAddress}.
	 *
	 * Injectable because the behaviour it selects is decided by Windows named-pipe
	 * semantics while the only transport a test (or this project's CI) can bind is a
	 * unix socket. Defaults to the real platform, so production never passes it.
	 */
	readonly platform?: NodeJS.Platform;
	/** Notified once the socket is bound. Tests await this instead of polling. */
	readonly onListening?: (socketPath: string) => void;
}

/** Why the daemon stopped — surfaced for logs and asserted by tests. */
export type McpDaemonExitReason =
	| "refused" // a cwd guard declined to serve this directory
	| "unsafe-socket-dir" // the socket directory is not exclusively ours
	| "address-in-use" // another daemon won the race; it serves this worktree
	| "listen-failed"
	| "idle"
	| "no-first-client"
	| "retired"; // a newer bundle asked us to stand down

/**
 * Runs the daemon until it reaps itself. Resolves with the reason it stopped.
 *
 * Never throws for an "another daemon got there first" outcome: losing the bind
 * race is the SUCCESS case from the caller's point of view — a server for this
 * worktree exists, which is all the proxy wanted.
 */
export async function runMcpDaemon(options: RunMcpDaemonOptions): Promise<McpDaemonExitReason> {
	const { cwd } = options;
	const socketPath = options.socketPath ?? mcpSocketPath(cwd);
	const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
	const firstClientTimeoutMs = options.firstClientTimeoutMs ?? DEFAULT_FIRST_CLIENT_TIMEOUT_MS;

	// Run the cwd guards BEFORE binding. A refused directory must leave no socket
	// behind: a bound-then-refusing daemon would look reachable to every future
	// proxy, which would attach and get nothing — strictly worse than the
	// documented fallback of serving (and refusing) in-process.
	const runtime = await prepareMcpRuntime(cwd, options.deps ?? {});
	if (!runtime) return "refused";

	// The safety gate follows the PATH, not who chose it. Keying it on "did the
	// caller supply one" made it dead code in production: the proxy always spawns
	// us with `--socket`, and the path it supplies is exactly `mcpSocketPath(cwd)`
	// — inside the very shared-`/tmp` directory the gate exists to police. So ask
	// the only question that matters, which also still lets a test bind a scratch
	// path of its own. The mkdir applies to both: `listen` fails ENOENT on a
	// missing parent.
	await ensureSocketParentDir(socketPath);
	const uid = process.getuid?.() ?? 0;
	if (isInManagedSocketDir(socketPath, uid) && !isManagedSocketDirSafe(uid)) {
		log.warn("Refusing to bind: %s is not exclusively owned by this user", socketPath);
		return "unsafe-socket-dir";
	}

	return serveOnSocket({ ...options, socketPath, idleTimeoutMs, firstClientTimeoutMs, runtime });
}

interface ServeArgs extends RunMcpDaemonOptions {
	readonly socketPath: string;
	readonly idleTimeoutMs: number;
	readonly firstClientTimeoutMs: number;
	readonly runtime: McpRuntime;
}

function serveOnSocket(args: ServeArgs): Promise<McpDaemonExitReason> {
	const { socketPath, idleTimeoutMs, firstClientTimeoutMs } = args;
	const platform = args.platform ?? process.platform;

	return new Promise<McpDaemonExitReason>((resolve) => {
		const connections = new Set<Socket>();
		let retiring = false;
		let settled = false;
		let reapTimer: NodeJS.Timeout | undefined;
		let server: NetServer;

		/**
		 * Releases the socket: stops accepting, and lets `close()` remove the file.
		 *
		 * There is NO explicit unlink here, and adding one back is a bug. Measured:
		 * `server.close()` unlinks the path SYNCHRONOUSLY, at call time — while its
		 * callback fires only once every existing connection has ended. Those two
		 * moments are far apart for a retiring daemon, and only the first one is a
		 * moment at which we still own the path.
		 *
		 * That gap is the whole hazard. A retiring daemon releases at once (so the
		 * requesting proxy's re-ensure cannot land back on us) and finishes when its
		 * last in-flight call drains — seconds later, by which time the SUCCESSOR has
		 * bound a new file at the same path. An unlink placed after the await deletes
		 * THEIR socket: the successor stays `listening` on a path nothing can reach,
		 * every later proxy spawns yet another daemon, and the unreachable one holds
		 * its ~100 MB until its idle reap — the exact waste this module exists to
		 * remove, reappearing once per upgrade. A once-per-daemon guard does NOT fix
		 * it, because the very first release is already the mistimed one.
		 *
		 * If a future runtime stops unlinking on close, the leftover file is the
		 * ordinary stale-socket case: the next proxy fails to connect and clears it
		 * in `removeStaleSocket` before spawning. Recovering there is strictly safer
		 * than unlinking a path we may no longer own.
		 */
		const releaseSocket = (): Promise<void> => closeListener(server);

		const stop = (reason: McpDaemonExitReason): void => {
			if (settled) return;
			settled = true;
			if (reapTimer) clearTimeout(reapTimer);
			// Destroy rather than end: `stop` only runs once no client is being
			// served (idle / no-first-client) or after retirement drained, so
			// anything still here is a half-open peer that never greeted.
			for (const socket of connections) socket.destroy();
			releaseSocket().finally(() => resolve(reason));
		};

		/**
		 * Arms the "nothing is using me" countdown. Called whenever the connection
		 * count reaches zero — including at bind time, when it has never been
		 * anything else — so the two timeouts share one code path and a daemon can
		 * never end up with neither armed.
		 */
		const armReap = (reason: "idle" | "no-first-client", ms: number): void => {
			if (reapTimer) clearTimeout(reapTimer);
			reapTimer = setTimeout(() => {
				if (connections.size === 0) stop(reason);
			}, ms);
			// Do not hold the event loop open on the reap timer alone: with the
			// listener closed during retirement, this timer would otherwise keep a
			// finished process alive for the rest of its window.
			reapTimer.unref?.();
		};

		const onConnectionClosed = (socket: Socket): void => {
			connections.delete(socket);
			if (connections.size > 0) return;
			// A retiring daemon exists only to finish the calls it already had.
			// Once they are done it leaves immediately — waiting out an idle window
			// would keep the superseded runtime resident for no one's benefit.
			if (retiring) stop("retired");
			else armReap("idle", idleTimeoutMs);
		};

		// Not `const`: a degraded runtime is replaced in place on a later
		// connection — see `refreshIfDegraded`.
		let runtime = args.runtime;

		/**
		 * Re-fetches the platform-tool manifest when the previous attempt failed.
		 *
		 * The manifest fetch is best-effort by design, so a network blip yields an
		 * empty list. In a one-shot server that cost exactly one session its
		 * platform tools; caching it in a daemon would cost EVERY session on the
		 * worktree, for the daemon's whole lifetime, with nothing in `tools/list`
		 * to say so. Retrying here bounds that to one session.
		 *
		 * Only the platform half is retried. The storage half is a process-global
		 * side effect (`setActiveStorage`) that is already correct and is the
		 * expensive one; re-running it per connection would undo the sharing this
		 * daemon exists for. A CLOSED gate is not degraded, so the normal path
		 * makes no network call here at all.
		 */
		// De-duplicates concurrent retries. A host reopening several sessions at
		// once after a network outage would otherwise fire one manifest fetch per
		// connection, all racing to write the same answer.
		let refreshInFlight: Promise<McpRuntime> | undefined;

		const refreshIfDegraded = async (): Promise<McpRuntime> => {
			if (!runtime.platformDegraded) return runtime;
			refreshInFlight ??= (async () => {
				try {
					const refreshed = await rebuildPlatformHalf(runtime, args.deps ?? {});
					if (!refreshed.platformDegraded) {
						log.info("Platform tools recovered on retry: %d advertised", refreshed.toolDefinitions.length);
					}
					runtime = refreshed;
				} catch (err) {
					// Serving the built-ins beats refusing the connection: the manifest
					// is an enhancement, and this is already the degraded path.
					log.warn("Platform-tool retry failed: %s", err instanceof Error ? err.message : String(err));
				}
				// Cleared either way, so a later connection can try again after a
				// failure — but only one at a time.
				refreshInFlight = undefined;
				return runtime;
			})();
			return refreshInFlight;
		};

		server = createServer((socket) => {
			connections.add(socket);
			if (reapTimer) clearTimeout(reapTimer);
			socket.setNoDelay(true);
			/* v8 ignore start -- a unix-domain socket has no portable way to force a
			   peer-side error: `resetAndDestroy` is TCP-only and an abrupt client
			   destroy delivers a clean EOF, so this handler cannot be driven
			   deterministically from a test. It is one log line plus a destroy; the
			   behaviour that matters (one client's death not taking the others with
			   it) is covered by the multi-client tests above. */
			socket.on("error", (err) => {
				// A client that vanishes mid-call is routine (host quit, session
				// closed); it must never take the daemon's other clients with it.
				log.debug("Client socket error: %s", err.message);
				socket.destroy();
			});
			/* v8 ignore stop */
			socket.once("close", () => onConnectionClosed(socket));

			// `refreshIfDegraded` is handed in as a thunk rather than awaited here so
			// the hello line still goes out immediately. Greeting first is what lets
			// the proxy judge our version without waiting, and it keeps a `retire`
			// request — which needs no tools at all — from paying for a manifest
			// fetch that may be exactly what is hanging.
			void handleConnection(socket, refreshIfDegraded, runtime.cwd)
				.then((greeting) => {
					if (greeting !== "retire") return;
					// `connections` still holds the requester itself here, which is
					// exactly what `canReleaseAddress` counts on: on Windows the sole
					// remaining instance of the pipe name is the socket we are about to
					// close, so an idle handover proceeds as it always has.
					const canRelease = canReleaseAddress(platform, connections.size);
					// ANSWER BEFORE the `retiring` guard. A second, even newer proxy can
					// arrive while we are already deferring, and it needs the same answer
					// — silence means "released" on this wire, so skipping it would send
					// that proxy off to bind an address we are still holding.
					if (canRelease) socket.end();
					else socket.end(encodeHandshakeLine({ t: "retire-deferred" }));
					if (retiring) return;
					retiring = true;
					if (canRelease) {
						log.info("Retiring: a newer bundle asked to take over %s", socketPath);
						// Unbind FIRST so the requesting proxy's immediate re-ensure cannot
						// race back onto this dying daemon, then let the drain path decide
						// when to exit.
						void releaseSocket();
						if (connections.size === 0) stop("retired");
						return;
					}
					// Deferred: KEEP LISTENING. Unbinding would strand the clients that
					// are holding the address without freeing it for anyone — the
					// successor cannot bind this name either way, so it moves to the next
					// generation while we serve out the sessions we already have and exit
					// when they drain.
					log.info(
						"Retirement deferred on %s: %d client(s) still hold the address; the successor takes a new generation",
						socketPath,
						connections.size - 1,
					);
				})
				.catch((err) => {
					// One client's failed setup must never take the others with it. Without
					// this the rejection is unhandled, and Node's default for that is to
					// terminate the process — killing the MCP server of every OTHER session
					// attached to this worktree, from a detached daemon whose stdio is
					// ignored, so the only trace anywhere would be their tools vanishing.
					// `server.connect` is the reachable rejector; a peer that dies between
					// our `hello` write and its greeting is the ordinary way to reach it.
					log.warn(
						"Dropping client after a failed attach: %s",
						err instanceof Error ? err.message : String(err),
					);
					socket.destroy();
				});
		});

		server.on("error", (err: NodeJS.ErrnoException) => {
			// EADDRINUSE with a live peer means a sibling daemon beat us to this
			// worktree — exactly the outcome we want, reached by a different route.
			// A STALE socket file (no listener) reports the same code, and is the
			// normal state after a kill -9 or a reboot with a surviving tmpdir; the
			// proxy clears those before spawning us, so we do not retry here.
			if (settled) return;
			settled = true;
			if (reapTimer) clearTimeout(reapTimer);
			// Log the errno. A bare "listen-failed" is a dead end for whoever reads
			// debug.log: the daemon is detached with stdio ignored, so this line is
			// the ONLY trace it leaves, and the two failures that actually happen
			// (ENOENT from a missing parent dir, EACCES from a hostile one) are
			// indistinguishable without it.
			log.warn("listen(%s) failed: %s", socketPath, err.code ?? err.message);
			resolve(err.code === "EADDRINUSE" ? "address-in-use" : "listen-failed");
		});

		server.listen(socketPath, () => {
			log.info("MCP daemon listening on %s (cwd=%s, version=%s)", socketPath, runtime.cwd, cliCoreVersion());
			armReap("no-first-client", firstClientTimeoutMs);
			args.onListening?.(socketPath);
		});
	});
}

/**
 * Serves one client: greet, read its answer, and on `attach` hand the remainder
 * of the socket to a fresh MCP `Server`.
 *
 * Resolves with the greeting that was acted on (or `undefined` when the peer
 * never sent a usable one) rather than when the client disconnects — the caller
 * tracks liveness through the socket's own `close` event, and a `retire` must be
 * acted on immediately, not after the requester finishes its session.
 */
async function handleConnection(
	socket: Socket,
	/**
	 * Resolves the runtime to serve this client with. A thunk, not a value,
	 * because it may perform the degraded-manifest retry — which must happen
	 * AFTER the hello line and only for a client that actually attaches.
	 */
	getRuntime: () => Promise<McpRuntime>,
	cwd: string,
): Promise<"attach" | "retire" | undefined> {
	socket.write(
		encodeHandshakeLine({
			t: "hello",
			protocol: MCP_DAEMON_PROTOCOL,
			version: cliCoreVersion(),
			pid: process.pid,
			cwd,
		}),
	);

	const first = await readHandshakeLine(socket);
	if (!first) {
		socket.destroy();
		return undefined;
	}
	const greeting = parseClientGreeting(first.line);
	if (!greeting) {
		log.debug("Dropping client that sent an unrecognised greeting");
		socket.destroy();
		return undefined;
	}
	// Answering — and closing — is the CALLER's job, not ours: whether we can
	// actually give up the address depends on how many other clients are attached,
	// which only `serveOnSocket` knows. Ending here would also make that answer
	// unwritable, which is how a daemon that could not release its address came to
	// report success by saying nothing.
	if (greeting.t === "retire") return "retire";

	// Everything after the greeting line belongs to the MCP transport. It is fed
	// through a PassThrough rather than `socket.unshift` because the socket has an
	// active `data` listener for the duration of the handshake, which puts it in
	// flowing mode — `unshift` on a flowing stream is a documented no-op-with-loss.
	// In practice `rest` is empty (a proxy holds its stdin until it has attached),
	// but a client that pipelines its `initialize` must not lose it.
	const input = new PassThrough();
	if (first.rest.length > 0) input.write(first.rest);
	socket.pipe(input);

	// Resolved here, not at the top: this is the first point at which we know the
	// client wants tools, and the degraded-manifest retry behind it must not sit
	// in front of the hello line.
	const server = createMcpServer(await getRuntime());
	await server.connect(new StdioServerTransport(input, socket));
	log.debug("Client attached (cwd=%s)", cwd);
	return "attach";
}

/**
 * Stops accepting new connections, resolving once the listener is fully closed.
 *
 * Removing the socket file is part of what `close()` does — measured: the path
 * is unlinked synchronously when `close()` is CALLED, which is what keeps a
 * restart clean (a unix socket path is a real directory entry that outlives its
 * process, and a leftover one makes the next `listen` fail EADDRINUSE). The
 * callback, by contrast, waits for every open connection to end. Do not add an
 * unlink after awaiting this; see {@link serveOnSocket}'s `releaseSocket`.
 */
async function closeListener(server: NetServer): Promise<void> {
	await new Promise<void>((resolve) => {
		if (!server.listening) {
			resolve();
			return;
		}
		server.close(() => resolve());
	});
}
