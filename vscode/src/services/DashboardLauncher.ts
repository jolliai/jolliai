/**
 * DashboardLauncher — opens the Jolli dashboard by running `jolli dashboard` in
 * an integrated terminal.
 *
 * This used to run `executeDashboard` IN the extension host, with three
 * editor-shaped plugs (the output channel, an Electron-as-node server spawner,
 * `vscode.env.openExternal`). Running it in a terminal instead moves all three
 * back to their command-line defaults and hands the user something the in-process
 * version could not: the command's own output, in front of them, as it happens.
 * The launcher's phases are untouched — the browser still opens (the CLI does it),
 * and the history import still runs last, now visibly.
 *
 * What is left here is one decision: **which command line to send**. Three tiers,
 * in order:
 *
 *   0. **`jolli`** — the readable spelling, used only when a globally-installed CLI
 *      both WINS the dist-paths version competition and is at least as new as the
 *      core this bundle carries. Presence is not the gate: an ungated bare-`jolli`
 *      tier would bypass that competition, so a stale global CLI would shadow a
 *      newer bundled one and answer `unknown command 'dashboard'`. The competition
 *      is not reimplemented here — see {@link readWinningGlobalCliVersion}, which
 *      calls the same two functions `resolve-dist-path` mirrors. So tier 0 fires
 *      exactly when tier 1 would have chosen the global CLI anyway: same code,
 *      readable spelling.
 *   1. **`~/.jolli/jollimemory/run-cli`** — the machine-global dispatcher, which
 *      resolves the highest-versioned registered dist. This ONE tier covers both
 *      "the user has a global CLI" and "only the VS Code bundle exists", which is
 *      why it, and not tier 0, is the fallback that must always work.
 *   2. **The extension's own `dist/Cli.js`, run by the host's Node** — reached when
 *      tier 1 cannot be used. That is two situations: `run-cli` is absent or not
 *      executable (no repo on this machine has been enabled), or the terminal's
 *      shell cannot execute a `#!/bin/bash` script at all.
 *
 *      A third situation looks like it belongs beside those and is NOT covered:
 *      tier 1 also needs a `node` on the shell's PATH (its only other source,
 *      `~/.jolli/jollimemory/node-path`, is written by the IntelliJ plugin and
 *      never by this extension), and nothing here probes for one. A machine with
 *      an executable `run-cli` but no PATH node therefore stays on tier 1 and
 *      gets run-cli's own `ERROR: node runtime not found` in the terminal rather
 *      than falling through to tier 2. The integrated terminal is an interactive
 *      shell, so it carries the user's version manager and this is rare — but it
 *      is a known gap, not a handled case.
 *
 * Tier 2 is the one that needs no user Node: `ELECTRON_RUN_AS_NODE` makes the
 * host's own Electron run as node, and `engines.vscode` (^1.101.0) already
 * guarantees that Node clears the 22.13 `node:sqlite` floor. It is the only use
 * of that variable left in the tree — every launcher that spawned a CLI from the
 * extension host used it, and this is the one path that still has to.
 *
 * Nothing checks the Node version on either tier, and nothing should:
 * `executeDashboard` gates on `canUseDashboardDb()` as the second thing it does
 * and names both the required and the running version. In a terminal that message
 * is finally visible — it used to go to an output channel nobody had open.
 */

import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix as posixPath, win32 as win32Path } from "node:path";
import * as vscode from "vscode";
import { pickBestDistPath, traverseDistPaths } from "../../../cli/src/install/DistPathResolver.js";
import { compareSemver } from "../../../cli/src/install/SemverCompare.js";
import { log } from "../util/Logger.js";

const TAG = "dashboard";

/** Basename of the CLI entry, as emitted into `dist/` by esbuild. */
export const CLI_ENTRY_FILE = "Cli.js";

