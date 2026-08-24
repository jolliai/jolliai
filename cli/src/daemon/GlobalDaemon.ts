/**
 * GlobalDaemon — the one resident process per machine per user.
 *
 * It exists to run work that must happen when NOBODY is asking for it: the daily
 * `jollimemory.db` snapshot, the periodic re-scan that notices an agent conversation
 * has grown since the dashboard last imported it, and the periodic session-activity
 * upload. Every other trigger for any of them is opportunistic (the dashboard
 * launcher, the post-commit worker, `doctor`), which covers the user who commits
 * regularly and abandons the user who does not — exactly the user whose snapshot is
 * oldest, whose afternoon of agent work is least likely to have been recorded, and
 * whose week of sessions is least likely to have been synced.
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
import { loadConfig } from "../core/SessionTracker.js";
import { opportunisticSnapshot } from "../dashboard/Backup.js";
import { applyConfiguredLogLevel, createLogger, errMsg, setLogDir } from "../Logger.js";
import {
	GLOBAL_DAEMON_PROTOCOL,
	type GlobalDaemonHello,
	globalSocketDir,
	globalSocketPath,
} from "./GlobalDaemonProtocol.js";
import { reachabilityReconcileTask } from "./ReachabilityReconcileTask.js";
import { sessionRescanTask } from "./SessionRescanTask.js";
import { type DaemonTask, startScheduler } from "./TaskScheduler.js";

const log = createLogger("GlobalDaemon");

/** How long to wait for a client's greeting before dropping the connection. */
const GREETING_TIMEOUT_MS = 5_000;

/** How often to ASK the backup task whether it is due. See `TaskScheduler`. */
const BACKUP_TICK_MS = 60 * 60 * 1000;

/**
 * How often to ASK the session sync whether it is due.
 *
 * The upload's real period is `MIN_ATTEMPT_INTERVAL_MS` (30 min) and it is
 * enforced by `runSessionSync` itself, from `lastAttemptAtMs` in its own channel
 * file — this is a tick rate, not a schedule, per the `TaskScheduler` rule that
 * a task owns its own due-ness.
 *
 * ⚠ Deliberately SHORTER than that period, and equal is the bug it looks like a
 * tidy choice. `isDueForSessionSync` is `now - lastAttempt >= interval`, so with
 * a tick of exactly 30 min every tick lands on the boundary and any negative
 * jitter — `setInterval` drift, a busy loop, a tick the previous run overlapped
 * — answers "throttled" and pushes the real upload out to SIXTY minutes. It
 * would present as the feature working, at half the rate it claims. Asking
 * often and being told no is the shape the backup task already has (hourly, "no"
 * 23 times out of 24); the cost here is one file read per tick, which is exactly
 * what `isDueForSessionSync` is built to be.
 */
const SESSION_SYNC_TICK_MS = 5 * 60 * 1000;

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
 * Each is asked on a clock and decides for itself whether to act, which is the
 * whole of the scheduling model: `opportunisticSnapshot` reads `last-snapshot-at`
 * from the database and skips unless a day has passed, the session re-scan compares
 * each conversation's instant against the one already stored, and `runSessionSync`
 * reads `lastAttemptAtMs` from its own channel file. The daemon adds no scheduling
 * knowledge of its own — see `TaskScheduler` for why a second owner of "when did this
 * last run" is the one thing that shape must not grow.
 *
 * The intervals differ by two orders of magnitude and that is not an
 * inconsistency: an hourly question is right for work whose answer changes once a
 * day, and a 30-second one is right for work whose answer changes while the user is
 * typing. What makes the fast one affordable is that its converged tick does no I/O
 * beyond a `stat` per conversation file.
 *
 * They may overlap, and deliberately nothing stops them. `TaskScheduler`'s in-flight
 * flag is per task, so the backup's `VACUUM INTO` can begin while a re-scan is
 * waiting on disk. That is safe rather than merely unlikely: the snapshot reads the
 * database and writes a separate file, the re-scan's own write is a short transaction
 * at the very end, and WAL lets those coexist. Adding a cross-task mutex would mean
 * giving the scheduler shared state, which is the one thing it must not have.
 *
 * ⚠ The session sync belongs HERE, not only on the commit path, and the reason
 * is the same one that put the backup here: the post-commit trigger in
 * `QueueWorker` covers the user who commits, and abandons the user who does not
 * — while most sessions never produce a commit at all, so gating the upload on
 * one means a machine syncs only the conversations that happened to end in one.
 * `runSessionSync` is called with NO cwd deliberately: the channel is
 * cross-repo, and a machine-level timer has no single repository to ask about
 * (see `SessionSyncOptions.cwd`).
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
		sessionRescanTask(),
		reachabilityReconcileTask(),
		{
			name: "session-sync",
			tickIntervalMs: SESSION_SYNC_TICK_MS,
			run: async (): Promise<string> => {
				// Imported here, not at module scope: this module is loaded by
				// `GlobalDaemonCommand` on the ordinary CLI path, and the runner pulls in
				// the push client and the whole HTTP stack behind it. Only the process
				// that actually ticks needs them.
				const { runSessionSync } = await import("../dashboard/SessionSyncRunner.js");
				const outcome = await runSessionSync();
				return outcome.status === "done"
					? `sent ${outcome.rows} row(s) in ${outcome.batches} batch(es)`
					: `${outcome.status}: ${outcome.reason}`;
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
	// Then honour the configured level, which nothing here used to do: the default
	// file threshold is `info`, so every `log.debug` in this process — including the
	// scheduler's per-task result line — was dropped, and setting `logLevel: "debug"`
	// in the config had no effect on the one process a user cannot watch directly.
	// Best-effort: a daemon must still come up when the config is missing or corrupt,
	// and the default level is the right fallback.
	try {
		const config = await loadConfig();
		applyConfiguredLogLevel(config.logLevel, config.logLevelOverrides);
	} catch (error: unknown) {
		log.warn("could not read the configured log level: %s", errMsg(error));
	}

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
