/**
 * DashboardLauncher tests.
 *
 * The subject is the wiring, not the dashboard: the child process is injected by
 * every case except the one that exists to prove the default spawner is wired
 * (and that one mocks `spawnHidden`), so nothing here binds a port, starts a
 * process or opens a browser.
 *
 * What is worth pinning is what this module decides on its own now that
 * `jolli dashboard` is a foreground command it runs as a CHILD: the remote gate,
 * the argv that runs the CLI entry as node with `--no-open`, that the URL is
 * recovered from the child's own output (nothing on disk records the port any
 * more), that the progress notification ends at the BROWSER rather than at the
 * child's exit, that a child which dies before serving is reported, that a
 * repeat click reuses the running dashboard, that a refused browser is reported
 * at all, and that the child can be stopped — the Ctrl+C a button cannot offer.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
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

const { spawnHiddenMock } = vi.hoisted(() => ({ spawnHiddenMock: vi.fn() }));

// No real process is ever started: the default spawner's whole job here is the
// argv + env it hands to `spawnHidden`, which is what makes Electron run the
// CLI entry as a plain node process.
vi.mock("../../../cli/src/util/Subprocess.js", () => ({ spawnHidden: spawnHiddenMock }));

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
	CLI_ENTRY_FILE,
	type DashboardLauncherUi,
	type DashboardSpawner,
	FAILURE_MESSAGE,
	isDashboardRunning,
	isRemoteWorkspace,
	launchDashboard,
	PROGRESS_TITLE,
	REMOTE_HINT,
	stopDashboard,
	URL_PATTERN,
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

/**
 * A stand-in for the spawned `jolli dashboard`.
 *
 * Real streams rather than stubs, because the module reads them through
 * `readline` — the line buffering is part of what is under test (a chunk
 * boundary inside the URL line must not lose it).
 */
function fakeChild(): {
	child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn>; exitCode: null };
	say: (line: string) => Promise<void>;
	gone: (code: number) => Promise<void>;
	closed: (code: number) => Promise<void>;
	exit: (code: number) => Promise<void>;
} {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const child = Object.assign(new EventEmitter(), {
		stdout,
		stderr,
		kill: vi.fn(),
		exitCode: null as null,
	});
	// The two halves of a child ending, exposed separately because the GAP between
	// them is what this module has to survive: `exit` fires the moment the process
	// is gone, while lines it printed a moment earlier are still travelling through
	// the pipes, and `close` is the event that waits for those pipes.
	//
	// They are separate here rather than sequenced inside one helper because a
	// `PassThrough` written from a test delivers synchronously — the gap a real
	// pipe has does not exist unless a case opens it deliberately.
	const gone = async (code: number) => {
		child.emit("exit", code);
		await flushMicrotasks();
	};
	const closed = async (code: number) => {
		stdout.end();
		stderr.end();
		await flushMicrotasks();
		child.emit("close", code);
		await flushMicrotasks();
	};
	return {
		child,
		say: async (line: string) => {
			stdout.write(`${line}\n`);
			await flushMicrotasks();
		},
		gone,
		closed,
		/** The ordinary case: nothing was left in flight, so both fire back to back. */
		exit: async (code: number) => {
			await gone(code);
			await closed(code);
		},
	};
}

/** The spawner seam, wired to a fake child. */
function spawnerFor(child: unknown, record?: { args: string[]; cwd: string }[]): DashboardSpawner {
	return (args, cwd) => {
		record?.push({ args: [...args], cwd });
		return child as ReturnType<DashboardSpawner>;
	};
}

/** A real dist directory holding a real CLI entry, so `existsSync` passes. */
function distWithEntry(): string {
	const dir = mkdtempSync(join(tmpdir(), "jolli-dashboard-launcher-"));
	writeFileSync(join(dir, CLI_ENTRY_FILE), "");
	return dir;
}

/** A macrotask: guarantees every pending microtask has drained first. */
function flushMicrotasks(): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const URL_LINE = "  Jolli dashboard → http://127.0.0.1:1818/dashboard";
const URL = "http://127.0.0.1:1818/dashboard";

