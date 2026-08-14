/**
 * DashboardCommand — `jolli dashboard`, the one command that serves the local
 * dashboard (the `jolli stats` / `jolli standup` page aliases are retired; the
 * pages themselves stay served).
 *
 * An ordinary foreground command: it registers the current repo, brings the
 * database schema up, binds the loopback port **in this process**, opens the
 * browser at the plain page URL (no token — see DashboardServer's security
 * model for what does and does not gate access), and serves until Ctrl+C.
 *
 * It used to be a launcher for a detached server, with everything that implies:
 * a `dashboard.json` pid/port record, a `/health` reuse probe, a spawn lock, an
 * idle self-shutdown and a `--stop` flag. All of that existed to keep ONE
 * background process alive across invocations, and it is gone — along with its
 * most expensive consequence, that a reused server could be running an older
 * build than the CLI that found it and therefore could not be allowed to
 * migrate the schema.
 *
 * The order still puts the page first: bind → open browser → run the backfill,
 * then wait for the signal. The page renders whatever the DB already holds and
 * polls `/api/model`, so history fills in behind it. The import now shares this
 * process's event loop, which is why it stays after the bind rather than before.
 *
 * Browser opening deliberately does NOT go through `openUrlOrPrint` — that
 * helper enforces an https-only allowlist that (correctly) rejects
 * `http://127.0.0.1`, and loosening it for localhost would weaken every other
 * caller. The `open` package is used directly, dynamically imported because
 * open v11 is pure ESM and the VS Code bundle is CJS.
 */

import { statSync } from "node:fs";
import { hostname } from "node:os";
import type { Command } from "commander";
import { getProjectRootDir } from "../core/GitOps.js";
import { readManualDisableFlagSync } from "../core/RepoProfile.js";
import { getGlobalConfigDir } from "../core/SessionTracker.js";
import { maybeAutoCutover } from "../dashboard/AutoCutover.js";
import { opportunisticSnapshot } from "../dashboard/Backup.js";
import { canUseDashboardDb, DASHBOARD_SQLITE_MIN_VERSION, ensureDashboardDbExists } from "../dashboard/DashboardDb.js";
import {
	DASHBOARD_HEALTH_SERVICE,
	DASHBOARD_PORTS,
	type StartedDashboardServer,
	startDashboardServer,
} from "../dashboard/DashboardServer.js";
import { type DbBackfillProgress, dbBackfillRepos } from "../dashboard/DbBackfill.js";
import { listActiveRepos, registerRepo } from "../dashboard/RepoRegistry.js";
import { type ServerTelemetryHandle, startServerTelemetry } from "../dashboard/ServerTelemetry.js";
import { createLogger, errMsg } from "../Logger.js";

const log = createLogger("DashboardCommand");

export interface DashboardOptions {
	readonly port?: string;
	readonly open?: boolean;
	readonly cwd?: string;
}

/**
 * Where this command's human-facing lines go.
 *
 * Defaults to the console, which is exactly right for a terminal. A GUI host is
 * the reason this is a seam at all: the VS Code extension bundles this module
 * and runs it inside the extension host, whose `console` writes to the debug
 * console — a place no user has open. Without a writer to hand over, every line
 * this command produces (the URL it just opened, and more importantly each
 * failure reason) would be invisible on that surface.
 *
 * Every member must stay a total function rather than an optional one: a partial
 * writer would silently drop a whole class of output, and the classes most likely
 * to go missing are the ones nothing else reports.
 */
export interface DashboardOutput {
	readonly log: (line: string) => void;
	readonly error: (line: string) => void;
	/**
	 * A line the user has to SEE, on a host where `log` is somewhere they don't
	 * look.
	 *
	 * `log` and `error` are both fine on a terminal, where every line is already
	 * in front of the user — which is why the split only pays off in a GUI. There
	 * `log` lands in an output channel nobody opens, and that is the right home
	 * for progress and for a reason that accompanies a visible failure. It is the
	 * wrong home for a line that is the ONLY explanation of something the user is
	 * looking at right now: the disabled-repo notice below opens the dashboard
	 * successfully and silently leaves this repo out of it, so routing it through
	 * `log` moves it from one unread place to another.
	 *
	 * NOT an error, so it must not be `error`: nothing failed, and a host that
	 * renders `error` as a modal or a red toast would be lying about it.
	 */
	readonly notice: (line: string) => void;
}

/**
 * The default writer. Behaviourally identical to the direct `console` calls it
 * replaced.
 *
 * The members WRAP `console.log`/`console.error` instead of referencing them
 * (`log: console.log`), and that is load-bearing rather than style: a direct
 * reference binds the original function at module load, so a `vi.spyOn(console,
 * "log")` installed afterwards would never be seen. Every existing assertion on
 * this command's output is a console spy, so the reference form would leave them
 * all passing against a console nothing writes to.
 */
const CONSOLE_OUTPUT: DashboardOutput = {
	log: (line: string) => console.log(line),
	error: (line: string) => console.error(line),
	// Same stream as `log`, because on a terminal it already IS in front of the
	// user — the distinction only means something to a host that has somewhere
	// else to put it.
	notice: (line: string) => console.log(line),
};

/** Injectable seams — every process/network/browser effect goes through these. */
export interface DashboardDeps {
	readonly configDir?: string;
	readonly dbPath?: string;
	/**
	 * Where the human-facing lines go. Defaults to {@link CONSOLE_OUTPUT}, so a
	 * caller that omits it gets the pre-seam behaviour byte for byte.
	 */
	readonly output?: DashboardOutput;
	readonly openBrowser?: (url: string) => Promise<void>;
	/** Binds the port. Injected so tests never open a real socket. */
	readonly startServer?: (options: {
		readonly port?: number;
		readonly configDir?: string;
		readonly dbPath?: string;
		readonly serverCwd?: string;
	}) => Promise<StartedDashboardServer>;
	/** Arms the periodic telemetry flush this long-lived process needs. */
	readonly startTelemetry?: () => Promise<ServerTelemetryHandle>;
	/**
	 * Blocks until the user stops the server. The default registers
	 * SIGINT/SIGTERM; tests pass a resolved promise so the suite does not hang.
	 */
	readonly waitForShutdown?: (started: StartedDashboardServer, telemetry: ServerTelemetryHandle) => Promise<void>;
	/** Asks a port whether a dashboard is on it. `null` means "not one of ours". */
	readonly probeHealth?: (port: number) => Promise<DashboardHealth | null>;
	/** Signals the previous dashboard. Returns whether the signal was delivered. */
	readonly killPid?: (pid: number) => boolean;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
}

/** What a `/health` answer says about the process holding a candidate port. */
export interface DashboardHealth {
	/** The responder's own process id, already checked to be signal-shaped. */
	readonly pid: number;
	/**
	 * The responder PROVED it is in a different pid namespace, so {@link
	 * reclaimPort} must not resolve `pid` locally. Absent means "no evidence
	 * either way", which is the legacy payload and every pre-`platform` build.
	 */
	readonly foreign?: boolean;
}

