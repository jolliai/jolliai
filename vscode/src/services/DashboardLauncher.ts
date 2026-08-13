/**
 * DashboardLauncher — the extension-host side of `jolli dashboard`.
 *
 * Every decision the launcher makes (runtime floor, database creation, repo
 * registration, server reuse vs spawn, the history import, cutover, the backup
 * snapshot) stays in `executeDashboard`. This module only supplies the three
 * plugs that behave differently inside an editor:
 *
 *   1. **Where the lines go.** The CLI writes to `console`; in the extension
 *      host that is the debug console, which no user has open — so every failure
 *      reason would be invisible. They are routed to the "Jolli Memory" output
 *      channel instead.
 *   2. **What runs the server.** `process.execPath` here is Electron, not node.
 *      See {@link createServerSpawner}.
 *   3. **What opens the URL.** `vscode.env.openExternal` rather than the CLI's
 *      `open` package: inside an editor the host owns URL handling, and the
 *      package is dynamically imported for a CJS bundle it does not need to be.
 *
 * What this module does NOT do is re-order the launcher's phases. The history
 * import still runs after the browser is opened, exactly as it does on the
 * command line — see {@link launchDashboard} for how the progress notification
 * stops early without changing that order.
 *
 * Two things it owns outright, both consequences of that early stop: only one
 * launch runs at a time (see {@link InFlightLaunch}), and a browser that refuses
 * to open is reported (see {@link reportBrowserFailure}). Neither has a CLI
 * equivalent — on a terminal the command's own output is already in front of the
 * user, and there is no button to click twice.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import {
	type DashboardDeps,
	type DashboardOutput,
	executeDashboard,
} from "../../../cli/src/commands/DashboardCommand.js";
import { spawnHidden } from "../../../cli/src/util/Subprocess.js";
import { log } from "../util/Logger.js";

const TAG = "dashboard";

/** Basename of the detached server entry, as emitted into `dist/` by esbuild. */
export const SERVER_ENTRY_FILE = "DashboardServerEntry.js";

/**
 * Makes Electron run the entry as a plain node process.
 *
 * The extension host is an Electron helper, so `process.execPath` is that
 * binary rather than a node one. Handing it a script path without this variable
 * does not start a node process at all. The Node embedded in it is the host's
 * own, which `engines.vscode` (^1.101.0 — the first release whose bundled Node
 * crossed the 22.13 `node:sqlite` floor) already guarantees is new enough, so
 * nothing here needs to hunt for a system node.
 */
const RUN_AS_NODE_ENV = { ELECTRON_RUN_AS_NODE: "1" } as const;

/** Port override the server entry reads. Mirrors `DASHBOARD_PORT_ENV` in ServerEntry.ts. */
const PORT_ENV = "JOLLI_DASHBOARD_PORT";

/**
 * Routes the launcher's human-facing lines to the output channel — except
 * `notice`, which also has to reach the screen.
 *
 * The channel is the right home for progress and for a reason that accompanies a
 * visible failure, and the wrong home for a line that is the only explanation of
 * something the user is looking at. `notice` is the CLI's marker for the second
 * kind, so it gets a notification on top of its channel entry; see
 * {@link DashboardOutput.notice}.
 */
export function createOutput(ui: DashboardLauncherUi): DashboardOutput {
	// The CLI's lines are shaped for a terminal — leading blank lines and two
	// spaces of indent. Trimmed here because the channel already prefixes every
	// line with a timestamp and tag, against which that padding reads as damage.
	// `trim` alone is the whole job: it already removes the leading/trailing
	// newlines along with the indent, so stripping them separately first was two
	// passes that could not change the result.
	const clean = (line: string): string => line.trim();
	return {
		log: (line) => {
			const text = clean(line);
			if (text) log.info(TAG, text);
		},
		error: (line) => {
			const text = clean(line);
			if (text) log.error(TAG, text);
		},
		notice: (line) => {
			const text = clean(line);
			if (!text) return;
			// Kept in the channel too, so the launch reads as one story there.
			log.info(TAG, text);
			// Not awaited: an information message resolves only when the user
			// dismisses it, and the command that emitted this line is mid-run.
			void ui.showInfo(text);
		},
	};
}

/**
 * Builds the spawner for the detached server.
 *
 * `distDir` is where esbuild put {@link SERVER_ENTRY_FILE}; the server resolves
 * its own asset directory relative to that same file, so passing the real dist
 * is also what lets it find `dashboard-assets/`.
 *
 * `cwd` comes from the launcher (the resolved repo root) and is passed through
 * rather than defaulted: the server's telemetry buffer is keyed by its literal
 * working directory, so a wrong one writes a buffer nothing else drains.
 */