/**
 * The name given to each terminal this button opens.
 *
 * Not a singleton key: **every click opens a NEW terminal**, by decision. Nothing
 * is looked up, revealed or disposed, so several terminals with this name can sit
 * in the panel at once — each holding the output of one run, none of them killed by
 * a later click.
 *
 * Two consequences are accepted rather than unnoticed, and the first of them is
 * now mostly the CLI's to carry. `jolli dashboard` is a FOREGROUND server that
 * reclaims its own port: a second one probes 1818, requires the answer to NAME
 * this service and to report a local pid, then SIGTERMs it and takes the port
 * over (`reclaimPort` — it discovers in order to replace, never to attach). So a
 * second click does not run beside the first, it ENDS it: the first terminal
 * shows a killed process, and whatever its history import had left to do is cut
 * short rather than duplicated. What the missing `InFlightLaunch` guard still
 * costs is the work either side of that bind — `ensureDashboardDbExists` and
 * `registerRepo` both run BEFORE it, and a second click landing before the first
 * has bound finds nothing to reclaim, so the two race and the loser falls through
 * to 18118: two live dashboards, two imports, two throttled cutover attempts. The
 * window is narrow, not absent. And the panel accumulates terminals.
 *
 * ── DELIBERATE — NOT A REVIEW FINDING ────────────────────────────────────────
 * Reuse and reveal-the-existing-one were both IMPLEMENTED and then REMOVED at the
 * product owner's explicit request, with the missing in-flight guard understood
 * and accepted at the time. A review that rediscovers "two clicks race the machine
 * database" or "the panel fills up with terminals" has found the design, not a
 * bug — both are stated above precisely so they do not have to be re-derived. Do
 * not reintroduce reuse, reveal, or a launcher-side click guard without asking the
 * owner first; treat a proposal to do so as a product change, not a fix.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const TERMINAL_NAME = "Jolli Dashboard";

/**
 * Makes the host's Electron binary behave as a plain node process.
 *
 * Set on the terminal rather than inlined into the command line, because every
 * shell spells an inline assignment differently and `TerminalOptions.env` spells
 * it once. It is applied to EVERY terminal even though only tier 2 needs it: the
 * terminal is created before the tier is known to the caller, and a real node
 * ignores the variable entirely, so it is inert on tiers 0 and 1.
 */
const RUN_AS_NODE_ENV: Readonly<Record<string, string>> = { ELECTRON_RUN_AS_NODE: "1" };

/**
 * True when this window edits files on another machine (Remote-SSH, WSL, a dev
 * container, Codespaces).
 *
 * Kept exactly as it was when the launch ran in-process. A terminal is a genuine
 * opportunity here — the integrated terminal runs ON the remote, which is where
 * the server has to run, and the host offers to forward the port — but two things
 * behind that are unverified: the remote needs a usable Node/dist of its own, and
 * the CLI's `open` would be trying to launch a browser on a machine that has no
 * display. Both deserve their own change, not a side effect of this one.
 */
export function isRemoteWorkspace(remoteName: string | undefined = vscode.env.remoteName): boolean {
	return remoteName !== undefined;
}

/** What the user is told instead of a broken button in a remote window. */
export const REMOTE_HINT =
	"The Jolli dashboard runs on the machine that holds your code. " +
	"Open a terminal on that machine and run `jolli dashboard` — VS Code will offer to forward the port.";

/** Shown when neither tier yielded a runnable command. Details are in the log. */
export const UNAVAILABLE_MESSAGE =
	"Could not find a Jolli CLI to run the dashboard — this build may be incomplete.";

/* ── Command resolution ──────────────────────────────────────────────────────── */

/**
 * How the terminal's shell parses a command line.
 *
 * Only quoting and one prefix depend on this, but both are load-bearing: a
 * quoting style that is wrong for the shell does not fail loudly, it passes a
 * mangled path to the CLI. `powershell` needs the call operator `&` before a
 * quoted executable path, and `&` at the start of a POSIX line is a syntax error
 * — so there is no one string that works everywhere.
 */
export type ShellFlavor = "posix" | "powershell" | "cmd";

