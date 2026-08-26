/**
 * DashboardLauncher — starts `jolli dashboard` as a detached background process.
 *
 * The button used to spawn an integrated terminal and type the command into it.
 * That mode meant the user carried both the shell window and the CLI's output
 * on screen, and it left an accumulating strip of dashboard terminals in the
 * panel. This launcher instead does what the Claude Code plugin's dashboard
 * skill already does: launch the CLI detached, unref it, and let the CLI itself
 * open the browser. The command reclaims any existing dashboard on ports 1818 /
 * 18118, so a second click ends the first server and takes over, with nothing
 * for this module to poll or clean up.
 *
 * The command selection is unchanged from the terminal-based launcher — same
 * three tiers, in order:
 *
 *   0. **`jolli`** — the readable spelling, used only when a globally-installed
 *      CLI both WINS the dist-paths version competition and is at least as new
 *      as the core this bundle carries. Presence is not the gate: a stale
 *      global CLI would shadow a newer bundled one and answer `unknown command
 *      'dashboard'`. This tier spawns the absolute global script with the
 *      extension host's `process.env.PATH` snapshot — not a freshly sourced
 *      login shell. If the GUI that launched VS Code provided a reduced PATH,
 *      a POSIX `#!/usr/bin/env node` interpreter can exec and then exit 127
 *      without ever reaching the `error` event. The `exit` listener below
 *      records that specific exit code so the failure is not silent.
 *   1. **`~/.jolli/jollimemory/run-cli`** — the machine-global dispatcher,
 *      which resolves the highest-versioned registered dist. Covers both "the
 *      user has a global CLI" and "only the VS Code bundle exists", and is
 *      POSIX-only because it carries a `#!/bin/bash` shebang.
 *   2. **The best registered dist's `Cli.js`, run by the host's Node** —
 *      reached when tiers 0 and 1 are unavailable. The dist-paths registry
 *      names the highest-available dist — the same competition `run-cli`
 *      re-reads at runtime — and its `Cli.js` is run by the host's Electron
 *      under `ELECTRON_RUN_AS_NODE=1` (`engines.vscode` guarantees a Node that
 *      clears the 22.13 `node:sqlite` floor). If the winner's file is missing
 *      or nothing is registered, this falls back to the extension's own
 *      `dist/Cli.js` — the same shape as `resolveMcpCli` — so a stale entry
 *      pointing at a deleted dist degrades to the bundle instead of failing.
 *
 * The spawned child is detached with `stdio: "ignore"` and unref'd, so it
 * outlives this extension host and the user closing the window. Its stdout
 * / stderr are dropped: `executeDashboard` inside the CLI opens the browser
 * itself, and any failure message it prints AFTER a successful spawn — the
 * runtime-version check, a database error, a port conflict — lands in the
 * CLI's own `.jolli/jollimemory/debug.log` rather than in a terminal we no
 * longer open. When the CLI cannot be SPAWNED at all (a synchronous throw or
 * the async `error` event) we show a VS Code error message the user actually
 * sees, which is the failure mode that used to reach the terminal.
 */

import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix as posixPath, win32 as win32Path } from "node:path";
import * as vscode from "vscode";
import { pickBestDistPath, traverseDistPaths } from "../../../cli/src/install/DistPathResolver.js";
import { compareSemver } from "../../../cli/src/install/SemverCompare.js";
import { spawnHidden } from "../../../cli/src/util/Subprocess.js";
import { log } from "../util/Logger.js";

const TAG = "dashboard";

/** Basename of the CLI entry, as emitted into `dist/` by esbuild. */
export const CLI_ENTRY_FILE = "Cli.js";

/**
 * Environment variable that makes the host's Electron binary behave as a plain
 * node process. Applied only when tier 2 is chosen — on tiers 0 and 1 the
 * executable is already a real node-launching binary.
 */
export const RUN_AS_NODE_ENV_KEY = "ELECTRON_RUN_AS_NODE";

