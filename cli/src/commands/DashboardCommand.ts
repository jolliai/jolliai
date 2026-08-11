/**
 * DashboardCommand — `jolli dashboard`, the only launcher command (the
 * `jolli stats` / `jolli standup` page aliases are retired; the pages
 * themselves stay served).
 *
 * The launcher, not the server: it registers the current repo, brings the
 * database up to date (bootstrap or gap recovery — the write side), makes sure
 * the read-only server is running (probe `/health`, spawn detached if not),
 * and opens the browser at the plain page URL (no token — see DashboardServer's
 * security model for what does and does not gate access).
 *
 * The wake sequence is ordered so the page appears fast: ensure server →
 * open browser → then run the backfill. The page renders whatever the DB
 * already holds and polls `/api/model`, so history fills in as the import
 * lands rather than blocking the launch.
 *
 * Browser opening deliberately does NOT go through `openUrlOrPrint` — that
 * helper enforces an https-only allowlist that (correctly) rejects
 * `http://127.0.0.1`, and loosening it for localhost would weaken every other
 * caller. The `open` package is used directly, dynamically imported because
 * open v11 is pure ESM and the VS Code bundle is CJS.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { getProjectRootDir } from "../core/GitOps.js";
import { getGlobalConfigDir } from "../core/SessionTracker.js";
import { maybeAutoCutover } from "../dashboard/AutoCutover.js";
import { opportunisticSnapshot } from "../dashboard/Backup.js";
import { canUseDashboardDb, DASHBOARD_SQLITE_MIN_VERSION, ensureDashboardDbExists } from "../dashboard/DashboardDb.js";
import { clearDashboardState, type DashboardServerState, readDashboardState } from "../dashboard/DashboardServer.js";
import { type DbBackfillProgress, dbBackfillRepos } from "../dashboard/DbBackfill.js";
import { listActiveRepos, registerRepo } from "../dashboard/RepoRegistry.js";
import { createLogger, errMsg } from "../Logger.js";
import { spawnHidden } from "../util/Subprocess.js";

const log = createLogger("DashboardCommand");

/** How long the launcher waits for a freshly spawned server's /health. */
const STARTUP_TIMEOUT_MS = 10_000;

export interface DashboardOptions {
	readonly port?: string;
	readonly open?: boolean;
	readonly stop?: boolean;
	readonly cwd?: string;
}

/** Injectable seams — every process/network/browser effect goes through these. */
export interface DashboardDeps {
	readonly configDir?: string;
	readonly dbPath?: string;
	/**
	 * Spawns the detached server. `cwd` is the launcher's resolved repo directory
	 * (`--cwd` or the process cwd): the child runs there so its telemetry buffer
	 * lands under that repo's `.jolli` rather than wherever the launcher happened
	 * to be invoked from.
	 */
	readonly spawnServer?: (port: number | undefined, cwd: string) => void;
	readonly openBrowser?: (url: string) => Promise<void>;
	readonly fetchHealth?: (port: number) => Promise<{ ok: boolean; pid?: number }>;
	readonly killPid?: (pid: number) => boolean;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
	/** Launcher's resolved repo directory, threaded to {@link spawnServer}. Defaults to `process.cwd()`. */
	readonly cwd?: string;
}

/* v8 ignore start -- default seams do real process/network/browser work; tests inject fakes */
async function defaultFetchHealth(port: number): Promise<{ ok: boolean; pid?: number }> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 1500);
		const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
		clearTimeout(timer);
		if (!res.ok) return { ok: false };
		const body = (await res.json()) as { ok?: boolean; pid?: number };
		return { ok: body.ok === true, ...(typeof body.pid === "number" ? { pid: body.pid } : {}) };
	} catch {
		return { ok: false };
	}
}