/** The pid namespace `identifyDashboardHealth` is deciding reachability against. */
export interface LocalIdentity {
	readonly platform: string;
	readonly host: string;
}

/**
 * Whether a value is a process id this may hand to `process.kill`.
 *
 * `typeof pid === "number"` is NOT that test, and the gap is the whole reason
 * this exists. `process.kill` forwards its argument to `kill(2)`, where **0 means
 * every process in the CALLER's own process group** and a negative means the
 * group `-pid` — so a `/health` body answering `pid: 0` does not fail, it SIGTERMs
 * this CLI along with whatever shares its group (the user's shell pipeline
 * included). A non-integer throws `ERR_OUT_OF_RANGE` instead, which is merely
 * noise, but it is not a pid either.
 */
function isSignalablePid(pid: unknown): pid is number {
	return typeof pid === "number" && Number.isInteger(pid) && pid > 0;
}

/**
 * Decides whether a `/health` body belongs to one of our dashboards, and yields
 * the pid to signal if it does.
 *
 * A pure function of its own, deliberately OUTSIDE the ignore region below,
 * because this is the decision that authorises a SIGTERM in {@link reclaimPort} —
 * the one thing on this path worth testing directly rather than through a socket.
 *
 * Two accepted shapes, and the second is a compatibility story rather than
 * redundancy:
 *
 *  - **Current** — must NAME the service (`DASHBOARD_HEALTH_SERVICE`). Matching
 *    `{ok: true, pid: number}` instead, as this once did, means signalling
 *    whatever happens to answer: that is among the most common health payloads
 *    there is, and under an explicit `--port` the probe is aimed straight at a
 *    port a dev server is far more likely to hold than a dashboard.
 *  - **Legacy** — the detached server this command replaced answered `{ok, pid,
 *    port, schemaVersion}` and knows nothing about the marker. That process
 *    SURVIVES the upgrade which introduced it (it was detached and self-managed,
 *    so nothing stops it), and without this arm a freshly upgraded CLI could never
 *    take 1818 back from it — it would silently serve on the fallback port for as
 *    long as the old process lived. Those four fields together are specific enough
 *    to accept on their own; the two the current arm rejects were not.
 *
 * Being one of ours is necessary and not sufficient, because a process id is only
 * meaningful inside the namespace that issued it. A dashboard in WSL, a container
 * or another user's session answers loopback perfectly well; resolving its id here
 * finds either nothing (which `unstoppable` already covers) or an UNRELATED local
 * process, which is then killed while the port stays held — a wrong kill with no
 * symptom, since the fallback line that follows looks exactly the same either way.
 * So `platform`/`host` are compared against this process's own, and a mismatch is
 * reported rather than signalled. Neither field being present is the pre-existing
 * "no evidence" case and stays signallable: gating on their absence would make
 * every dashboard from an older build unreclaimable, which is the failure the
 * legacy arm exists to avoid.
 *
 * `local` is a parameter so the comparison is testable without a second machine.
 */
export function identifyDashboardHealth(
	body: unknown,
	local: LocalIdentity = { platform: process.platform, host: hostname() },
): DashboardHealth | null {
	if (typeof body !== "object" || body === null) return null;
	const { ok, pid, service, port, schemaVersion, platform, host } = body as Record<string, unknown>;
	if (ok !== true || !isSignalablePid(pid)) return null;
	const ours =
		service === DASHBOARD_HEALTH_SERVICE || (typeof port === "number" && typeof schemaVersion === "number");
	if (!ours) return null;
	const elsewhere =
		(typeof platform === "string" && platform !== local.platform) ||
		(typeof host === "string" && host !== local.host);
	return elsewhere ? { pid, foreign: true } : { pid };
}

/* v8 ignore start -- default seams do real socket/browser/signal work; tests inject fakes */
/**
 * Asks a port whether one of our dashboards is on it.
 *
 * Any failure — nothing listening, a foreign service, a non-JSON body — is
 * `null` rather than a throw, so a launch is never blocked by whatever else
 * happens to hold the port. Whether an answer counts as ours is
 * {@link identifyDashboardHealth}'s call, not this function's.
 *
 * **The timeout is generous on purpose, and "it is local so it will be fast" is
 * the wrong way to set it.** The thing being probed is a dashboard, and a
 * dashboard runs its history import on the very event loop that has to answer
 * this — `node:sqlite` is synchronous, so a first full sweep stalls it for well
 * over half a second at a time. A probe that gives up early reads a busy
 * dashboard as ABSENT, and the reclaim then reports "nothing there" while the
 * port is still held: the bind falls through to 18118 and the user ends up with
 * two live dashboards running concurrent imports and cutover attempts against
 * one database. That is the exact failure this whole step exists to prevent.
 *
 * Waiting longer is nearly free in the case that actually matters: a port with
 * nothing on it refuses the connection immediately rather than timing out, so
 * this budget is only ever spent on something that accepted the connection and
 * then went quiet.
 */
const HEALTH_PROBE_TIMEOUT_MS = 1_500;

async function defaultProbeHealth(port: number): Promise<DashboardHealth | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
	try {
		const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
		if (!res.ok) return null;
		return identifyDashboardHealth(await res.json());
	} catch {
		return null;
	} finally {
		// Cleared once the BODY is parsed, never when the headers arrive. The abort
		// has to stay armed across `res.json()` or the budget above does not bound
		// this call at all: a service that answers 200 and then stalls its body
		// leaves undici's own `bodyTimeout` as the only remaining limit at 300 s,
		// and that one is an INACTIVITY timer, so a slow-drip body resets it for as
		// long as it likes — an unbounded hang on the launch path, under a comment
		// promising a short timeout.
		clearTimeout(timer);
		// Aborted on EVERY exit, not only on the timeout, because the non-2xx arm
		// above returns without reading the body: undici keeps that socket and its
		// pending response alive, ref'd, so a `jolli dashboard` whose probe met an
		// unrelated service could sit on a live handle for the rest of the run. A
		// request that already finished ignores this.
		controller.abort();
	}
}

function defaultKillPid(pid: number): boolean {
	// Last check before the syscall, and not redundant with
	// `identifyDashboardHealth`: this is a seam, so the pid reaching it came from
	// whatever `probeHealth` a caller supplied. See {@link isSignalablePid} for why
	// a plain `typeof === "number"` is not a guard here — `process.kill(0)` signals
	// this process's whole group rather than failing.
	if (!isSignalablePid(pid)) return false;
	try {
		process.kill(pid);
		return true;
	} catch {
		// Already gone, or not ours to signal. Either way there is nothing to
		// reclaim and the bind below reports what actually happened.
		return false;
	}
}

async function defaultOpenBrowser(url: string): Promise<void> {
	const open = (await import("open")).default;
	const child = await open(url);
	child.unref();
}

