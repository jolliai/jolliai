/**
 * DashboardLauncher tests.
 *
 * The subject is the command line and the terminal, not the dashboard: nothing
 * here starts a process, and `executeDashboard` is not involved at all any more —
 * the launcher's job ends when a line has been sent to a terminal.
 *
 * What is worth pinning is what this module decides on its own: the remote gate,
 * that tier 0 is a version-gated global `jolli`, tier 1 is `run-cli` and tier 2 is
 * the bundled entry run by the host's Node, that tier 1 is skipped on a shell that
 * cannot execute a bash script, that each shell's quoting and the PowerShell call
 * operator are right (a wrong quote does not fail loudly — it passes a mangled path
 * to the CLI), that the repo directory reaches the CLI ONLY as the terminal's own
 * cwd and never as a command argument, and that every click opens a NEW terminal
 * rather than reusing or revealing an earlier one.
 */

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `createTerminal` returns a usable stub rather than `undefined` because one case
// below omits the `host` seam entirely, so that it exercises the `?? defaultHost()`
// fallback — the only line in this module that touches `vscode.window` directly.
const { createTerminalMock } = vi.hoisted(() => ({
	createTerminalMock: vi.fn((options: { name: string }) => ({
		name: options.name,
		show: vi.fn(),
		sendText: vi.fn(),
	})),
}));

vi.mock("vscode", () => ({
	env: { remoteName: undefined, shell: "/bin/zsh" },
	window: {
		createTerminal: createTerminalMock,
		showInformationMessage: vi.fn(),
		showErrorMessage: vi.fn(),
	},
}));

const logCalls: Array<{ level: string; message: string }> = [];
vi.mock("../util/Logger.js", () => ({
	log: {
		info: (_tag: string, message: string) => logCalls.push({ level: "info", message }),
		warn: (_tag: string, message: string) => logCalls.push({ level: "warn", message }),
		error: (_tag: string, message: string) => logCalls.push({ level: "error", message }),
		debug: () => {},
		show: () => {},
	},
}));

import {
	BUNDLED_CLI_VERSION,
	CLI_ENTRY_FILE,
	type DashboardLauncherHost,
	detectShellFlavor,
	findExecutableOnPath,
	GLOBAL_BIN_NAME,
	isRemoteWorkspace,
	launchDashboard,
	quoteArg,
	readWinningGlobalCliVersion,
	REMOTE_HINT,
	resolveDashboardCommand,
	resolveRunCliPath,
	type ShellFlavor,
	TERMINAL_NAME,
	type TerminalLike,
	UNAVAILABLE_MESSAGE,
} from "./DashboardLauncher.js";

const REPO = "/repo/root";
const EXEC = "/Applications/Code.app/Contents/MacOS/Electron";
const RUN_CLI = "/home/u/.jolli/jollimemory/run-cli";

/** A dist directory that really holds a real `Cli.js`, so `existsSync` passes. */
function distWithCli(): string {
	const dir = mkdtempSync(join(tmpdir(), "jolli-dashboard-launcher-"));
	writeFileSync(join(dir, CLI_ENTRY_FILE), "");
	return dir;
}

interface FakeTerminal extends TerminalLike {
	readonly sent: Array<string>;
	readonly shown: Array<boolean | undefined>;
}

function fakeTerminal(name: string = TERMINAL_NAME): FakeTerminal {
	const terminal: FakeTerminal = {
		name,
		sent: [],
		shown: [],
		show: (preserveFocus) => {
			terminal.shown.push(preserveFocus);
		},
		sendText: (text) => {
			terminal.sent.push(text);
		},
	};
	return terminal;
}

interface FakeHostCalls {
	readonly created: Array<{ name: string; cwd: string; env: Readonly<Record<string, string>> }>;
	readonly infos: Array<string>;
	readonly errors: Array<string>;
	/** Every terminal handed out, in creation order. */
	readonly terminals: Array<FakeTerminal>;
}

