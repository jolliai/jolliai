/**
 * TaskScheduler — the global daemon's ticker, and deliberately nothing more.
 *
 * It holds NO persistent state, and that falls out of a property its only task
 * already has rather than from minimalism for its own sake. `maybeSnapshot`
 * gates itself on `last-snapshot-at` in `schema_meta`, so the backup task
 * already knows whether it is due and that knowledge is already persisted,
 * already shared across processes. A scheduler that recorded its own `lastRun`
 * would become a second owner of the same fact, and nothing would say which to
 * believe when they disagreed.
 *
 * So `tickIntervalMs` is how often to ASK a task whether it is due — not how
 * often it acts. Backup is asked hourly and answers "already done today" 23
 * times out of 24.
 *
 * Three properties come free from that shape:
 *
 *   - **Catch-up needs no code.** Every task is ticked once at startup, so a
 *     machine that was off for three days snapshots on the first tick. There is
 *     no "missed run" to model.
 *   - **Retire needs no handover.** A fresh daemon inherits nothing and
 *     self-aligns on its first tick.
 *   - **No cron vocabulary.** "24 hours since the last success" is already
 *     expressed inside the task; restating it here would be the second owner
 *     again.
 */

import { createLogger, errMsg } from "../Logger.js";

const log = createLogger("TaskScheduler");

/** One thing the daemon asks about on a clock. */
export interface DaemonTask {
	readonly name: string;
	/** How often to ASK this task whether it is due — not its execution period. */
	readonly tickIntervalMs: number;
	/** The task decides whether to act. The returned string is for logging only. */
	run(): Promise<string>;
}

export interface SchedulerDeps {
	/** Test seam. Defaults to the global timer. */
	readonly setInterval?: typeof globalThis.setInterval;
	readonly clearInterval?: typeof globalThis.clearInterval;
	readonly onTaskResult?: (name: string, result: string) => void;
	readonly onTaskError?: (name: string, error: unknown) => void;
}

export interface SchedulerHandle {
	stop(): void;
}

/**
 * Starts ticking every task and returns a handle that stops all of them.
 *
 * A task that throws is reported and its schedule continues: backup failure
 * already has an independent, result-oriented signal (`backupHealthCheck`, on
 * `jolli doctor`), so a second one here would be noise — and stopping the
 * schedule would turn one bad day into a permanently dead timer.
 *
 * A task never overlaps itself. `VACUUM INTO` on a large database can outlive a
 * short tick interval, and two concurrent snapshots would race on the same temp
 * file; the in-flight flag is cheaper than any lock and is correct because this
 * is one process.
 */
export function startScheduler(tasks: ReadonlyArray<DaemonTask>, deps: SchedulerDeps = {}): SchedulerHandle {
	const setIntervalImpl = deps.setInterval ?? globalThis.setInterval;
	const clearIntervalImpl = deps.clearInterval ?? globalThis.clearInterval;
	const timers: Array<ReturnType<typeof globalThis.setInterval>> = [];
	const inFlight = new Set<string>();

	const tick = (task: DaemonTask): void => {
		if (inFlight.has(task.name)) {
			log.debug("%s still running; skipping this tick", task.name);
			return;
		}
		inFlight.add(task.name);
		void task
			.run()
			.then((result) => {
				log.debug("%s: %s", task.name, result);
				deps.onTaskResult?.(task.name, result);
			})
			.catch((error: unknown) => {
				log.warn("%s failed: %s", task.name, errMsg(error));
				deps.onTaskError?.(task.name, error);
			})
			.finally(() => {
				inFlight.delete(task.name);
			});
	};

	for (const task of tasks) {
		// Tick once now: this is the entire catch-up mechanism.
		tick(task);
		const timer = setIntervalImpl(() => tick(task), task.tickIntervalMs);
		// The listening socket keeps the daemon alive on its own, so an unref'd
		// timer is what lets "socket closed -> process exits" work. Note this is
		// the OPPOSITE of McpProxy's retry timer, which must NOT be unref'd
		// because there it is the only handle keeping the loop alive.
		timer.unref?.();
		timers.push(timer);
	}

	return {
		stop(): void {
			for (const timer of timers) clearIntervalImpl(timer);
			timers.length = 0;
		},
	};
}