/**
 * Waits for Ctrl+C (or a `kill`), then closes the listener.
 *
 * Deliberately does NOT call `process.exit()`. The detached entry this replaces
 * had to — nothing ran after it — but here the stack unwinds back into `Cli.ts`,
 * whose tail flushes telemetry one last time and triggers the machine-global
 * daemon. Exiting here would skip both.
 *
 * The listeners are removed on the way out so a second server started in the
 * same process (tests, a future embedder) does not inherit them.
 */
function defaultWaitForShutdown(started: StartedDashboardServer, telemetry: ServerTelemetryHandle): Promise<void> {
	return new Promise<void>((resolve) => {
		let done = false;
		const stop = (): void => {
			if (done) return;
			done = true;
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
			started.server.closeAllConnections();
			started.server.close();
			void telemetry.stop().then(resolve, resolve);
		};
		// SIGTERM is never delivered on Windows; Ctrl+C arrives as SIGINT there.
		// Registering both keeps one code path across platforms.
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);
	});
}

/**
 * Resolves every seam to a concrete implementation, so the `?? default`
 * fallbacks live in exactly one place — inside this region, because a test that
 * took one of them would bind a socket, open a browser or park on a signal,
 * which is the whole reason the seams exist.
 */
function resolveSeams(deps: DashboardDeps): ResolvedSeams {
	return {
		configDir: deps.configDir ?? getGlobalConfigDir(),
		output: outputOf(deps),
		openBrowser: deps.openBrowser ?? defaultOpenBrowser,
		startServer: deps.startServer ?? startDashboardServer,
		startTelemetry: deps.startTelemetry ?? (() => startServerTelemetry()),
		waitForShutdown: deps.waitForShutdown ?? defaultWaitForShutdown,
		probeHealth: deps.probeHealth ?? defaultProbeHealth,
		killPid: deps.killPid ?? defaultKillPid,
		sleep: deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
		// Resolved here as well as being read raw by `runHistoryImport`, which
		// forwards `deps.now` to `dbBackfillRepos` and needs the ABSENCE preserved
		// (that option is optional there too). The reclaim's deadline needs a
		// function it can call unconditionally, so it takes the resolved one.
		now: deps.now ?? Date.now,
	};
}
/* v8 ignore stop */

/**
 * The writer this call should use.
 *
 * Its own function rather than only a {@link resolveSeams} field because
 * {@link runHistoryImport} and {@link importDashboardHistory} print without ever
 * resolving the process/network seams — they have no server to reach.
 */
function outputOf(deps: DashboardDeps): DashboardOutput {
	return deps.output ?? CONSOLE_OUTPUT;
}

/** {@link DashboardDeps} with every optional seam filled in. */
interface ResolvedSeams {
	readonly configDir: string;
	readonly output: DashboardOutput;
	readonly openBrowser: (url: string) => Promise<void>;
	readonly startServer: NonNullable<DashboardDeps["startServer"]>;
	readonly startTelemetry: () => Promise<ServerTelemetryHandle>;
	readonly waitForShutdown: (started: StartedDashboardServer, telemetry: ServerTelemetryHandle) => Promise<void>;
	readonly probeHealth: NonNullable<DashboardDeps["probeHealth"]>;
	readonly killPid: NonNullable<DashboardDeps["killPid"]>;
	readonly sleep: (ms: number) => Promise<void>;
	readonly now: () => number;
}

/**
 * Takes one candidate port back from a dashboard that is already on it.
 *
 * Every launch starts a fresh server, so an earlier one has to go. Finding it
 * needs SOME discovery, and this is the cheapest form that is still safe:
 *
 *  - **Ask the port, not a file.** There is no `dashboard.json` any more, and it
 *    is not coming back. The candidate ports are fixed, so a probe of each one
 *    answers "is a dashboard here" without anything on disk to go stale.
 *  - **Only kill what identifies itself.** The pid comes from `/health` on the
 *    port about to be taken, so it is alive by construction, and the body has to
 *    NAME this service before that pid is signalled — see
 *    {@link identifyDashboardHealth}, which is where "identifies itself" is
 *    actually decided. Anything else holding 1818 — an unrelated local service,
 *    very much including one whose own `/health` answers `{ok: true, pid: …}` —
 *    fails that check, is left alone, and the bind falls through to the next
 *    candidate exactly as before.
 *  - **Only kill what this process's pids can name.** Identifying itself is not
 *    enough: an id is only meaningful inside the namespace that issued it, so a
 *    body declaring a foreign `platform`/`host` is reported, never signalled.
 *
 * That is the whole difference from the launcher this replaced: it discovers in
 * order to REPLACE, never to attach. Nothing here can serve a page from a build
 * older than this one, which is what made the old reuse expensive.
 *
 * FOUR outcomes, which is why this does not return a boolean: nothing of ours was
 * there, we stopped it, we signalled it and it is STILL holding the port, or we
 * found one and could not signal it at all.
 *
 * The last two are both real rather than theoretical, and they are not the same
 * thing. `killPid` answers whether the signal was DELIVERED, never whether the
 * process died — so a delivered signal followed by a port that never frees is
 * `signalled`, not `stopped`. Collapsing the two is a message bug with teeth:
 * "Stopped the dashboard already running on port 1818" printed immediately above
 * "Port 1818 was in use — serving on 18118 instead" tells the user two
 * contradictory things about one port, and the first of them is false.
 * `unstoppable` is the other half — the process id comes from an HTTP response,
 * and answering on loopback does not make a process ours to signal. A dashboard
 * running inside WSL answers a Windows `jolli` perfectly well and reports a Linux
 * process id; the same holds for a container, or another user's process.
 * Reporting either as "nothing there" left the port silently changing with no
 * explanation anywhere, which is precisely what the fallback line exists to
 * prevent.
 *
 * That outcome is now reached two ways, and only one of them is a failed signal.
 * Treating "the kill did not land" as the whole story assumed a foreign id would
 * not resolve here — true for the pid a Linux dashboard reports to a Windows CLI
 * only while nothing local happens to hold it. When something does, the signal
 * lands on a stranger: an unrelated process dies, the port stays held, and the
 * outcome is `signalled` — indistinguishable from a dashboard being slow to let
 * go. So a proven-foreign responder short-circuits to `unstoppable` BEFORE
 * `killPid` is reached, which is the only point at which the two are still
 * distinguishable.
 */
type ReclaimOutcome = "none" | "stopped" | "signalled" | "unstoppable";

