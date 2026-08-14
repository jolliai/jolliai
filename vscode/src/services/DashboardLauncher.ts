/**
 * DashboardLauncher — the extension-host side of `jolli dashboard`.
 *
 * `jolli dashboard` is a FOREGROUND command: it binds the port in its own
 * process and serves until it is stopped. That is why this module runs it as a
 * child process rather than calling `executeDashboard` in-process the way it
 * used to. In the extension host there is no Ctrl+C, so an in-process call would
 * never return, and the HTTP listener would live inside the editor's own
 * process for the rest of the session.
 *
 * So the split is: the CLI owns every decision (runtime floor, database
 * creation, repo registration, the history import, cutover, the backup
 * snapshot); this module owns the child's LIFECYCLE, which is the one thing a
 * terminal used to provide for free.
 *
 *   1. **What runs it.** `process.execPath` here is Electron, not node — see
 *      {@link RUN_AS_NODE_ENV}. The host's embedded Node is already guaranteed
 *      new enough by `engines.vscode`, so nothing here hunts for a system node
 *      the way `~/.jolli/jollimemory/run-cli` has to.
 *   2. **Where the lines go.** The child's stdout/stderr are drained into the
 *      "Jolli Memory" output channel. The CLI's `DashboardOutput` seam cannot
 *      help across a process boundary, so the pipes are the seam.
 *   3. **What opens the URL.** The child is run with `--no-open`: inside an
 *      editor the host owns URL handling (`vscode.env.openExternal`), and the
 *      CLI's `open` package would otherwise launch a browser from a process the
 *      editor did not choose. The URL is read off the child's own output — see
 *      {@link URL_PATTERN}.
 *   4. **When it stops.** {@link stopDashboard} kills it, and `deactivate` calls
 *      that. The child is deliberately NOT `unref`'d: an orphan whose stdout
 *      nobody drains blocks forever once the pipe fills (the history import
 *      prints for minutes), and a surviving invisible server is exactly the
 *      background process this command was rewritten to stop being.
 *
 * Two things it owns for the same reason as before: only one dashboard at a time
 * (see {@link LiveDashboard}), and a browser that refuses to open is reported
 * (see {@link reportBrowserFailure}).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import * as vscode from "vscode";
import { spawnHidden } from "../../../cli/src/util/Subprocess.js";
import { log } from "../util/Logger.js";

/**
 * The child handle, derived from the wrapper rather than imported from
 * `node:child_process` — that module is lint-blocked here (every spawn must go
 * through `spawnHidden`, which injects `windowsHide`), and deriving it also
 * keeps this type honest if the wrapper's return ever narrows.
 */
type ChildProcess = ReturnType<typeof spawnHidden>;

const TAG = "dashboard";

/** Basename of the CLI entry, as emitted into `dist/` by esbuild. */
export const CLI_ENTRY_FILE = "Cli.js";

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

/**
 * How the URL is recovered from the child's output.
 *
 * The command prints `Jolli dashboard → http://127.0.0.1:<port>/dashboard` once
 * it is listening, and that line is the only place the bound port exists: with
 * the state file gone there is nothing on disk to read it from, and the port is
 * not knowable in advance because a taken 1818 falls back to 18118.
 *
 * Matching the URL itself rather than the sentence around it, so a reworded line
 * still works. Anchored on the loopback address so no other line can match.
 */
export const URL_PATTERN = /(https?:\/\/127\.0\.0\.1:\d+\/\S*)/;

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

/** The window interactions this module performs, as a seam. */
export interface DashboardLauncherUi {
	readonly withProgress: (title: string, task: () => Promise<void>) => Promise<void>;
	readonly showError: (message: string, action: string) => Promise<string | undefined>;
	readonly showInfo: (message: string) => Promise<void>;
	readonly openExternal: (url: string) => Promise<void>;
	readonly revealLog: () => void;
}

/** Spawning the child, as a seam. Returns the process so the caller owns it. */
export type DashboardSpawner = (args: readonly string[], cwd: string) => ChildProcess;

