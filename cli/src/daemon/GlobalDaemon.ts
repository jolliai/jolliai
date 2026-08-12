/**
 * GlobalDaemon — the one resident process per machine per user.
 *
 * It exists to run work that must happen when NOBODY is working: today the
 * daily `jollimemory.db` snapshot, next the periodic session-activity upload.
 * Every other trigger for that snapshot is opportunistic (the dashboard
 * launcher, the post-commit worker, `doctor`), which covers the user who
 * commits regularly and abandons the user who does not — exactly the user who
 * needs an old snapshot most.
 *
 * Owned by NO session, spawned detached. Unlike `McpDaemon` it has **no idle
 * timeout**, and that inversion is the whole point: the MCP daemon reaps itself
 * when its last client leaves because it exists to serve clients, whereas this
 * one exists to be awake when there is nobody to serve. Its only exit paths are
 * a retire from a newer bundle, a lost bind race, and the machine going down.
 *
 * Lifecycle in one line: bind → hello → (attach | retire) → tick → retired.
 */

import { createServer, type Server as NetServer, type Socket } from "node:net";
import { homedir } from "node:os";
import {
	cliCoreVersion,
	encodeHandshakeLine,
	ensureSocketParentDir,
	isInSocketDir,
	isSocketDirSafe,
	parseDaemonGreeting,
	readHandshakeLine,
} from "../core/DaemonHandshake.js";
import { opportunisticSnapshot } from "../dashboard/Backup.js";
import { createLogger, errMsg, setLogDir } from "../Logger.js";
import {
	GLOBAL_DAEMON_PROTOCOL,
	type GlobalDaemonHello,
	globalSocketDir,
	globalSocketPath,
} from "./GlobalDaemonProtocol.js";
import { type DaemonTask, startScheduler } from "./TaskScheduler.js";

const log = createLogger("GlobalDaemon");

/** The hidden subcommand name, shared with the trigger that spawns it. */
export const GLOBAL_DAEMON_COMMAND = "global-daemon";

/** How long to wait for a client's greeting before dropping the connection. */
const GREETING_TIMEOUT_MS = 5_000;

/** How often to ASK the backup task whether it is due. See `TaskScheduler`. */
const BACKUP_TICK_MS = 60 * 60 * 1000;

/** Why the daemon stopped — surfaced for logs and asserted by tests. */
export type GlobalDaemonExitReason = "unsafe-socket-dir" | "address-in-use" | "listen-failed" | "retired";

export interface RunGlobalDaemonOptions {
	/** Override the derived socket path. Tests pass a scratch path. */
	readonly socketPath?: string;
	/** Override the task set. Defaults to {@link defaultTasks}. */
	readonly tasks?: ReadonlyArray<DaemonTask>;
	/** Notified once the socket is bound. Tests await this instead of polling. */
	readonly onListening?: (socketPath: string) => void;
}

/**
 * The tasks a production daemon runs.
 *
 * `opportunisticSnapshot` is asked hourly and decides for itself: it reads
 * `last-snapshot-at` from the database and skips unless a day has passed. The
 * daemon adds no scheduling knowledge of its own — see `TaskScheduler`.
 */
export function defaultTasks(): ReadonlyArray<DaemonTask> {
	return [
		{
			name: "backup",
			tickIntervalMs: BACKUP_TICK_MS,
			run: async (): Promise<string> => {
				const result = await opportunisticSnapshot();
				return result.status === "created" ? `created ${result.path}` : `${result.status}: ${result.reason}`;
			},
		},
	];
}

/**
 * Runs the daemon until it is retired or loses the bind race.
 *
 * Never throws for "another daemon got there first": losing that race is the
 * SUCCESS case from the caller's point of view — a daemon for this user exists,
 * which is all anyone wanted.
 */
export async function runGlobalDaemon(options: RunGlobalDaemonOptions = {}): Promise<GlobalDaemonExitReason> {
	const socketPath = options.socketPath ?? globalSocketPath();
	const tasks = options.tasks ?? defaultTasks();

	// A detached process inherits its spawner's cwd, and `getJolliMemoryDir()`
	// falls back to `process.cwd()`. Left alone, this daemon would write
	// debug.log into whichever repository happened to trigger it first — a
	// different one across reboots. `homedir()` lands it in the global config
	// dir, since getGlobalConfigDir() is join(homedir(), ".jolli", "jollimemory").
	setLogDir(homedir());

	await ensureSocketParentDir(socketPath);
	/* v8 ignore start -- process.getuid is undefined only on win32, which this suite does not run on */
	const uid = process.getuid?.() ?? 0;
	/* v8 ignore stop */
	const dir = globalSocketDir(uid);
	// The gate follows the PATH, not who chose it: production always lands in the
	// shared-/tmp directory the gate exists to police, while a test's scratch
	// path elsewhere is its own choice and is not second-guessed.
	if (isInSocketDir(socketPath, dir) && !isSocketDirSafe(dir, uid)) {
		log.warn("Refusing to bind: %s is not exclusively owned by this user", dir);
		return "unsafe-socket-dir";
	}

	const startedAt = Date.now();
	const hello: GlobalDaemonHello = {
		t: "hello",
		protocol: GLOBAL_DAEMON_PROTOCOL,
		version: cliCoreVersion(),
		pid: process.pid,
		startedAt,
	};

	return await new Promise<GlobalDaemonExitReason>((resolve) => {
		let settled = false;
		let scheduler: { stop(): void } | undefined;
		let server: NetServer | undefined;

		const finish = (reason: GlobalDaemonExitReason): void => {
			if (settled) return;
			settled = true;
			scheduler?.stop();
			server?.close();
			log.info("global daemon exiting: %s", reason);
			resolve(reason);
		};

		server = createServer((socket: Socket) => {
			/* v8 ignore start -- a unix-domain socket has no portable way to force a
			   peer-side error: `resetAndDestroy` is TCP-only and an abrupt client
			   destroy delivers a clean EOF, so this handler cannot be driven
			   deterministically from a test. See the identical note on `McpDaemon`'s
			   own per-client socket error handler. */
			socket.on("error", (err) => log.debug("client socket error: %s", errMsg(err)));
			/* v8 ignore stop */
			socket.write(encodeHandshakeLine(hello));
			void readHandshakeLine(socket, GREETING_TIMEOUT_MS).then((read) => {
				const greeting = read ? parseDaemonGreeting(read.line) : undefined;
				if (greeting?.t === "retire") {
					socket.end();
					finish("retired");
					return;
				}
				// Everything else — `attach`, an unparseable line, a timeout, a client
				// that connected only to learn we exist and hung up — means carry on.
				// A probe closing its socket is the COMMON case, not an error: the
				// trigger's cheapest question is answered by connect() alone.
				socket.end();
			});
		});

		server.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "EADDRINUSE") {
				finish("address-in-use");
				return;
			}
			log.warn("listen failed: %s", errMsg(err));
			finish("listen-failed");
		});

		server.listen(socketPath, () => {
			log.info("global daemon listening on %s (pid %d, v%s)", socketPath, process.pid, hello.version);
			scheduler = startScheduler(tasks);
			options.onListening?.(socketPath);
		});
	});
}