/** A host that records what it was asked to do and hands back fake terminals. */
function fakeHost(): { host: DashboardLauncherHost; calls: FakeHostCalls } {
	const calls: FakeHostCalls = { created: [], infos: [], errors: [], terminals: [] };
	const host: DashboardLauncherHost = {
		createTerminal: (options) => {
			calls.created.push({ ...options });
			const created = fakeTerminal(options.name);
			calls.terminals.push(created);
			return created;
		},
		showInfo: async (message) => {
			calls.infos.push(message);
		},
		showError: async (message) => {
			calls.errors.push(message);
		},
	};
	return { host, calls };
}

/**
 * Options that resolve to tier 1 on a POSIX shell, with nothing left to the machine.
 *
 * `globalCliVersion: null` is the load-bearing part: without it the launcher reads
 * the REAL dist-paths registry, and a developer machine with a global CLI installed
 * would silently push every one of these cases up to tier 0.
 */
function tierOneOptions(overrides: Partial<Parameters<typeof launchDashboard>[0]> = {}) {
	return {
		cwd: REPO,
		distDir: "/ext/dist",
		platform: "darwin" as NodeJS.Platform,
		shell: "/bin/zsh",
		execPath: EXEC,
		runCliPath: RUN_CLI,
		canExecute: (path: string) => path === RUN_CLI,
		fileExists: () => true,
		globalCliVersion: null,
		...overrides,
	};
}

beforeEach(() => {
	logCalls.length = 0;
	createTerminalMock.mockClear();
});

describe("isRemoteWorkspace", () => {
	it("is false for a local window", () => {
		expect(isRemoteWorkspace(undefined)).toBe(false);
	});

	it("is true for every remote flavour, WSL included", () => {
		for (const name of ["ssh-remote", "wsl", "dev-container", "attached-container", "codespaces"]) {
			expect(isRemoteWorkspace(name)).toBe(true);
		}
	});
});

describe("detectShellFlavor", () => {
	it("reads PowerShell off either of its two binary names, with or without .exe", () => {
		for (const shell of [
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
			"C:\\Program Files\\PowerShell\\7\\pwsh.exe",
			"/usr/local/bin/pwsh",
		]) {
			expect(detectShellFlavor(shell, "win32")).toBe("powershell");
		}
	});

	it("recognises cmd only when the path actually names it", () => {
		expect(detectShellFlavor("C:\\Windows\\System32\\cmd.exe", "win32")).toBe("cmd");
	});

	it("classifies every POSIX shell as posix, Git Bash on Windows included", () => {
		for (const shell of ["/bin/bash", "/bin/sh", "/bin/zsh", "/usr/bin/fish", "/bin/dash", "/bin/ksh"]) {
			expect(detectShellFlavor(shell, "darwin")).toBe("posix");
		}
		// The reason the classification keys off the shell rather than the platform:
		// Git Bash as the Windows default can run tier 1, and gets to.
		expect(detectShellFlavor("C:\\Program Files\\Git\\bin\\bash.exe", "win32")).toBe("posix");
	});

	it("falls back to the platform default when the shell is unknown or absent", () => {
		expect(detectShellFlavor(undefined, "win32")).toBe("powershell");
		expect(detectShellFlavor(undefined, "darwin")).toBe("posix");
		expect(detectShellFlavor("C:\\tools\\nushell\\nu.exe", "win32")).toBe("powershell");
		expect(detectShellFlavor("/opt/homebrew/bin/nu", "darwin")).toBe("posix");
	});
});

describe("quoteArg", () => {
	it("single-quotes for POSIX so $ and backticks in a path stay literal", () => {
		expect(quoteArg("/a/b $HOME/`x`", "posix")).toBe(`'/a/b $HOME/\`x\`'`);
	});

	it("escapes a literal quote per shell, and the two shells disagree", () => {
		expect(quoteArg("it's", "posix")).toBe(`'it'\\''s'`);
		expect(quoteArg("it's", "powershell")).toBe("'it''s'");
	});

	it("double-quotes for cmd, which has no literal-quoting form", () => {
		expect(quoteArg("C:\\Program Files\\x", "cmd")).toBe(`"C:\\Program Files\\x"`);
	});
});