export interface LaunchDashboardOptions {
	/** Repo directory to register and serve from. */
	readonly cwd: string;
	/** The extension's `dist/` — where {@link CLI_ENTRY_FILE} lives. */
	readonly distDir: string;
	/** Injected in tests so no real process runs. */
	readonly spawn?: DashboardSpawner;
	/** Injected in tests; production uses the real window APIs. */
	readonly ui?: DashboardLauncherUi;
	/** Injected in tests. Defaults to `vscode.env.remoteName`. */
	readonly remoteName?: string | undefined;
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

function defaultSpawner(distDir: string): DashboardSpawner {
	return (args, cwd) => {
		const scriptPath = join(distDir, CLI_ENTRY_FILE);
		if (!existsSync(scriptPath)) {
			// Thrown rather than logged: the caller turns this into the user-facing
			// failure. A log-and-return would leave the button spinning on a child
			// that was never started.
			throw new Error(`Jolli CLI entry not found at ${scriptPath} — this build is incomplete.`);
		}
		return spawnHidden(process.execPath, [scriptPath, ...args], {
			// Piped, and NOT unref'd — see the module header's point 4.
			stdio: ["ignore", "pipe", "pipe"],
			cwd,
			env: { ...process.env, ...RUN_AS_NODE_ENV },
		});
	};
}
/* v8 ignore stop */

/** Shown while the dashboard is starting. */
export const PROGRESS_TITLE = "Opening the Jolli dashboard…";

/** Shown when the dashboard could not be started. Details are in the output channel. */
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
 * The dashboard child this window owns, or null.
 *
 * Module-level because the callers are independent command invocations — one per
 * click — while what is guarded is shared: one server, one browser tab, and one
 * history import / cutover attempt / backup snapshot against the one machine
 * database. A second click must never start a second one.
 */
interface LiveDashboard {
	readonly child: ChildProcess;
	/** The startup barrier, so a click that arrives early can share the wait. */
	readonly startup: Promise<void>;
	/** The URL the child printed, once it has printed one. */
	url: string | undefined;
}

let live: LiveDashboard | null = null;

/** Drops the live record so each test starts from a clean launcher. */
export function __resetDashboardLaunchForTests(): void {
	live = null;
}

/**
 * Stops the dashboard this window started, if any.
 *
 * Called from `deactivate`, and available as a command. Idempotent: a child that
 * has already exited is simply forgotten.
 *
 * This is the replacement for the terminal's Ctrl+C, and it is the whole reason
 * the child is not `unref`'d — without an owner, a foreground server started
 * from a button is an invisible background process with no way to stop it.
 */
export function stopDashboard(): void {
	const running = live;
	live = null;
	if (!running || running.child.exitCode !== null || running.child.killed) return;
	log.info(TAG, "stopping the dashboard");
	running.child.kill();
}

/**
 * True while this window has a dashboard running.
 *
 * A test observer, not a production caller — `live` is module-private and the
 * launch/stop paths both consult it directly, so this exists to let the suite
 * assert the guard was set or cleared without reaching into the module. Wiring it
 * to a `when` clause for `jollimemory.stopDashboard` would need a context key
 * written from both paths; the command is harmless when nothing is running
 * ({@link stopDashboard} is idempotent), so that was not worth the second owner.
 */
export function isDashboardRunning(): boolean {
	return live !== null;
}

/**
 * The generic "it did not open" report, offering the channel that holds why.
 *
 * One function rather than a copy per failure path — a spawn that throws, a
 * child that exits before printing a URL, a child that fails to start — because
 * every one of them owes the user the same thing, and the reveal is easy to
 * forget on a new one.
 */
async function reportLaunchFailure(ui: DashboardLauncherUi): Promise<void> {
	if ((await ui.showError(FAILURE_MESSAGE, FAILURE_ACTION)) === FAILURE_ACTION) ui.revealLog();
}

/**
 * Tells the user the dashboard is up but the browser is not, and offers the log.
 *
 * Without this the whole failure is invisible: the child is serving happily and
 * printing its URL to a channel nobody has open, so the button spins, stops, and
 * nothing else ever happens.
 */
async function reportBrowserFailure(url: string, err: unknown, ui: DashboardLauncherUi): Promise<void> {
	log.error(TAG, `could not open a browser for ${url}: ${describeError(err)}`);
	if ((await ui.showError(BROWSER_FAILURE_MESSAGE, FAILURE_ACTION)) === FAILURE_ACTION) ui.revealLog();
}

/**
 * What a click does while a dashboard is already running.
 *
 * Starting a second one would bind a second port (the CLI falls back rather than
 * failing), open a second tab, and put a second history import, cutover attempt
 * and backup snapshot against the same database.
 */
async function rejoinLaunch(running: LiveDashboard, ui: DashboardLauncherUi): Promise<void> {
	log.info(TAG, "the dashboard is already running — reusing it");
	const opened = running.url;
	if (opened === undefined) {
		// It has not printed its URL yet, so there is nothing to re-open. Share the
		// barrier instead: this click gets its own progress notification, and the
		// first launch's browser is what ends it.
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
 * Drains one of the child's streams into the output channel, and reports the
 * first URL it sees.
 *
 * Line-buffered through `readline` rather than per-chunk, because a chunk
 * boundary can fall inside the URL line and a half-line would neither match
 * {@link URL_PATTERN} nor read sensibly in the channel.
 */
function drain(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
	if (!stream) return;
	createInterface({ input: stream }).on("line", onLine);
}

/**
 * Opens the dashboard: starts `jolli dashboard` as a child and opens its URL.
 *
 * The progress notification covers only up to the browser opening, NOT the
 * child's whole life — it serves until stopped, and the history import behind
 * the page can take minutes on a first run. So the notification is released by
 * whichever comes first: the URL line (success) or the child exiting (failure).
 *
 * One dashboard at a time: a click that arrives while one is running is served
 * by {@link rejoinLaunch}.
 *
 * Resolves once the startup phase has settled. Never rejects — a failure becomes
 * a notification.
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
	const running = live;
	if (running) {
		await rejoinLaunch(running, ui);
		return;
	}
	const spawn = options.spawn ?? defaultSpawner(options.distDir);

	/* v8 ignore next -- the seed no-op only satisfies definite assignment; the Promise executor below runs synchronously and replaces it first. */
	let releaseStartup: () => void = () => {};
	const startupSettled = new Promise<void>((resolve) => {
		releaseStartup = resolve;
	});

	let child: ChildProcess;
	try {
		// `--no-open` because this host opens the URL itself (module header, 3).
		child = spawn(["dashboard", "--no-open", "--cwd", options.cwd], options.cwd);
	} catch (err) {
		// A missing entry, or a spawn that failed synchronously. Nothing to unwind:
		// `live` is published below, so no guard leaked.
		log.error(TAG, `dashboard launch threw: ${describeError(err)}`);
		await reportLaunchFailure(ui);
		return;
	}

	const launch: LiveDashboard = { child, startup: startupSettled, url: undefined };
	live = launch;

	const onLine = (line: string): void => {
		const text = line.trim();
		if (text) log.info(TAG, text);
		if (launch.url !== undefined) return;
		const match = URL_PATTERN.exec(text);
		if (!match?.[1]) return;
		// Recorded before the attempt rather than after it: a click that arrives
		// during the import should retry this URL even when the first open failed.
		launch.url = match[1];
		void (async () => {
			try {
				await ui.openExternal(match[1] as string);
			} catch (err) {
				// Not awaited by the caller — `showErrorMessage` resolves only when
				// the user answers it, and the child keeps running regardless.
				void reportBrowserFailure(match[1] as string, err, ui);
			} finally {
				// In `finally` so a browser that refuses to open still ends the
				// notification: the dashboard IS up, and leaving a spinner on screen
				// would be the only damage.
				releaseStartup();
			}
		})();
	};
	drain(child.stdout, onLine);
	drain(child.stderr, onLine);

	// `error` and `close` can both fire for one launch — a spawn that fails emits
	// `error` and then `close`, with no `exit` in between — and each of them ends
	// in the same notification. Reporting once is the point: two modal errors for
	// one click is the bug the `close` switch below would otherwise introduce.
	let reported = false;
	const reportOnce = (): void => {
		if (reported) return;
		reported = true;
		void reportLaunchFailure(ui);
	};

	child.on("error", (err) => {
		log.error(TAG, `dashboard process error: ${describeError(err)}`);
		if (live === launch) live = null;
		releaseStartup();
		reportOnce();
	});
	// `close`, NOT `exit`. `exit` fires when the process ends, while the pipes it
	// wrote to may still hold buffered lines — including the URL line this whole
	// launch is waiting for. A dashboard stopped moments after it started serving
	// therefore raced its own `drain`, and losing that race meant `launch.url` was
	// still undefined here: the user was told the dashboard could not be started,
	// about a dashboard that had started and printed its URL. `close` waits for
	// both stdio streams to end, so every line `drain` will ever see has been seen.
	child.on("close", (code) => {
		if (live === launch) live = null;
		const url = launch.url;
		releaseStartup();
		// A child that exited BEFORE printing a URL never served anything, so the
		// click failed and the user has to be told. One that exits afterwards was
		// either stopped on purpose or died later; the channel already carries why,
		// and a notification for a dashboard the user closed would be noise.
		if (url === undefined) {
			log.error(TAG, `dashboard exited before it started serving (code ${code ?? "null"})`);
			reportOnce();
		} else {
			log.info(TAG, `dashboard stopped (code ${code ?? "null"})`);
		}
	});

	await ui.withProgress(PROGRESS_TITLE, () => startupSettled);
}