beforeEach(() => {
	logCalls.length = 0;
	spawnHiddenMock.mockReset();
	// The live-dashboard guard is module state, and several cases below leave a
	// child running — without this the next case would be treated as a repeat
	// click on the previous one's dashboard.
	__resetDashboardLaunchForTests();
});

describe("isRemoteWorkspace", () => {
	it("is true for any remote name and false only for undefined", () => {
		expect(isRemoteWorkspace("ssh-remote")).toBe(true);
		expect(isRemoteWorkspace("wsl")).toBe(true);
		expect(isRemoteWorkspace(undefined)).toBe(false);
	});
});

describe("URL_PATTERN", () => {
	it("finds the loopback URL in the command's own line", () => {
		expect(URL_PATTERN.exec(URL_LINE)?.[1]).toBe(URL);
	});

	it("matches the fallback port too — the port is not knowable in advance", () => {
		expect(URL_PATTERN.exec("  Jolli dashboard → http://127.0.0.1:18118/dashboard")?.[1]).toBe(
			"http://127.0.0.1:18118/dashboard",
		);
	});

	it("ignores lines that carry no loopback URL", () => {
		expect(URL_PATTERN.exec("  ✓ Migrated 3 memories.")).toBeNull();
		expect(URL_PATTERN.exec("  Port 1818 was in use")).toBeNull();
	});
});

