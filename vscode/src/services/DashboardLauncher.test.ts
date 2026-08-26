/**
 * DashboardLauncher tests.
 *
 * The launcher's job is to pick an executable + argv from three tiers and
 * spawn it as a detached background process. What is worth pinning: the remote
 * gate, that tier 0 is a version-gated global `jolli`, tier 1 is `run-cli` and
 * tier 2 is the winning registered dist's `Cli.js` — falling back to the
 * bundled entry — run by the host's Node, that tier 1 is skipped on win32
 * (bash-only shebang and no shell to interpret it in a detached child), that a
 * win32 `.cmd` shim is spawned through a shell, that the repo directory
 * reaches the CLI only as the spawn's own cwd and never as an argument, and
 * that the child is detached + unref'd + stdio-ignored so it survives the
 * extension host.
 */

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
	env: { remoteName: undefined },
	window: {
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
	type DashboardSpawn,
	findExecutableOnPath,
	GLOBAL_BIN_NAME,
	INVOKED_VIA_ENV_KEY,
	INVOKED_VIA_VALUE,
	isShellSafePath,
	isRemoteWorkspace,
	launchDashboard,
	readWinningGlobalCliVersion,
	REMOTE_HINT,
	resolveDashboardCommand,
	resolveRunCliPath,
	resolveWinningDistCliPath,
	RUN_AS_NODE_ENV_KEY,
	SPAWN_FAILED_MESSAGE,
	type SpawnedChild,
	UNAVAILABLE_MESSAGE,
} from "./DashboardLauncher.js";

const REPO = "/repo/root";
const EXEC = "/Applications/Code.app/Contents/MacOS/Electron";
const RUN_CLI = "/home/u/.jolli/jollimemory/run-cli";
const GLOBAL_JOLLI = "/usr/local/bin/jolli";

/** A dist directory that really holds a real `Cli.js`, so `existsSync` passes. */
function distWithCli(): string {
	const dir = mkdtempSync(join(tmpdir(), "jolli-dashboard-launcher-"));
	writeFileSync(join(dir, CLI_ENTRY_FILE), "");
	return dir;
}

interface FakeSpawnCall {
	readonly executable: string;
	readonly args: ReadonlyArray<string>;
	readonly cwd: unknown;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly detached: unknown;
	readonly stdio: unknown;
	readonly shell: unknown;
	readonly child: SpawnedChild;
}

interface FakeSpawn {
	readonly fn: DashboardSpawn;
	readonly calls: Array<FakeSpawnCall>;
	/** The most recent child's `error` listener, for tests that fire it. */
	errorListener?: (err: Error) => void;
	/** The most recent child's `exit` listener, for tests that fire it. */
	exitListener?: (code: number | null, signal: NodeJS.Signals | null) => void;
	throwNextWith?: Error;
	nextPid?: number;
}

function fakeSpawn(): FakeSpawn {
	const state: FakeSpawn = {
		fn: (executable, args, options) => {
			if (state.throwNextWith) {
				const err = state.throwNextWith;
				state.throwNextWith = undefined;
				throw err;
			}
			const child: SpawnedChild = {
				pid: state.nextPid ?? 12345,
				unref: vi.fn(),
				on: vi.fn((event: string, listener: unknown) => {
					if (event === "error") state.errorListener = listener as (err: Error) => void;
					if (event === "exit") state.exitListener = listener as (code: number | null, signal: NodeJS.Signals | null) => void;
				}),
			};
			state.calls.push({
				executable,
				args,
				cwd: options.cwd,
				env: (options.env ?? {}) as Readonly<Record<string, string | undefined>>,
				detached: options.detached,
				stdio: options.stdio,
				shell: options.shell,
				child,
			});
			return child;
		},
		calls: [],
	};
	return state;
}

interface FakeHostCalls {
	readonly infos: Array<string>;
	readonly errors: Array<string>;
}