async function reclaimPort(port: number, seams: ResolvedSeams): Promise<ReclaimOutcome> {
	const health = await seams.probeHealth(port);
	if (!health || !isSignalablePid(health.pid)) return "none";
	// One of ours, but running where this process's pids do not apply — see
	// `identifyDashboardHealth`. Reported rather than signalled: resolving that id
	// here would hit an unrelated local process, and killing it would neither free
	// the port nor leave any sign of what happened.
	if (health.foreign) return "unstoppable";
	if (health.pid === process.pid) return "none";
	if (!seams.killPid(health.pid)) return "unstoppable";
	// A killed listener does not release the port synchronously. Poll the probe
	// rather than sleeping a fixed amount: the common case frees in a few ms, and
	// a bounded wait beats binding the fallback port for a server that was about
	// to let go. Falling through after the budget is safe — the bind loop then
	// moves to the next candidate, which is the pre-existing behaviour.
	//
	// The budget is WALL CLOCK, not an iteration count, and the difference is the
	// probe: each pass also awaits `probeHealth`, which can spend
	// `HEALTH_PROBE_TIMEOUT_MS` before answering. At 50 ms per iteration a
	// count-based budget of 2 s buys 40 passes, so a port that stops answering
	// *slowly* rather than refusing outright stretched this to a minute or more —
	// on the launch path, under a constant that says two seconds.
	//
	// Wall clock does not make the ceiling exactly two seconds either, and the
	// overshoot is bounded rather than absent: the deadline is checked BEFORE a
	// pass, so the last one can start just under it and still spend a sleep plus a
	// full probe timeout, i.e. ~3.5 s worst case. That also means a port answering
	// at the timeout gets ~2 polls, not 40 — which is the right number, because
	// the case this wait exists for (a listener releasing a port it was just told
	// to drop) refuses the connection instantly and is answered on the first pass.
	const deadline = seams.now() + RECLAIM_TIMEOUT_MS;
	while (seams.now() < deadline) {
		await seams.sleep(RECLAIM_POLL_MS);
		if (!(await seams.probeHealth(port))) return "stopped";
	}
	return "signalled";
}

/** How long to wait for a killed dashboard to release its port. */
const RECLAIM_TIMEOUT_MS = 2_000;
const RECLAIM_POLL_MS = 50;

/**
 * Says what the reclaim of one candidate port did, if anything.
 *
 * Takes the port it is reporting on rather than reading the preferred one,
 * because the caller now walks every fixed candidate and a line naming the wrong
 * port is worse than no line: the whole purpose of these three is to explain a
 * port change the user did not ask for.
 */
function reportReclaim(port: number, outcome: ReclaimOutcome, output: DashboardOutput): void {
	if (outcome === "stopped") {
		output.log(`\n  Stopped the dashboard already running on port ${port}.`);
	} else if (outcome === "signalled") {
		// Says what was actually observed, because the fallback line below is about
		// to say the port is still in use. Claiming "Stopped" here — which is what a
		// single "we sent the signal" outcome did — put those two lines together and
		// made one of them a lie.
		output.log(`\n  Asked the dashboard on port ${port} to stop, but it is still holding the port.`);
	} else if (outcome === "unstoppable") {
		// Names the process this launch could not stop, because the user is the
		// only one who can: it answers on loopback but is out of this process's
		// reach — another user, a container, or (measured) a dashboard inside WSL
		// answering a Windows CLI with a Linux process id.
		output.log(
			`\n  A dashboard is already on port ${port} and could not be stopped from here` +
				" — it may belong to another user, a container, or WSL. Stop it there, or use --port.",
		);
	}
}

/**
 * Resolves the repo directory the server answers for, from the raw
 * `--cwd`/process cwd.
 *
 * Two guarantees, both inherited from when this computed a detached child's
 * `cwd` and both still load-bearing now that it feeds `serverCwd` directly:
 *
 *  - **Always a real directory.** An invalid `--cwd` (nonexistent, or a file)
 *    falls back to `process.cwd()`, which always exists. The Settings page reads
 *    this path per request; a bogus one would surface as a failure per render
 *    rather than once, at launch, where it can be reasoned about.
 *  - **The repo ROOT, not a subdir.** Launched from `repo/sub`, the raw cwd is
 *    `repo/sub`, and the Settings page's per-repo displays and repo-scoped
 *    actions (generate-missing, migrate, sync-now, the push list's "this repo"
 *    marker) would then answer for a subdirectory rather than the repo.
 *
 * `getRoot` is injected for tests; production uses the real `getProjectRootDir`.
 * Non-repo directories (and any git failure) keep the validated base dir.
 */
export async function resolveServerCwd(
	rawCwd: string,
	getRoot: (cwd: string) => Promise<string> = getProjectRootDir,
): Promise<string> {
	let base = process.cwd();
	try {
		if (statSync(rawCwd).isDirectory()) base = rawCwd;
	} catch {
		// nonexistent path or a file — keep the always-valid process.cwd()
	}
	try {
		const root = await getRoot(base);
		if (statSync(root).isDirectory()) return root;
	} catch {
		// `base` is not inside a git repo (or git is unavailable) — use it as-is
	}
	return base;
}

/** A bound foreground dashboard: already serving, not yet waited on. */
export interface ForegroundDashboard {
	readonly port: number;
	/** Resolves once the user has stopped the server. */
	readonly waitForShutdown: () => Promise<void>;
}

/**
 * Binds the port, opens the browser and prints the URL — everything up to, but
 * not including, waiting for the signal.
 *
 * Split from {@link executeDashboard} for one caller: the guided front door has
 * already run the import by the time it offers to open the dashboard, and going
 * back through `executeDashboard` would run it a second time — printing "all N
 * memories were already migrated" directly under the block that just migrated
 * them, which reads as a failure.
 *
 * Returns before the wait so the caller controls the ordering: `executeDashboard`
 * runs the import between the two halves, which is what keeps the page up while
 * history fills in behind it.
 */