describe("launchDashboard", () => {
	it("refuses a remote window with a hint instead of a local server", async () => {
		const { ui, calls } = fakeUi();
		const spawned: { args: string[]; cwd: string }[] = [];
		await launchDashboard({
			cwd: "/repo",
			distDir: "/dist",
			remoteName: "ssh-remote",
			ui,
			spawn: spawnerFor(fakeChild().child, spawned),
		});
		expect(spawned).toEqual([]);
		expect(calls.infos).toEqual([REMOTE_HINT]);
	});

	it("runs `dashboard --no-open` in the repo, and opens the URL itself", async () => {
		const { child, say } = fakeChild();
		const spawned: { args: string[]; cwd: string }[] = [];
		const { ui, calls } = fakeUi();
		const done = launchDashboard({ cwd: "/repo", distDir: "/dist", ui, spawn: spawnerFor(child, spawned) });
		await say(URL_LINE);
		await done;

		// `--no-open` is what stops the child launching a browser the editor did
		// not choose; the host opens it instead.
		expect(spawned).toEqual([{ args: ["dashboard", "--no-open", "--cwd", "/repo"], cwd: "/repo" }]);
		expect(calls.opened).toEqual([URL]);
	});

	it("ends the progress notification at the browser, not at the child's exit", async () => {
		// The child serves until stopped and its history import runs for minutes
		// behind the page, so a notification spanning it would read as a hang.
		const { child, say } = fakeChild();
		const { ui, calls } = fakeUi();
		const done = launchDashboard({ cwd: "/repo", distDir: "/dist", ui, spawn: spawnerFor(child) });
		expect(calls.progressEnded).toBe(false);
		await say(URL_LINE);
		await done;
		expect(calls.progressEnded).toBe(true);
		// Still running — the notification ended, the dashboard did not.
		expect(isDashboardRunning()).toBe(true);
	});

	it("drains the child's output into the log", async () => {
		const { child, say } = fakeChild();
		const { ui } = fakeUi();
		const done = launchDashboard({ cwd: "/repo", distDir: "/dist", ui, spawn: spawnerFor(child) });
		await say("  ✓ Migrated 3 memories.");
		await say(URL_LINE);
		await done;
		expect(logCalls.some((c) => c.message.includes("Migrated 3 memories"))).toBe(true);
	});

	it("reports a child that dies before it ever served", async () => {
		const { child, exit } = fakeChild();
		const { ui, calls } = fakeUi({ errorChoice: "Show Log" });
		const done = launchDashboard({ cwd: "/repo", distDir: "/dist", ui, spawn: spawnerFor(child) });
		await exit(1);
		await done;
		expect(calls.errors).toEqual([FAILURE_MESSAGE]);
		expect(calls.logRevealed).toBe(true);
		expect(isDashboardRunning()).toBe(false);
	});

	it("does not report a child that exits AFTER serving — that is a stop, not a failure", async () => {
		const { child, say, exit } = fakeChild();
		const { ui, calls } = fakeUi();
		const done = launchDashboard({ cwd: "/repo", distDir: "/dist", ui, spawn: spawnerFor(child) });
		await say(URL_LINE);
		await done;
		await exit(0);
		expect(calls.errors).toEqual([]);
		expect(isDashboardRunning()).toBe(false);
	});

	it("does not report a stop whose URL was still in the pipe when the child ended", async () => {
		// A dashboard stopped moments after it started serving: the process is gone
		// while the URL it printed is still in flight. Listening on `exit` read
		// `launch.url` at that instant, so a dashboard that HAD served was reported
		// as one that could not be started — a modal error for a stop the user
		// asked for. `close` is the event that waits for the pipe, and waiting is
		// the only thing that separates this from a child that never served.
		const { child, say, gone, closed } = fakeChild();
		const { ui, calls } = fakeUi({ errorChoice: "Show Log" });
		const done = launchDashboard({ cwd: "/repo", distDir: "/dist", ui, spawn: spawnerFor(child) });
		await gone(0);
		await say(URL_LINE);
		await closed(0);
		await done;
		expect(calls.errors).toEqual([]);
		expect(calls.opened).toEqual([URL]);
	});

	it("reports a failed spawn once, though both `error` and `close` fire for it", async () => {
		// A spawn that fails emits `error` and then `close`, with no `exit` between
		// them — so moving this listener to `close` put two modal errors on screen
		// for one click unless the report is guarded.
		const { child, exit } = fakeChild();
		const { ui, calls } = fakeUi();
		const done = launchDashboard({ cwd: "/repo", distDir: "/dist", ui, spawn: spawnerFor(child) });
		child.emit("error", new Error("ENOENT"));
		await flushMicrotasks();
		await exit(1);
		await done;
		expect(calls.errors).toEqual([FAILURE_MESSAGE]);
	});

	it("reports a spawn that throws", async () => {
		const { ui, calls } = fakeUi();
		await launchDashboard({
			cwd: "/repo",
			distDir: "/dist",
			ui,
			spawn: () => {
				throw new Error("entry not found");
			},
		});
		expect(calls.errors).toEqual([FAILURE_MESSAGE]);
		// No guard leaked, so the button still works next time.
		expect(isDashboardRunning()).toBe(false);
	});

	it("reports a process-level error", async () => {
		const { child } = fakeChild();
		const { ui, calls } = fakeUi();
		const done = launchDashboard({ cwd: "/repo", distDir: "/dist", ui, spawn: spawnerFor(child) });
		child.emit("error", new Error("ENOENT"));
		await flushMicrotasks();
		await done;
		expect(calls.errors).toEqual([FAILURE_MESSAGE]);
		expect(isDashboardRunning()).toBe(false);
	});

	it("a repeat click re-opens the URL instead of starting a second dashboard", async () => {
		const { child, say } = fakeChild();
		const spawned: { args: string[]; cwd: string }[] = [];
		const { ui, calls } = fakeUi();
		const done = launchDashboard({ cwd: "/repo", distDir: "/dist", ui, spawn: spawnerFor(child, spawned) });
		await say(URL_LINE);
		await done;

		await launchDashboard({ cwd: "/repo", distDir: "/dist", ui, spawn: spawnerFor(fakeChild().child, spawned) });
		// One spawn, two opens: a second child would bind a second port and run a
		// second import against the same database.
		expect(spawned).toHaveLength(1);
		expect(calls.opened).toEqual([URL, URL]);
	});

	it("a click that arrives before the URL shares the wait rather than spawning", async () => {
		const { child, say } = fakeChild();
		const spawned: { args: string[]; cwd: string }[] = [];
		const { ui, calls } = fakeUi();
		const first = launchDashboard({ cwd: "/repo", distDir: "/dist", ui, spawn: spawnerFor(child, spawned) });
		const second = launchDashboard({ cwd: "/repo", distDir: "/dist", ui, spawn: spawnerFor(fakeChild().child, spawned) });
		await say(URL_LINE);
		await Promise.all([first, second]);
		expect(spawned).toHaveLength(1);
		// The first launch's browser is what ends both notifications.
		expect(calls.opened).toEqual([URL]);
	});

	it("reports a refused browser without calling the launch a failure", async () => {
		const { child, say } = fakeChild();
		const { ui, calls } = fakeUi({
			overrides: {
				openExternal: async () => {
					throw new Error("no handler");
				},
			},
		});
		const done = launchDashboard({ cwd: "/repo", distDir: "/dist", ui, spawn: spawnerFor(child) });
		await say(URL_LINE);
		await done;
		await flushMicrotasks();
		// The dashboard IS up, so this is not FAILURE_MESSAGE...
		expect(calls.errors).toEqual([BROWSER_FAILURE_MESSAGE]);
		// ...and the spinner still ends, or a working dashboard would look hung.
		expect(calls.progressEnded).toBe(true);
		expect(isDashboardRunning()).toBe(true);
	});

	it("uses the default spawner when none is injected", async () => {
		const { child, say } = fakeChild();
		spawnHiddenMock.mockReturnValue(child);
		const { ui } = fakeUi();
		const dir = distWithEntry();
		const done = launchDashboard({ cwd: "/repo", distDir: dir, ui });
		await say(URL_LINE);
		await done;

		const [command, args, opts] = spawnHiddenMock.mock.calls[0] as [string, string[], Record<string, unknown>];
		expect(command).toBe(process.execPath);
		expect(args).toEqual([join(dir, CLI_ENTRY_FILE), "dashboard", "--no-open", "--cwd", "/repo"]);
		// Electron only runs a script as node with this set.
		expect((opts.env as Record<string, string>).ELECTRON_RUN_AS_NODE).toBe("1");
		// Piped, so the URL line is readable — and NOT detached/unref'd, so the
		// child cannot outlive the window that owns it.
		expect(opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
		expect(opts.detached).toBeUndefined();
	});

	it("PROGRESS_TITLE is what the notification shows", async () => {
		const { child, say } = fakeChild();
		const titles: string[] = [];
		const { ui } = fakeUi({
			overrides: {
				withProgress: async (title, task) => {
					titles.push(title);
					await task();
				},
			},
		});
		const done = launchDashboard({ cwd: "/repo", distDir: "/dist", ui, spawn: spawnerFor(child) });
		await say(URL_LINE);
		await done;
		expect(titles).toEqual([PROGRESS_TITLE]);
	});
});

describe("stopDashboard", () => {
	it("kills the running child and forgets it", async () => {
		const { child, say } = fakeChild();
		const { ui } = fakeUi();
		const done = launchDashboard({ cwd: "/repo", distDir: "/dist", ui, spawn: spawnerFor(child) });
		await say(URL_LINE);
		await done;

		stopDashboard();
		expect(child.kill).toHaveBeenCalledTimes(1);
		expect(isDashboardRunning()).toBe(false);
	});

	it("is a no-op when nothing is running", () => {
		expect(() => stopDashboard()).not.toThrow();
		expect(isDashboardRunning()).toBe(false);
	});

	it("does not kill a child that already exited", async () => {
		const { child, say, exit } = fakeChild();
		const { ui } = fakeUi();
		const done = launchDashboard({ cwd: "/repo", distDir: "/dist", ui, spawn: spawnerFor(child) });
		await say(URL_LINE);
		await done;
		await exit(0);

		stopDashboard();
		expect(child.kill).not.toHaveBeenCalled();
	});
});
