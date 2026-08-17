/**
 * SessionRescanTask — the global daemon's periodic conversation re-scan.
 *
 * ## What it is for
 *
 * An agent's conversation keeps growing after the dashboard has already imported it:
 * a Codex rollout resumed at noon carries skills and MCP calls that were not there at
 * ten. Until now the only thing that noticed was the next `jolli dashboard` run, so a
 * user who never opens the dashboard — or opens it before the afternoon's work — had
 * that usage recorded nowhere. This asks the question on a timer instead.
 *
 * ## Why it is cheap enough to ask every 30 seconds
 *
 * Because asking is not doing. {@link dbRescanSessions} compares each discovered
 * session's `updatedAt` against the instant already stored for it, and re-reads the
 * TRANSCRIPT of only the ones that moved. On a converged tick — which is almost every
 * tick — nothing is parsed and no session row is written.
 *
 * Two costs are paid on every tick regardless, and neither is zero:
 *
 *   - **The scan.** One `stat` per rollout the user has ever recorded, measured at
 *     ~10 ms across 460 files, and it grows without bound because Codex prunes neither
 *     `sessions/` nor `archived_sessions/`. That `stat` IS the question this pass asks, so
 *     it cannot be cached. The two things around it are cached and therefore are not
 *     per-tick costs: `session_meta.cwd` (needed to attribute a rollout to a repo) is read
 *     at most ONCE per process per rollout, and a past day directory is listed at most
 *     once — see `CodexSessionDiscoverer`'s two memos.
 *   - **The baseline read.** Phase 1 of {@link dbRescanSessions} opens the dashboard
 *     database through the READ-ONLY handle, so it neither migrates nor chmods nor takes
 *     SQLite's writer lock. Only the apply phase, which is skipped when nothing moved,
 *     opens for writing.
 *
 * Both are small today and the first scales with how much the user has used the agent, so
 * treat the interval as a budget against them rather than against zero. Do not re-derive
 * that budget from a stale reading of it: this list claimed a first-line read of every
 * in-window rollout 2,880 times a day, and a migration pass and a chmod on every tick,
 * after the change that removed all three.
 *
 * That property belongs to the SOURCE, not to this file, which is why the set of
 * sources is opt-in per definition (`SessionSourceSpec.daemonRescan`) rather than
 * "everything the back-fill can read". A source whose reported instant is a creation
 * time answers "unchanged" forever, so a timer over it would spend I/O to discover
 * nothing — which is exactly what Codex did before its scan moved to file mtime.
 * Today `codex` is the only opted-in source; adding the next one is one field on its
 * definition and no change here.
 *
 * ## Phase 1 BLOCKS the daemon's event loop, and that is not a bug to be fixed here
 *
 * `node:sqlite` exposes only a SYNCHRONOUS API, so every statement in phase 1 — two
 * cursors per repo, a session map per repo, the health count, and the emission-gate seed
 * on the first tick — runs to completion with nothing else able to make progress. The
 * daemon accepts no connection for the duration, and `TaskScheduler` ticks each task once
 * immediately after bind, so the most expensive tick of the process is also the one most
 * likely to collide with a trigger: a `post-commit` or `SessionStart` from a newly
 * upgraded dist connects to compare versions, lands inside a tick, and can exceed
 * `EnsureGlobalDaemon`'s 300 ms hello budget — whose timeout means "do nothing", so the
 * stale daemon is never retired. AGENTS.md sizes that budget against a once-daily
 * `VACUUM INTO`; this is a second, far more frequent source of the same collision.
 *
 * Three things are worth knowing before anyone tries to shrink it:
 *
 *   - There is no async handle to move to. Making phase 1 non-blocking would mean a
 *     different SQLite binding, not a refactor.
 *   - `readKnownSessions` CANNOT be bounded to the sessions this tick cares about. It is
 *     the baseline, and the baseline is read in phase 1 while discovery happens in phase 2
 *     — so at the moment of the query there is no key set to narrow by. Reversing the two
 *     would mean scanning before knowing whether any repo even has a baseline.
 *   - The seed is the one part that was cut, and it was: it reads the NEWEST row per
 *     session and parses only those, 31 ms against 283 ms for the `json_valid` form it
 *     replaced. It also runs once per process, not once per tick.
 *
 * `storedSessionRows` in phase 3 is the one query that COULD be bounded — the events are
 * in hand by then — and is deliberately left whole: phase 3 runs only on a tick that found
 * something, which is roughly 1 in 100, while the same function is on `dbBackfillRepo`'s
 * per-repo path where a chunked `IN (…)` would be a new failure mode on the hot side for
 * no gain on the cold one. So the honest statement is that the interval is a budget
 * against a synchronous block whose size grows with the machine's session history, and the
 * lever is {@link SESSION_RESCAN_TICK_MS}, not the query shapes.
 *
 * ## Why the disable check is per repo and not once for the process
 *
 * The daemon is machine-global and serves every registered repo, while `jolli
 * disable` is a statement about ONE repo: everything Jolli writes about that repo
 * stops. So the switch has to be read per repo on the way in — a single check against
 * the daemon's own working directory (the user's home) would answer for a repo that
 * does not exist. The read-only variant is deliberate for the same reason
 * `jolli dashboard` uses it: a question asked on the way to a background task must not
 * migrate and persist someone's profile as a side effect.
 */