export async function startForegroundDashboard(
	page: "stats" | "standup",
	options: { readonly port?: number; readonly open?: boolean; readonly cwd?: string },
	deps: DashboardDeps = {},
): Promise<ForegroundDashboard> {
	const seams = resolveSeams(deps);
	const serverCwd = await resolveServerCwd(options.cwd ?? process.cwd());

	// Every launch is a fresh server, so a dashboard already running has to go —
	// see {@link reclaimPort} for why this discovers by asking the port rather than
	// by reading a file, and why it can only ever kill one of ours.
	//
	// EVERY fixed candidate is reclaimed, not just the one this launch prefers, and
	// the difference is not hypothetical. Reclaiming only the preferred port is
	// correct exactly while the preferred port is available: let an unrelated local
	// service hold 1818, and the first launch falls back to 18118, the second
	// reclaims a 1818 that was never ours, finds 18118 taken by the first
	// dashboard and lands on an OS-assigned port. That is two dashboards running
	// concurrent history imports and cutover attempts against one database —
	// precisely the state this step exists to prevent, reached without either
	// launch doing anything unusual. Probing the second candidate is nearly free
	// when nothing is on it: the connection is refused immediately rather than
	// timing out.
	//
	// An explicit `--port` narrows this to that port alone, matching the bind's own
	// candidate list. The OS-assigned fallback cannot be covered either way — there
	// is no port to probe — so the invariant is "one dashboard across the fixed
	// candidates", not "one on the machine".
	const candidates = options.port !== undefined ? [options.port] : [...DASHBOARD_PORTS];
	for (const candidate of candidates) {
		reportReclaim(candidate, await reclaimPort(candidate, seams), seams.output);
	}

	// Armed after the reclaim and before the bind: this process serves for as long
	// as the user leaves the tab open, so the `/api/telemetry` beacon's events need
	// a periodic drain rather than only the one `Cli.ts` does on exit.
	const telemetry = await seams.startTelemetry();
	let started: StartedDashboardServer;
	try {
		started = await seams.startServer({
			...(options.port !== undefined ? { port: options.port } : {}),
			configDir: seams.configDir,
			...(deps.dbPath ? { dbPath: deps.dbPath } : {}),
			serverCwd,
		});
	} catch (err) {
		// The flusher is armed before the bind and nothing else will ever stop it
		// on this path, since the caller only gets a handle on success.
		await telemetry.stop();
		throw err;
	}

	// View token → its ONE served path. `/stats` and `/standup` were removed as
	// paths (see `VIEW_PATHS`), so this mapping is what keeps the command from
	// opening a 404 — the token and the URL are no longer the same string.
	const url = `http://127.0.0.1:${started.port}${page === "standup" ? "/dashboard/standup" : "/dashboard"}`;
	if (options.open !== false) {
		try {
			await seams.openBrowser(url);
		} catch (err) {
			log.warn("could not open the browser (non-fatal): %s", errMsg(err));
		}
	}
	if (started.fellBack) {
		// The only symptom of something else already holding the preferred port —
		// with no state record and no reuse probe, an unexplained port is otherwise
		// unexplainable. The likeliest cause is a background server from a build
		// before this one, which exits on its own within a couple of hours.
		//
		// Names every candidate that was actually passed over rather than only the
		// first. `fellBack` is true for BOTH later candidates, and when the bind
		// lands on the OS-assigned one it is because 1818 *and* 18118 were taken —
		// reporting just 1818 there is true but reads as though the documented
		// fallback port were still free, which is the one thing a user would check
		// next. An explicit `--port` cannot reach this line (its candidate list is
		// one long), so these two are the whole set.
		const taken = DASHBOARD_PORTS.filter((candidate) => candidate !== started.port);
		const ports = taken.join(" and ");
		seams.output.log(
			taken.length > 1
				? `\n  Ports ${ports} were in use — serving on ${started.port} instead.`
				: `\n  Port ${ports} was in use — serving on ${started.port} instead.`,
		);
	}
	seams.output.log(`\n  Jolli dashboard → ${url}`);
	seams.output.log("  Press Ctrl+C to stop.\n");

	return { port: started.port, waitForShutdown: () => seams.waitForShutdown(started, telemetry) };
}

/**
 * The write side on its own: bring the dashboard database up to date from every
 * registered repo (bootstrap or gap recovery, plus the orphan-branch
 * source-of-truth import) and report what actually landed.
 *
 * Split out of {@link executeDashboard} because the import is the only part
 * `jolli enable` and the guided front door actually need. `dbBackfillRepos` is
 * the sole production caller of the SOT import, so memories just written would
 * otherwise sit outside the database until someone ran `jolli dashboard` by
 * hand — but wanting that import is no reason to bind a port, take over the
 * user's browser, or (now that the server is in the foreground) hold their
 * terminal until Ctrl+C. Those two entry points call this; serving stays a
 * `jolli dashboard` decision.
 *
 * Never throws: a failed import is a warning, not a failed enable.
 */
/**
 * Block headers, chosen by whichever tier reveals the block.
 *
 * Separate strings because they describe different work: `commits` re-sweeps git
 * whenever any branch tip moves, while `memories` is cursor-gated on the orphan
 * tip and normally does nothing at all.
 */
const MIGRATION_HEADER = "\n  Migrating your memories to the Jolli Memory database…";
const HISTORY_HEADER = "\n  Indexing your git history…";

async function runHistoryImport(deps: DashboardDeps): Promise<void> {
	const output = outputOf(deps);
	try {
		const repos = await listActiveRepos(deps.configDir);
		// Zero registered repos stays completely silent, header included: there is
		// no work, and announcing none is worse than saying nothing. The call still
		// happens — `dbBackfillRepos([])` is a no-op, and skipping it would make this
		// function's contract depend on the registry, which callers rely on not
		// doing.
		const quiet = repos.length === 0;
		// Held, not printed: on a steady-state pass the whole block is noise. The
		// import itself is cursor-gated (see DbBackfill's `sot-import`), so a converged
		// run does no memory work at all — but the phase markers still fire for the
		// tiers that DO run every time (sessions), and a header announcing a
		// migration that will not happen is exactly what made this look like it
		// re-migrated on every launch. The header is therefore chosen at reveal time
		// by the tier that had work, not written up front. The closing ✓ line is the
		// honest report and prints either way.
		const out = createDeferredWriter(output.log);
		const printer = createProgressPrinter({ log: out.write });
		const results = await dbBackfillRepos(repos, {
			...(deps.dbPath ? { dbPath: deps.dbPath } : {}),
			...(deps.now ? { now: deps.now } : {}),
			// THE reveal rule: only the two tiers that are cursor-gated may put this
			// block on screen. `commits` events exist only when the checkout
			// fingerprint moved, `memories` events only when the orphan tip did — so
			// seeing either means there is genuinely something to migrate, and seeing
			// neither means every gate held.
			//
			// `sessions` is excluded on purpose, and it is the whole reason a
			// done-based rule is not enough: that tier re-projects the discoverable
			// set on EVERY pass by design (an old session can be updated out of
			// order), so its batches report real per-item progress on a run where
			// nothing changed. `summaries` is excluded for symmetry — its phase marker
			// now fires only inside its own gate, so it cannot reach here ungated
			// anyway.
			onProgress: (progress) => {
				// The header names the tier that actually has work. Scanning git history
				// is NOT migrating memories, and titling it that way is what made a
				// routine commit sweep read as "it re-migrates everything on every
				// launch" — the memory tier had converged and said so on the next line.
				if (progress.kind === "commits") out.reveal(HISTORY_HEADER);
				else if (progress.kind === "memories") out.reveal(MIGRATION_HEADER);
				printer.onProgress(progress);
			},
		});
		// A repo whose every registered worktree is gone is not counted with the
		// ones that were imported: it was never swept, so `results` — never
		// `repos` — is what this report may count, minus the entries that only say
		// "not here". Unfiltered it printed "✓ All 0 memories already migrated."
		const worked = results.filter((r) => r.mode !== "unavailable");
		const missing = results.filter((r) => r.mode === "unavailable");
		// ONE line for the whole run, naming the repos. The three warnings per repo
		// per pass this replaced were the reason it went silent, but silence is not
		// the fix: "no checkout on disk" is also what a network share or an
		// external drive looks like while it is unmounted, and in that case the
		// user is still expecting these memories to arrive. The wording says what
		// was observed and what follows from it — not "failed", which is what a
		// `skipped` row below means.
		//
		// Printed directly rather than through the deferred writer, and WITHOUT
		// revealing a header: nothing was migrated for these repos, so putting
		// "Migrating your memories…" on screen because one of them is unmounted
		// would re-introduce, in the block that exists to avoid it, exactly the
		// claim the reveal rule is there to prevent.
		if (missing.length > 0) {
			// A SAMPLE of distinct names, never the whole list. Measured on a real
			// registry: 132 dead entries, most of them named `repo` — test fixtures
			// that predate the `isolatedHome` fix in this same change — printed as
			// one 132-item line that buried the ✓ result under it. Nothing prunes
			// this file, so the count only grows. Distinct because a list reading
			// "repo, repo, repo" identifies nothing; the count carries the scale and
			// the sample carries "which kind of thing is this".
			const distinct = [...new Set(missing.map((r) => r.repoName))];
			const sample = distinct.slice(0, 3).join(", ");
			const rest = distinct.length > 3 ? `, +${distinct.length - 3} more` : "";
			output.log(
				`\n  ⚠ Skipped ${missing.length} repo(s) with no checkout on disk (${sample}${rest})` +
					" — deleted, or on a drive that is not mounted. Still registered; they resume on their own.",
			);
		}
		// With every entry dead that leaves nothing more to say, and the
		// zero-registered-repos rule applies for the same reason: announcing work
		// on repos that were not touched is worse than silence.
		if (quiet || worked.length === 0) return;
		// A failure has to be shown in context — which repo, under which header.
		if (worked.some((r) => r.mode === "skipped")) out.reveal(MIGRATION_HEADER);
		// A repo that threw used to reach `log.error` and nothing else, so on
		// screen it was indistinguishable from a repo with nothing to do.
		for (const failed of worked.filter((r) => r.mode === "skipped")) {
			output.log(`  ⚠ ${failed.repoName} — migration failed: ${failed.error ?? "unknown error"}`);
		}
		// Report what actually happened, not what was re-projected. A steady-state
		// recovery pass still applies events — sessions and worktree state are
		// re-projected every time by design, as idempotent UPSERTs — so printing
		// that count unconditionally read as "imported 26 events" on a run that
		// changed nothing.
		//
		// The counts are MEMORIES, not events: events are the activity tier, and
		// this whole line is about the thing the user was told was migrating.
		const migrated = worked.reduce((sum, r) => sum + (r.sotImport?.nodes ?? 0), 0);
		const bootstrapped = worked.filter((r) => r.mode === "bootstrapped").length;
		const newMemories = worked.reduce((sum, r) => sum + (r.sotImport?.updated ?? 0), 0);
		const across = worked.length > 1 ? ` across ${bootstrapped || worked.length} repo(s)` : "";
		if (bootstrapped > 0 || newMemories > 0) {
			// Something landed, so the progress that produced it belongs on screen —
			// including the runs too fast to have tripped the elapsed-time reveal.
			out.reveal(MIGRATION_HEADER);
			output.log(`  ✓ Migrated ${migrated} ${migrated === 1 ? "memory" : "memories"}${across}.\n`);
		} else {
			// Previously this branch printed NOTHING, which is the bug that started
			// all this: a converged re-run looked identical to a run that never
			// happened.
			output.log(`  ✓ All ${migrated} ${migrated === 1 ? "memory" : "memories"} already migrated.\n`);
		}
	} catch (err) {
		output.error(`  Warning: memory migration failed: ${errMsg(err)}\n`);
	}
}