export function createServerSpawner(distDir: string): NonNullable<DashboardDeps["spawnServer"]> {
	return (port: number | undefined, cwd: string): void => {
		const scriptPath = join(distDir, SERVER_ENTRY_FILE);
		if (!existsSync(scriptPath)) {
			// Thrown rather than logged: `ensureServerRunning` turns this into the
			// launcher's own error line, which reaches the user. A log-and-return
			// would instead spend the full startup timeout waiting for a process
			// that was never started.
			throw new Error(`Dashboard server entry not found at ${scriptPath} — this build is incomplete.`);
		}
		const child = spawnHidden(process.execPath, [scriptPath], {
			detached: true,
			stdio: "ignore",
			cwd,
			env: {
				...process.env,
				...RUN_AS_NODE_ENV,
				...(port !== undefined ? { [PORT_ENV]: String(port) } : {}),
			},
		});
		// A detached spawn reports `error` asynchronously, and with no listener
		// Node re-throws it as an uncaught exception — in the extension host, not
		// in a command we control. The /health probe already reports the outcome.
		child.on("error", (err) => log.warn(TAG, `dashboard server failed to spawn: ${err.message}`));
		child.unref();
	};
}

/**
 * True when this window edits files on another machine (Remote-SSH, WSL, a dev
 * container, Codespaces).
 *
 * The dashboard binds `127.0.0.1` on whichever machine runs the server — which
 * in these windows is the remote one, while the browser is local. So opening
 * the URL locally reaches the local port 1818: either nothing, or an unrelated
 * service. Supporting it properly means `vscode.env.asExternalUri` (which asks
 * the host to tunnel the port) and that is deliberately not wired yet: the
 * tunnel is a separate capability from the connection itself — an SSH server
 * with `AllowTcpForwarding no` keeps remote development working while refusing
 * to forward — so it needs its own verification rather than an assumption.
 *
 * WSL would very likely work as-is (its localhost is shared with the host), but
 * it is not special-cased for the same reason: one unverified exception is
 * worse than a uniform, honest message.
 */
export function isRemoteWorkspace(remoteName: string | undefined = vscode.env.remoteName): boolean {
	return remoteName !== undefined;
}

/** What the user is told instead of a broken button in a remote window. */
export const REMOTE_HINT =
	"The Jolli dashboard runs on the machine that holds your code. " +
	"Open a terminal on that machine and run `jolli dashboard` — VS Code will offer to forward the port.";

export interface LaunchDashboardOptions {
	/** Repo directory to register and serve from. */
	readonly cwd: string;
	/** The extension's `dist/` — where {@link SERVER_ENTRY_FILE} lives. */
	readonly distDir: string;
	/** Injected in tests so no real command runs. */
	readonly run?: typeof executeDashboard;
	/** Injected in tests; production uses the real window APIs. */
	readonly ui?: DashboardLauncherUi;
	/** Injected in tests. Defaults to `vscode.env.remoteName`. */
	readonly remoteName?: string | undefined;
}

/** The window interactions this module performs, as a seam. */
export interface DashboardLauncherUi {
	readonly withProgress: (title: string, task: () => Promise<void>) => Promise<void>;
	readonly showError: (message: string, action: string) => Promise<string | undefined>;
	readonly showInfo: (message: string) => Promise<void>;
	readonly openExternal: (url: string) => Promise<void>;
	readonly revealLog: () => void;
}

/* v8 ignore start -- thin adapters over vscode.window/env; every test injects its own */
function defaultUi(): DashboardLauncherUi {
	return {
		withProgress: (title, task) =>
			Promise.resolve(
				vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () => task()),
			),
		showError: (message, action) => Promise.resolve(vscode.window.showErrorMessage(message, action)),
		showInfo: (message) => Promise.resolve(vscode.window.showInformationMessage(message)).then(() => undefined),
		openExternal: (url) => Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(url))).then(() => undefined),
		revealLog: () => log.show(),
	};
}
/* v8 ignore stop */

/** Shown while the server is being reached or started. */
export const PROGRESS_TITLE = "Opening the Jolli dashboard…";

/** Shown when the launcher reports failure. Details are in the output channel. */
export const FAILURE_MESSAGE = "Could not open the Jolli dashboard.";