describe("resolveRunCliPath", () => {
	it("points at the machine-global dispatcher under the given home", () => {
		expect(resolveRunCliPath("/home/u")).toBe(join("/home/u", ".jolli", "jollimemory", "run-cli"));
	});
});

describe("findExecutableOnPath", () => {
	it("finds a bare name in the first PATH dir that has it", () => {
		const seen: Array<string> = [];
		const found = findExecutableOnPath("jolli", {
			pathEnv: ["/nope", "/usr/local/bin"].join(delimiter),
			platform: "darwin",
			fileExists: (path) => {
				seen.push(path);
				return path === join("/usr/local/bin", "jolli");
			},
		});
		expect(found).toBe(join("/usr/local/bin", "jolli"));
		expect(seen[0]).toBe(join("/nope", "jolli"));
	});

	it("is null for an absent binary, an empty PATH, and no PATH at all", () => {
		const common = { platform: "darwin" as NodeJS.Platform, fileExists: () => false };
		expect(findExecutableOnPath("jolli", { pathEnv: "/a", ...common })).toBeNull();
		expect(findExecutableOnPath("jolli", { pathEnv: "", ...common })).toBeNull();
		expect(findExecutableOnPath("jolli", { platform: "darwin" })).toBeNull();
	});

	// These two assert WINDOWS behaviour from a POSIX host, which only works because
	// the function takes its separator and its join from the `platform` argument. A
	// `C:\npm` PATH split on the host's `:` would come back as `["C", "\\npm"]`.
	it("tries PATHEXT suffixes on win32, which is how a .cmd shim is found", () => {
		const found = findExecutableOnPath("jolli", {
			pathEnv: "C:\\npm;C:\\other",
			pathExt: ".COM;.EXE;.BAT;.CMD",
			platform: "win32",
			// npm installs a cmd-shim, so only the .CMD candidate exists.
			fileExists: (path) => path === "C:\\npm\\jolli.CMD",
		});
		expect(found).toBe("C:\\npm\\jolli.CMD");
	});

	it("falls back to a default PATHEXT when the variable is absent", () => {
		const found = findExecutableOnPath("jolli", {
			pathEnv: "C:\\npm",
			platform: "win32",
			fileExists: (path) => path === "C:\\npm\\jolli.CMD",
		});
		expect(found).toBe("C:\\npm\\jolli.CMD");
	});

	it("never appends a suffix off win32, so it cannot match jolli.CMD there", () => {
		expect(
			findExecutableOnPath("jolli", {
				pathEnv: "/usr/local/bin",
				pathExt: ".CMD",
				platform: "linux",
				fileExists: (path) => path === "/usr/local/bin/jolli.CMD",
			}),
		).toBeNull();
	});

	it("uses a real exec-bit probe when none is injected", () => {
		const dir = distWithCli();
		chmodSync(join(dir, CLI_ENTRY_FILE), 0o755);
		// The host's own platform, since this one touches a real path on it.
		expect(findExecutableOnPath(CLI_ENTRY_FILE, { pathEnv: dir, platform: process.platform })).toBe(
			join(dir, CLI_ENTRY_FILE),
		);
	});

	// The reason that default is the exec bit and not `existsSync`: a present but
	// unrunnable file would clear tier 0's gate and hand the shell a `command not
	// found`, where a miss falls safely through to tier 1. Skipped on Windows,
	// which has no exec bit for `chmod` to clear — there libuv folds X_OK down to
	// an existence check, which is the intended behaviour on that platform.
	it.skipIf(process.platform === "win32")("does not match a present file with no exec bit", () => {
		const dir = distWithCli();
		chmodSync(join(dir, CLI_ENTRY_FILE), 0o644);
		expect(findExecutableOnPath(CLI_ENTRY_FILE, { pathEnv: dir, platform: process.platform })).toBeNull();
	});

	// The other false positive `existsSync` let through: a DIRECTORY named `jolli`
	// early on PATH. It has the exec (search) bit, so the probe alone cannot reject
	// it — but a directory is not a regular file, which is what `isExecutableFile`
	// now also requires.
	it("does not match a directory that happens to carry the binary's name", () => {
		const dir = mkdtempSync(join(tmpdir(), "jolli-dashboard-launcher-"));
		mkdirSync(join(dir, "jolli"));
		expect(findExecutableOnPath("jolli", { pathEnv: dir, platform: process.platform })).toBeNull();
	});
});