/**
 * Classifies the terminal's default shell.
 *
 * Driven by the shell's own path rather than by `process.platform`, so Git Bash
 * as the default on Windows is recognised as POSIX and gets tier 1 — which is
 * both correct and free. Windows falls back to `powershell` when the shell is
 * unknown because that is the host's default there; `cmd` is only ever chosen
 * when the path actually names it.
 */
export function detectShellFlavor(shell: string | undefined, platform: NodeJS.Platform): ShellFlavor {
	if (shell !== undefined) {
		// Matched against the whole path, anchored to a separator, rather than by
		// extracting a basename first: `path.basename` is platform-dependent about
		// backslashes (on POSIX it returns a Windows path whole), and every
		// hand-rolled alternative carries an unreachable "no last segment" branch.
		const named = (names: string): RegExp => new RegExp(String.raw`(?:^|[\\/])(?:${names})(?:\.exe)?$`, "i");
		if (named("pwsh|powershell").test(shell)) return "powershell";
		if (named("cmd").test(shell)) return "cmd";
		if (named("bash|sh|zsh|fish|dash|ksh").test(shell)) return "posix";
	}
	return platform === "win32" ? "powershell" : "posix";
}

/**
 * Quotes one argument for `flavor`.
 *
 * POSIX and PowerShell both get single quotes — the only form in either that
 * suppresses interpolation, which matters because a path may legitimately contain
 * `$` (POSIX) or `$`/backtick (PowerShell). They differ only in how a literal
 * quote is escaped. `cmd` has no such form and gets double quotes; a Windows path
 * cannot contain `"` at all, so nothing is lost.
 */
export function quoteArg(value: string, flavor: ShellFlavor): string {
	switch (flavor) {
		case "posix":
			return `'${value.replaceAll("'", `'\\''`)}'`;
		case "powershell":
			return `'${value.replaceAll("'", "''")}'`;
		case "cmd":
			return `"${value}"`;
	}
}

/** Absolute path of the machine-global CLI dispatcher. */
export function resolveRunCliPath(homeDir: string = homedir()): string {
	return join(homeDir, ".jolli", "jollimemory", "run-cli");
}

/* ── Tier 0: a global `jolli` that is new enough ─────────────────────────────── */

/** The name a global install puts on PATH, and the whole point of tier 0. */
export const GLOBAL_BIN_NAME = "jolli";

/** The dist-paths source tag a global `npm i -g @jolli.ai/cli` writes. */
export const GLOBAL_CLI_SOURCE = "cli";

/**
 * The core version this bundle carries — the floor a global CLI must clear.
 *
 * `__CLI_PKG_VERSION__`, NOT `__PKG_VERSION__` (the extension's own release
 * number): dist-paths entries record the `@jolli.ai/cli` core version, so that is
 * what the comparison below is against.
 */
/* v8 ignore next -- compile-time ternary: "0.0.0" under vitest, the real define in bundled builds */
export const BUNDLED_CLI_VERSION = typeof __CLI_PKG_VERSION__ !== "undefined" ? __CLI_PKG_VERSION__ : "0.0.0";

/**
 * The version of a globally-installed CLI that outranks every other registered
 * dist, or null when there is no such install.
 *
 * This is the reuse: `traverseDistPaths` + `pickBestDistPath` ARE the "is a CLI
 * installed, and which install wins on version" logic — the same two functions
 * `resolve-dist-path` mirrors and `JolliMemoryBridge` already calls. So tier 0
 * fires exactly when run-cli would have chosen the global CLI anyway, which is
 * what makes it a readable spelling of tier 1 rather than a second opinion. Not
 * reimplemented, and deliberately not probed with `jolli --version` either: a
 * spawn (measured 0.35 s) would answer a question the registry already answers
 * for free, and could disagree with it.
 *
 * The version is still compared against {@link BUNDLED_CLI_VERSION} rather than
 * being taken on trust from `cli` having won. Winning implies "at least as new as
 * this bundle" only while our OWN `dist-paths/vscode` entry is registered — and on
 * a fresh install, or after a failed registration, it is not, so a stale `cli`
 * could win a field of one.
 *
 * KNOWN RESIDUAL RISK, and the price of not spawning: this answers for the install
 * that WROTE `dist-paths/cli`, while the terminal resolves the bare name against
 * its OWN PATH. Those can be different binaries — two node versions under
 * nvm/volta, or a shim earlier on PATH — and then tier 0 clears a gate the CLI
 * that actually runs never faced, so an old one answers `unknown command
 * 'dashboard'` in the terminal. Tier 1 has no such gap, because `run-cli` re-reads
 * the registry itself at run time. Closing it needs the `jolli --version` spawn
 * ruled out above, so the gap is accepted, not overlooked: it costs one visible
 * error line on a misconfigured machine, and the user can still run the printed
 * command by hand.
 */
