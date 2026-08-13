/**
 * DashboardLauncher tests.
 *
 * The subject is the wiring, not the launcher: `executeDashboard` is injected by
 * every case except the one that exists to prove the default is wired (and that
 * one gets a module mock), and `spawnHidden` is mocked throughout — so nothing
 * here binds a port, starts a process or opens a browser. What is worth pinning
 * is the six things this module decides on its own: the remote gate, the argv +
 * env that make Electron run the server entry as node, that the progress
 * notification ends at the BROWSER rather than at the end of the command, that a
 * failure reaches the user, that a repeat click reuses the running launch rather
 * than starting a second one, and that a refused browser is reported at all.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `withProgress` runs its task here (rather than being an inert `vi.fn()`)
// because the default-seam case below goes through `defaultUi()`, whose progress
// adapter is the only thing that awaits the startup barrier. An inert stub would
// let that test pass without the barrier ever being released.
vi.mock("vscode", () => ({
	env: { remoteName: undefined, openExternal: vi.fn() },
	window: {
		withProgress: vi.fn((_options: unknown, task: () => Promise<void>) => task()),
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
	},
	Uri: { parse: (s: string) => s },
	ProgressLocation: { Notification: 15 },
}));

const { spawnHiddenMock, executeDashboardMock } = vi.hoisted(() => ({
	spawnHiddenMock: vi.fn(),
	executeDashboardMock: vi.fn(),
}));

// No real process is ever started: the spawner's whole job here is the argv +
// env it hands to `spawnHidden`, which is what makes Electron run the entry as
// a plain node process.
vi.mock("../../../cli/src/util/Subprocess.js", () => ({ spawnHidden: spawnHiddenMock }));

// The launcher itself is injected as `run` by nearly every case; this mock only
// covers the one case that omits it, so the `?? executeDashboard` fallback can
// be exercised without binding a port or touching the repo.
vi.mock("../../../cli/src/commands/DashboardCommand.js", () => ({ executeDashboard: executeDashboardMock }));

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
	__resetDashboardLaunchForTests,
	BROWSER_FAILURE_MESSAGE,
	createOutput,
	createServerSpawner,
	type DashboardLauncherUi,
	FAILURE_MESSAGE,
	isRemoteWorkspace,
	launchDashboard,
	PROGRESS_TITLE,
	REMOTE_HINT,
	SERVER_ENTRY_FILE,
} from "./DashboardLauncher.js";

interface FakeUiCalls {
	progressEnded: boolean;
	errors: Array<string>;
	infos: Array<string>;
	opened: Array<string>;
	logRevealed: boolean;
}

/**
 * A UI seam that records what it was asked to do.
 *
 * `errorChoice` is what the user is taken to have clicked on the failure
 * notification — a constructor argument rather than an override so a case can
 * exercise the "Show Log" branch without having to restate the recording.
 */
function fakeUi(
	opts: { readonly errorChoice?: string; readonly overrides?: Partial<DashboardLauncherUi> } = {},
): { ui: DashboardLauncherUi; calls: FakeUiCalls } {
	const calls: FakeUiCalls = {
		progressEnded: false,
		errors: [],
		infos: [],
		opened: [],
		logRevealed: false,
	};
	const ui: DashboardLauncherUi = {
		withProgress: async (_title, task) => {
			await task();
			calls.progressEnded = true;
		},
		showError: async (message) => {
			calls.errors.push(message);
			return opts.errorChoice;
		},
		showInfo: async (message) => {
			calls.infos.push(message);
		},
		openExternal: async (url) => {
			calls.opened.push(url);
		},
		revealLog: () => {
			calls.logRevealed = true;
		},
		...(opts.overrides ?? {}),
	};
	return { ui, calls };
}

/** A stand-in for the detached child: only `on` and `unref` are ever touched. */
function fakeChild(): { on: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> } {
	return { on: vi.fn(), unref: vi.fn() };
}

/** A real dist directory holding a real server entry, so `existsSync` passes. */
function distWithEntry(): string {
	const dir = mkdtempSync(join(tmpdir(), "jolli-dashboard-launcher-"));
	writeFileSync(join(dir, SERVER_ENTRY_FILE), "");
	return dir;
}