/**
 * A line writer that holds everything until the caller says the block has
 * earned its place on screen.
 *
 * The alternative — deciding before the run whether to print the header — is not
 * available: whether a pass has anything to do is discovered per tier, inside
 * the run. So the decision is deferred instead of guessed.
 *
 * An elapsed-time reveal was tried and removed. It cannot separate the two cases
 * it needs to: a converged pass on this repo takes ~2.5 s (the session tier runs
 * unconditionally by design), which is the same order as the wait that would
 * justify narrating a slow one. Any threshold either fires on every launch — the
 * complaint this exists to fix — or is long enough to leave a real bootstrap
 * silent for most of it. {@link RepoProgress}' `kind` answers the question
 * directly and deterministically; see the reveal rule at the call site.
 *
 * Ordering survives the delay: held lines flush in the order they were written,
 * ahead of anything printed after the reveal.
 */
export function createDeferredWriter(write?: (line: string) => void): {
	/** Print if revealed, otherwise hold. */
	readonly write: (line: string) => void;
	/**
	 * Flush everything held and print directly from here on. Idempotent.
	 *
	 * `header` is printed once, ahead of the held lines — which is why it is a
	 * reveal argument rather than a line written up front: WHICH tier turned out
	 * to have work is discovered inside the run, and the header names it. The
	 * first reveal wins; later ones cannot retitle a block already on screen.
	 */
	readonly reveal: (header?: string) => void;
} {
	const held: string[] = [];
	const emit = write ?? CONSOLE_OUTPUT.log;
	let revealed = false;
	return {
		write: (line: string): void => {
			if (revealed) emit(line);
			else held.push(line);
		},
		reveal: (header?: string): void => {
			if (revealed) return;
			revealed = true;
			if (header) emit(header);
			for (const line of held) emit(line);
			held.length = 0;
		},
	};
}

/**
 * Turns the per-memory event stream into a handful of lines.
 *
 * Stateful because both rules need history: the quarter-marks need to know
 * which ones have been passed, and the small-repo suppression needs to know
 * the denominator, which only arrives with the first event.
 *
 * No `\r` redraw and no spinner — nothing else in this CLI has one, and a
 * rewritten line is invisible in a piped log.
 */