export function readWinningGlobalCliVersion(globalDir?: string): string | null {
	const winner = pickBestDistPath(traverseDistPaths(globalDir));
	return winner?.source === GLOBAL_CLI_SOURCE ? winner.version : null;
}

/**
 * Finds `binName` on the plain inherited PATH, or null.
 *
 * Deliberately NOT the local-agent resolver's `discover`: that widens PATH with
 * well-known install dirs because it then spawns the absolute path it found. Tier
 * 0 sends the bare NAME, so the only PATH that matters is the one the TERMINAL
 * resolves it against — widening ours would let us emit a `jolli` the terminal
 * cannot find. A GUI-launched editor's narrow PATH therefore produces false
 * negatives here, which is the right way round: a miss falls through to tier 1,
 * while a false positive is a `command not found` in the user's face.
 *
 * Also why this probes the filesystem and never spawns: the Windows install is a
 * `.cmd` shim that `execFile` refuses outright (EINVAL since the CVE-2024-27980
 * fix), but a bare name is resolved through `PATHEXT` by PowerShell and cmd
 * themselves. We need to know the shim is THERE, not to run it — so Windows needs
 * no shim expansion and tier 0 works there too.
 *
 * The probe is the EXEC BIT, not mere existence, and the default deliberately
 * shares {@link isExecutableFile} with tier 1's `run-cli` check. A bare
 * `existsSync` answers true for a directory named `jolli`, or for a file whose
 * exec bit was never set — both of which the shell then refuses, which is the
 * `command not found` in the user's face that this whole function exists to
 * avoid, and which tier 1 would have handled fine. `accessSync(X_OK)` is also the
 * right call on Windows for free: that platform has no exec bit, so libuv folds
 * `X_OK` down to an existence check, which is exactly the PATHEXT-membership rule
 * above.
 *
 * Every platform-dependent choice — the PATH separator, the path join, whether
 * `PATHEXT` applies at all — comes from the `platform` ARGUMENT, never from the
 * host. Same rule as the local-agent resolver's `discoveryPath`: a function
 * parameterized by platform must not change shape when the host differs, or its
 * tests assert the host's behaviour instead of the target's. This is not
 * hypothetical here — `"C:\\npm"` split on the host delimiter yields `["C",
 * "\\npm"]` on macOS, so the win32 path was silently unreachable.
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
	// On win32 a bare name is only runnable via one of these extensions; elsewhere
	// the file itself is the candidate.
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

/** Which tier produced a command line. Reported in the log, and pinned by tests. */
export type DashboardCommandTier = "global-jolli" | "run-cli" | "bundled-node";

export interface ResolvedDashboardCommand {
	/** The exact line to send to the terminal. */
	readonly commandLine: string;
	readonly tier: DashboardCommandTier;
}