import { readManualDisableFlagReadonly } from "../core/RepoProfile.js";
import { DAEMON_RESCAN_SOURCES } from "../core/sessions/SessionSources.js";
import { canUseDashboardDb } from "../dashboard/DashboardDb.js";
import { existingWorktrees, listActiveRepos, type RegisteredRepo } from "../dashboard/RepoRegistry.js";
import { createLogger, errMsg } from "../Logger.js";
import type { TranscriptSource } from "../Types.js";
import type { DaemonTask } from "./TaskScheduler.js";

/**
 * Every line this feature writes carries this module tag, so one `grep AgentScan
 * ~/.jolli/jollimemory/debug.log` returns all of it — including the lines `DbBackfill`
 * emits from inside the pass (a per-repo failure, a source's scan-failure REASON, and an
 * unusable database), each of which prefixes its message with the same word for exactly
 * that reason. PascalCase to match every other module tag in the log
 * (`GlobalDaemon`, `TaskScheduler`, `Backup`); the source names inside each message
 * are lower-case, as they are everywhere else in the product.
 */
const log = createLogger("AgentScan");

/**
 * How often to ASK whether any watched agent's conversations have moved.
 *
 * Not how often anything is read or written — see the header. The scheduler holds no
 * state of its own, so this is purely the polling interval; the decision to act is
 * made per session, from the instants already in the database.
 */
export const SESSION_RESCAN_TICK_MS = 30_000;

/** The scheduler's name for this task, shared with its log lines. */
export const SESSION_RESCAN_TASK_NAME = "session-rescan";

/**
 * Entry cap on the emission gate, enforced by {@link dbRescanSessions} refusing NEW keys
 * once the map is full — never by clearing it.
 *
 * The number is a memory budget rather than a tuned threshold: an entry is a
 * `session:<identity>:<source>:<id>` key plus a number, so this is single-digit megabytes
 * — comfortably more sessions than a machine accumulates inside the retention window, and
 * far below anything a resident process should hold indefinitely.
 *
 * A whole-map clear was the obvious policy (it is what the two `CodexSessionDiscoverer`
 * memos use) and it is wrong HERE, for a reason specific to how this map refills. The
 * memos refill from one `readdir` or one first-line read; this one refills from a full scan
 * of the largest table in the database — and the seed comes from the SAME population that
 * just overflowed, so a clear cannot converge: the next tick re-seeds past the limit and
 * clears again, every 30 s for the machine's whole uptime, with the gate empty the entire
 * time and every already-parked session re-emitted on every tick. That is precisely the
 * permanent write loop the gate exists to stop. Refusing new keys degrades gracefully
 * instead: the newest `EMITTED_GATE_LIMIT` sessions stay gated and anything past them is
 * re-read as it was before the gate existed.
 */
const EMITTED_GATE_LIMIT = 50_000;

