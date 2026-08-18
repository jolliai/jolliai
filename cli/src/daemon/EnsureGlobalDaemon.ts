/**
 * EnsureGlobalDaemon — the trigger and worker helpers that guarantee a
 * machine-global daemon exists.
 *
 * It never throws, never blocks its caller, and logs on every failure path:
 * four of its five call sites (the CLI tail, `post-commit`, `SessionStart`,
 * and both plugin bootstraps — all but the CLI tail itself) are on the git or
 * agent critical path, where a thrown error would be a blocked commit.
 *
 * ## The two questions, and why they get different budgets
 *
 * `connect()` asks *does one exist* and is answered by the KERNEL — a stale
 * socket file with no listener gives ECONNREFUSED, a live daemon accepts even
 * while its event loop is busy. It is therefore bounded.
 *
 * Reading `hello` asks *which build is it* and is answered by the daemon's
 * event loop, which is NOT bounded: the daemon runs `VACUUM INTO` through
 * `node:sqlite`'s synchronous API, so it answers nothing for the duration
 * (measured: 547 ms on a 143 MB database plus 196 ms for the verifying
 * `integrity_check`, both scaling with size).
 *
 * So a successful connect is enough on its own, and the hello read gets a short
 * budget whose failure means DO NOTHING — not retry, and emphatically not
 * "assume dead".
 *
 * ## Why retiring does not spawn the replacement
 *
 * The retired daemon still holds the socket when `retire` is delivered, and may
 * hold it for the rest of an in-flight snapshot. Because this helper
 * deliberately does not wait for its spawn, a replacement started immediately
 * would die `address-in-use` with nobody watching — an upgrade would silently
 * remove the daemon. Leaving the respawn to the NEXT trigger is bounded and
 * self-healing: triggers are frequent while a user works, and a retire only
 * follows an upgrade, which is itself a trigger-dense moment.
 */

import { unlink } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { cliCoreVersion, encodeHandshakeLine, isCoreVersionNewer, readHandshakeLine } from "../core/DaemonHandshake.js";
import { canUseDashboardDb } from "../dashboard/DashboardDb.js";
import { createLogger, errMsg } from "../Logger.js";
import { resolveCliInvocation } from "../util/CliEntry.js";
import { spawnHidden } from "../util/Subprocess.js";
import {
	GLOBAL_DAEMON_COMMAND,
	GLOBAL_HELLO_TIMEOUT_MS,
	type GlobalDaemonHello,
	globalSocketPath,
	parseGlobalDaemonHello,
} from "./GlobalDaemonProtocol.js";

const log = createLogger("EnsureGlobalDaemon");
export const GLOBAL_DAEMON_ENSURE_COMMAND = "global-daemon-ensure";

/** How long to wait for the TCP/unix connect itself. */
const CONNECT_TIMEOUT_MS = 200;

/**
 * Commands that must never bring a daemon up.
 *
 * The first three are mechanical: `global-daemon` would trigger itself, and
 * `mcp` / `mcp-serve` / `daemon` own their stdout as a protocol stream and are
 * cold-start sensitive. (Bare `mcp` takes `Cli.ts`'s proxy fast path and never
 * reaches the trigger at all, but `mcp --reindex` and `mcp-serve` do.)
 *
 * The fourth is semantic and is the one that gets missed: without it, `jolli
 * uninstall` spawns a resident process on its way out and leaves an orphan
 * behind.
 */
const EXCLUDED_COMMANDS: ReadonlySet<string> = new Set([
	GLOBAL_DAEMON_COMMAND,
	GLOBAL_DAEMON_ENSURE_COMMAND,
	"mcp",
	"mcp-serve",
	"daemon",
	"uninstall",
	"disable",
]);

/** Whether the resolved command opts out of bringing the daemon up. */
export function shouldSkipGlobalDaemon(command: string | null): boolean {
	return command !== null && EXCLUDED_COMMANDS.has(command);
}

export type EnsureOutcome =
	| "already-running"
	| "spawned"
	| "retired-incumbent"
	| "skipped-unsupported-node"
	| "skipped-excluded-command"
	| "failed";

export interface EnsureDeps {
	readonly socketPath?: string;
	/** The commander-parsed root command, when there is one. */
	readonly command?: string | null;
	/** Test seam for the Node floor check. */
	readonly nodeVersion?: string;
	/** Test seam for the version comparison. */
	readonly ownVersion?: string;
	readonly helloTimeoutMs?: number;
	/** Spawns the detached daemon. Injected by tests; defaults to a real spawn. */
	readonly spawnDaemon?: (socketPath: string) => void;
}

export interface TriggerEnsureDeps {
	readonly socketPath?: string;
	readonly command?: string | null;
	readonly nodeVersion?: string;
}

/**
 * The result of a connect attempt: the live socket, or (on failure) the
 * error's `code` — `undefined` for a timeout, which is not a real error at
 * all and must not be confused with one that named a reason.
 */