/** The environment probes, injected so tests never touch the real machine. */
export interface CommandResolutionDeps {
	/** Repo directory to register and serve from — always passed explicitly, see below. */
	readonly cwd: string;
	/** The extension's `dist/`, holding {@link CLI_ENTRY_FILE}. */
	readonly distDir: string;
	readonly flavor: ShellFlavor;
	/** The host's Electron binary; runs as node under {@link RUN_AS_NODE_ENV}. */
	readonly execPath: string;
	readonly runCliPath?: string | undefined;
	/**
	 * Version of the winning globally-installed CLI, or null when none wins.
	 * Resolved by the caller ({@link readWinningGlobalCliVersion}) so this function
	 * stays pure — it reads no registry and touches no PATH of its own.
	 */
	readonly globalCliVersion?: string | null | undefined;
	/** Whether {@link GLOBAL_BIN_NAME} is on the PATH the terminal will use. */
	readonly globalBinOnPath?: boolean | undefined;
	/** The floor a global CLI must clear. Defaults to {@link BUNDLED_CLI_VERSION}. */
	readonly minGlobalCliVersion?: string | undefined;
	/** Defaults to {@link isExecutableFile}. */
	readonly canExecute?: ((path: string) => boolean) | undefined;
	/** Defaults to a real `existsSync` — tier 2 only needs `Cli.js` to be readable. */
	readonly fileExists?: ((path: string) => boolean) | undefined;
}

/**
 * A regular file the shell can actually run — what tier 1 needs of `run-cli`, and
 * the default probe tier 0 uses for a PATH candidate.
 *
 * BOTH halves are required, and the directory half is not hypothetical: every
 * directory carries the search bit, so `X_OK` alone says yes to a directory named
 * `jolli` (or `run-cli`) sitting early on PATH. `statSync` follows symlinks, which
 * is what a global npm bin is, so the ordinary install still passes.
 */