describe("readWinningGlobalCliVersion", () => {
	/** A global config dir holding the given dist-paths entries, all pointing at real dirs. */
	function registryWith(entries: Record<string, string>): string {
		const globalDir = mkdtempSync(join(tmpdir(), "jolli-dashboard-registry-"));
		const distPaths = join(globalDir, "dist-paths");
		mkdirSync(distPaths, { recursive: true });
		for (const [source, version] of Object.entries(entries)) {
			// `available` is just existsSync(distDir), so any real directory will do.
			const distDir = join(globalDir, `${source}-dist`);
			mkdirSync(distDir, { recursive: true });
			writeFileSync(join(distPaths, source), `${version}\n${distDir}\n`);
		}
		return globalDir;
	}

	it("reports the global CLI's version when it wins the competition", () => {
		expect(readWinningGlobalCliVersion(registryWith({ cli: "1.2.3", vscode: "0.99.12" }))).toBe("1.2.3");
	});

	it("reports it on a tie too, since the preference order puts cli ahead of vscode", () => {
		expect(readWinningGlobalCliVersion(registryWith({ cli: "0.99.12", vscode: "0.99.12" }))).toBe("0.99.12");
	});

	it("is null when another source outranks the global CLI", () => {
		expect(readWinningGlobalCliVersion(registryWith({ cli: "0.97.0", vscode: "0.99.12" }))).toBeNull();
	});

	it("is null when no global CLI is registered at all", () => {
		expect(readWinningGlobalCliVersion(registryWith({ vscode: "0.99.12" }))).toBeNull();
	});

	it("is null for a registry that does not exist", () => {
		expect(readWinningGlobalCliVersion(join(tmpdir(), "jolli-dashboard-no-such-dir"))).toBeNull();
	});
});