/**
 * Marker env variable so a `ps` line can tell this launch apart from a manual
 * `jolli dashboard`. NOT a telemetry signal: the CLI consumes the variable
 * before `dashboard` runs, but its telemetry `via` validator only accepts
 * `skill:<name>` values (see `resolveInvokedVia` in the CLI), so this value is
 * dropped whole there. Wiring button launches into telemetry would need that
 * validator to grow a new value class — do not widen this comment to claim it.
 */
export const INVOKED_VIA_ENV_KEY = "JOLLI_INVOKED_VIA";
export const INVOKED_VIA_VALUE = "vscode:dashboard-button";

/**
 * True when this window edits files on another machine (Remote-SSH, WSL, dev
 * container, Codespaces). Kept from the terminal-based launcher: a detached
 * child of the extension host runs on the host, not the remote, so the server
 * would bind on the wrong side and the browser call would target a machine
 * with no display.
 */
export function isRemoteWorkspace(remoteName: string | undefined = vscode.env.remoteName): boolean {
	return remoteName !== undefined;
}

/** What the user is told instead of a broken button in a remote window. */
export const REMOTE_HINT =
	"The Jolli dashboard runs on the machine that holds your code. " +
	"Open a terminal on that machine and run `jolli dashboard` — VS Code will offer to forward the port.";

/** Shown when no tier yielded a runnable command. Details are in the log. */
export const UNAVAILABLE_MESSAGE =
	"Could not find a Jolli CLI to run the dashboard — this build may be incomplete.";

/** Shown when the CLI cannot be spawned at all — sync throw or async `error`. */
export const SPAWN_FAILED_MESSAGE = "Could not start the Jolli dashboard — see Jolli's output channel for details.";

/** Absolute path of the machine-global CLI dispatcher. */
export function resolveRunCliPath(homeDir: string = homedir()): string {
	return join(homeDir, ".jolli", "jollimemory", "run-cli");
}

/* ── Tier 0: a global `jolli` that is new enough ─────────────────────────────── */

/** The name a global install puts on PATH. */
export const GLOBAL_BIN_NAME = "jolli";

/** The dist-paths source tag a global `npm i -g @jolli.ai/cli` writes. */
export const GLOBAL_CLI_SOURCE = "cli";

/**
 * The core version this bundle carries — the floor a global CLI must clear.
 * `__CLI_PKG_VERSION__`, NOT `__PKG_VERSION__` (the extension's own release
 * number): dist-paths entries record the `@jolli.ai/cli` core version.
 */
/* v8 ignore next -- compile-time ternary: "0.0.0" under vitest, the real define in bundled builds */
export const BUNDLED_CLI_VERSION = typeof __CLI_PKG_VERSION__ !== "undefined" ? __CLI_PKG_VERSION__ : "0.0.0";

/**
 * The single `pickBestDistPath(traverseDistPaths(...))` pass shared by the two
 * callers that need the winning registry entry. Kept private on purpose: both
 * public helpers below derive their result from this one traversal, and the
 * launcher reuses it so a click does not re-read the whole registry twice.
 */
function readWinningDistEntry(globalDir?: string): ReturnType<typeof pickBestDistPath> {
	return pickBestDistPath(traverseDistPaths(globalDir));
}

/**
 * The version of a globally-installed CLI that outranks every other registered
 * dist, or null when there is no such install. Same competition `resolve-dist-path`
 * runs.
 */
export function readWinningGlobalCliVersion(globalDir?: string): string | null {
	const winner = readWinningDistEntry(globalDir);
	return winner?.source === GLOBAL_CLI_SOURCE ? winner.version : null;
}

/**
 * Absolute path of the winning registered dist's `Cli.js`, or undefined when no
 * dist is registered/available. The same competition `run-cli` re-reads at
 * runtime — this is the Node-side spelling of it, and what `resolveMcpCli`
 * already does for the MCP launcher. The FILE's existence is checked by the
 * resolver's `fileExists` seam, not here: `pickBestDistPath` only proves the
 * dist DIRECTORY exists, and a registered dist may be missing its `Cli.js`.
 */
export function resolveWinningDistCliPath(globalDir?: string): string | undefined {
	const best = readWinningDistEntry(globalDir);
	return best ? join(best.distDir, CLI_ENTRY_FILE) : undefined;
}