function isExecutableFile(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * Picks the tier and builds its command line, or returns null when none is
 * usable.
 *
 * **The command carries no `--cwd`, by decision.** `executeDashboard` therefore
 * falls back to `process.cwd()` — the working directory of the shell in the
 * terminal — and `createTerminal({ cwd })` is the only thing pointing that at the
 * repo root. That is a weaker guarantee than it looks, and the gap is accepted
 * rather than unknown: a `cd` in the user's `.zshrc` / `.bashrc` overrides the
 * spawn directory outright (measured: spawned in the repo, `pwd` reported `/` once
 * the rc had run). When that happens the button acts on whatever repo the shell is
 * in — `registerRepo` and `maybeAutoCutover` both take that directory, and the
 * second FREEZES the orphan branch of the repo it is given. Nothing on screen
 * distinguishes it, because the dashboard opens either way.
 *
 * (Each click gets a FRESH terminal — see {@link TERMINAL_NAME} — so a `cd` the
 * user typed by hand does not carry into the next launch. The rc-file case is
 * what remains, and it is the one that fires on every launch alike.)
 *
 * ── DELIBERATE — NOT A REVIEW FINDING ────────────────────────────────────────
 * Both fixes were considered and DROPPED at the product owner's explicit request:
 * `--cwd` on the command line, and a `cd` line sent ahead of it. The irreversible
 * consequence above (a fence `jolli enable` cannot clear, on a repo the user did
 * not point at) was on the table when that call was made. A review that
 * rediscovers "the dashboard command should pass --cwd" has found the design, not
 * a bug. Do not add either back without asking the owner first.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function resolveDashboardCommand(deps: CommandResolutionDeps): ResolvedDashboardCommand | null {
	const canExecute = deps.canExecute ?? isExecutableFile;
	const fileExists = deps.fileExists ?? existsSync;
	const quote = (value: string): string => quoteArg(value, deps.flavor);
	const tail = "dashboard";

	// Tier 0 — the readable form, and the only tier that is not platform-gated: a
	// bare name is resolved through `PATHEXT` by PowerShell and cmd themselves, so
	// a Windows `jolli.cmd` runs here even though nothing may spawn it directly.
	//
	// Two conditions, and presence alone is neither of them. A stale global CLI
	// would shadow a newer bundled one and answer `unknown command 'dashboard'` —
	// the failure that made an ungated bare-`jolli` tier wrong.
	// `>=` rather than `>`: an equal version is the same code, so preferring the
	// readable spelling is free.
	const globalVersion = deps.globalCliVersion;
	const floor = deps.minGlobalCliVersion ?? BUNDLED_CLI_VERSION;
	if (globalVersion != null && compareSemver(globalVersion, floor) >= 0 && deps.globalBinOnPath === true) {
		return { commandLine: `${GLOBAL_BIN_NAME} ${tail}`, tier: "global-jolli" };
	}

	// Tier 1 is POSIX-only: `run-cli` carries a `#!/bin/bash` shebang and there is
	// no `.cmd` / `.ps1` sibling, so PowerShell and cmd cannot run it at all.
	if (deps.flavor === "posix") {
		const runCli = deps.runCliPath ?? resolveRunCliPath();
		if (canExecute(runCli)) {
			return { commandLine: `${quote(runCli)} ${tail}`, tier: "run-cli" };
		}
	}

	const cliEntry = join(deps.distDir, CLI_ENTRY_FILE);
	if (!fileExists(cliEntry)) return null;
	// The call operator is what lets PowerShell treat a quoted string as the
	// command to run rather than as a value to echo.
	const prefix = deps.flavor === "powershell" ? "& " : "";
	return {
		commandLine: `${prefix}${quote(deps.execPath)} ${quote(cliEntry)} ${tail}`,
		tier: "bundled-node",
	};
}

/* ── Terminal ────────────────────────────────────────────────────────────────── */

/**
 * The subset of `vscode.Terminal` this module uses.
 *
 * Deliberately narrow: no `exitStatus` and no `dispose`, because nothing here
 * inspects or tears down a terminal. Both were here while the launcher reused one,
 * and they are gone with it rather than left as an invitation.
 */
export interface TerminalLike {
	readonly name: string;
	show(preserveFocus?: boolean): void;
	sendText(text: string, addNewLine?: boolean): void;
}

/** The window interactions this module performs, as a seam. */
export interface DashboardLauncherHost {
	readonly createTerminal: (options: {
		readonly name: string;
		readonly cwd: string;
		readonly env: Readonly<Record<string, string>>;
	}) => TerminalLike;
	readonly showInfo: (message: string) => Promise<void>;
	readonly showError: (message: string) => Promise<void>;
}

/* v8 ignore start -- thin adapters over vscode.window; every test injects its own */
function defaultHost(): DashboardLauncherHost {
	return {
		createTerminal: (options) => vscode.window.createTerminal(options),
		showInfo: (message) =>
			Promise.resolve(vscode.window.showInformationMessage(message)).then(() => undefined),
		showError: (message) => Promise.resolve(vscode.window.showErrorMessage(message)).then(() => undefined),
	};
}
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
	/** Injected in tests. Defaults to `vscode.env.shell`. */
	readonly shell?: string | undefined;
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
	/** Injected in tests. Defaults to {@link BUNDLED_CLI_VERSION}. */
	readonly minGlobalCliVersion?: string | undefined;
	/** Injected in tests. Defaults to `process.env.PATH`. */
	readonly pathEnv?: string | undefined;
	/** Injected in tests. Defaults to `process.env.PATHEXT` (win32 only). */
	readonly pathExt?: string | undefined;
}

/**
 * Opens a new terminal and runs the command in it.
 *
 * Resolves once the line has been sent — immediately, without waiting for the
 * shell, and certainly without waiting for the command. The command keeps
 * running past that: its output, including the history import that can take
 * minutes, is on screen instead of behind an output channel. Never rejects.
 */