/**
 * Whether this repo has opted out of everything Jolli writes about it.
 *
 * ANY surviving checkout saying "disabled" disables the repo, because the rows this
 * task would write are keyed by `repoIdentity` — two clones of one project share
 * them, so there is no half of the data to leave alone. Erring towards the user's
 * opt-out is the only reading that respects it.
 *
 * The READ-ONLY reader, for the reason `jolli dashboard` uses it: a question asked on
 * the way to a background task must not migrate and persist someone's profile as a side
 * effect. The ASYNC read-only reader, because this is a resident process asking once per
 * repo per worktree every 30 seconds — the sync form made that dozens of blocking
 * syscalls a minute on the daemon's event loop, forever.
 *
 * That moved the PROFILE READ off the event loop and no more than that, so do not read it
 * as "this tick no longer blocks". Three synchronous passes remain per tick and they are
 * known: `existingWorktrees` here is a `.filter(existsSync)` over every recorded worktree,
 * `dbRescanSessions` runs the same predicate again through `hasLiveWorktree` and then a
 * third time to pick each repo's newest checkout, and `readManualDisableFlagReadonly`'s own
 * anchor (`resolveMainRootSync`) is fully synchronous — including, for a worktree whose
 * `.git` layout it cannot read, a ~10 ms `git rev-parse --git-common-dir` spawn on the
 * daemon's first tick. Sharing one resolved worktree list across the three would remove two
 * of them; it is not done here because the list would have to cross a module boundary as an
 * option purely for that, and the cost is bounded and measured rather than growing.
 *
 * Sequential rather than `Promise.all`: the answer short-circuits on the first checkout
 * that says disabled, which is the case worth being fast for, and the fan-out would cost
 * a rejected-promise path for a handful of `readFile`s.
 */
async function isRepoDisabled(repo: RegisteredRepo): Promise<boolean> {
	for (const root of existingWorktrees(repo)) {
		if (await readManualDisableFlagReadonly(root)) return true;
	}
	return false;
}

/**
 * The scheduler entry.
 *
 * ## What lands in the log, and why it is not simply "everything"
 *
 * `TaskScheduler` reports a task's own result at DEBUG, and debug is below the
 * default file threshold (`Logger`'s `_globalLogLevel` is `info`) — so a task that
 * says nothing itself says nothing anywhere. At 30-second ticks the opposite extreme
 * is just as useless: an INFO line per tick is 2,880 lines a day saying "nothing
 * changed", which buries the ones that matter. So this task decides per outcome:
 *
 *   - **Armed** — one INFO line on the first tick, naming the interval and the
 *     sources. This is what makes "nothing changed" distinguishable from "never
 *     ran", and it is the line to look for when checking the feature is live.
 *   - **Something was re-read** — INFO, with the counts. The event a user is looking
 *     for when they wonder why a conversation's skills appeared.
 *   - **Nothing changed** — DEBUG, i.e. invisible unless `logLevel: "debug"` is
 *     configured. This is the normal tick.
 *   - **A scan failed, or no repo has a baseline** — WARN, and the baseline one is
 *     said ONCE rather than every tick, because it needs a user action
 *     (`jolli dashboard`) and repeating it 2,880 times a day would not help. It is
 *     re-armed if the situation resolves and later returns.
 *   - **Events are parked unprojected** — WARN, once, re-armed the same way. A parked
 *     event is a conversation the dashboard will never show, and this is the only
 *     place that says so: nothing queries `events_raw`, and the prune deletes only
 *     `projected` rows, so a failure neither surfaces nor ages out on its own.
 *   - **The pass THREW** — WARN, once per distinct message, re-armed when it changes or
 *     clears. This is the outcome the list above forgot, and letting it reach the
 *     scheduler undoes every once-only decision on it: `TaskScheduler` warns on a
 *     rejected `run()` and keeps the schedule, so one unreadable or corrupt
 *     `jollimemory.db` — a standing condition, not a transient — is 2,880 identical
 *     lines a day, with tick 1 and tick 2,880 indistinguishable. Caught HERE rather
 *     than made a scheduler feature: the scheduler holds no per-task state by design,
 *     and this is per-task state.
 *
 * All of it goes to the daemon's `debug.log`, which is under `~/.jolli/jollimemory/`
 * — the daemon calls `setLogDir(homedir())` at startup precisely so its lines do not
 * land in whichever repository happened to spawn it.
 *
 * `tickIntervalMs` is injectable so a test can drive several ticks without waiting,
 * never to tune it in production — see the constant. The once-only state lives in
 * this closure rather than at module scope so each task instance starts clean.
 */