describe("resolveDashboardCommand", () => {
	// `fileExists` is stubbed true because `/ext/dist` is a fictional path; the
	// two cases that exercise the real probes build a real directory instead.
	// `globalCliVersion: null` keeps tier 0 out of the way of the tier-1/2 cases.
	const base = {
		cwd: REPO,
		distDir: "/ext/dist",
		execPath: EXEC,
		runCliPath: RUN_CLI,
		fileExists: () => true,
		globalCliVersion: null,
	};

	/** Tier-0-eligible: a winning global CLI at the bundle's own version, on PATH. */
	const withGlobalCli = { ...base, globalCliVersion: BUNDLED_CLI_VERSION, globalBinOnPath: true };

	it("prefers a global jolli over run-cli when it wins and is new enough", () => {
		const resolved = resolveDashboardCommand({
			...withGlobalCli,
			flavor: "posix",
			// run-cli is present and usable — tier 0 still wins.
			canExecute: (path) => path === RUN_CLI,
		});
		expect(resolved).toEqual({
			tier: "global-jolli",
			commandLine: `${GLOBAL_BIN_NAME} dashboard`,
		});
	});

	it("sends the bare name unquoted, with no call operator on any shell", () => {
		for (const flavor of ["posix", "powershell", "cmd"] as Array<ShellFlavor>) {
			const resolved = resolveDashboardCommand({ ...withGlobalCli, flavor });
			// Tier 0 is the one tier that is not platform-gated: PowerShell and cmd
			// resolve a bare name through PATHEXT themselves.
			expect(resolved?.tier).toBe("global-jolli");
			expect(resolved?.commandLine.startsWith(`${GLOBAL_BIN_NAME} dashboard`)).toBe(true);
		}
	});

	it("never puts the repo directory in the command, on any tier or shell", () => {
		// The directory reaches the CLI only as the terminal's own working directory
		// (`createTerminal({ cwd })` → `process.cwd()`). Pinned because the opposite —
		// an explicit `--cwd` — is the obvious thing to add back, and was dropped on
		// purpose. Every tier is covered: tier 0 by the global CLI, tier 1 by run-cli,
		// tier 2 by canExecute answering false.
		const cwd = "/some/repo/root";
		for (const flavor of ["posix", "powershell", "cmd"] as Array<ShellFlavor>) {
			for (const tierDeps of [withGlobalCli, { ...base, canExecute: () => true }, base]) {
				const resolved = resolveDashboardCommand({ ...tierDeps, cwd, flavor });
				expect(resolved?.commandLine).not.toContain(cwd);
				expect(resolved?.commandLine).not.toContain("--cwd");
				expect(resolved?.commandLine.endsWith("dashboard")).toBe(true);
			}
		}
	});

	it("refuses a global CLI older than the core this bundle carries", () => {
		const resolved = resolveDashboardCommand({
			...withGlobalCli,
			flavor: "posix",
			globalCliVersion: "0.97.0",
			minGlobalCliVersion: "0.99.12",
			canExecute: (path) => path === RUN_CLI,
		});
		// The whole reason presence is not the gate: 0.97 has no `dashboard` command,
		// so a bare `jolli` there answers `unknown command` where run-cli works.
		expect(resolved?.tier).toBe("run-cli");
	});

	it("refuses a winning global CLI that is not on PATH", () => {
		const resolved = resolveDashboardCommand({
			...withGlobalCli,
			flavor: "posix",
			globalBinOnPath: false,
			canExecute: (path) => path === RUN_CLI,
		});
		expect(resolved?.tier).toBe("run-cli");
	});

	it("prefers run-cli on a POSIX shell — never a bare `jolli`", () => {
		const resolved = resolveDashboardCommand({
			...base,
			flavor: "posix",
			canExecute: (path) => path === RUN_CLI,
		});
		expect(resolved).toEqual({
			tier: "run-cli",
			commandLine: `'${RUN_CLI}' dashboard`,
		});
		// The point of tier 1 existing at all: it is the version-selecting entry,
		// and a bare CLI name would bypass that selection.
		expect(resolved?.commandLine.startsWith("jolli ")).toBe(false);
	});

	it("falls to the bundled entry when run-cli is not executable", () => {
		const resolved = resolveDashboardCommand({ ...base, flavor: "posix", canExecute: () => false });
		expect(resolved).toEqual({
			tier: "bundled-node",
			commandLine: `'${EXEC}' '${join("/ext/dist", CLI_ENTRY_FILE)}' dashboard`,
		});
	});

	it("never tries run-cli on a shell that cannot execute a bash script", () => {
		for (const flavor of ["powershell", "cmd"] as Array<ShellFlavor>) {
			const probed: Array<string> = [];
			const resolved = resolveDashboardCommand({
				...base,
				flavor,
				canExecute: (path) => {
					probed.push(path);
					return true;
				},
			});
			// Not even probed: `run-cli` carries a #!/bin/bash shebang and has no
			// .cmd / .ps1 sibling, so an executable bit would not make it runnable.
			expect(probed).toEqual([]);
			expect(resolved?.tier).toBe("bundled-node");
		}
	});

	it("prefixes the PowerShell form with the call operator, and no other form", () => {
		const ps = resolveDashboardCommand({ ...base, flavor: "powershell", canExecute: () => false });
		expect(ps?.commandLine).toBe(
			`& '${EXEC}' '${join("/ext/dist", CLI_ENTRY_FILE)}' dashboard`,
		);
		const cmd = resolveDashboardCommand({ ...base, flavor: "cmd", canExecute: () => false });
		expect(cmd?.commandLine).toBe(
			`"${EXEC}" "${join("/ext/dist", CLI_ENTRY_FILE)}" dashboard`,
		);
		expect(cmd?.commandLine.startsWith("&")).toBe(false);
	});

	it("is null when the bundled entry is missing, since tier 2 has no other precondition", () => {
		expect(
			resolveDashboardCommand({ ...base, flavor: "posix", canExecute: () => false, fileExists: () => false }),
		).toBeNull();
	});

	it("uses real filesystem probes when none are injected", () => {
		const dir = distWithCli();
		// `runCliPath` names a file that does not exist, so the default X_OK probe
		// must answer false and hand over to tier 2 — whose entry really is there,
		// so the default `existsSync` must answer true.
		const resolved = resolveDashboardCommand({
			cwd: REPO,
			distDir: dir,
			execPath: EXEC,
			flavor: "posix",
			runCliPath: join(dir, "definitely-absent-run-cli"),
		});
		expect(resolved?.tier).toBe("bundled-node");
		expect(resolved?.commandLine).toContain(join(dir, CLI_ENTRY_FILE));
	});

	it("treats a real executable as tier 1 through the default probe", () => {
		// `process.execPath` is the one file every platform guarantees is
		// executable, so it stands in for an installed `run-cli`.
		const resolved = resolveDashboardCommand({
			cwd: REPO,
			distDir: "/ext/dist",
			execPath: EXEC,
			flavor: "posix",
			runCliPath: process.execPath,
		});
		expect(resolved?.tier).toBe("run-cli");
	});

	it("resolves run-cli under the real home when no path is given", () => {
		// Only the shape is asserted: whether this machine has run-cli installed
		// decides the tier, and a test must not depend on that.
		const resolved = resolveDashboardCommand({ ...base, runCliPath: undefined, flavor: "posix" });
		expect(resolved === null || resolved.tier === "run-cli" || resolved.tier === "bundled-node").toBe(true);
	});
});