function defaultSpawnServer(port: number | undefined, cwd: string): void {
	// Resolve the entry by directory + filename, not import.meta.url alone —
	// same rationale as QueueWorker.launchWorker: this function gets inlined
	// into whichever bundle imports it, and the sibling file is the contract.
	const dir = dirname(fileURLToPath(import.meta.url));
	const scriptPath = join(dir, "DashboardServerEntry.js");
	if (!existsSync(scriptPath)) {
		throw new Error(
			`Dashboard server entry not found at ${scriptPath} — this dist was built without a DashboardServerEntry entry.`,
		);
	}
	const child = spawnHidden(process.execPath, [scriptPath], {
		detached: true,
		stdio: "ignore",
		// Run the server in the launcher's resolved repo dir so its telemetry
		// buffer (ServerTelemetry uses process.cwd()) lands under that repo's
		// `.jolli`, not wherever `jolli dashboard` was invoked from.
		cwd,
		env: {
			...process.env,
			...(port !== undefined ? { JOLLI_DASHBOARD_PORT: String(port) } : {}),
		},
	});
	// A detached spawn emits `error` asynchronously (e.g. a cwd that vanished
	// between the resolve and the spawn); with no listener Node re-throws it as an
	// uncaught exception and kills the launcher. Swallow it — a failed spawn means
	// no dashboard, and the /health probe already reports that to the user.
	child.on("error", (err) => log.warn("dashboard server failed to spawn: %s", errMsg(err)));
	child.unref();
}

async function defaultOpenBrowser(url: string): Promise<void> {
	const open = (await import("open")).default;
	const child = await open(url);
	child.unref();
}