/**
 * Shown when the server came up but the host refused to open a browser.
 *
 * Deliberately NOT {@link FAILURE_MESSAGE}: nothing failed except the last step.
 * The dashboard is running and its address is in the output channel, so the only
 * thing left for the user to do is reach it by hand.
 */
export const BROWSER_FAILURE_MESSAGE =
	"The Jolli dashboard is running, but no browser could be opened for it — its address is in the Jolli Memory log.";

const FAILURE_ACTION = "Show Log";

/** `err.message` when there is one, its string form otherwise. */
function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * A launch that has not finished yet.
 *
 * "Finished" is the whole command, not the startup phase: the history import
 * keeps running for minutes after the browser opens, and it is exactly that
 * stretch — with the notification already gone and nothing on screen to say
 * anything is happening — that invites a second click.
 */
interface InFlightLaunch {
	/** The startup barrier, so a click that arrives early can share the wait. */
	readonly startup: Promise<void>;
	/** The URL the command opened, once it has opened one. */
	url: string | undefined;
}

/**
 * The launch currently running, or null.
 *
 * Module-level because the callers are independent command invocations — one per
 * click — while everything being guarded is shared: one browser tab, and one
 * history import / cutover attempt / backup snapshot against the one machine
 * database. The CLI's `acquireSpawnLock` does not cover any of that; it is held
 * only across the server spawn, and a second click arrives to a server that is
 * already healthy.
 */
let inFlight: InFlightLaunch | null = null;

/** Drops the in-flight record so each test starts from a clean launcher. */
export function __resetDashboardLaunchForTests(): void {
	inFlight = null;
}

/**
 * The generic "it did not open" report, offering the channel that holds why.
 *
 * One function rather than three copies of the same two lines: every failure
 * path — a `false` return, a rejection, a synchronous throw from the `run` seam
 * — owes the user the same thing, and the reveal is easy to forget on a new one.
 */
async function reportLaunchFailure(ui: DashboardLauncherUi): Promise<void> {
	if ((await ui.showError(FAILURE_MESSAGE, FAILURE_ACTION)) === FAILURE_ACTION) ui.revealLog();
}

/**
 * Tells the user the dashboard is up but the browser is not, and offers the log.
 *
 * Without this the whole failure is invisible: `executeDashboard` catches a
 * refused open, records the reason through the CLI's own logger — which writes
 * `debug.log`, not the output channel — and still returns success, so the button
 * spins, stops, and nothing else ever happens.
 */
async function reportBrowserFailure(url: string, err: unknown, ui: DashboardLauncherUi): Promise<void> {
	// The URL is logged from here rather than left to the command's own line for
	// it: that line is printed AFTER the browser call returns, so at the moment
	// this notification appears the channel is not guaranteed to hold it yet.
	log.error(TAG, `could not open a browser for ${url}: ${describeError(err)}`);
	if ((await ui.showError(BROWSER_FAILURE_MESSAGE, FAILURE_ACTION)) === FAILURE_ACTION) ui.revealLog();
}

/**
 * What a click does while a launch is still running.
 *
 * Re-running the command would open a second tab and put a second history
 * import, cutover attempt and backup snapshot concurrently against the same
 * database, in the same process — and `maybeAutoCutover`'s throttle cannot stop
 * that, since it reads its own timestamp and writes it back with an await in
 * between, so two concurrent callers both pass it.
 */
async function rejoinLaunch(running: InFlightLaunch, ui: DashboardLauncherUi): Promise<void> {
	log.info(TAG, "a dashboard launch is already running — reusing it");
	const opened = running.url;
	if (opened === undefined) {
		// The server has not answered yet, so there is nothing to re-open. Share
		// the barrier instead: this click gets its own progress notification, and
		// the first launch's browser is what ends it.
		await ui.withProgress(PROGRESS_TITLE, () => running.startup);
		return;
	}
	// A URL exists, so the click is satisfiable on its own terms — the tab may
	// well have been closed — without repeating any of the work behind it.
	try {
		await ui.openExternal(opened);
	} catch (err) {
		void reportBrowserFailure(opened, err, ui);
	}
}