/**
 * Whether a path is safe to hand to `cmd.exe` through `shell: true`.
 *
 * `shell: true` routes the command through a shell, and the path comes from
 * the user's own PATH, so it must not be able to change what the shell runs.
 * cmd metacharacters that survive inside Node's quoting (`%` expands env
 * vars, `&`/`|`/`<`/`>` separate commands, `"` breaks quoting, `!` enables
 * delayed expansion, `^` escapes, `*`/`?` glob) refuse the path entirely.
 * Whitespace is refused for the same reason: Node builds the `cmd.exe` command
 * by joining the unquoted `file` and `args`, so a directory containing a space
 * (`C:\Users\John Doe\...\jolli.cmd`) would be split by `cmd.exe` before
 * execution. Refusal makes tier 0 fall through to tier 1/2 — a graceful
 * fallback, never a failure.
 *
 * This is NOT the same call as `runNpmCommand`: that helper passes the bare
 * token `npm` (resolved through `PATHEXT`, so no absolute path can carry a
 * space) and validates its allow-listed `args`. Here the executable is an
 * absolute user-controlled path, which is exactly why the path itself is the
 * guard target.
 */
export function isShellSafePath(path: string): boolean {
	return !/[\s%&|<>^"!*?]/.test(path);
}

/**
 * Finds `binName` on PATH, returning its absolute path or null. Used by tier 0
 * to (a) confirm a global CLI is reachable and (b) hand `spawn` an absolute
 * path — spawning a bare name on Windows depends on shell resolution.
 *
 * Every platform-dependent choice comes from the `platform` argument, not the
 * host, so a test running on POSIX can assert win32 behaviour.
 */
export function findExecutableOnPath(
	binName: string,
	deps: {
		readonly pathEnv?: string | undefined;
		readonly pathExt?: string | undefined;
		readonly platform: NodeJS.Platform;
		/** Defaults to {@link isExecutableFile} — the exec bit, not mere existence. */
		readonly fileExists?: ((path: string) => boolean) | undefined;
	},
): string | null {
	const exists = deps.fileExists ?? isExecutableFile;
	const paths = deps.platform === "win32" ? win32Path : posixPath;
	const dirs = (deps.pathEnv ?? "").split(paths.delimiter).filter((dir) => dir.length > 0);
	const suffixes =
		deps.platform === "win32"
			? (deps.pathExt ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext.length > 0)
			: [""];
	for (const dir of dirs) {
		for (const suffix of suffixes) {
			const candidate = paths.join(dir, `${binName}${suffix}`);
			if (exists(candidate)) return candidate;
		}
	}
	return null;
}

/** Which tier produced a command. Reported in the log, and pinned by tests. */
export type DashboardCommandTier = "global-jolli" | "run-cli" | "host-node";

export interface ResolvedDashboardCommand {
	/** Absolute path of the executable to spawn. */
	readonly executable: string;
	/** Arguments passed as argv[1..]. */
	readonly args: ReadonlyArray<string>;
	readonly tier: DashboardCommandTier;
	/** True when the child needs `ELECTRON_RUN_AS_NODE=1` in its env (tier 2). */
	readonly runAsNode: boolean;
	/**
	 * True only for win32 `.cmd` / `.bat` shims, which Node refuses to spawn
	 * directly (EINVAL since the CVE-2024-27980 fix) and which therefore go
	 * through `cmd.exe` via `shell: true`.
	 */
	readonly shell: boolean;
}

export interface CommandResolutionDeps {
	/** Repo directory to register and serve from — reaches the CLI as its cwd. */
	readonly cwd: string;
	/** The extension's `dist/` — the fallback that holds {@link CLI_ENTRY_FILE}. */
	readonly distDir: string;
	/** Host platform — decides whether tier 1 (bash script) is reachable. */
	readonly platform: NodeJS.Platform;
	/** The host's Electron binary; runs as node under `ELECTRON_RUN_AS_NODE`. */
	readonly execPath: string;
	readonly runCliPath?: string | undefined;
	/**
	 * Absolute path of the winning globally-installed CLI, or null. Resolved by
	 * the caller so this function stays pure.
	 */
	readonly globalCliPath?: string | null | undefined;
	/** Version of the winning globally-installed CLI, or null. */
	readonly globalCliVersion?: string | null | undefined;
	/**
	 * Absolute path of the winning registered dist's `Cli.js`, or null.
	 * Resolved by the caller (via {@link resolveWinningDistCliPath}) so this
	 * function stays pure — it reads no registry of its own.
	 */
	readonly winningDistCliPath?: string | null | undefined;
	/** The floor a global CLI must clear. Defaults to {@link BUNDLED_CLI_VERSION}. */
	readonly minGlobalCliVersion?: string | undefined;
	/** Defaults to {@link isExecutableFile}. */
	readonly canExecute?: ((path: string) => boolean) | undefined;
	/** Defaults to a real `existsSync` — tier 2 only needs `Cli.js` to be readable. */
	readonly fileExists?: ((path: string) => boolean) | undefined;
}

/** A regular file the shell can actually run. */
function isExecutableFile(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * Picks the tier and returns the argv the spawn will use, or null when no tier
 * is usable.
 *
 * The command carries no `--cwd`: the CLI reads `process.cwd()`, and the
 * spawn's own `cwd` is what points that at the repo root.
 */
export function resolveDashboardCommand(deps: CommandResolutionDeps): ResolvedDashboardCommand | null {
	const canExecute = deps.canExecute ?? isExecutableFile;
	const fileExists = deps.fileExists ?? existsSync;
	const tail = "dashboard";

	// Tier 0 — the readable form. Version-gated so a stale global CLI cannot
	// shadow a newer bundled one. `globalCliPath` is what turns the "on PATH"
	// check into an absolute path we can hand `spawn` directly.
	//
	// win32 wrinkle: the path a global npm install puts on PATH is a `.cmd`
	// shim, and Node refuses to spawn `.cmd` / `.bat` directly (EINVAL since
	// the CVE-2024-27980 fix), so those are run through `cmd.exe` via
	// `shell: true`. That is a different surface from `runNpmCommand`: here the
	// executable is an absolute user-controlled path, not the bare `npm` token,
	// and Node joins that path with args without quoting it. The path is
	// therefore required to be free of cmd metacharacters AND whitespace before
	// `shell: true` is used; a path that fails that check falls through to
	// tier 1/2 instead of being quoted into a shell command.
	const globalVersion = deps.globalCliVersion;
	const globalPath = deps.globalCliPath;
	const floor = deps.minGlobalCliVersion ?? BUNDLED_CLI_VERSION;
	if (globalVersion != null && globalPath != null && compareSemver(globalVersion, floor) >= 0) {
		const needsShell = /\.(?:cmd|bat)$/i.test(globalPath);
		if (!needsShell || isShellSafePath(globalPath)) {
			return {
				executable: globalPath,
				args: [tail],
				tier: "global-jolli",
				runAsNode: false,
				shell: needsShell,
			};
		}
	}

	// Tier 1 — POSIX-only: `run-cli` carries a `#!/bin/bash` shebang. The
	// terminal-based launcher also reached this tier under Git Bash on Windows,
	// because the terminal shell interpreted the shebang; a detached child has
	// no such shell, and locating/verifying a Git-for-Windows bash is not
	// attempted here, so win32 skips this tier outright.
	if (deps.platform !== "win32") {
		const runCli = deps.runCliPath ?? resolveRunCliPath();
		if (canExecute(runCli)) {
			return { executable: runCli, args: [tail], tier: "run-cli", runAsNode: false, shell: false };
		}
	}

	// Tier 2 — the best registered dist's `Cli.js`, run by the host's Node.
	// Mirrors `resolveMcpCli`: the registry names the highest-available dist,
	// and when that dist's `Cli.js` is missing — a stale entry pointing at a
	// deleted or incomplete dist — this falls back to the extension's own
	// `dist/Cli.js` rather than failing. That fallback is what keeps Windows
	// (where tiers 0 and 1 are unavailable or bash-only) from freezing the
	// button on the bundle when a newer plugin dist is registered.
	const winningEntry = deps.winningDistCliPath;
	if (winningEntry != null && fileExists(winningEntry)) {
		return {
			executable: deps.execPath,
			args: [winningEntry, tail],
			tier: "host-node",
			runAsNode: true,
			shell: false,
		};
	}

	const cliEntry = join(deps.distDir, CLI_ENTRY_FILE);
	if (!fileExists(cliEntry)) return null;
	return {
		executable: deps.execPath,
		args: [cliEntry, tail],
		tier: "host-node",
		runAsNode: true,
		shell: false,
	};
}

/* ── Launcher ───────────────────────────────────────────────────────────────── */

/** The window interactions this module performs, as a seam. */
export interface DashboardLauncherHost {
	readonly showInfo: (message: string) => Promise<void>;
	readonly showError: (message: string) => Promise<void>;
}

/** Options handed to the spawn seam — the minimum this module actually sets. */
export interface DashboardSpawnOptions {
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly detached: boolean;
	readonly stdio: "ignore";
	/** True only for win32 `.cmd` / `.bat` shims, which need `cmd.exe`. */
	readonly shell: boolean;
}

/**
 * How the spawn happens. Injected so tests never launch a real process. The
 * return value is minimal on purpose: this module never waits on the child or
 * reads its output, so there is nothing else to expose.
 */
export type DashboardSpawn = (
	executable: string,
	args: ReadonlyArray<string>,
	options: DashboardSpawnOptions,
) => SpawnedChild;

export interface SpawnedChild {
	readonly pid: number | undefined;
	unref(): void;
	on(event: "error", listener: (err: Error) => void): void;
	on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

/* v8 ignore start -- thin adapters over vscode.window and node:child_process */
function defaultHost(): DashboardLauncherHost {
	return {
		showInfo: (message) =>
			Promise.resolve(vscode.window.showInformationMessage(message)).then(() => undefined),
		showError: (message) => Promise.resolve(vscode.window.showErrorMessage(message)).then(() => undefined),
	};
}

const defaultSpawn: DashboardSpawn = (executable, args, options) =>
	spawnHidden(executable, [...args], { ...options }) as unknown as SpawnedChild;
/* v8 ignore stop */

export interface LaunchDashboardOptions {
	/** Repo directory to register and serve from. */
	readonly cwd: string;
	/** The extension's `dist/` — where {@link CLI_ENTRY_FILE} lives. */
	readonly distDir: string;
	/** Injected in tests; production uses the real window APIs. */
	readonly host?: DashboardLauncherHost;
	/** Injected in tests. Defaults to `vscode.env.remoteName`. */
	readonly remoteName?: string | undefined;
	/** Injected in tests. Defaults to `process.platform`. */
	readonly platform?: NodeJS.Platform;
	/** Injected in tests. Defaults to `process.execPath` (the host's Electron). */
	readonly execPath?: string;
	/** Injected in tests, so no case reads the real home directory. */
	readonly runCliPath?: string;
	/** Injected in tests. Defaults to a real `X_OK` probe. */
	readonly canExecute?: (path: string) => boolean;
	/** Injected in tests. Defaults to a real `existsSync`. */
	readonly fileExists?: (path: string) => boolean;
	/** Injected in tests. Defaults to reading the real dist-paths registry. */
	readonly globalCliVersion?: string | null | undefined;
	/** Injected in tests. Defaults to a PATH walk keyed off {@link GLOBAL_BIN_NAME}. */
	readonly globalCliPath?: string | null | undefined;
	/** Injected in tests. Defaults to reading the real dist-paths registry. */
	readonly winningDistCliPath?: string | null | undefined;
	/** Injected in tests. Defaults to {@link BUNDLED_CLI_VERSION}. */
	readonly minGlobalCliVersion?: string | undefined;
	/** Injected in tests. Defaults to `process.env.PATH`. */
	readonly pathEnv?: string | undefined;
	/** Injected in tests. Defaults to `process.env.PATHEXT` (win32 only). */
	readonly pathExt?: string | undefined;
	/** Injected in tests. Defaults to a real `child_process.spawn`. */
	readonly spawn?: DashboardSpawn;
}

/**
 * Starts the dashboard as a detached background process.
 *
 * Resolves once the child has been spawned. The child keeps running past that —
 * `detached: true` + `unref()` means it survives the extension host and the
 * user closing the window. Its stdio is `"ignore"` so nothing accumulates in
 * memory here. Never rejects.
 */
export async function launchDashboard(options: LaunchDashboardOptions): Promise<void> {
	const host = options.host ?? defaultHost();
	if (isRemoteWorkspace(options.remoteName)) {
		log.info(TAG, "remote window — not starting a local dashboard server");
		await host.showInfo(REMOTE_HINT);
		return;
	}

	const platform = options.platform ?? process.platform;
	const ambientWinner =
		options.globalCliVersion === undefined || options.winningDistCliPath === undefined
			? readWinningDistEntry()
			: undefined;
	const globalCliVersion =
		options.globalCliVersion !== undefined
			? options.globalCliVersion
			: ambientWinner?.source === GLOBAL_CLI_SOURCE
				? ambientWinner.version
				: null;
	const globalCliPath =
		options.globalCliPath !== undefined
			? options.globalCliPath
			: globalCliVersion !== null
				? findExecutableOnPath(GLOBAL_BIN_NAME, {
						pathEnv: options.pathEnv ?? process.env.PATH,
						pathExt: options.pathExt ?? process.env.PATHEXT,
						platform,
						fileExists: options.fileExists,
					})
				: null;
	const winningDistCliPath =
		options.winningDistCliPath !== undefined
			? options.winningDistCliPath
			: ambientWinner
				? join(ambientWinner.distDir, CLI_ENTRY_FILE)
				: undefined;
	const resolved = resolveDashboardCommand({
		cwd: options.cwd,
		distDir: options.distDir,
		platform,
		execPath: options.execPath ?? process.execPath,
		runCliPath: options.runCliPath,
		canExecute: options.canExecute,
		fileExists: options.fileExists,
		globalCliVersion,
		globalCliPath,
		winningDistCliPath,
		minGlobalCliVersion: options.minGlobalCliVersion,
	});

	if (resolved === null) {
		log.error(
			TAG,
			`no usable CLI for the dashboard: no qualifying global jolli, no runnable run-cli, no usable registered dist, and no bundled entry at ${join(options.distDir, CLI_ENTRY_FILE)}`,
		);
		await host.showError(UNAVAILABLE_MESSAGE);
		return;
	}

	const env: NodeJS.ProcessEnv = { ...process.env, [INVOKED_VIA_ENV_KEY]: INVOKED_VIA_VALUE };
	if (resolved.runAsNode) {
		env[RUN_AS_NODE_ENV_KEY] = "1";
	}

	const displayArgv = [resolved.executable, ...resolved.args]
		.map((part) => (part.includes(" ") ? `"${part}"` : part))
		.join(" ");
	log.info(TAG, `launching dashboard in background via ${resolved.tier}: ${displayArgv}`);
	const spawn = options.spawn ?? defaultSpawn;
	try {
		const child = spawn(resolved.executable, resolved.args, {
			cwd: options.cwd,
			env,
			detached: true,
			stdio: "ignore",
			shell: resolved.shell,
		});
		child.on("error", (err) => {
			log.error(TAG, `dashboard child spawn error: ${err.message}`);
			void host.showError(SPAWN_FAILED_MESSAGE);
		});
		child.on("exit", (code) => {
			if (resolved.tier === "global-jolli" && code === 127) {
				log.error(
					TAG,
					"global jolli exited 127 before opening the dashboard — tier 0 inherits this process's PATH snapshot, so a missing `node` on a GUI-launched host is the likely cause",
				);
			}
		});
		child.unref();
		log.info(TAG, `dashboard child spawned pid=${child.pid ?? "?"}`);
	} catch (err) {
		log.error(TAG, `failed to spawn dashboard child: ${err instanceof Error ? err.message : String(err)}`);
		await host.showError(SPAWN_FAILED_MESSAGE);
	}
}