function defaultKillPid(pid: number): boolean {
	try {
		process.kill(pid);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolves every seam to a concrete implementation, so the `?? default`
 * fallbacks live in exactly one place — inside this region, because a test that
 * took one of them would spawn a process, hit the network or open a browser,
 * which is the whole reason the seams exist. Callers below then work with plain
 * functions instead of re-deciding the default at each call site, where the same
 * `??` had to be repeated (and could disagree between two of them).
 */
function resolveSeams(deps: DashboardDeps): ResolvedSeams {
	return {
		configDir: deps.configDir ?? getGlobalConfigDir(),
		spawnServer: deps.spawnServer ?? defaultSpawnServer,
		openBrowser: deps.openBrowser ?? defaultOpenBrowser,
		fetchHealth: deps.fetchHealth ?? defaultFetchHealth,
		killPid: deps.killPid ?? defaultKillPid,
		sleep: deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
	};
}
/* v8 ignore stop */

/** {@link DashboardDeps} with every optional seam filled in. */
interface ResolvedSeams {
	readonly configDir: string;
	readonly spawnServer: (port: number | undefined, cwd: string) => void;
	readonly openBrowser: (url: string) => Promise<void>;
	readonly fetchHealth: (port: number) => Promise<{ ok: boolean; pid?: number }>;
	readonly killPid: (pid: number) => boolean;
	readonly sleep: (ms: number) => Promise<void>;
}

/** True when `pid` is a live process we may signal. */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Exclusive create — the only way this module ever claims the lock. */
function tryCreateLock(lockPath: string): boolean {
	try {
		writeFileSync(lockPath, String(process.pid), { flag: "wx" });
		return true;
	} catch {
		return false;
	}
}

/** The pid recorded in the lock, or null if it is missing or unparseable. */
function readLockHolder(lockPath: string): number | null {
	try {
		const holder = Number.parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
		return Number.isFinite(holder) ? holder : null;
	} catch {
		return null;
	}
}

/**
 * The spawn lock: prevents two launchers (CLI + a second CLI, or later the
 * extension) racing each other into a double server.
 *
 * `wx` create is the atomic take, and reclaiming a stale lock goes through that
 * same exclusive create — never a blind overwrite. An overwrite is what made
 * reclaim unsafe: two launchers that both read the same dead pid would both
 * write themselves in and both return `true`, which is precisely the double
 * spawn the lock exists to prevent. Now the loser's create fails, it falls into
 * the "wait for the other launcher" branch, and one server comes up.
 *
 * A lock that is unreadable or holds a non-numeric pid counts as stale too:
 * a launcher killed mid-write must not wedge the dashboard permanently.
 *
 * Residual race, deliberately accepted: remove-then-create is two syscalls, so a
 * second reclaimer whose `rm` lands after the first has already created *and*
 * read back its own lock still takes it. Closing that needs a real CAS the
 * filesystem does not offer. The consequence is bounded on the other side —
 * {@link ensureServerRunning} probes `/health` and reuses a live server before
 * spawning at all, and `dashboard.json` is only ever cleared by the pid that
 * owns it — so the worst case is one short-lived extra process, not a
 * permanently orphaned server.
 */
export function acquireSpawnLock(configDir: string): boolean {
	const lockPath = join(configDir, "dashboard-spawn.lock");
	mkdirSync(configDir, { recursive: true });
	if (tryCreateLock(lockPath)) return true;
	const holder = readLockHolder(lockPath);
	if (holder !== null && isPidAlive(holder)) return false;
	rmSync(lockPath, { force: true });
	// Read back: the create alone proves only that the file did not exist a
	// moment ago, not that what is on disk now is ours.
	return tryCreateLock(lockPath) && readLockHolder(lockPath) === process.pid;
}

export function releaseSpawnLock(configDir: string): void {
	rmSync(join(configDir, "dashboard-spawn.lock"), { force: true });
}

/**
 * Confirms that the pid in `dashboard.json` is still the dashboard server on
 * that port, by asking the port itself.
 *
 * `dashboard.json` can outlive its process (SIGKILL, a crash, a reboot that left
 * the file behind) and the OS recycles pids, so a recorded pid is a *claim*, not
 * a fact. Everything that signals or replaces the recorded server verifies here
 * first — signalling a stale record blind is how a launcher kills whichever
 * unrelated process happens to have inherited the number.
 *
 * A `/health` that answers without a pid also fails the check: our own handler
 * always reports one, so a pid-less `{ ok: true }` is some other service on that
 * port and must not be signalled either.
 */
async function isRecordedServerLive(state: DashboardServerState, seams: ResolvedSeams): Promise<boolean> {
	const health = await seams.fetchHealth(state.port);
	return health.ok && health.pid === state.pid;
}

/**
 * Resolves the working directory the detached server should run in, from the
 * launcher's raw `--cwd`/process cwd.
 *
 * Two review-driven guarantees, both about the fact that the server inherits its
 * cwd and that the telemetry buffer's identity IS the literal cwd (JOLLI-1957):
 *
 *  - **Always a real directory.** A bad `--cwd` (nonexistent, or a file) would
 *    make the detached `spawn` emit an `error` (ENOENT) and — before the
 *    `child.on("error")` guard — crash the whole launcher. An invalid path falls
 *    back to `process.cwd()`, which is always valid.
 *  - **The repo ROOT, not a subdir.** Launched from `repo/sub`, the raw cwd is
 *    `repo/sub`, whose buffer no other surface (hooks, QueueWorker, `jolli
 *    compile`, VS Code) drains — the server's own 60 s flush would be the only
 *    thing shipping it. Resolving to the git top level lets the server share the
 *    one repo-root buffer everything else uses.
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

/**
 * Ensures a healthy server is running and returns its state. Reuses a live one
 * (verified pid via /health), restarts after a stale `dashboard.json`, and
 * spawns fresh when nothing is up.
 *
 * An explicit `--port` that disagrees with a live server **replaces** it rather
 * than starting a second one beside it: both would compete for the single
 * `dashboard.json`, so only one of them would ever be findable by a later
 * launcher — and the loser keeps running, invisible, until its idle timeout.
 */
export async function ensureServerRunning(
	requestedPort: number | undefined,
	deps: DashboardDeps,
): Promise<DashboardServerState> {
	const seams = resolveSeams(deps);
	const { configDir, fetchHealth, sleep } = seams;

	const existing = await readDashboardState(configDir);
	if (existing) {
		const live = await isRecordedServerLive(existing, seams);
		if (live && (requestedPort === undefined || requestedPort === existing.port)) return existing;
		if (live) seams.killPid(existing.pid);
		// Either the record was stale, or we just retired its server. Guarded on
		// the pid we read so we never delete a record that has moved on.
		await clearDashboardState(configDir, existing.pid);
	}

	if (!acquireSpawnLock(configDir)) {
		// Another launcher is mid-spawn — wait for its server instead of racing it.
		for (let waited = 0; waited < STARTUP_TIMEOUT_MS; waited += 250) {
			await sleep(250);
			const state = await readDashboardState(configDir);
			if (state && (await fetchHealth(state.port)).ok) return state;
		}
		throw new Error("Another process is starting the dashboard but it never became healthy.");
	}
	try {
		seams.spawnServer(requestedPort, deps.cwd ?? process.cwd());
		for (let waited = 0; waited < STARTUP_TIMEOUT_MS; waited += 250) {
			await sleep(250);
			const state = await readDashboardState(configDir);
			if (state && (await fetchHealth(state.port)).ok) return state;
		}
		throw new Error(
			"The dashboard server did not become healthy in time — check .jolli/jollimemory/debug.log for details.",
		);
	} finally {
		releaseSpawnLock(configDir);
	}
}

/**
 * `--stop`: kill the recorded server and clear its state file.
 *
 * The signal is sent only once `/health` on the recorded port confirms the
 * recorded pid — see {@link isRecordedServerLive}. When it does not, the record
 * is simply cleared: there is nothing of ours to stop, and the pid may well
 * belong to something else by now.
 */
async function stopServer(deps: DashboardDeps): Promise<void> {
	const seams = resolveSeams(deps);
	const state = await readDashboardState(seams.configDir);
	if (!state) {
		console.log("\n  The dashboard server is not running.\n");
		return;
	}
	const live = await isRecordedServerLive(state, seams);
	const killed = live && seams.killPid(state.pid);
	await clearDashboardState(seams.configDir, state.pid);
	console.log(
		killed
			? `\n  Dashboard server stopped (pid ${state.pid}).\n`
			: "\n  The dashboard server had already exited — cleared its stale record.\n",
	);
}

/**
 * The write side of the launcher, on its own: bring the dashboard database up
 * to date from every registered repo (bootstrap or gap recovery, plus the
 * orphan-branch source-of-truth import) and report what actually landed.
 *
 * Split out of {@link executeDashboard} because the import is the only part of
 * the launcher `jolli enable` and the guided front door actually need.
 * `dbBackfillRepos` is the sole production caller of the SOT import, so memories
 * just written would otherwise sit outside the database until someone ran
 * `jolli dashboard` by hand — but wanting that import is no reason to bind a
 * port, spawn a detached server and take over the user's browser at enable
 * time. Those two entry points call this; the server stays a `jolli dashboard`
 * decision.
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
		const out = createDeferredWriter();
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
			console.log(
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
			console.log(`  ⚠ ${failed.repoName} — migration failed: ${failed.error ?? "unknown error"}`);
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
			console.log(`  ✓ Migrated ${migrated} ${migrated === 1 ? "memory" : "memories"}${across}.\n`);
		} else {
			// Previously this branch printed NOTHING, which is the bug that started
			// all this: a converged re-run looked identical to a run that never
			// happened.
			console.log(`  ✓ All ${migrated} ${migrated === 1 ? "memory" : "memories"} already migrated.\n`);
		}
	} catch (err) {
		console.error(`  Warning: memory migration failed: ${errMsg(err)}\n`);
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
export function createDeferredWriter(): {
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
	let revealed = false;
	return {
		write: (line: string): void => {
			if (revealed) console.log(line);
			else held.push(line);
		},
		reveal: (header?: string): void => {
			if (revealed) return;
			revealed = true;
			if (header) console.log(header);
			for (const line of held) console.log(line);
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
	const write = deps.log ?? ((line: string) => console.log(line));
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
 */
export async function importDashboardHistory(cwd: string, deps: DashboardDeps = {}): Promise<void> {
	if (!canUseDashboardDb()) return;
	try {
		await registerRepo({ cwd, ...(deps.configDir ? { configDir: deps.configDir } : {}) });
	} catch (err) {
		log.info("not registering a repo from %s: %s", cwd, errMsg(err));
	}
	await runHistoryImport(deps);
	// No throttle: a fresh import is the one attempt worth making unconditionally.
	await maybeAutoCutover(cwd, deps.dbPath ? { dbPath: deps.dbPath } : {});
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
 */
export async function executeDashboard(
	page: "stats" | "standup",
	options: DashboardOptions,
	deps: DashboardDeps = {},
): Promise<boolean> {
	if (options.stop) {
		await stopServer(deps);
		return true;
	}
	if (!canUseDashboardDb()) {
		console.error(
			`\n  Error: the dashboard needs Node >= ${DASHBOARD_SQLITE_MIN_VERSION.major}.${DASHBOARD_SQLITE_MIN_VERSION.minor}` +
				` for built-in SQLite (running ${process.versions.node}).\n`,
		);
		return false;
	}

	// Before anything reads: the server opens read-only handles, and read-only
	// is the one mode that must not create a schema. Nothing else on this path
	// is guaranteed to create the file either — `registerRepo` below is skipped
	// outside a repo, and `runHistoryImport` with zero registered repos returns
	// without opening a writable handle — so a first run in a non-repo
	// directory used to serve a plain-text 500 on every page, with no scripts
	// on it to ever recover.
	try {
		await ensureDashboardDbExists(deps.dbPath ? { dbPath: deps.dbPath } : {});
	} catch (err) {
		console.error(`\n  Error: could not create the dashboard database: ${errMsg(err)}\n`);
		return false;
	}

	const cwd = options.cwd ?? process.cwd();
	const seams = resolveSeams(deps);

	// Register the current repo when we are inside one; outside a repo the
	// dashboard still opens with whatever repos are already registered.
	try {
		await registerRepo({ cwd, ...(deps.configDir ? { configDir: deps.configDir } : {}) });
	} catch (err) {
		log.info("not registering a repo from %s: %s", cwd, errMsg(err));
	}

	const port = options.port !== undefined ? Number.parseInt(options.port, 10) : undefined;
	if (port !== undefined && (!Number.isFinite(port) || port <= 0 || port > 65535)) {
		console.error(`\n  Error: invalid --port value: ${options.port}\n`);
		return false;
	}

	// The server runs at the repo root and only at a real directory — see
	// resolveServerCwd. `registerRepo` above keeps using the raw `cwd`.
	const serverCwd = await resolveServerCwd(cwd);
	let state: DashboardServerState;
	try {
		state = await ensureServerRunning(port, { ...deps, configDir: seams.configDir, cwd: serverCwd });
	} catch (err) {
		console.error(`\n  Error: ${errMsg(err)}\n`);
		return false;
	}

	// View token → its ONE served path. `/stats` and `/standup` were removed as
	// paths (see `VIEW_PATHS`), so this mapping is what keeps the launcher from
	// opening a 404 — the token and the URL are no longer the same string.
	const url = `http://127.0.0.1:${state.port}${page === "standup" ? "/dashboard/standup" : "/dashboard"}`;
	if (options.open !== false) {
		try {
			await seams.openBrowser(url);
		} catch (err) {
			log.warn("could not open the browser (non-fatal): %s", errMsg(err));
		}
	}
	console.log(`\n  Jolli dashboard → ${url}`);
	console.log("  Reopen anytime with `jolli dashboard`; stop with `jolli dashboard --stop`.\n");

	// Write side last: the page is already up and polling, so history fills in
	// as this lands. Runs in this command process — the server never writes.
	await runHistoryImport(deps);
	// Attempted for the same reason {@link importDashboardHistory} does it: the
	// import above has just filled the database from the orphan branch, so this is
	// when the containment compare is most likely to pass. Without a call here the
	// guided front door — which wakes the dashboard through this function rather
	// than the import-only entry point — would be the one setup path that never
	// converges past `uncutover`.
	//
	// THROTTLED, unlike that caller, and the difference is the invocation
	// frequency rather than the moment: `jolli dashboard` is a reopen command a
	// user can type many times a day, the import is cursor-gated so a steady-state
	// reopen fills nothing in, and the engine's compare reads every file the
	// frozen tip lists. Unthrottled, a repo that keeps answering `not-ready` would
	// pay that sweep on every launch. Reports nothing and cannot throw.
	await maybeAutoCutover(cwd, { throttle: true, ...(deps.dbPath ? { dbPath: deps.dbPath } : {}) });
	// The "dashboard start" half of the no-daemon backup schedule (the other is
	// the post-commit QueueWorker). It belongs here, not in the server: taking a
	// snapshot needs a WRITABLE handle, which runs schema migrations, and the
	// server is the one long-lived process whose build can lag. Internally
	// day-gated and never throws, so this costs nothing on a normal reopen.
	await opportunisticSnapshot(deps.dbPath);
	return true;
}

/**
 * Registers the one launcher command.
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
		.description("Open the local Jolli dashboard (stats + standup) in your browser")
		.option("--port <port>", "Port for the dashboard server (default: 1818, then 18118)")
		.option("--no-open", "Do not open the browser, just print the URL")
		.option("--stop", "Stop the running dashboard server")
		.option("--cwd <dir>", "Repo directory to register (default: current directory)")
		.action(async (options: DashboardOptions) => {
			if (!(await executeDashboard("stats", options))) process.exitCode = 1;
		});
}