/**
 * Opens the dashboard: reuses or starts the server, then opens the browser.
 *
 * The progress notification covers only up to the browser opening, NOT the whole
 * command. `executeDashboard` deliberately runs the history import last — the
 * page is already up and polling by then, so history fills in as it lands — and
 * that import can take minutes on a first run. A notification spanning it would
 * read as a hang, so the two are separated without touching the command's order:
 * the injected browser opener releases the notification the moment it is called,
 * and the import continues in the background with its progress going to the
 * output channel.
 *
 * One launch at a time: a click that arrives while the previous command is still
 * running is served by {@link rejoinLaunch} instead of starting a second one.
 * The guard covers the whole command rather than the startup phase, because the
 * gap the notification leaves open is exactly the import.
 *
 * Resolves once the startup phase has settled, so a caller never waits on the
 * import. Never rejects — a failure becomes a notification.
 */
export async function launchDashboard(options: LaunchDashboardOptions): Promise<void> {
	const ui = options.ui ?? defaultUi();
	// Passed straight through: `isRemoteWorkspace` already defaults an absent
	// argument to `vscode.env.remoteName`, so coalescing to it here read as a
	// second opinion while producing the identical answer.
	if (isRemoteWorkspace(options.remoteName)) {
		log.info(TAG, "remote window — not starting a local dashboard server");
		await ui.showInfo(REMOTE_HINT);
		return;
	}
	const running = inFlight;
	if (running) {
		await rejoinLaunch(running, ui);
		return;
	}
	const run = options.run ?? executeDashboard;

	// The barrier the notification waits on. Released by whichever comes first:
	// the browser opening (success) or the command returning (failure, or
	// `--no-open`). Released more than once by design — a resolved promise
	// ignores later calls, which is what makes both paths safe to keep.
	/* v8 ignore next -- the seed no-op is only there to satisfy definite assignment; the Promise executor below runs synchronously and replaces it before anything can call it. */
	let releaseStartup: () => void = () => {};
	const startupSettled = new Promise<void>((resolve) => {
		releaseStartup = resolve;
	});

	const launch: InFlightLaunch = { startup: startupSettled, url: undefined };
	let command: Promise<boolean>;
	try {
		command = run(
			"stats",
			{ cwd: options.cwd },
			{
				output: createOutput(ui),
				spawnServer: createServerSpawner(options.distDir),
				openBrowser: async (url: string) => {
					// Recorded before the attempt rather than after it: a click that
					// arrives during the import should retry this URL even when the
					// first open was refused.
					launch.url = url;
					try {
						await ui.openExternal(url);
					} catch (err) {
						// Not awaited — `showErrorMessage` resolves only when the user
						// answers it, and everything behind this call (the import, the
						// cutover attempt) must not wait on a notification.
						void reportBrowserFailure(url, err, ui);
						// Rethrown so `executeDashboard` still records its own non-fatal
						// warning and still prints the URL: this branch ADDS a report, it
						// does not take one away.
						throw err;
					} finally {
						// In `finally` so a browser that refuses to open still ends the
						// notification. The launcher treats that as non-fatal and prints
						// the URL, so leaving a spinner up would be the only damage.
						releaseStartup();
					}
				},
			},
		);
	} catch (err) {
		// `run` is a seam, so a SYNCHRONOUS throw is reachable here even though
		// `executeDashboard` is `async` and cannot produce one. Caught because the
		// contract above says this function never rejects and its one caller
		// `void`s it, so an escaping throw becomes an unhandled rejection in the
		// extension host instead of something the user can act on. Nothing to
		// unwind: `inFlight` is published below, so no guard leaked, and no
		// progress notification has been opened yet.
		log.error(TAG, `dashboard launch threw: ${describeError(err)}`);
		await reportLaunchFailure(ui);
		return;
	}
	// Published after the call rather than before it: `run` is a seam, and a
	// synchronous throw from one would otherwise leave the guard set with no
	// command left to clear it — a permanently dead button. Nothing awaits in
	// between, so no second click can slip through the gap.
	inFlight = launch;

	// Fire-and-forget on purpose: this is the tail that carries the history
	// import, and awaiting it here is exactly what the split above avoids.
	void command.then(
		async (ok) => {
			// Released here rather than at the barrier: the barrier ends with the
			// browser, and the import behind it is the whole reason the guard exists.
			inFlight = null;
			releaseStartup();
			if (ok) return;
			await reportLaunchFailure(ui);
		},
		async (err: unknown) => {
			// `executeDashboard` reports its own failures as `false`, so a rejection
			// is something it did not anticipate. It must still reach the user.
			inFlight = null;
			releaseStartup();
			log.error(TAG, `dashboard launch threw: ${describeError(err)}`);
			await reportLaunchFailure(ui);
		},
	);

	await ui.withProgress(PROGRESS_TITLE, () => startupSettled);
}