export async function launchDashboard(options: LaunchDashboardOptions): Promise<void> {
	const host = options.host ?? defaultHost();
	// Passed straight through: `isRemoteWorkspace` already defaults an absent
	// argument to `vscode.env.remoteName`.
	if (isRemoteWorkspace(options.remoteName)) {
		log.info(TAG, "remote window — not starting a local dashboard server");
		await host.showInfo(REMOTE_HINT);
		return;
	}

	const platform = options.platform ?? process.platform;
	const flavor = detectShellFlavor(options.shell ?? vscode.env.shell, platform);
	// Both reads are cheap and synchronous — two small files from the registry, and
	// a directory-by-directory existence check. Neither spawns anything, so the
	// click pays nothing for the extra tier.
	const globalCliVersion =
		options.globalCliVersion !== undefined ? options.globalCliVersion : readWinningGlobalCliVersion();
	const globalBinOnPath =
		globalCliVersion !== null &&
		findExecutableOnPath(GLOBAL_BIN_NAME, {
			pathEnv: options.pathEnv ?? process.env.PATH,
			pathExt: options.pathExt ?? process.env.PATHEXT,
			platform,
			fileExists: options.fileExists,
		}) !== null;
	const resolved = resolveDashboardCommand({
		cwd: options.cwd,
		distDir: options.distDir,
		flavor,
		execPath: options.execPath ?? process.execPath,
		runCliPath: options.runCliPath,
		canExecute: options.canExecute,
		fileExists: options.fileExists,
		globalCliVersion,
		globalBinOnPath,
		minGlobalCliVersion: options.minGlobalCliVersion,
	});

	if (resolved === null) {
		// Every tier unavailable means tier 2's own entry is missing from `dist/`,
		// since tier 2 has no precondition beyond that. Logged with the path so the
		// report names the thing that is actually wrong.
		log.error(TAG, `no CLI entry at ${join(options.distDir, CLI_ENTRY_FILE)} and no usable run-cli`);
		await host.showError(UNAVAILABLE_MESSAGE);
		return;
	}

	log.info(TAG, `running the dashboard via ${resolved.tier} (${flavor} shell): ${resolved.commandLine}`);
	// A new terminal every click. Created only now, after resolution succeeded, so a
	// build that cannot run the dashboard does not leave an empty terminal behind.
	const terminal = host.createTerminal({ name: TERMINAL_NAME, cwd: options.cwd, env: RUN_AS_NODE_ENV });
	// Shown before the line is sent so the first output is already visible, and
	// with focus preserved: the user clicked a button in the sidebar, not in a
	// terminal, and stealing the cursor to a panel they did not ask for is worse
	// than making them click once more to type in it.
	terminal.show(true);
	// Sent IMMEDIATELY, into a shell that has not started yet. That is deliberate,
	// and it is the whole of this function's contract: open a terminal, put the
	// command in it, return. Nothing here waits for the shell, and nothing waits
	// for `jolli dashboard` — its output arriving later is the point.
	//
	// ── DELIBERATE — NOT A REVIEW FINDING ────────────────────────────────────
	// The known cost is COSMETIC and measured: `createTerminal` only starts a
	// shell, so these bytes reach a pty still in canonical mode and the line
	// discipline echoes them — the command appears once, unprefixed, above the
	// first prompt, and again after it when the shell's line editor redraws the
	// pending input. One execution, printed twice. (It was effectively invisible
	// while the launcher reused a terminal, because that shell was already up;
	// a fresh terminal per click makes it every time.)
	//
	// Both fixes for it were IMPLEMENTED, MEASURED and REVERTED, so do not
	// re-derive them. Waiting for `onDidChangeTerminalShellIntegration` and then
	// sending does not work at all: that event fires at zsh's `precmd`, BEFORE
	// the first prompt, which is still inside the echoing window. Waiting and
	// then sending via `shellIntegration.executeCommand` does fix the echo, but
	// costs seconds — click-to-CLI-start went from 1.0-3.9 s (13 samples) to
	// 5.8-8.4 s (3 samples), because `executeCommand` additionally waits for
	// VS Code's own command detection to confirm a prompt that accepts input.
	// A double-printed line is worth far less than 4-6 s on every click, and the
	// product owner made that trade explicitly. Do not reintroduce a wait here.
	// ─────────────────────────────────────────────────────────────────────────
	terminal.sendText(resolved.commandLine);
}