interface ConnectResult {
	readonly socket: Socket | undefined;
	readonly code?: string;
}

/**
 * Connects, resolving a result rather than throwing on any failure.
 *
 * The `error` listener is attached for the socket's WHOLE life, not just for the
 * connect: a `settled` flag makes the post-resolution arrivals a no-op instead
 * of `removeAllListeners` taking the handler away. An error event on a socket
 * with no listener is re-raised by Node as an uncaughtException, and every
 * caller here goes on to `write` and `end()` on the socket this returns — so a
 * peer that retired between the connect and the write (a racing trigger; an
 * EPIPE) would kill the process. Four of the five triggers are hooks, which
 * means killing SessionStart or a plugin bootstrap BEFORE it writes the stdout
 * envelope its host is waiting for, and the `try/catch` around the caller cannot
 * see an uncaughtException. Matches `McpProxy.tryConnect`, which keeps its
 * handler for the same reason.
 */
function tryConnect(socketPath: string): Promise<ConnectResult> {
	return new Promise((resolve) => {
		let settled = false;
		const socket = connect(socketPath);
		const done = (result: ConnectResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.removeAllListeners("connect");
			if (result.socket === undefined) socket.destroy();
			resolve(result);
		};
		const timer = setTimeout(() => done({ socket: undefined }), CONNECT_TIMEOUT_MS);
		timer.unref?.();
		socket.once("connect", () => done({ socket }));
		socket.on("error", (err: NodeJS.ErrnoException) => {
			// Before settling this is the connect's own failure and names the reason
			// the caller branches on (only ECONNREFUSED may unlink the socket file).
			// Afterwards it is a live-socket error with nowhere to be reported: the
			// handshake is over, the outcome is already decided, and swallowing it is
			// the whole point — this helper must never take a git hook down.
			if (settled) {
				log.warn("global daemon socket error after connect: %s", errMsg(err));
				return;
			}
			done({ socket: undefined, code: err.code });
		});
	});
}

/**
 * Removes a stale socket file so a fresh `listen()` at the same path does not
 * fail `EADDRINUSE`. Same treatment as `McpProxy.removeStaleSocket`: a no-op
 * on Windows, whose named pipes live in a kernel namespace with no file to
 * remove, and total — an already-gone file is the common case and the desired
 * end state either way.
 */
async function removeStaleSocket(socketPath: string): Promise<void> {
	if (socketPath.startsWith("\\\\.\\pipe\\")) return;
	try {
		await unlink(socketPath);
	} catch {
		// Already gone is the common case and the desired end state either way.
	}
}

/**
 * Ensures a global daemon exists. Resolves with what it did; never rejects.
 */
export async function ensureGlobalDaemon(deps: EnsureDeps = {}): Promise<EnsureOutcome> {
	try {
		if (shouldSkipGlobalDaemon(deps.command ?? null)) return "skipped-excluded-command";

		// The daemon's only job writes the dashboard database, and node:sqlite
		// throws on import below 22.13. A resident process that cannot do the one
		// thing it exists for is worse than no process.
		if (!canUseDashboardDb(deps.nodeVersion ?? process.versions.node)) {
			return "skipped-unsupported-node";
		}

		const socketPath = deps.socketPath ?? globalSocketPath();
		const { socket, code } = await tryConnect(socketPath);

		if (!socket) {
			// ONLY `ECONNREFUSED` proves a stale socket FILE with nobody bound — the
			// `kill -9` / dead-reboot case that would otherwise make the fresh
			// `listen()` below fail `EADDRINUSE` forever, since macOS sweeps `$TMPDIR`
			// on an idle timer rather than at reboot. A timeout or any other code
			// (`EAGAIN`, …) proves nothing about the file: a live daemon wedged behind
			// a full accept backlog answers exactly like a timeout, and unlinking on
			// that evidence would let the spawn below bind a FRESH file at the same
			// path while the incumbent still holds the old inode — the one way in this
			// whole design to get two daemons running `VACUUM INTO` against the same
			// database at once. Same treatment as `McpProxy.removeStaleSocket`'s
			// "absent" vs "unresponsive" split.
			if (code === "ECONNREFUSED") await removeStaleSocket(socketPath);
			(deps.spawnDaemon ?? spawnDetachedGlobalDaemon)(socketPath);
			return "spawned";
		}

		try {
			const read = await readHandshakeLine(socket, deps.helloTimeoutMs ?? GLOBAL_HELLO_TIMEOUT_MS);
			const hello = read ? parseGlobalDaemonHello(read.line) : undefined;
			// No hello, an unparseable one, or a foreign protocol: connect() already
			// proved a listener exists, and only the version refinement was lost.
			if (!hello) return "already-running";

			const mine = deps.ownVersion ?? cliCoreVersion();
			if (!isCoreVersionNewer(mine, hello.version)) return "already-running";

			socket.write(encodeHandshakeLine({ t: "retire" }));
			log.info("retiring global daemon pid %d (v%s < v%s)", hello.pid, hello.version, mine);
			// Deliberately no spawn — see the module header.
			return "retired-incumbent";
		} finally {
			socket.end();
		}
	} catch (error: unknown) {
		log.warn("could not ensure the global daemon: %s", errMsg(error));
		return "failed";
	}
}