/** A macrotask: guarantees every pending microtask has drained first. */
function flushMicrotasks(): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	logCalls.length = 0;
	spawnHiddenMock.mockReset().mockReturnValue(fakeChild());
	executeDashboardMock.mockReset().mockResolvedValue(true);
	// The in-flight guard is module state, and several cases below deliberately
	// leave a command pending — without this the next case would be treated as a
	// repeat click on the previous one's launch.
	__resetDashboardLaunchForTests();
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

describe("createOutput", () => {
	it("strips the CLI's terminal padding and routes by severity", () => {
		const out = createOutput(fakeUi().ui);
		out.log("\n  Jolli dashboard → http://127.0.0.1:1818/dashboard\n");
		out.error("\n  Error: invalid --port value: abc\n");
		expect(logCalls).toEqual([
			{ level: "info", message: "Jolli dashboard → http://127.0.0.1:1818/dashboard" },
			{ level: "error", message: "Error: invalid --port value: abc" },
		]);
	});

	it("drops a blank line rather than logging an empty entry", () => {
		const { ui, calls } = fakeUi();
		const out = createOutput(ui);
		out.log("\n");
		out.error("   ");
		out.notice("  \n ");
		expect(logCalls).toEqual([]);
		expect(calls.infos).toEqual([]);
	});

	it("puts a notice on screen as well as in the channel", async () => {
		// The whole point of the third channel: a `log` line lands in an output
		// panel nobody opens, and this one is the only explanation the user gets.
		const { ui, calls } = fakeUi();
		createOutput(ui).notice("\n  Jolli Memory is disabled here — opening the dashboard without adding this repo to it.\n");
		expect(calls.infos).toEqual(["Jolli Memory is disabled here — opening the dashboard without adding this repo to it."]);
		// Still in the channel too, so the launch reads as one story there.
		expect(logCalls).toEqual([
			{
				level: "info",
				message: "Jolli Memory is disabled here — opening the dashboard without adding this repo to it.",
			},
		]);
	});
});

describe("createServerSpawner", () => {
	it("throws when the dist has no server entry, naming the path it looked at", () => {
		const spawn = createServerSpawner("/nonexistent-dist-dir");
		expect(() => spawn(undefined, "/repo")).toThrow(/nonexistent-dist-dir/);
		expect(() => spawn(undefined, "/repo")).toThrow(new RegExp(SERVER_ENTRY_FILE));
		expect(spawnHiddenMock).not.toHaveBeenCalled();
	});

	it("runs the entry through the host's own node, detached, from the repo cwd", () => {
		const distDir = distWithEntry();
		createServerSpawner(distDir)(undefined, "/repo/root");

		expect(spawnHiddenMock).toHaveBeenCalledWith(
			process.execPath,
			[join(distDir, SERVER_ENTRY_FILE)],
			expect.objectContaining({ detached: true, stdio: "ignore", cwd: "/repo/root" }),
		);
		const env = spawnHiddenMock.mock.calls[0][2].env as Record<string, string>;
		// Without this the extension host's Electron binary would not run the
		// script as node at all.
		expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
		// No port asked for → no override, so the server keeps its own default.
		expect(env).not.toHaveProperty("JOLLI_DASHBOARD_PORT");
	});

	it("passes an explicit port through to the server entry as a string", () => {
		const distDir = distWithEntry();
		createServerSpawner(distDir)(1919, "/repo/root");
		const env = spawnHiddenMock.mock.calls[0][2].env as Record<string, string>;
		expect(env.JOLLI_DASHBOARD_PORT).toBe("1919");
	});

	it("logs a spawn failure instead of letting it surface as an uncaught exception", () => {
		const child = fakeChild();
		spawnHiddenMock.mockReturnValue(child);
		const distDir = distWithEntry();
		createServerSpawner(distDir)(undefined, "/repo");

		// The detached child is released so it outlives the extension host…
		expect(child.unref).toHaveBeenCalled();
		// …but an async `error` with no listener would be re-thrown by Node inside
		// the host, far from any command we control. The /health probe is what
		// actually reports the outcome, so this only has to not explode.
		const onError = child.on.mock.calls.find((c) => c[0] === "error")?.[1] as (err: Error) => void;
		expect(onError).toBeTypeOf("function");
		onError(new Error("EACCES"));
		expect(logCalls.some((c) => c.level === "warn" && c.message.includes("EACCES"))).toBe(true);
	});
});