export function createProgressPrinter(deps: { readonly log?: (line: string) => void } = {}): {
	onProgress: (progress: DbBackfillProgress) => void;
} {
	const write = deps.log ?? CONSOLE_OUTPUT.log;
	let lastQuarter = 0;
	let lastCommitQuarter = 0;
	let warnedSlow = false;
	let announcedResume = false;
	let currentRepo: string | null = null;
	const labelled = new Set<string>();
	return {
		onProgress: (progress) => {
			if (progress.repoName !== currentRepo) {
				currentRepo = progress.repoName;
				lastQuarter = 0;
				lastCommitQuarter = 0;
				announcedResume = false;
				labelled.clear();
				if (progress.repoTotal > 1)
					write(`  ${progress.repoName} (${progress.repoIndex}/${progress.repoTotal})`);
			}
			// The scans before the migration. These are where the wall clock
			// actually goes — measured 64 s of scanning against 3 s of migrating —
			// so they are named as they START, and the commit sweep (the big one)
			// also carries its count.
			//
			// Two totals on screen was the worry, and it turned out to be the wrong
			// worry: "4016 commits" above "434 memories" is not a contradiction to
			// explain away, it is the true and mildly interesting fact that most
			// commits have no memory. A minute of motionless output is the real
			// problem.
			if (progress.kind !== "memories") {
				if (progress.done === 0) {
					// The "this is slow" warning belongs to the slow thing, not to the
					// command. A steady-state re-run skips the git scan entirely
					// (`commitsUnchanged`) and finishes in ~10 s — measured — so
					// printing "the first run can take a few minutes" up front was
					// wrong on exactly the runs where it was most visible. Emitting it
					// with the first git scan makes it true whenever it appears.
					//
					// `firstRun` narrows it further, and has to: a sweep triggered by a
					// moved branch tip re-reads the commit list but skips `--numstat`
					// for everything already stored, so it finishes in well under a
					// second on a 2.5k-commit history. Only a real bootstrap can take
					// minutes, and only a bootstrap sets the flag.
					if (progress.kind === "commits" && progress.firstRun && !warnedSlow) {
						warnedSlow = true;
						write("  Scanning your whole history — this can take a few minutes.");
						write("  Interrupting is safe: progress is saved and the next run resumes.");
					}
					// `detail` distinguishes one checkout's scan from the next, so a
					// repeat with a new qualifier is a new line, not a duplicate.
					const key = `${progress.kind}:${progress.detail ?? ""}`;
					if (labelled.has(key)) return;
					labelled.add(key);
					write(`  ${PHASE_LABELS[progress.kind]}${progress.detail ? ` (${progress.detail})` : ""}`);
					return;
				}
				// Counts only for the commit sweep: sessions and the summary index
				// are short, and a line each would bury the phase names.
				if (progress.kind !== "commits" || progress.total === undefined) return;
				if (progress.total < PROGRESS_MIN_TOTAL) return;
				// Unlike the memory counter, the LAST quarter prints too: the commit
				// sweep is followed by a silent prune, so suppressing the final line
				// left a 16 s gap right where the user is told nothing more is
				// coming.
				const q = Math.floor((progress.done * 4) / progress.total);
				if (q > lastCommitQuarter) {
					lastCommitQuarter = q;
					write(`    ${progress.done}/${progress.total} commits`);
				}
				return;
			}
			const total = progress.total;
			// No denominator (unreadable index.json): fall back to a plain count
			// every 500, so a long run still visibly moves.
			if (total === undefined) {
				if (progress.done > 0 && progress.done % 500 === 0) write(`  ${progress.done} memories…`);
				return;
			}
			// A run that started partway through picked up a cursor. Say so once —
			// it explains why the first number is not near zero.
			if (!announcedResume) {
				announcedResume = true;
				if (progress.done > 1) {
					write(`  Resuming from ${progress.done}/${total}…`);
					lastQuarter = Math.floor((progress.done * 4) / total);
				}
			}
			// Small repos print nothing between the header and the summary: four
			// lines of progress for eleven memories is noise, not information.
			if (total < PROGRESS_MIN_TOTAL) return;
			const quarter = Math.floor((progress.done * 4) / total);
			if (quarter > lastQuarter && quarter < 4) {
				lastQuarter = quarter;
				write(`  ${progress.done}/${total} memories…`);
			}
		},
	};
}

/** Below this many memories the run is fast enough that progress lines are noise. */
const PROGRESS_MIN_TOTAL = 200;

/**
 * What each pre-migration scan is called on screen.
 *
 * Deliberately activities, not table names. "Indexing stored memories" is the
 * event-tier summary sweep, which is a different pass from the migration whose
 * counter follows it — hence "indexing" rather than a second "migrating".
 */
const PHASE_LABELS: Record<"commits" | "summaries" | "sessions", string> = {
	commits: "Scanning git history…",
	summaries: "Indexing stored memories…",
	sessions: "Reading AI sessions…",
};

/**
 * Registers this repo and runs {@link runHistoryImport} — the server-free
 * entry point for `jolli enable` and the guided front door.
 *
 * Self-gating on `canUseDashboardDb()` so callers cannot forget it: on a
 * runtime without flag-free `node:sqlite` there is no database to import into,
 * and staying silent is better than an error at the end of a successful setup.
 * Never throws and never touches `process.exitCode`.
 *
 * Ends by attempting the cutover, for the same reason the import runs here at
 * all: this is the moment the database has just been filled from the orphan
 * branch, so it is the moment the containment compare is most likely to pass.
 * Without a caller here the engine was only ever reachable by typing `jolli
 * cutover`, and every repo stayed `uncutover` — reads served from the folder
 * layer, `SqliteStorage` never on the path. `maybeAutoCutover` reports nothing
 * and cannot throw, so it cannot turn a successful setup into a failure; the
 * two states short of `cutover` are both workable and converge later.
 *
 * **Carries the same disabled-repo gate as {@link executeDashboard}, and for the
 * same two writes.** This used to be reachable only from `jolli enable`, where
 * `install` has already cleared the opt-out by the time it runs — so the gate
 * looked redundant. The guided front door now comes here too, and it does NOT
 * clear anything: a repo whose `userDisabled` is set while its hooks survive (an
 * uninstall that failed after the flag was persisted, which is the documented
 * order) would have had `registerRepo` rebuild its registry entry and clear the
 * `disabledAt` that `jolli disable` set — silently undoing the user's decision
 * on a command they ran to look at status. `runHistoryImport` is deliberately
 * NOT gated: it sweeps every registered repo, so it belongs to the machine
 * rather than to `cwd`, exactly like `opportunisticSnapshot`.
 *
 * `throttleCutover` is the caller's policy, not a default, because the two
 * callers are opposites: `jolli enable` runs once and wants the attempt
 * unconditionally, while the front door is a command a user types many times a
 * day and would otherwise pay the containment compare — which reads every file
 * the frozen tip lists — on every one of them.
 */
export async function importDashboardHistory(
	cwd: string,
	deps: DashboardDeps = {},
	options: { readonly throttleCutover?: boolean } = {},
): Promise<void> {
	if (!canUseDashboardDb()) return;
	const repoDisabled = readManualDisableFlagSync(cwd);
	if (repoDisabled) {
		// `notice` for the same reason `executeDashboard` uses it: this is the only
		// explanation the user gets for a run that succeeded while leaving their
		// repo out of the database.
		outputOf(deps).notice("\n  Jolli Memory is disabled here — leaving this repo out of the dashboard.\n");
	} else {
		try {
			await registerRepo({ cwd, ...(deps.configDir ? { configDir: deps.configDir } : {}) });
		} catch (err) {
			log.info("not registering a repo from %s: %s", cwd, errMsg(err));
		}
	}
	await runHistoryImport(deps);
	if (!repoDisabled) {
		await maybeAutoCutover(cwd, {
			...(options.throttleCutover ? { throttle: true } : {}),
			...(deps.dbPath ? { dbPath: deps.dbPath } : {}),
		});
	}
}

/**
 * The executor behind `jolli dashboard`. Returns success instead of setting
 * `process.exitCode` so a soft caller can ignore a failure while the command
 * below still turns `false` into exit code 1.
 *
 * `page` stays a parameter although the one caller passes `"stats"`: it picks
 * which Dashboard child the browser opens (`/dashboard` or
 * `/dashboard/standup`) — the retired `jolli stats` / `jolli standup` aliases
 * were the only thing that made a second value reachable from the CLI.
 *
 * A repo the user has disabled still gets the page — the dashboard is a
 * machine-level view of every registered repo, so one repo's opt-out is no
 * reason to withhold the others' data — but none of this command's writes to
 * THAT repo run. See the `repoDisabled` gate below for which writes those are
 * and why the machine-scoped ones stay.
 */