/**
 * Starts the detached "ensure one exists" helper and returns immediately.
 *
 * This is what short-lived CLI and hook processes call so their own latency
 * never inherits the daemon's bounded connect/hello wait.
 */
export function triggerEnsureGlobalDaemon(deps: TriggerEnsureDeps = {}): boolean {
	try {
		if (shouldSkipGlobalDaemon(deps.command ?? null)) return false;
		if (!canUseDashboardDb(deps.nodeVersion ?? process.versions.node)) return false;
		spawnDetachedEnsureGlobalDaemon(deps.socketPath);
		return true;
	} catch (error: unknown) {
		log.warn("could not trigger the global daemon ensure helper: %s", errMsg(error));
		return false;
	}
}

/**
 * Asks a running daemon to stand down. Resolves true when the request was sent.
 *
 * Used by `uninstall`, which is on the exclusion list — so nothing respawns.
 */
export async function retireGlobalDaemon(deps: { readonly socketPath?: string } = {}): Promise<boolean> {
	try {
		const { socket } = await tryConnect(deps.socketPath ?? globalSocketPath());
		if (!socket) return false;
		// Read and discard the hello so the daemon's write completes before we
		// answer; the version is irrelevant when the answer is always "retire".
		await readHandshakeLine(socket, GLOBAL_HELLO_TIMEOUT_MS);
		socket.write(encodeHandshakeLine({ t: "retire" }));
		socket.end();
		return true;
	} catch (error: unknown) {
		log.warn("could not retire the global daemon: %s", errMsg(error));
		return false;
	}
}

/**
 * Reads a running daemon's hello without changing anything, for `doctor`.
 *
 * Uses the full `HANDSHAKE_TIMEOUT_MS`-class budget rather than
 * {@link GLOBAL_HELLO_TIMEOUT_MS}: nothing on a git critical path calls this,
 * and a diagnostic that reports "not running" because the daemon was busy
 * snapshotting would be worse than a slow diagnostic.
 */
export async function probeGlobalDaemon(socketPath?: string): Promise<GlobalDaemonHello | undefined> {
	try {
		const { socket } = await tryConnect(socketPath ?? globalSocketPath());
		if (!socket) return undefined;
		try {
			const read = await readHandshakeLine(socket, 5_000);
			return read ? parseGlobalDaemonHello(read.line) : undefined;
		} finally {
			socket.end();
		}
	} catch {
		return undefined;
	}
}

/**
 * Spawns the daemon, detached, from the SAME bundle this process is running.
 *
 * The entry comes from {@link resolveCliInvocation}: the sibling `Cli.js` in a
 * built dist, or `src/Cli.ts` plus the current loader args during a source-mode
 * `tsx` run. That keeps detached development runs alive without reintroducing
 * the old `argv[1]` hook-recursion trap.
 */
function spawnDetachedGlobalDaemon(socketPath: string): void {
	const invocation = resolveCliInvocation(import.meta.url);
	if (!invocation) {
		log.warn("Cannot locate the CLI entry to spawn the global daemon");
		return;
	}
	// NO Node flags before the script: a flag an older Node does not recognise
	// kills the child before it runs a line of code, and with `stdio: "ignore"`
	// that death is invisible.
	//
	// `cwd: homedir()` so every cwd-derived path inside the daemon agrees with
	// the `setLogDir(homedir())` it does at startup.
	const child = spawnHidden(
		process.execPath,
		[...invocation.nodeArgs, invocation.entry, GLOBAL_DAEMON_COMMAND, "--socket", socketPath],
		{
			detached: true,
			stdio: "ignore",
			cwd: homedir(),
		},
	);
	// A detached spawn emits `error` asynchronously; with no listener Node
	// re-throws it as an uncaught exception and would kill the git hook.
	child.on("error", (err) => log.warn("global daemon failed to spawn: %s", errMsg(err)));
	child.unref();
	log.info("spawned global daemon (pid %d)", child.pid ?? -1);
}

function spawnDetachedEnsureGlobalDaemon(socketPath?: string): void {
	const invocation = resolveCliInvocation(import.meta.url);
	if (!invocation) {
		log.warn("Cannot locate the CLI entry to spawn the global daemon ensure helper");
		return;
	}
	const args = [...invocation.nodeArgs, invocation.entry, GLOBAL_DAEMON_ENSURE_COMMAND];
	if (socketPath) args.push("--socket", socketPath);
	const child = spawnHidden(process.execPath, args, {
		detached: true,
		stdio: "ignore",
		cwd: homedir(),
	});
	child.on("error", (err) => log.warn("global daemon ensure helper failed to start: %s", errMsg(err)));
	child.unref();
	log.info("spawned global daemon ensure helper (pid %d)", child.pid ?? -1);
}