describe("launchDashboard", () => {
	it("does not start a server in a remote window; it explains instead", async () => {
		const { ui, calls } = fakeUi();
		const run = vi.fn();
		await launchDashboard({ cwd: "/repo", distDir: "/dist", remoteName: "ssh-remote", ui, run });
		expect(run).not.toHaveBeenCalled();
		expect(calls.infos).toEqual([REMOTE_HINT]);
		expect(calls.errors).toEqual([]);
	});

	it("ends the progress notification when the browser opens, NOT when the command finishes", async () => {
		const { ui, calls } = fakeUi();
		let finishCommand: (ok: boolean) => void = () => {};
		const commandDone = new Promise<boolean>((resolve) => {
			finishCommand = resolve;
		});
		// Stands in for the history import: opens the browser, then keeps running.
		const run = vi.fn(async (_page, _options, deps) => {
			await deps?.openBrowser?.("http://127.0.0.1:1818/dashboard");
			return commandDone;
		});

		await launchDashboard({ cwd: "/repo", distDir: "/dist", remoteName: undefined, ui, run: run as never });

		// Returned while the command is still pending — the whole point of the split.
		expect(calls.progressEnded).toBe(true);
		expect(calls.opened).toEqual(["http://127.0.0.1:1818/dashboard"]);
		expect(calls.errors).toEqual([]);
		finishCommand(true);
		await commandDone;
	});

	it("passes the launcher the repo cwd", async () => {
		const { ui } = fakeUi();
		const run = vi.fn(async () => true);
		await launchDashboard({ cwd: "/repo/root", distDir: "/dist", remoteName: undefined, ui, run: run as never });
		expect(run).toHaveBeenCalledWith("stats", { cwd: "/repo/root" }, expect.anything());
	});

	it("reports a failed launch and offers the log", async () => {
		const { ui, calls } = fakeUi({ errorChoice: "Show Log" });
		const run = vi.fn(async () => false);
		await launchDashboard({ cwd: "/repo", distDir: "/dist", remoteName: undefined, ui, run: run as never });
		// The notification must end even though no browser was ever opened.
		expect(calls.progressEnded).toBe(true);
		await vi.waitFor(() => expect(calls.errors).toEqual([FAILURE_MESSAGE]));
		expect(calls.logRevealed).toBe(true);
	});

	it("reports an unexpected rejection instead of losing it", async () => {
		const { ui, calls } = fakeUi();
		const run = vi.fn(async () => {
			throw new Error("boom");
		});
		await launchDashboard({ cwd: "/repo", distDir: "/dist", remoteName: undefined, ui, run: run as never });
		expect(calls.progressEnded).toBe(true);
		await vi.waitFor(() => expect(calls.errors).toEqual([FAILURE_MESSAGE]));
		expect(logCalls.some((c) => c.level === "error" && c.message.includes("boom"))).toBe(true);
	});

	it("leaves the log alone when the failure notification is dismissed", async () => {
		// No button clicked (showError resolves undefined): the failure is still
		// reported, but nothing is revealed — only "Show Log" opens the channel.
		const { ui, calls } = fakeUi();
		const run = vi.fn(async () => false);
		await launchDashboard({ cwd: "/repo", distDir: "/dist", remoteName: undefined, ui, run: run as never });
		await vi.waitFor(() => expect(calls.errors).toEqual([FAILURE_MESSAGE]));
		expect(calls.logRevealed).toBe(false);
	});

	it("stringifies a non-Error rejection and still offers the log", async () => {
		const { ui, calls } = fakeUi({ errorChoice: "Show Log" });
		// Rejecting with a plain string exercises the String(err) arm of the
		// `err instanceof Error ? err.message : String(err)` ternary.
		const run = vi.fn(async () => {
			throw "dashboard exploded";
		});
		await launchDashboard({ cwd: "/repo", distDir: "/dist", remoteName: undefined, ui, run: run as never });
		await vi.waitFor(() => expect(calls.errors).toEqual([FAILURE_MESSAGE]));
		expect(calls.logRevealed).toBe(true);
		expect(logCalls.some((c) => c.level === "error" && c.message.includes("dashboard exploded"))).toBe(true);
	});

	it("falls back to the window UI and the real launcher when neither seam is injected", async () => {
		// Production shape: no `ui`, no `run`, no `remoteName`. Nothing here binds
		// a port — `executeDashboard` is mocked — but it is the only case that
		// proves the two defaults are wired at all.
		const vscode = await import("vscode");
		await launchDashboard({ cwd: "/repo", distDir: "/dist" });
		expect(executeDashboardMock).toHaveBeenCalledWith("stats", { cwd: "/repo" }, expect.anything());
		expect(vscode.window.withProgress).toHaveBeenCalledWith(
			expect.objectContaining({ title: PROGRESS_TITLE }),
			expect.any(Function),
		);
	});

	it("still ends the notification when opening the browser fails, and says so", async () => {
		const { ui, calls } = fakeUi({
			errorChoice: "Show Log",
			overrides: {
				openExternal: async () => {
					throw new Error("no browser");
				},
			},
		});
		const run = vi.fn(async (_page, _options, deps) => {
			// The launcher swallows a failed open and carries on, so this must too.
			await deps?.openBrowser?.("http://127.0.0.1:1818/dashboard").catch(() => {});
			return true;
		});
		await launchDashboard({ cwd: "/repo", distDir: "/dist", remoteName: undefined, ui, run: run as never });
		expect(calls.progressEnded).toBe(true);
		// `executeDashboard` treats this as non-fatal and returns success, so the
		// generic failure path never fires — without a report of its own the whole
		// thing would be a spinner that stops and nothing else.
		await vi.waitFor(() => expect(calls.errors).toEqual([BROWSER_FAILURE_MESSAGE]));
		expect(calls.logRevealed).toBe(true);
		// Logged from the launcher because the command prints its own copy of the
		// URL only after the call that just failed.
		expect(logCalls.some((c) => c.level === "error" && c.message.includes("127.0.0.1:1818"))).toBe(true);
	});

	it("leaves the log alone when the browser report is dismissed", async () => {
		const { ui, calls } = fakeUi({
			overrides: {
				openExternal: async () => {
					throw new Error("no browser");
				},
			},
		});
		const run = vi.fn(async (_page, _options, deps) => {
			await deps?.openBrowser?.("http://127.0.0.1:1818/dashboard").catch(() => {});
			return true;
		});
		await launchDashboard({ cwd: "/repo", distDir: "/dist", remoteName: undefined, ui, run: run as never });
		await vi.waitFor(() => expect(calls.errors).toEqual([BROWSER_FAILURE_MESSAGE]));
		expect(calls.logRevealed).toBe(false);
	});

	it("re-opens the same URL on a repeat click instead of launching twice", async () => {
		const { ui, calls } = fakeUi();
		let finishCommand: (ok: boolean) => void = () => {};
		const commandDone = new Promise<boolean>((resolve) => {
			finishCommand = resolve;
		});
		// Opens the browser, then stands in for the multi-minute history import.
		const run = vi.fn(async (_page, _options, deps) => {
			await deps?.openBrowser?.("http://127.0.0.1:1818/dashboard");
			return commandDone;
		});
		const opts = { cwd: "/repo", distDir: "/dist", remoteName: undefined, ui, run: run as never };

		await launchDashboard(opts);
		await launchDashboard(opts);

		// The second click reached the browser but NOT the command: one history
		// import, one cutover attempt, one backup snapshot.
		expect(run).toHaveBeenCalledTimes(1);
		expect(calls.opened).toEqual(["http://127.0.0.1:1818/dashboard", "http://127.0.0.1:1818/dashboard"]);
		expect(calls.errors).toEqual([]);
		finishCommand(true);
		await commandDone;
	});

	it("shares the startup wait with a click that lands before the browser opens", async () => {
		const { ui, calls } = fakeUi();
		let openTheBrowser: () => Promise<void> = async () => {};
		// Stands in for a server that has not answered /health yet: the command is
		// running, but no URL exists for a repeat click to re-open.
		const run = vi.fn(async (_page, _options, deps) => {
			await new Promise<void>((resolve) => {
				openTheBrowser = async () => {
					await deps?.openBrowser?.("http://127.0.0.1:1818/dashboard");
					resolve();
				};
			});
			return true;
		});
		const opts = { cwd: "/repo", distDir: "/dist", remoteName: undefined, ui, run: run as never };

		const first = launchDashboard(opts);
		const second = launchDashboard(opts);
		expect(run).toHaveBeenCalledTimes(1);

		await openTheBrowser();
		await first;
		await second;
		// Both clicks were released by the one browser open, and only that one.
		expect(calls.opened).toEqual(["http://127.0.0.1:1818/dashboard"]);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("reports a refused re-open on a repeat click too", async () => {
		let opens = 0;
		const { ui, calls } = fakeUi({
			errorChoice: "Show Log",
			overrides: {
				openExternal: async () => {
					opens += 1;
					if (opens > 1) throw new Error("no browser");
				},
			},
		});
		let finishCommand: (ok: boolean) => void = () => {};
		const commandDone = new Promise<boolean>((resolve) => {
			finishCommand = resolve;
		});
		const run = vi.fn(async (_page, _options, deps) => {
			await deps?.openBrowser?.("http://127.0.0.1:1818/dashboard");
			return commandDone;
		});
		const opts = { cwd: "/repo", distDir: "/dist", remoteName: undefined, ui, run: run as never };

		await launchDashboard(opts);
		await launchDashboard(opts);

		expect(run).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => expect(calls.errors).toEqual([BROWSER_FAILURE_MESSAGE]));
		expect(calls.logRevealed).toBe(true);
		finishCommand(true);
		await commandDone;
	});

	it("wires the command's notice channel to a real notification", async () => {
		// Proves the launcher hands its OWN ui to `createOutput`: a notice the
		// command emits mid-run has to reach the screen, not just the channel.
		const { ui, calls } = fakeUi();
		const run = vi.fn(async (_page, _options, deps) => {
			deps?.output?.notice("\n  Jolli Memory is disabled here — opening the dashboard without adding this repo to it.\n");
			await deps?.openBrowser?.("http://127.0.0.1:1818/dashboard");
			return true;
		});
		await launchDashboard({ cwd: "/repo", distDir: "/dist", remoteName: undefined, ui, run: run as never });
		expect(calls.infos).toEqual([
			"Jolli Memory is disabled here — opening the dashboard without adding this repo to it.",
		]);
	});

	it("reports a synchronous throw from the launcher seam instead of rejecting", async () => {
		const { ui, calls } = fakeUi({ errorChoice: "Show Log" });
		// `executeDashboard` is async and cannot do this, but `run` is a seam — and
		// the one caller `void`s this function, so an escaping throw would land as
		// an unhandled rejection in the extension host.
		const boom = vi.fn(() => {
			throw new Error("seam exploded");
		});
		await expect(
			launchDashboard({ cwd: "/repo", distDir: "/dist", remoteName: undefined, ui, run: boom as never }),
		).resolves.toBeUndefined();
		expect(calls.errors).toEqual([FAILURE_MESSAGE]);
		expect(calls.logRevealed).toBe(true);
		expect(logCalls.some((c) => c.level === "error" && c.message.includes("seam exploded"))).toBe(true);

		// And the guard was never published, so the button is not left dead.
		const ok = vi.fn(async () => true);
		await launchDashboard({ cwd: "/repo", distDir: "/dist", remoteName: undefined, ui, run: ok as never });
		expect(ok).toHaveBeenCalledTimes(1);
	});

	it("launches again once the previous launch has settled", async () => {
		const { ui } = fakeUi();
		const run = vi.fn(async (_page, _options, deps) => {
			await deps?.openBrowser?.("http://127.0.0.1:1818/dashboard");
			return true;
		});
		const opts = { cwd: "/repo", distDir: "/dist", remoteName: undefined, ui, run: run as never };

		await launchDashboard(opts);
		// The guard is released in the command's settle handler, which is a
		// microtask behind the startup barrier `launchDashboard` awaits.
		await flushMicrotasks();
		await launchDashboard(opts);

		expect(run).toHaveBeenCalledTimes(2);
	});
});