function fakeHost(): { host: DashboardLauncherHost; calls: FakeHostCalls } {
	const calls: FakeHostCalls = { infos: [], errors: [] };
	const host: DashboardLauncherHost = {
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
 * Options that resolve to tier 1 on a non-win32 host, with nothing left to the
 * machine. `globalCliVersion: null` is load-bearing: without it the launcher
 * reads the REAL dist-paths registry, and a developer machine with a global CLI
 * installed would silently push every one of these cases up to tier 0.
 */
function tierOneOptions(overrides: Partial<Parameters<typeof launchDashboard>[0]> = {}) {
	const spawn = fakeSpawn();
	return {
		options: {
			cwd: REPO,
			distDir: "/ext/dist",
			platform: "darwin" as NodeJS.Platform,
			execPath: EXEC,
			runCliPath: RUN_CLI,
			canExecute: (path: string) => path === RUN_CLI,
			fileExists: () => true,
			globalCliVersion: null,
			globalCliPath: null,
			winningDistCliPath: null,
			spawn: spawn.fn,
			...overrides,
		},
		spawn,
	};
}

beforeEach(() => {
	logCalls.length = 0;
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

	it("tries PATHEXT suffixes on win32, which is how a .cmd shim is found", () => {
		const found = findExecutableOnPath("jolli", {
			pathEnv: "C:\\npm;C:\\other",
			pathExt: ".COM;.EXE;.BAT;.CMD",
			platform: "win32",
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
		expect(findExecutableOnPath(CLI_ENTRY_FILE, { pathEnv: dir, platform: process.platform })).toBe(
			join(dir, CLI_ENTRY_FILE),
		);
	});

	it.skipIf(process.platform === "win32")("does not match a present file with no exec bit", () => {
		const dir = distWithCli();
		chmodSync(join(dir, CLI_ENTRY_FILE), 0o644);
		expect(findExecutableOnPath(CLI_ENTRY_FILE, { pathEnv: dir, platform: process.platform })).toBeNull();
	});

	it("does not match a directory that happens to carry the binary's name", () => {
		const dir = mkdtempSync(join(tmpdir(), "jolli-dashboard-launcher-"));
		mkdirSync(join(dir, "jolli"));
		expect(findExecutableOnPath("jolli", { pathEnv: dir, platform: process.platform })).toBeNull();
	});
});

describe("readWinningGlobalCliVersion", () => {
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

/** A temp dist-paths registry whose entries point at real (but Cli.js-less) dist dirs. */
function registryWith(entries: Record<string, string>): string {
	const globalDir = mkdtempSync(join(tmpdir(), "jolli-dashboard-registry-"));
	const distPaths = join(globalDir, "dist-paths");
	mkdirSync(distPaths, { recursive: true });
	for (const [source, version] of Object.entries(entries)) {
		const distDir = join(globalDir, `${source}-dist`);
		mkdirSync(distDir, { recursive: true });
		writeFileSync(join(distPaths, source), `${version}\n${distDir}\n`);
	}
	return globalDir;
}

describe("resolveWinningDistCliPath", () => {
	it("names the winning registered dist's Cli.js — existence checked by the resolver", () => {
		const globalDir = registryWith({ cli: "1.2.3", vscode: "0.99.12" });
		expect(resolveWinningDistCliPath(globalDir)).toBe(join(globalDir, "cli-dist", CLI_ENTRY_FILE));
	});

	it("is undefined when nothing is registered", () => {
		expect(resolveWinningDistCliPath(registryWith({}))).toBeUndefined();
	});

	it("is undefined when the only entry's dist dir is gone (unavailable)", () => {
		const globalDir = mkdtempSync(join(tmpdir(), "jolli-dashboard-registry-"));
		const distPaths = join(globalDir, "dist-paths");
		mkdirSync(distPaths, { recursive: true });
		writeFileSync(join(distPaths, "cli"), `1.2.3\n${join(globalDir, "ghost-dist")}\n`);
		expect(resolveWinningDistCliPath(globalDir)).toBeUndefined();
	});
});

describe("resolveDashboardCommand", () => {
	const base = {
		cwd: REPO,
		distDir: "/ext/dist",
		execPath: EXEC,
		runCliPath: RUN_CLI,
		fileExists: () => true,
		globalCliVersion: null,
		globalCliPath: null,
		winningDistCliPath: null,
	};

	const withGlobalCli = {
		...base,
		globalCliVersion: BUNDLED_CLI_VERSION,
		globalCliPath: GLOBAL_JOLLI,
	};

	it("prefers a global jolli over run-cli when it wins and is new enough", () => {
		const resolved = resolveDashboardCommand({
			...withGlobalCli,
			platform: "darwin",
			canExecute: (path) => path === RUN_CLI,
		});
		expect(resolved).toEqual({
			tier: "global-jolli",
			executable: GLOBAL_JOLLI,
			args: ["dashboard"],
			runAsNode: false,
			shell: false,
		});
	});

	it("uses the absolute global path on every platform, tier 0 is not platform-gated", () => {
		for (const platform of ["darwin", "linux", "win32"] as Array<NodeJS.Platform>) {
			const resolved = resolveDashboardCommand({ ...withGlobalCli, platform });
			expect(resolved?.tier).toBe("global-jolli");
			expect(resolved?.executable).toBe(GLOBAL_JOLLI);
			expect(resolved?.runAsNode).toBe(false);
			expect(resolved?.shell).toBe(false);
		}
	});

	it("spawns a win32 `.cmd` shim through a shell — Node refuses `.cmd` without one", () => {
		const resolved = resolveDashboardCommand({
			...withGlobalCli,
			platform: "win32",
			globalCliPath: "C:\\Users\\u\\AppData\\Roaming\\npm\\jolli.cmd",
		});
		expect(resolved).toEqual({
			tier: "global-jolli",
			executable: "C:\\Users\\u\\AppData\\Roaming\\npm\\jolli.cmd",
			args: ["dashboard"],
			runAsNode: false,
			shell: true,
		});
	});

	it("does not shell a win32 `.exe` global CLI", () => {
		const resolved = resolveDashboardCommand({
			...withGlobalCli,
			platform: "win32",
			globalCliPath: "C:\\Tools\\jolli.exe",
		});
		expect(resolved?.tier).toBe("global-jolli");
		expect(resolved?.shell).toBe(false);
	});

	it("refuses a win32 shim path with cmd metacharacters, falling through to the host's Node", () => {
		const resolved = resolveDashboardCommand({
			...withGlobalCli,
			platform: "win32",
			globalCliPath: "C:\\Users\\a&b\\npm\\jolli.cmd",
			canExecute: () => false,
		});
		expect(resolved?.tier).toBe("host-node");
		expect(resolved?.shell).toBe(false);
	});

	it("refuses a win32 shim path with spaces, falling through to the host's Node", () => {
		const resolved = resolveDashboardCommand({
			...withGlobalCli,
			platform: "win32",
			globalCliPath: "C:\\Users\\John Doe\\AppData\\Roaming\\npm\\jolli.cmd",
			canExecute: () => false,
		});
		expect(resolved?.tier).toBe("host-node");
		expect(resolved?.shell).toBe(false);
	});

	it("never puts the repo directory in the args, on any tier or platform", () => {
		const cwd = "/some/repo/root";
		for (const platform of ["darwin", "linux", "win32"] as Array<NodeJS.Platform>) {
			for (const tierDeps of [withGlobalCli, { ...base, canExecute: () => true }, base]) {
				const resolved = resolveDashboardCommand({ ...tierDeps, cwd, platform });
				expect(resolved?.args).not.toContain(cwd);
				expect(resolved?.args).not.toContain("--cwd");
				expect(resolved?.args.at(-1)).toBe("dashboard");
			}
		}
	});

	it("refuses a global CLI older than the core this bundle carries", () => {
		const resolved = resolveDashboardCommand({
			...withGlobalCli,
			platform: "darwin",
			globalCliVersion: "0.97.0",
			minGlobalCliVersion: "0.99.12",
			canExecute: (path) => path === RUN_CLI,
		});
		expect(resolved?.tier).toBe("run-cli");
	});

	it("refuses a winning global CLI whose path was not found on PATH", () => {
		const resolved = resolveDashboardCommand({
			...withGlobalCli,
			platform: "darwin",
			globalCliPath: null,
			canExecute: (path) => path === RUN_CLI,
		});
		expect(resolved?.tier).toBe("run-cli");
	});

	it("prefers run-cli on a POSIX host — never a bare `jolli`", () => {
		const resolved = resolveDashboardCommand({
			...base,
			platform: "linux",
			canExecute: (path) => path === RUN_CLI,
		});
		expect(resolved).toEqual({
			tier: "run-cli",
			executable: RUN_CLI,
			args: ["dashboard"],
			runAsNode: false,
			shell: false,
		});
	});

	it("falls back to the bundled entry when run-cli is not executable and nothing is registered", () => {
		const resolved = resolveDashboardCommand({ ...base, platform: "darwin", canExecute: () => false });
		expect(resolved).toEqual({
			tier: "host-node",
			executable: EXEC,
			args: [join("/ext/dist", CLI_ENTRY_FILE), "dashboard"],
			runAsNode: true,
			shell: false,
		});
	});

	it("prefers the winning registered dist's Cli.js over the bundled entry", () => {
		const resolved = resolveDashboardCommand({
			...base,
			platform: "darwin",
			canExecute: () => false,
			winningDistCliPath: "/registry/winning/Cli.js",
		});
		expect(resolved).toEqual({
			tier: "host-node",
			executable: EXEC,
			args: ["/registry/winning/Cli.js", "dashboard"],
			runAsNode: true,
			shell: false,
		});
	});

	it("falls back to the bundled entry when the winning dist's Cli.js is missing", () => {
		const resolved = resolveDashboardCommand({
			...base,
			platform: "darwin",
			canExecute: () => false,
			winningDistCliPath: "/registry/winning/Cli.js",
			fileExists: (path: string) => path !== "/registry/winning/Cli.js",
		});
		expect(resolved).toEqual({
			tier: "host-node",
			executable: EXEC,
			args: [join("/ext/dist", CLI_ENTRY_FILE), "dashboard"],
			runAsNode: true,
			shell: false,
		});
	});

	it("never tries run-cli on win32 (its shebang is bash-only)", () => {
		const probed: Array<string> = [];
		const resolved = resolveDashboardCommand({
			...base,
			platform: "win32",
			canExecute: (path) => {
				probed.push(path);
				return true;
			},
		});
		expect(probed).toEqual([]);
		expect(resolved?.tier).toBe("host-node");
	});

	it("marks tier 2 with runAsNode so the launcher adds ELECTRON_RUN_AS_NODE", () => {
		const resolved = resolveDashboardCommand({ ...base, platform: "darwin", canExecute: () => false });
		expect(resolved?.runAsNode).toBe(true);
	});

	it("is null when the bundled entry and the winning dist are both missing", () => {
		expect(
			resolveDashboardCommand({
				...base,
				platform: "darwin",
				canExecute: () => false,
				fileExists: () => false,
			}),
		).toBeNull();
	});

	it("uses real filesystem probes when none are injected", () => {
		const dir = distWithCli();
		const resolved = resolveDashboardCommand({
			cwd: REPO,
			distDir: dir,
			execPath: EXEC,
			platform: "darwin",
			runCliPath: join(dir, "definitely-absent-run-cli"),
		});
		expect(resolved?.tier).toBe("host-node");
		expect(resolved?.args).toContain(join(dir, CLI_ENTRY_FILE));
	});

	it("treats a real executable as tier 1 through the default probe", () => {
		const resolved = resolveDashboardCommand({
			cwd: REPO,
			distDir: "/ext/dist",
			execPath: EXEC,
			platform: "linux",
			runCliPath: process.execPath,
		});
		expect(resolved?.tier).toBe("run-cli");
	});

	it("resolves run-cli under the real home when no path is given", () => {
		const resolved = resolveDashboardCommand({ ...base, runCliPath: undefined, platform: "darwin" });
		expect(resolved === null || resolved.tier === "run-cli" || resolved.tier === "host-node").toBe(true);
	});
});

describe("isShellSafePath", () => {
	it("accepts an ordinary win32 npm prefix", () => {
		expect(isShellSafePath("C:\\Users\\me\\AppData\\Roaming\\npm\\jolli.cmd")).toBe(true);
	});

	it("rejects a path with spaces — cmd.exe does not get a quoted file", () => {
		expect(isShellSafePath("C:\\Program Files\\Git\\bin\\bash.exe")).toBe(false);
		expect(isShellSafePath("C:\\Users\\John Doe\\AppData\\Roaming\\npm\\jolli.cmd")).toBe(false);
	});

	it("rejects cmd metacharacters", () => {
		expect(isShellSafePath("C:\\Users\\a&b\\npm\\jolli.cmd")).toBe(false);
		expect(isShellSafePath("C:\\Users\\100%done\\npm\\jolli.cmd")).toBe(false);
		expect(isShellSafePath("C:\\Users\\x|y\\npm\\jolli.cmd")).toBe(false);
		expect(isShellSafePath("C:\\Users\\say \"hi\"\\npm\\jolli.cmd")).toBe(false);
	});
});

describe("launchDashboard", () => {
	it("spawns the tier-1 executable detached, with stdio ignored and unref'd", async () => {
		const { host } = fakeHost();
		const { options, spawn } = tierOneOptions({ host });
		await launchDashboard(options);
		expect(spawn.calls).toHaveLength(1);
		const call = spawn.calls[0];
		expect(call?.executable).toBe(RUN_CLI);
		expect(call?.args).toEqual(["dashboard"]);
		expect(call?.detached).toBe(true);
		expect(call?.stdio).toBe("ignore");
		expect(call?.shell).toBe(false);
		expect(call?.child.unref).toHaveBeenCalledTimes(1);
	});

	it("refuses a remote window with the hint, spawning nothing", async () => {
		const { host, calls } = fakeHost();
		const { options, spawn } = tierOneOptions({ host, remoteName: "ssh-remote" });
		await launchDashboard(options);
		expect(calls.infos).toEqual([REMOTE_HINT]);
		expect(spawn.calls).toEqual([]);
	});

	it("runs the child at the repo cwd, never as a --cwd argument", async () => {
		const { host } = fakeHost();
		const { options, spawn } = tierOneOptions({ host, cwd: "/other/repo" });
		await launchDashboard(options);
		expect(spawn.calls[0]?.cwd).toBe("/other/repo");
		expect(spawn.calls[0]?.args).toEqual(["dashboard"]);
	});

	it("marks tier 1 without ELECTRON_RUN_AS_NODE — it is a real executable", async () => {
		const { host } = fakeHost();
		const { options, spawn } = tierOneOptions({ host });
		await launchDashboard(options);
		expect(spawn.calls[0]?.env[RUN_AS_NODE_ENV_KEY]).toBeUndefined();
	});

	it("tags every launch with JOLLI_INVOKED_VIA so ps can tell it apart from a manual run", async () => {
		const { host } = fakeHost();
		const { options, spawn } = tierOneOptions({ host });
		await launchDashboard(options);
		expect(spawn.calls[0]?.env[INVOKED_VIA_ENV_KEY]).toBe(INVOKED_VIA_VALUE);
	});

	it("starts a fresh child on every click, never reusing or waiting", async () => {
		const { host } = fakeHost();
		const { options, spawn } = tierOneOptions({ host });
		await launchDashboard(options);
		await launchDashboard(options);
		await launchDashboard(options);
		expect(spawn.calls).toHaveLength(3);
		for (const call of spawn.calls) {
			expect(call.executable).toBe(RUN_CLI);
			expect(call.args).toEqual(["dashboard"]);
		}
	});

	it("runs the bundled entry through the host's Node when run-cli is unusable and nothing is registered", async () => {
		const { host } = fakeHost();
		const { options, spawn } = tierOneOptions({ host, canExecute: () => false });
		await launchDashboard(options);
		expect(spawn.calls[0]?.executable).toBe(EXEC);
		expect(spawn.calls[0]?.args).toEqual([join("/ext/dist", CLI_ENTRY_FILE), "dashboard"]);
		expect(spawn.calls[0]?.env[RUN_AS_NODE_ENV_KEY]).toBe("1");
		expect(spawn.calls[0]?.shell).toBe(false);
	});

	it("runs the winning registered dist's Cli.js through the host's Node on win32", async () => {
		const { host } = fakeHost();
		const { options, spawn } = tierOneOptions({
			host,
			platform: "win32",
			canExecute: () => false,
			globalCliVersion: null,
			globalCliPath: null,
			winningDistCliPath: "/registry/winning/Cli.js",
		});
		await launchDashboard(options);
		expect(spawn.calls[0]?.executable).toBe(EXEC);
		expect(spawn.calls[0]?.args).toEqual(["/registry/winning/Cli.js", "dashboard"]);
		expect(spawn.calls[0]?.env[RUN_AS_NODE_ENV_KEY]).toBe("1");
		expect(spawn.calls[0]?.shell).toBe(false);
		expect(logCalls.some((c) => c.message.includes("host-node"))).toBe(true);
	});

	it("falls back to the bundled entry when the winning dist's Cli.js is missing", async () => {
		const { host } = fakeHost();
		const { options, spawn } = tierOneOptions({
			host,
			canExecute: () => false,
			winningDistCliPath: "/registry/winning/Cli.js",
			fileExists: (path: string) => path !== "/registry/winning/Cli.js",
		});
		await launchDashboard(options);
		expect(spawn.calls[0]?.executable).toBe(EXEC);
		expect(spawn.calls[0]?.args).toEqual([join("/ext/dist", CLI_ENTRY_FILE), "dashboard"]);
		expect(spawn.calls[0]?.env[RUN_AS_NODE_ENV_KEY]).toBe("1");
	});

	it("reports an incomplete build when neither the winning dist nor the bundled entry exists", async () => {
		const { host, calls } = fakeHost();
		const { options, spawn } = tierOneOptions({
			host,
			canExecute: () => false,
			winningDistCliPath: "/registry/winning/Cli.js",
			fileExists: () => false,
		});
		await launchDashboard(options);
		expect(calls.errors).toEqual([UNAVAILABLE_MESSAGE]);
		expect(spawn.calls).toEqual([]);
	});

	it("resolves the winning dist from the ambient registry when not injected", async () => {
		const { host } = fakeHost();
		const { options, spawn } = tierOneOptions({
			host,
			canExecute: () => false,
			winningDistCliPath: undefined,
		});
		await launchDashboard(options);
		// The path is machine-dependent (a real dist may or may not win), so only
		// the shape is pinned: tier 2 always runs the host's Node as node.
		expect(spawn.calls).toHaveLength(1);
		expect(spawn.calls[0]?.executable).toBe(EXEC);
		expect(spawn.calls[0]?.env[RUN_AS_NODE_ENV_KEY]).toBe("1");
		expect(logCalls.some((c) => c.message.includes("host-node"))).toBe(true);
	});

	it("reports an incomplete build instead of spawning nothing", async () => {
		const { host, calls } = fakeHost();
		const { options, spawn } = tierOneOptions({
			host,
			canExecute: () => false,
			fileExists: () => false,
		});
		await launchDashboard(options);
		expect(calls.errors).toEqual([UNAVAILABLE_MESSAGE]);
		expect(spawn.calls).toEqual([]);
		expect(logCalls.some((c) => c.level === "error" && c.message.includes(CLI_ENTRY_FILE))).toBe(true);
	});

	it("reports a spawn failure with a message box the user can see", async () => {
		const { host, calls } = fakeHost();
		const { options, spawn } = tierOneOptions({ host });
		spawn.throwNextWith = new Error("EACCES");
		await launchDashboard(options);
		expect(calls.errors).toEqual([SPAWN_FAILED_MESSAGE]);
		expect(logCalls.some((c) => c.level === "error" && c.message.includes("EACCES"))).toBe(true);
	});

	it("reports an asynchronous spawn error with a message box the user can see", async () => {
		const { host, calls } = fakeHost();
		const { options, spawn } = tierOneOptions({ host });
		await launchDashboard(options);
		expect(spawn.errorListener).toBeDefined();
		spawn.errorListener?.(new Error("EINVAL"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls.errors).toEqual([SPAWN_FAILED_MESSAGE]);
		expect(logCalls.some((c) => c.level === "error" && c.message.includes("EINVAL"))).toBe(true);
	});

	it("logs a tier-0 exit 127 so a missing shebang interpreter is not silent", async () => {
		const { host } = fakeHost();
		const { options, spawn } = tierOneOptions({
			host,
			globalCliVersion: BUNDLED_CLI_VERSION,
			minGlobalCliVersion: BUNDLED_CLI_VERSION,
			globalCliPath: GLOBAL_JOLLI,
		});
		await launchDashboard(options);
		expect(spawn.exitListener).toBeDefined();
		spawn.exitListener?.(127, null);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(logCalls.some((c) => c.level === "error" && c.message.includes("exited 127"))).toBe(true);
	});

	it("runs the readable `jolli dashboard` when a winning global CLI is on PATH", async () => {
		const { host } = fakeHost();
		const { options, spawn } = tierOneOptions({
			host,
			globalCliVersion: BUNDLED_CLI_VERSION,
			minGlobalCliVersion: BUNDLED_CLI_VERSION,
			globalCliPath: GLOBAL_JOLLI,
		});
		await launchDashboard(options);
		expect(spawn.calls[0]?.executable).toBe(GLOBAL_JOLLI);
		expect(spawn.calls[0]?.args).toEqual(["dashboard"]);
		expect(spawn.calls[0]?.env[RUN_AS_NODE_ENV_KEY]).toBeUndefined();
		expect(spawn.calls[0]?.shell).toBe(false);
	});

	it("passes shell: true to the spawn for a win32 `.cmd` global shim", async () => {
		const { host } = fakeHost();
		const { options, spawn } = tierOneOptions({
			host,
			platform: "win32",
			globalCliVersion: BUNDLED_CLI_VERSION,
			minGlobalCliVersion: BUNDLED_CLI_VERSION,
			globalCliPath: "C:\\Users\\u\\AppData\\Roaming\\npm\\jolli.cmd",
			canExecute: () => false,
		});
		await launchDashboard(options);
		expect(spawn.calls[0]?.executable).toBe("C:\\Users\\u\\AppData\\Roaming\\npm\\jolli.cmd");
		expect(spawn.calls[0]?.args).toEqual(["dashboard"]);
		expect(spawn.calls[0]?.shell).toBe(true);
		expect(spawn.calls[0]?.env[RUN_AS_NODE_ENV_KEY]).toBeUndefined();
	});

	it("skips PATH lookup when no global CLI wins the version competition", async () => {
		const probed: Array<string> = [];
		const { host } = fakeHost();
		const { options, spawn } = tierOneOptions({
			host,
			globalCliVersion: null,
			globalCliPath: undefined,
			pathEnv: "/usr/local/bin",
			fileExists: (path) => {
				probed.push(path);
				return true;
			},
		});
		await launchDashboard(options);
		expect(probed.some((path) => path.endsWith(GLOBAL_BIN_NAME))).toBe(false);
		expect(spawn.calls[0]?.executable).toBe(RUN_CLI);
	});

	it("falls back to run-cli when the winning global CLI is not on PATH", async () => {
		const { host } = fakeHost();
		const { options, spawn } = tierOneOptions({
			host,
			globalCliVersion: BUNDLED_CLI_VERSION,
			minGlobalCliVersion: BUNDLED_CLI_VERSION,
			globalCliPath: null,
		});
		await launchDashboard(options);
		expect(spawn.calls[0]?.executable).toBe(RUN_CLI);
	});

	it("resolves a globalCliPath from the ambient PATH when not injected", async () => {
		const { host } = fakeHost();
		const { options, spawn } = tierOneOptions({
			host,
			globalCliVersion: BUNDLED_CLI_VERSION,
			minGlobalCliVersion: BUNDLED_CLI_VERSION,
			globalCliPath: undefined,
			pathEnv: "/usr/local/bin",
			fileExists: (path) => path === join("/usr/local/bin", GLOBAL_BIN_NAME),
		});
		await launchDashboard(options);
		expect(spawn.calls[0]?.executable).toBe(join("/usr/local/bin", GLOBAL_BIN_NAME));
	});

	it("records the tier it chose", async () => {
		const { host } = fakeHost();
		const { options } = tierOneOptions({ host });
		await launchDashboard(options);
		expect(logCalls.some((c) => c.message.includes("run-cli"))).toBe(true);
	});

	it("quotes argv parts with spaces in the launch log line", async () => {
		const { host } = fakeHost();
		const { options } = tierOneOptions({
			host,
			globalCliVersion: BUNDLED_CLI_VERSION,
			minGlobalCliVersion: BUNDLED_CLI_VERSION,
			globalCliPath: "/Users/me/Library/Application Support/jolli",
		});
		await launchDashboard(options);
		expect(
			logCalls.some((c) =>
				c.message.includes('launching dashboard in background via global-jolli: "/Users/me/Library/Application Support/jolli" dashboard'),
			),
		).toBe(true);
	});

	it("falls back to the ambient platform when none is injected", async () => {
		const { host } = fakeHost();
		const { options, spawn } = tierOneOptions({
			host,
			platform: undefined,
			globalCliVersion: null,
			globalCliPath: null,
		});
		await launchDashboard(options);
		expect(spawn.calls).toHaveLength(1);
	});

	it("uses the real execPath when none is injected", async () => {
		const { host } = fakeHost();
		const { options, spawn } = tierOneOptions({
			host,
			execPath: undefined,
			canExecute: () => false,
			fileExists: () => true,
			globalCliVersion: null,
			globalCliPath: null,
		});
		await launchDashboard(options);
		expect(spawn.calls[0]?.executable).toBe(process.execPath);
	});
});