export function sessionRescanTask(tickIntervalMs: number = SESSION_RESCAN_TICK_MS): DaemonTask {
	let announced = false;
	/** Sources already warned about, so a standing failure is said once. Per source. */
	let warnedFailedSources = new Set<TranscriptSource>();
	/**
	 * The situation each warning topic was last said for, so a standing condition is said
	 * once. See {@link sayOnce}.
	 */
	const said = new Map<string, string>();

	/**
	 * WARN once per distinct SITUATION within a topic; `null` clears the topic so a
	 * situation that returns later is said again.
	 *
	 * One mechanism rather than four. This started as three separate flags plus a message
	 * variable — two booleans with byte-identical if/else ladders, and a string that was
	 * already the general form of both — and the spread hid an asymmetry nobody chose: the
	 * boolean flags re-fired only when their count reached ZERO, so a machine going from one
	 * unbaselined repo to six stayed silent, which is exactly the "five repos permanently
	 * unvisited" case that warning exists to surface.
	 *
	 * Which fact is the dedup key is therefore a per-topic decision, not a detail: the
	 * baseline topic keys on the COUNT (a change is news), while the parked-events topic
	 * keys on a constant (the count can climb every tick under a systematic projection
	 * failure, and 2,880 lines a day is what all of this exists to avoid).
	 */
	const sayOnce = (topic: string, situation: string | null, render: () => string): void => {
		if (situation === null) {
			said.delete(topic);
			return;
		}
		if (said.get(topic) === situation) return;
		said.set(topic, situation);
		log.warn("[%s] %s", sourceTag, render());
	};
	// The emission gate's store, owned HERE rather than inside `dbRescanSessions`
	// because it has to outlive one tick — that persistence IS the mechanism. In the
	// closure rather than at module scope for the same reason as the flags above: each
	// task instance starts clean, and a test can drive several ticks against one map.
	const emitted = new Map<string, number>();
	// Seeded from the write-ahead log on the FIRST tick only — seeding is a full table
	// scan, and repeating it would put that scan back on the 30-second path. Flipped on
	// the pass that ACTUALLY seeded (`result.seededEmitted`), never on "the call
	// resolved": three of `dbRescanSessions`' early returns come before phase 1, so a
	// process that took one of them and flipped the flag anyway would never seed at all
	// and would re-emit once for every already-parked session on its first real tick.
	let seeded = false;
	// Comma-joined rather than pretty-printed: it goes into every line of this task's
	// output as a second, narrower filter key — `grep 'AgentScan.*codex'` once more than
	// one source has opted in.
	const sourceTag = DAEMON_RESCAN_SOURCES.map((source) => source.source).join(",") || "none";

	const tick = async (): Promise<string> => {
		if (!announced) {
			announced = true;
			log.info("[%s] armed: every %ds", sourceTag, Math.round(tickIntervalMs / 1000));
		}

		// `DashboardDb`'s own header: "Callers must gate on canUseDashboardDb first" —
		// it throws a clear error rather than letting the dynamic `node:sqlite` import
		// fail with a bare MODULE_NOT_FOUND. The sibling backup task gates and answers
		// `skipped`; without the same check here a runtime below the floor throws on
		// EVERY tick, and the scheduler turns that into 2,880 warn lines a day about a
		// machine that simply cannot run this. Answered quietly for the same reason the
		// backup task is: it is a capability, not a fault.
		//
		// Reached statically because `GlobalDaemon` already imports `Backup.js`, which
		// imports this module — so nothing new is loaded, and `node:sqlite` itself stays
		// behind the dynamic import that keeps its ExperimentalWarning out of processes
		// that never open the database.
		if (!canUseDashboardDb()) return "node:sqlite unavailable on this runtime";

		const registered = await listActiveRepos();
		if (registered.length === 0) return "no registered repos";

		// Asked of every repo concurrently — these are independent `readFile`s. `=== false`
		// rather than a negation so an answer that somehow arrived absent is treated as
		// DISABLED, which is the same direction `isRepoDisabled` errs in and the only one
		// that respects an opt-out.
		const disabled = await Promise.all(registered.map((repo) => isRepoDisabled(repo)));
		const repos = registered.filter((_repo, i) => disabled[i] === false);
		if (repos.length === 0) return `all ${registered.length} repo(s) disabled`;

		// Imported here rather than at module load: this pulls in the whole dashboard
		// stack, and a daemon that failed to START because of it would also lose the daily
		// backup — the one job it has always had. Inside the tick, the same failure is one
		// caught error reported once by the wrapper below.
		const { dbRescanSessions } = await import("../dashboard/DbBackfill.js");
		const result = await dbRescanSessions({
			repos,
			emitted,
			seedEmitted: !seeded,
			emittedLimit: EMITTED_GATE_LIMIT,
			// Flipped the moment the seed is merged, not from the resolved result: two
			// failure sites live after the seed (phase 3's writer open, anything
			// `applyBatches` throws), and a standing fault there put the full-table scan
			// back on the 30-second path while its own merge sat in memory, already paid for.
			onSeeded: () => {
				seeded = true;
			},
		});

		// The gate is bounded by refusal inside `dbRescanSessions`, so there is nothing to
		// evict here. Saying so once is worth a line: past the cap the newest
		// EMITTED_GATE_LIMIT sessions stay gated and everything beyond them is re-read every
		// tick, which is a real (bounded) cost with no other symptom.
		sayOnce(
			"gate-full",
			emitted.size >= EMITTED_GATE_LIMIT ? "full" : null,
			() => `emission gate full at ${emitted.size} entries -- sessions past it are re-read every tick`,
		);

		// Once per SOURCE, not once overall, and re-armed per source when one recovers.
		//
		// A plain boolean would have been the obvious shape and is wrong in both
		// directions: a second source failing later would be swallowed by the first
		// one's flag, and a source that recovered would leave the flag set. Tracking the
		// set costs nothing and gets both right. The alternative — warning every tick,
		// which is what this did — is 2,880 lines a day for a standing condition
		// (`~/.codex` permissions, an unmounted volume), with tick 1 and tick 2,880
		// indistinguishable.
		const freshFailures = result.failedSources.filter((source) => !warnedFailedSources.has(source));
		if (freshFailures.length > 0) {
			log.warn("[%s] scan failed for %s", sourceTag, freshFailures.join(", "));
		}
		warnedFailedSources = new Set(result.failedSources);

		// Said ONCE, like the baseline warning below and for the same reason: at
		// 30-second ticks a per-tick line about a standing condition is 2,880 a day.
		//
		// This is the first time the number has been surfaced anywhere. A parked event
		// is a conversation the dashboard will never show, and until now nothing
		// reported one — no row, no reader, and the prune only ever deletes `projected`
		// rows, so a failure neither appears nor ages out. That silence is what let one
		// poison event become a permanent write loop unnoticed.
		//
		// Keyed on a CONSTANT rather than the count: under a systematic projection failure
		// the number climbs on every writable open, and keying on it would put a line on
		// every tick.
		sayOnce(
			"parked-events",
			result.failedEvents > 0 ? "some" : null,
			() => `${result.failedEvents} event(s) parked unprojected -- see 'jolli doctor'`,
		);

		// Warned on the COUNT, not on "nothing was scanned at all". A machine with one
		// baselined repo and five without used to say nothing anywhere: the tick reported
		// a healthy re-scan of the one, and the five stayed permanently unvisited with no
		// line to explain why. Still once per situation rather than per tick, and still
		// re-armed below — a database that is wiped or a repo that is newly registered
		// owes the warning again.
		//
		// Keyed on the COUNT, so one unbaselined repo becoming six is said. Under the flag
		// this replaced it was not: the flag only re-armed when the count reached zero.
		sayOnce(
			"no-baseline",
			result.reposWithoutBaseline > 0 ? String(result.reposWithoutBaseline) : null,
			() =>
				`no baseline yet for ${result.reposWithoutBaseline} of ${result.reposWithoutBaseline + result.reposScanned} repo(s) -- run 'jolli dashboard' in each once`,
		);

		// The one idle answer that IS a fault, so unlike its siblings it also warns — once,
		// and re-armed when it clears. It arrives as an idle reason rather than a rejection
		// precisely so it can be said this way: as a throw it was one warn for the daemon's
		// entire lifetime (the dedup key is the message) followed by permanent silence, for a
		// state nothing on this path can repair.
		//
		// Said HERE, beside the three topics that share its shape, rather than inside the
		// `database-unusable` branch below — which is where it was, and that placement is what
		// made "re-armed when it clears" false. A constant situation only ever re-arms if some
		// path passes `null`, and the only path that could was the branch reached when the
		// condition still HELD. So one transient failure (the sibling backup task holding the
		// write lock through `VACUUM INTO`, an `EMFILE`, a schema the read-only handle cannot
		// migrate) spent the warning for the process, and this daemon has no idle timeout —
		// "the process" is the machine's whole uptime. Real corruption afterwards was silent.
		sayOnce(
			"database-unusable",
			result.idleReason === "database-unusable" ? "unusable" : null,
			() => "dashboard database present but unreadable -- see 'jolli doctor'",
		);

		if (result.reposScanned === 0) {
			// Three different situations, three different answers. They used to share one
			// line — "no baseline yet for 0 repo(s) -- run 'jolli dashboard' once" — which
			// prescribed a command that would change nothing, for a count of zero, about
			// repos that in one case no longer exist. `no-sources` in particular is the
			// documented one-line off switch and is supposed to read as "nothing to do".
			if (result.idleReason === "no-sources") return "no source has opted in -- nothing to do";
			if (result.idleReason === "no-live-repos") return `no live checkout for ${repos.length} repo(s)`;
			// Not a fault and not a missing baseline: this machine has never opened the
			// dashboard, so there is no database to read. Said plainly rather than as the
			// baseline line, which would prescribe `jolli dashboard` for its side effect of
			// creating the file — true, but it reads as "your import is incomplete" when
			// nothing has been imported at all.
			if (result.idleReason === "no-database") return "no dashboard database yet -- run 'jolli dashboard' once";
			// Warned above, with the other topics that dedup per situation — see there for why
			// it cannot be warned from inside this branch.
			if (result.idleReason === "database-unusable") return "dashboard database unusable";
			return `no baseline yet for ${result.reposWithoutBaseline} repo(s) -- run 'jolli dashboard' once`;
		}

		if (result.processed === 0) {
			// The converged tick. Returned for the scheduler's debug line and nothing more.
			return `${result.discovered} session(s) unchanged across ${result.reposScanned} repo(s)`;
		}

		const line = `re-read ${result.processed} of ${result.discovered} session(s) across ${result.reposScanned} repo(s), ${result.eventsApplied} event(s) applied`;
		log.info("[%s] %s", sourceTag, line);
		return line;
	};

	/**
	 * {@link tick} with its failures reduced to one line per distinct fault.
	 *
	 * Resolves rather than rejects, which is the point: `TaskScheduler` warns on every
	 * rejection and keeps the schedule, so a standing fault (an unreadable or corrupt
	 * `jollimemory.db`, a disk that filled, a dynamic import that cannot resolve) reached
	 * it 2,880 times a day. The message is the dedup key so a DIFFERENT fault appearing
	 * later is still said, and clearing it on a good tick re-arms the warning — the same
	 * once-per-situation shape as every other outcome above.
	 *
	 * The string it returns still reaches the scheduler's debug line, so a failing tick is
	 * visible under `logLevel: "debug"` on every tick, not only the first.
	 */
	const run = async (): Promise<string> => {
		try {
			const line = await tick();
			// Cleared directly rather than through `sayOnce(…, null, …)`: there is no message
			// to render on the success path, and a dummy one would read as if there were.
			said.delete("tick-failure");
			return line;
		} catch (error: unknown) {
			const message = errMsg(error);
			sayOnce("tick-failure", message, () => `tick failed: ${message}`);
			return `failed: ${message}`;
		}
	};

	return { name: SESSION_RESCAN_TASK_NAME, tickIntervalMs, run };
}