describe("launchDashboard", () => {
	it("sends the line immediately, without waiting for the shell", async () => {
		// The launcher's whole contract: open a terminal, put the command in it,
		// return. The cosmetic double-echo this leaves is documented at the send
		// site, along with the two measured fixes that were reverted for costing
		// seconds per click.
		const { host, calls } = fakeHost();
		await launchDashboard(tierOneOptions({ host }));
		expect(calls.terminals[0]?.shown).toEqual([true]);
		expect(calls.terminals[0]?.sent).toEqual([`'${RUN_CLI}' dashboard`]);
	});

	it("refuses a remote window with the hint, touching no terminal", async () => {
		const { host, calls } = fakeHost();
		await launchDashboard(tierOneOptions({ host, remoteName: "ssh-remote" }));
		expect(calls.infos).toEqual([REMOTE_HINT]);
		expect(calls.created).toEqual([]);
	});

	it("creates the dashboard terminal at the repo root and runs the tier-1 line in it", async () => {
		const { host, calls } = fakeHost();
		await launchDashboard(tierOneOptions({ host }));
		expect(calls.created).toEqual([
			{ name: TERMINAL_NAME, cwd: REPO, env: { ELECTRON_RUN_AS_NODE: "1" } },
		]);
		const terminal = calls.terminals[0];
		expect(terminal?.sent).toEqual([`'${RUN_CLI}' dashboard`]);
	});

	it("shows the terminal without stealing focus, before sending", async () => {
		const { host, calls } = fakeHost();
		await launchDashboard(tierOneOptions({ host }));
		const terminal = calls.terminals[0];
		// `true` is preserveFocus: the click came from the sidebar, not the panel.
		expect(terminal?.shown).toEqual([true]);
		expect(terminal?.sent).toHaveLength(1);
	});

	it("carries the repo directory ONLY as the terminal's cwd, never in the command", async () => {
		const { host, calls } = fakeHost();
		await launchDashboard(tierOneOptions({ host, cwd: "/other/repo" }));
		// The terminal is created there, and the command says nothing about it — so
		// `executeDashboard` gets the directory from `process.cwd()`. That is the whole
		// mechanism, and it is why no `cd` line is sent either.
		expect(calls.created[0]?.cwd).toBe("/other/repo");
		expect(calls.terminals[0]?.sent).toEqual([`'${RUN_CLI}' dashboard`]);
	});

	it("opens a NEW terminal on every click, never reusing or revealing an old one", async () => {
		const { host, calls } = fakeHost();
		await launchDashboard(tierOneOptions({ host }));
		await launchDashboard(tierOneOptions({ host }));
		await launchDashboard(tierOneOptions({ host }));
		expect(calls.created).toHaveLength(3);
		// Each terminal carries exactly its own run — no earlier one is written to
		// again, so no click can land a second command in a terminal already busy.
		for (const terminal of calls.terminals) {
			expect(terminal.sent).toEqual([`'${RUN_CLI}' dashboard`]);
			expect(terminal.shown).toEqual([true]);
		}
	});

	it("gives every terminal the same name, cwd and env", async () => {
		const { host, calls } = fakeHost();
		await launchDashboard(tierOneOptions({ host }));
		await launchDashboard(tierOneOptions({ host }));
		expect(calls.created).toEqual([
			{ name: TERMINAL_NAME, cwd: REPO, env: { ELECTRON_RUN_AS_NODE: "1" } },
			{ name: TERMINAL_NAME, cwd: REPO, env: { ELECTRON_RUN_AS_NODE: "1" } },
		]);
	});

	it("runs the bundled entry through the host's Node when run-cli is unusable", async () => {
		const { host, calls } = fakeHost();
		await launchDashboard(tierOneOptions({ host, canExecute: () => false }));
		expect(calls.terminals[0]?.sent).toEqual([
			`'${EXEC}' '${join("/ext/dist", CLI_ENTRY_FILE)}' dashboard`,
		]);
		// The env is what makes that Electron path behave as node.
		expect(calls.created[0]?.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
	});

	it("reports an incomplete build instead of opening an empty terminal", async () => {
		const { host, calls } = fakeHost();
		await launchDashboard(tierOneOptions({ host, canExecute: () => false, fileExists: () => false }));
		expect(calls.errors).toEqual([UNAVAILABLE_MESSAGE]);
		expect(calls.created).toEqual([]);
		expect(logCalls.some((c) => c.level === "error" && c.message.includes(CLI_ENTRY_FILE))).toBe(true);
	});

	it("runs the readable `jolli dashboard` when a winning global CLI is on PATH", async () => {
		const { host, calls } = fakeHost();
		await launchDashboard(
			tierOneOptions({
				host,
				globalCliVersion: BUNDLED_CLI_VERSION,
				minGlobalCliVersion: BUNDLED_CLI_VERSION,
				pathEnv: "/usr/local/bin",
				// Stands in for both the PATH probe and the Cli.js check.
				fileExists: () => true,
			}),
		);
		expect(calls.terminals[0]?.sent).toEqual([`${GLOBAL_BIN_NAME} dashboard`]);
	});

	it("skips tier 0 without probing PATH when no global CLI wins", async () => {
		const probed: Array<string> = [];
		const { host, calls } = fakeHost();
		await launchDashboard(
			tierOneOptions({
				host,
				globalCliVersion: null,
				pathEnv: "/usr/local/bin",
				fileExists: (path) => {
					probed.push(path);
					return true;
				},
			}),
		);
		// A null version short-circuits the PATH walk entirely, so the only existence
		// question asked is tier 2's — never `/usr/local/bin/jolli`.
		expect(probed.some((path) => path.endsWith(GLOBAL_BIN_NAME))).toBe(false);
		expect(calls.terminals[0]?.sent[0]).toContain(RUN_CLI);
	});

	it("falls back to run-cli when the winning global CLI is not on PATH", async () => {
		const { host, calls } = fakeHost();
		await launchDashboard(
			tierOneOptions({
				host,
				globalCliVersion: BUNDLED_CLI_VERSION,
				minGlobalCliVersion: BUNDLED_CLI_VERSION,
				pathEnv: "/usr/local/bin",
				// Nothing named `jolli` on PATH; run-cli is still executable.
				fileExists: (path) => !path.endsWith(GLOBAL_BIN_NAME),
			}),
		);
		expect(calls.terminals[0]?.sent[0]).toContain(RUN_CLI);
	});

	it("searches the ambient PATH when no pathEnv is injected", async () => {
		const { host, calls } = fakeHost();
		await launchDashboard(
			tierOneOptions({
				host,
				globalCliVersion: BUNDLED_CLI_VERSION,
				minGlobalCliVersion: BUNDLED_CLI_VERSION,
				// pathEnv omitted on purpose: the walk must fall back to process.env.PATH.
				// Nothing exists there as far as this probe is concerned, so tier 1 wins.
				fileExists: (path) => !path.endsWith(GLOBAL_BIN_NAME),
			}),
		);
		expect(calls.terminals[0]?.sent[0]).toContain(RUN_CLI);
	});

	it("reads the real registry and PATH when neither is injected", async () => {
		const { host, calls } = fakeHost();
		// `globalCliVersion` omitted, so `readWinningGlobalCliVersion` runs against
		// the real machine. Only the shape is asserted — whether this machine has a
		// global CLI decides the tier, and a test must not depend on that.
		await launchDashboard({
			cwd: REPO,
			distDir: "/ext/dist",
			host,
			platform: "darwin",
			shell: "/bin/zsh",
			execPath: EXEC,
			runCliPath: RUN_CLI,
			canExecute: (path) => path === RUN_CLI,
			fileExists: () => true,
		});
		expect(calls.terminals[0]?.sent).toHaveLength(1);
	});

	it("records the tier and the shell it chose", async () => {
		const { host } = fakeHost();
		await launchDashboard(tierOneOptions({ host }));
		expect(logCalls.some((c) => c.message.includes("run-cli") && c.message.includes("posix shell"))).toBe(
			true,
		);
	});

	it("falls back to the ambient platform and shell when neither is injected", async () => {
		const { host, calls } = fakeHost();
		await launchDashboard({
			cwd: REPO,
			distDir: "/ext/dist",
			host,
			remoteName: undefined,
			execPath: EXEC,
			runCliPath: RUN_CLI,
			canExecute: (path) => path === RUN_CLI,
			fileExists: () => true,
			// Pinned for the reason `tierOneOptions` states: without it this case
			// reads the REAL dist-paths registry, so it asserted tier 1 only while
			// this machine happened to have no available `cli` entry. Building
			// `cli/dist` locally flipped it to tier 0 and the case went red with
			// nothing about its subject — the ambient platform/shell — having changed.
			globalCliVersion: null,
		});
		// The mocked `vscode.env.shell` is /bin/zsh, so tier 1 is reachable.
		expect(calls.terminals[0]?.sent).toEqual([`'${RUN_CLI}' dashboard`]);
	});

	it("reaches vscode.window when no host is injected", async () => {
		await launchDashboard({
			cwd: REPO,
			distDir: "/ext/dist",
			platform: "darwin",
			shell: "/bin/zsh",
			execPath: EXEC,
			runCliPath: RUN_CLI,
			canExecute: (path) => path === RUN_CLI,
			fileExists: () => true,
		});
		expect(createTerminalMock).toHaveBeenCalledWith({
			name: TERMINAL_NAME,
			cwd: REPO,
			env: { ELECTRON_RUN_AS_NODE: "1" },
		});
	});

	it("uses the real execPath when none is injected", async () => {
		const { host, calls } = fakeHost();
		await launchDashboard({
			cwd: REPO,
			distDir: "/ext/dist",
			host,
			remoteName: undefined,
			platform: "darwin",
			shell: "/bin/zsh",
			canExecute: () => false,
			fileExists: () => true,
			// Same machine-independence pin as above: the subject here is tier 2's
			// execPath default, which tier 0 would short-circuit past entirely.
			globalCliVersion: null,
		});
		expect(calls.terminals[0]?.sent[0]).toContain(process.execPath);
	});
});