export async function executeDashboard(
	page: "stats" | "standup",
	options: DashboardOptions,
	deps: DashboardDeps = {},
): Promise<boolean> {
	// Resolved ahead of the runtime gate below, not with the rest of the seams:
	// the first two failure branches print before there is any reason to resolve
	// a listener or a browser opener, and those two messages are the ones a GUI
	// host most needs to be able to show.
	const output = outputOf(deps);
	if (!canUseDashboardDb()) {
		output.error(
			`\n  Error: the dashboard needs Node >= ${DASHBOARD_SQLITE_MIN_VERSION.major}.${DASHBOARD_SQLITE_MIN_VERSION.minor}` +
				` for built-in SQLite (running ${process.versions.node}).\n`,
		);
		return false;
	}

	// Before anything reads: every render opens a read-only handle, and read-only
	// is the one mode that must not create a schema. Nothing else on this path
	// is guaranteed to create the file either — `registerRepo` below is skipped
	// outside a repo, and `runHistoryImport` with zero registered repos returns
	// without opening a writable handle — so a first run in a non-repo
	// directory used to serve a plain-text 500 on every page, with no scripts
	// on it to ever recover. It is also what makes the schema THIS build's
	// before anything serves, which is why the registry projection no longer
	// needs a version gate of its own.
	try {
		await ensureDashboardDbExists(deps.dbPath ? { dbPath: deps.dbPath } : {});
	} catch (err) {
		output.error(`\n  Error: could not create the dashboard database: ${errMsg(err)}\n`);
		return false;
	}

	const cwd = options.cwd ?? process.cwd();

	// The user's own opt-out for THIS repo, which gates this command's two writes
	// to it (registration below, the cutover attempt at the end) and nothing else.
	// The page still opens: the dashboard is machine-level — it aggregates every
	// registered repo — so being launched from a repo the user turned off is no
	// reason to withhold the other repos' data. The machine-scoped work stays too:
	// `ensureDashboardDbExists` above and `opportunisticSnapshot` below belong to
	// the database, not to `cwd`, and gating them on one repo's switch would mean
	// a disabled repo silently stops the machine's backups.
	//
	// The read-only SYNC reader on purpose. `readManualDisableFlag` migrates a
	// legacy marker and PERSISTS the decision, and a question asked on the way to
	// opening a page has no business writing a profile — the same call, for the
	// same reason, that `SkillAutoRefresh` makes.
	const repoDisabled = readManualDisableFlagSync(cwd);
	if (repoDisabled) {
		// `notice`, not `log`: this line is the ONLY explanation the user gets for
		// a dashboard that opened successfully with their repo missing from it.
		// Nothing else reports it — the command returns success — so a host whose
		// `log` goes to an unread channel has to put this somewhere else.
		output.notice("\n  Jolli Memory is disabled here — opening the dashboard without adding this repo to it.\n");
	}

	// Register the current repo when we are inside one; outside a repo the
	// dashboard still opens with whatever repos are already registered.
	//
	// Skipped outright for a disabled repo, because `registerRepo` REBUILDS the
	// entry and so clears `disabledAt` — the flag `jolli disable` sets through
	// `deregisterRepo`, and the one `listActiveRepos` filters on. Opening a page
	// is not an explicit re-enable, so letting it land here would silently undo
	// the disable and put the repo back into every later history import.
	// `ensureWorktreeListed` exists for exactly this distinction; see its header.
	if (!repoDisabled) {
		try {
			await registerRepo({ cwd, ...(deps.configDir ? { configDir: deps.configDir } : {}) });
		} catch (err) {
			log.info("not registering a repo from %s: %s", cwd, errMsg(err));
		}
	}

	const port = options.port !== undefined ? Number.parseInt(options.port, 10) : undefined;
	if (port !== undefined && (!Number.isFinite(port) || port <= 0 || port > 65535)) {
		output.error(`\n  Error: invalid --port value: ${options.port}\n`);
		return false;
	}

	let dashboard: ForegroundDashboard;
	try {
		dashboard = await startForegroundDashboard(
			page,
			{
				...(port !== undefined ? { port } : {}),
				...(options.open !== undefined ? { open: options.open } : {}),
				cwd,
			},
			deps,
		);
	} catch (err) {
		output.error(`\n  Error: could not start the dashboard: ${errMsg(err)}\n`);
		return false;
	}

	// Write side after the bind: the page is already up and polling, so history
	// fills in as this lands. It shares this process's event loop now, so a first
	// full sweep makes the page slower while it runs — still far better than a
	// blank browser for the minutes it takes.
	await runHistoryImport(deps);
	// Attempted for the same reason {@link importDashboardHistory} does it: the
	// import above has just filled the database from the orphan branch, so this is
	// when the containment compare is most likely to pass.
	//
	// THROTTLED, unlike that caller, and the difference is the invocation
	// frequency rather than the moment: `jolli dashboard` is a reopen command a
	// user can type many times a day, the import is cursor-gated so a steady-state
	// reopen fills nothing in, and the engine's compare reads every file the
	// frozen tip lists. Unthrottled, a repo that keeps answering `not-ready` would
	// pay that sweep on every launch. Reports nothing and cannot throw.
	//
	// Skipped for a disabled repo, and this is the write that matters most: it
	// stamps `cutoverAttemptedAtMs` into that repo's profile and, when the compare
	// passes, FREEZES its orphan branch — a fence `jolli enable` is forbidden to
	// clear (only `doctor`'s manual path may). Opening a page must not be able to
	// leave that behind in a repo the user switched off.
	if (!repoDisabled) {
		await maybeAutoCutover(cwd, { throttle: true, ...(deps.dbPath ? { dbPath: deps.dbPath } : {}) });
	}
	// The "dashboard start" half of the backup schedule (the others are the
	// post-commit QueueWorker and the machine-global daemon). Internally
	// day-gated and never throws, so this costs nothing on a normal reopen.
	await opportunisticSnapshot(deps.dbPath);

	// Serve until Ctrl+C. Everything above ran while the page was already up.
	await dashboard.waitForShutdown();
	return true;
}

/**
 * Registers the one dashboard command.
 *
 * `jolli stats` / `jolli standup` used to sit beside it as page-specific
 * aliases and are retired: they differed from `jolli dashboard` only in which
 * URL got opened, and the page's own nav already switches views. Both pages
 * are still served, at `/dashboard` and `/dashboard/standup` — this removed
 * two command names, not two pages.
 */
export function registerDashboardCommand(program: Command): void {
	program
		.command("dashboard")
		.description("Serve the local Jolli dashboard in your browser until you stop it (Ctrl+C)")
		.option("--port <port>", "Port for the dashboard server (default: 1818, then 18118)")
		.option("--no-open", "Do not open the browser, just print the URL")
		.option("--cwd <dir>", "Repo directory to register (default: current directory)")
		.action(async (options: DashboardOptions) => {
			if (!(await executeDashboard("stats", options))) process.exitCode = 1;
		});
}
