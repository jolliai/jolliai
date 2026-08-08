import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackfillProgress } from "../dashboard/Backfill.js";
import type { DashboardServerState } from "../dashboard/DashboardServer.js";
import { writeDashboardState } from "../dashboard/DashboardServer.js";
import type { RegisteredRepo } from "../dashboard/RepoRegistry.js";

vi.mock("../dashboard/Backfill.js", () => ({
	backfillRepos: vi.fn(async () => [{ mode: "bootstrapped", eventsApplied: 3 }]),
}));
// executeDashboard takes the daily backup snapshot (moved here off the
// read-only server); unmocked it would open the real machine database and
// write ~/jolli_back.
vi.mock("../dashboard/Backup.js", () => ({
	opportunisticSnapshot: vi.fn().mockResolvedValue({ status: "skipped", reason: "test" }),
}));
vi.mock("../dashboard/RepoRegistry.js", () => ({
	registerRepo: vi.fn(
		async (): Promise<RegisteredRepo> => ({
			repoIdentity: "r",
			repoName: "jolli",
			worktreeRoot: "/w",
			enabledAt: "t",
		}),
	),
	listActiveRepos: vi.fn(async () => []),
}));
vi.mock("../dashboard/DashboardDb.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../dashboard/DashboardDb.js")>();
	return { ...original, canUseDashboardDb: vi.fn(() => true) };
});

import { backfillRepos } from "../dashboard/Backfill.js";
import { opportunisticSnapshot } from "../dashboard/Backup.js";
import { canUseDashboardDb } from "../dashboard/DashboardDb.js";
import { listActiveRepos, registerRepo } from "../dashboard/RepoRegistry.js";
import {
	acquireSpawnLock,
	createDeferredWriter,
	createProgressPrinter,
	type DashboardDeps,
	ensureServerRunning,
	executeDashboard,
	importDashboardHistory,
	registerDashboardCommand,
	releaseSpawnLock,
} from "./DashboardCommand.js";

let configDir: string;

const state = (over: Partial<DashboardServerState> = {}): DashboardServerState => ({
	pid: process.pid,
	port: 1818,
	startedAt: "2026-07-30T00:00:00.000Z",
	schemaVersion: 1,
	...over,
});

function deps(over: Partial<DashboardDeps> = {}): DashboardDeps & {
	opened: string[];
	spawned: Array<{ port: number | undefined }>;
} {
	const opened: string[] = [];
	const spawned: Array<{ port: number | undefined }> = [];
	return {
		configDir,
		opened,
		spawned,
		openBrowser: async (url: string) => {
			opened.push(url);
		},
		spawnServer: (port) => {
			spawned.push({ port });
			// Simulate the child writing its state file once healthy.
			void writeDashboardState(state({ port: port ?? 1818 }), configDir);
		},
		fetchHealth: async () => ({ ok: true, pid: process.pid }),
		sleep: async () => {},
		...over,
	};
}

beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), "jolli-cmd-"));
	// clearMocks resets implementations between tests — re-arm the defaults here.
	vi.mocked(canUseDashboardDb).mockReturnValue(true);
	vi.mocked(registerRepo).mockResolvedValue({
		repoIdentity: "r",
		repoName: "jolli",
		worktreeRoot: "/w",
		enabledAt: "t",
	});
	vi.mocked(backfillRepos).mockResolvedValue([{ mode: "bootstrapped", eventsApplied: 3, repoName: "jolli" }]);
	vi.mocked(listActiveRepos).mockResolvedValue([]);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	process.exitCode = undefined;
});

afterEach(() => {
	rmSync(configDir, { recursive: true, force: true });
	process.exitCode = undefined;
});

describe("spawn lock", () => {
	it("is exclusive while the holder lives, and reclaimable when it dies", () => {
		expect(acquireSpawnLock(configDir)).toBe(true);
		// Same-pid holder counts as alive → a second take fails.
		expect(acquireSpawnLock(configDir)).toBe(false);
		releaseSpawnLock(configDir);
		expect(acquireSpawnLock(configDir)).toBe(true);
		releaseSpawnLock(configDir);
	});

	it("reclaims a lock whose holder is a dead pid", () => {
		writeFileSync(join(configDir, "dashboard-spawn.lock"), "999999999");
		expect(acquireSpawnLock(configDir)).toBe(true);
		// Reclaimed through the exclusive create, so the file now names us.
		expect(readFileSync(join(configDir, "dashboard-spawn.lock"), "utf-8")).toBe(String(process.pid));
		releaseSpawnLock(configDir);
	});

	it("reclaims a lock whose contents are unreadable garbage", () => {
		// A launcher killed mid-write must not wedge the dashboard forever.
		writeFileSync(join(configDir, "dashboard-spawn.lock"), "");
		expect(acquireSpawnLock(configDir)).toBe(true);
		releaseSpawnLock(configDir);
	});

	it("does not reclaim a stale lock a live holder already took over", () => {
		writeFileSync(join(configDir, "dashboard-spawn.lock"), "999999999");
		expect(acquireSpawnLock(configDir)).toBe(true);
		// The reclaimed lock is now held by a live pid, so a second reclaimer is
		// turned away instead of overwriting it — the double-spawn the blind
		// overwrite used to allow.
		expect(acquireSpawnLock(configDir)).toBe(false);
		releaseSpawnLock(configDir);
	});
});

describe("ensureServerRunning", () => {
	it("reuses a healthy recorded server without spawning", async () => {
		await writeDashboardState(state(), configDir);
		const d = deps();
		const result = await ensureServerRunning(undefined, d);
		expect(result.port).toBe(1818);
		expect(d.spawned).toEqual([]);
	});

	it("reuses a healthy server when --port names the port it is already on", async () => {
		await writeDashboardState(state({ port: 1818 }), configDir);
		const d = deps();
		expect((await ensureServerRunning(1818, d)).port).toBe(1818);
		expect(d.spawned).toEqual([]);
	});

	it("replaces the live server when --port names a different one", async () => {
		await writeDashboardState(state({ pid: 424242, port: 1818 }), configDir);
		const killed: number[] = [];
		const d = deps({
			fetchHealth: async () => ({ ok: true, pid: 424242 }),
			killPid: (pid) => {
				killed.push(pid);
				return true;
			},
		});
		const result = await ensureServerRunning(2000, d);
		// One server, on the requested port — not a second one beside the first,
		// which would leave whichever lost the dashboard.json race unreachable.
		expect(killed).toEqual([424242]);
		expect(d.spawned).toEqual([{ port: 2000 }]);
		expect(result.port).toBe(2000);
	});

	it("does not reuse a record whose port answers as a different process", async () => {
		await writeDashboardState(state({ pid: 424242 }), configDir);
		let calls = 0;
		const d = deps({
			// A foreign pid on our recorded port: the record is not ours to trust.
			fetchHealth: async () => (++calls > 1 ? { ok: true, pid: process.pid } : { ok: true, pid: 777 }),
		});
		await ensureServerRunning(undefined, d);
		expect(d.spawned).toHaveLength(1);
	});

	it("clears a stale record (dead server) and respawns", async () => {
		await writeDashboardState(state({ pid: 999999999 }), configDir);
		let calls = 0;
		const d = deps({
			fetchHealth: async () => ({ ok: ++calls > 1 }), // dead once, healthy after respawn
		});
		const result = await ensureServerRunning(undefined, d);
		expect(d.spawned).toHaveLength(1);
		expect(result.port).toBe(1818);
	});

	it("waits for a competing launcher instead of double-spawning", async () => {
		// Someone else holds the lock…
		expect(acquireSpawnLock(configDir)).toBe(true);
		const other = state({ port: 2222 });
		const d = deps({
			sleep: async () => {
				// …and their server comes up while we wait.
				await writeDashboardState(other, configDir);
			},
		});
		try {
			const result = await ensureServerRunning(undefined, d);
			expect(result.port).toBe(2222);
			expect(d.spawned).toEqual([]);
		} finally {
			releaseSpawnLock(configDir);
		}
	});

	it("times out with a clear error when the competitor never delivers", async () => {
		expect(acquireSpawnLock(configDir)).toBe(true);
		const d = deps({ fetchHealth: async () => ({ ok: false }) });
		try {
			await expect(ensureServerRunning(undefined, d)).rejects.toThrow(/never became healthy/);
		} finally {
			releaseSpawnLock(configDir);
		}
	});

	it("times out when its own spawn never becomes healthy", async () => {
		const d = deps({
			spawnServer: () => {},
			fetchHealth: async () => ({ ok: false }),
		});
		await expect(ensureServerRunning(undefined, d)).rejects.toThrow(/did not become healthy/);
		// The lock was released on the way out.
		expect(acquireSpawnLock(configDir)).toBe(true);
		releaseSpawnLock(configDir);
	});
});

describe("importDashboardHistory", () => {
	it("registers the repo and imports, without spawning a server or a browser", async () => {
		const d = deps();
		await importDashboardHistory("/w", d);
		expect(registerRepo).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/w" }));
		expect(backfillRepos).toHaveBeenCalledTimes(1);
		// The whole point of the split: enable must not bind a port or open a browser.
		expect(d.spawned).toEqual([]);
		expect(d.opened).toEqual([]);
	});

	it("stays silent below the node:sqlite floor", async () => {
		vi.mocked(canUseDashboardDb).mockReturnValueOnce(false);
		await importDashboardHistory("/w", deps());
		expect(registerRepo).not.toHaveBeenCalled();
		expect(backfillRepos).not.toHaveBeenCalled();
	});

	it("imports anyway when the cwd is not a repo", async () => {
		vi.mocked(registerRepo).mockRejectedValueOnce(new Error("not a git repo"));
		await importDashboardHistory("/w", deps());
		expect(backfillRepos).toHaveBeenCalledTimes(1);
	});

	it("never throws when the import fails", async () => {
		vi.mocked(backfillRepos).mockRejectedValueOnce(new Error("db locked"));
		await expect(importDashboardHistory("/w", deps())).resolves.toBeUndefined();
	});
});

describe("executeDashboard", () => {
	it("refuses below the node:sqlite floor", async () => {
		vi.mocked(canUseDashboardDb).mockReturnValueOnce(false);
		await expect(executeDashboard("stats", {}, deps())).resolves.toBe(false);
	});

	it("rejects an invalid --port", async () => {
		await expect(executeDashboard("stats", { port: "not-a-port" }, deps())).resolves.toBe(false);
	});

	it("registers the repo, ensures the server, opens the plain page URL, then backfills", async () => {
		const d = deps();
		await executeDashboard("standup", { cwd: "/w" }, d);
		expect(registerRepo).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/w" }));
		expect(d.spawned).toHaveLength(1);
		expect(d.opened).toHaveLength(1);
		// No `?t=` — the URL is hand-openable, which is why the token was dropped.
		expect(d.opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/dashboard\/standup$/);
		expect(backfillRepos).toHaveBeenCalledTimes(1);
	});

	it("takes the daily snapshot here, not in the read-only server process", async () => {
		// The trigger used to live in `startDashboardServer`, where it opened a
		// WRITABLE handle (and so could run schema migrations) from the one
		// long-lived process whose build can lag behind the launcher's.
		const d = deps();
		await executeDashboard("stats", {}, d);
		expect(opportunisticSnapshot).toHaveBeenCalledTimes(1);
	});

	it("continues when the cwd is not a repo (dashboard still opens)", async () => {
		vi.mocked(registerRepo).mockRejectedValueOnce(new Error("not a git repo"));
		const d = deps();
		await executeDashboard("stats", {}, d);
		expect(d.opened).toHaveLength(1);
	});

	it("honours --no-open", async () => {
		const d = deps();
		await executeDashboard("stats", { open: false }, d);
		expect(d.opened).toEqual([]);
	});

	it("a browser failure is non-fatal", async () => {
		const d = deps({
			openBrowser: async () => {
				throw new Error("no display");
			},
		});
		await expect(executeDashboard("stats", {}, d)).resolves.toBe(true);
	});

	it("a backfill failure warns but does not fail the command", async () => {
		vi.mocked(backfillRepos).mockRejectedValueOnce(new Error("db locked"));
		await expect(executeDashboard("stats", {}, deps())).resolves.toBe(true);
	});

	it("reports a server that cannot start", async () => {
		const d = deps({ spawnServer: () => {}, fetchHealth: async () => ({ ok: false }) });
		await expect(executeDashboard("stats", {}, d)).resolves.toBe(false);
	});

	it("--stop kills the recorded pid and clears state; a second --stop reports not running", async () => {
		await writeDashboardState(state({ pid: 424242 }), configDir);
		const killed: number[] = [];
		const d = deps({
			// /health confirms the recorded pid is still the server on that port.
			fetchHealth: async () => ({ ok: true, pid: 424242 }),
			killPid: (pid) => {
				killed.push(pid);
				return true;
			},
		});
		await executeDashboard("stats", { stop: true }, d);
		expect(killed).toEqual([424242]);
		await executeDashboard("stats", { stop: true }, d); // state cleared → "not running"
		expect(killed).toEqual([424242]);
	});

	it("--stop copes with a pid that already exited", async () => {
		await writeDashboardState(state({ pid: 424242 }), configDir);
		const d = deps({ fetchHealth: async () => ({ ok: true, pid: 424242 }), killPid: () => false });
		await expect(executeDashboard("stats", { stop: true }, d)).resolves.toBe(true);
	});

	it("--stop never signals a pid /health cannot confirm", async () => {
		// The recorded server is gone and the OS may have handed 424242 to anything.
		await writeDashboardState(state({ pid: 424242 }), configDir);
		const killed: number[] = [];
		const d = deps({
			fetchHealth: async () => ({ ok: false }),
			killPid: (pid) => {
				killed.push(pid);
				return true;
			},
		});
		await expect(executeDashboard("stats", { stop: true }, d)).resolves.toBe(true);
		expect(killed).toEqual([]);
		// The stale record is still cleared — there is nothing of ours to stop.
		expect(existsSync(join(configDir, "dashboard.json"))).toBe(false);
	});

	it("--stop never signals when the port answers as a different process", async () => {
		await writeDashboardState(state({ pid: 424242 }), configDir);
		const killed: number[] = [];
		const d = deps({
			// Something is listening there, but it is not the pid we recorded.
			fetchHealth: async () => ({ ok: true, pid: 777 }),
			killPid: (pid) => {
				killed.push(pid);
				return true;
			},
		});
		await executeDashboard("stats", { stop: true }, d);
		expect(killed).toEqual([]);
	});
});

describe("registerDashboardCommand", () => {
	it("registers dashboard alone, with its flags", () => {
		const program = new Command();
		registerDashboardCommand(program);
		const names = program.commands.map((c) => c.name());
		expect(names).toEqual(["dashboard"]);
		// The retired page aliases must not come back as command names. Both
		// pages are still served, at `/dashboard` and `/dashboard/standup`.
		expect(names).not.toContain("stats");
		expect(names).not.toContain("standup");
		const dashboard = program.commands.find((c) => c.name() === "dashboard");
		const flags = dashboard?.options.map((o) => o.long);
		expect(flags).toEqual(expect.arrayContaining(["--port", "--no-open", "--stop", "--cwd"]));
	});

	it("turns an executeDashboard failure into exit code 1 (soft callers like enable see only the boolean)", async () => {
		// canUseDashboardDb=false makes executeDashboard bail before touching any
		// default dep (no real spawn/fetch/browser), so driving the real action
		// through commander is safe here.
		vi.mocked(canUseDashboardDb).mockReturnValue(false);
		const program = new Command();
		registerDashboardCommand(program);
		await program.parseAsync(["node", "jolli", "dashboard", "--no-open"]);
		expect(process.exitCode).toBe(1);
	});
});

describe("createProgressPrinter", () => {
	const event = (over: Partial<BackfillProgress>): BackfillProgress => ({
		repoName: "jolliai",
		kind: "memories",
		done: 1,
		total: 3_214,
		repoIndex: 1,
		repoTotal: 1,
		...over,
	});

	/** Drives `done` from 1..total, returning every line the printer emitted. */
	function drive(total: number, over: Partial<BackfillProgress> = {}, from = 1): string[] {
		const lines: string[] = [];
		const printer = createProgressPrinter({ log: (line) => lines.push(line) });
		for (let done = from; done <= total; done++) printer.onProgress(event({ done, total, ...over }));
		return lines;
	}

	it("prints one line per quarter, never a line per memory", () => {
		const lines = drive(3_214);
		expect(lines).toEqual(["  804/3214 memories…", "  1607/3214 memories…", "  2411/3214 memories…"]);
	});

	it("omits the patience note when there is no git scan to wait for", () => {
		// The steady-state path: `commitsUnchanged` skips the scan, so no `commits`
		// marker is ever emitted and the whole run takes seconds.
		const lines: string[] = [];
		const printer = createProgressPrinter({ log: (line) => lines.push(line) });
		printer.onProgress(event({ kind: "summaries", done: 0, total: undefined }));
		printer.onProgress(event({ kind: "sessions", done: 0, total: undefined }));
		expect(lines).toEqual(["  Indexing stored memories…", "  Reading AI sessions…"]);
	});

	it("stays silent on a repo small enough that the run is over before it reads", () => {
		expect(drive(150)).toEqual([]);
	});

	it("says so once when a run picked up a cursor", () => {
		// Resuming past the halfway mark: the two quarters this run never reached
		// must not be reprinted as if it had.
		const lines = drive(3_214, {}, 1_700);
		expect(lines[0]).toBe("  Resuming from 1700/3214…");
		expect(lines.slice(1)).toEqual(["  2411/3214 memories…"]);
	});

	it("falls back to a plain count when there is no denominator", () => {
		const lines: string[] = [];
		const printer = createProgressPrinter({ log: (line) => lines.push(line) });
		for (let done = 1; done <= 1_200; done++) printer.onProgress({ ...event({ done }), total: undefined });
		expect(lines).toEqual(["  500 memories…", "  1000 memories…"]);
	});

	it("names each repo only when there is more than one", () => {
		expect(drive(400, { repoTotal: 1 }).some((l) => l.includes("jolliai ("))).toBe(false);
		const multi = drive(400, { repoIndex: 2, repoTotal: 5 });
		expect(multi[0]).toBe("  jolliai (2/5)");
	});

	it("labels each slow scan before it runs, and counts the commit sweep", () => {
		// The scans are where the wall clock actually goes — measured 11-20 s per
		// checkout against ~3 s for the migration they precede — so each is named
		// as it STARTS. The commit sweep also gets numbers: two totals on screen
		// ("4000 commits" above "434 memories") is not a contradiction to explain
		// away, it is the true fact that most commits have no memory, and a
		// motionless minute is the worse problem.
		const lines: string[] = [];
		const printer = createProgressPrinter({ log: (line) => lines.push(line) });
		printer.onProgress(event({ kind: "commits", done: 0, total: undefined }));
		for (let done = 200; done <= 4_000; done += 200)
			printer.onProgress(event({ kind: "commits", done, total: 4_000 }));
		printer.onProgress(event({ kind: "summaries", done: 0, total: undefined }));
		printer.onProgress(event({ kind: "sessions", done: 0, total: undefined }));
		printer.onProgress(event({ kind: "sessions", done: 5, total: 5 }));
		expect(lines).toEqual([
			// The patience note rides with the git scan, not with the command: a
			// steady-state re-run skips that scan entirely and finishes in ~10 s
			// (measured), where "this can take a few minutes" was simply false.
			"  Scanning your whole history — this can take a few minutes.",
			"  Interrupting is safe: progress is saved and the next run resumes.",
			"  Scanning git history…",
			"    1000/4000 commits",
			"    2000/4000 commits",
			"    3000/4000 commits",
			// The LAST quarter prints, unlike the memory counter: a silent prune
			// follows it, and suppressing this line left a 15 s gap.
			"    4000/4000 commits",
			"  Indexing stored memories…",
			"  Reading AI sessions…",
		]);
	});

	it("names each checkout separately, because each pays its own git scan", () => {
		const lines: string[] = [];
		const printer = createProgressPrinter({ log: (line) => lines.push(line) });
		printer.onProgress(event({ kind: "commits", done: 0, total: undefined, detail: "checkout 1 of 2" }));
		printer.onProgress(event({ kind: "commits", done: 0, total: undefined, detail: "checkout 2 of 2" }));
		expect(lines.filter((l) => l.includes("checkout"))).toEqual([
			"  Scanning git history… (checkout 1 of 2)",
			"  Scanning git history… (checkout 2 of 2)",
		]);
	});

	it("re-labels the scans for each repo, under that repo's heading", () => {
		const lines: string[] = [];
		const printer = createProgressPrinter({ log: (line) => lines.push(line) });
		for (const [repoName, repoIndex] of [
			["jolli", 1],
			["jolliai", 2],
		] as const) {
			printer.onProgress(
				event({ repoName, repoIndex, repoTotal: 2, kind: "commits", done: 0, total: undefined }),
			);
			printer.onProgress(
				event({ repoName, repoIndex, repoTotal: 2, kind: "sessions", done: 0, total: undefined }),
			);
		}
		// The patience note is once per RUN, not once per repo — it is advice
		// about the command, and repeating it for the second repo would read as
		// a fresh warning rather than a continuation.
		expect(lines.filter((l) => !l.includes("Interrupting") && !l.includes("can take a few minutes"))).toEqual([
			"  jolli (1/2)",
			"  Scanning git history…",
			"  Reading AI sessions…",
			"  jolliai (2/2)",
			"  Scanning git history…",
			"  Reading AI sessions…",
		]);
		expect(lines.filter((l) => l.includes("can take a few minutes"))).toHaveLength(1);
	});
});

describe("createDeferredWriter", () => {
	it("holds every line until something reveals it, then prints in order", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const out = createDeferredWriter();
		out.write("  first");
		out.write("  second");
		expect(log).not.toHaveBeenCalled();

		out.reveal();

		expect(log.mock.calls.map((c) => c[0])).toEqual(["  first", "  second"]);
		// Past the reveal it is a plain writer — later lines land after the held ones.
		out.write("  third");
		expect(log.mock.calls.map((c) => c[0])).toEqual(["  first", "  second", "  third"]);
	});

	it("drops what was never revealed, and reveals only once", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const out = createDeferredWriter();
		out.write("  held");
		out.reveal();
		out.reveal(); // idempotent: not a second copy of the held line
		expect(log.mock.calls.map((c) => c[0])).toEqual(["  held"]);

		// A writer nobody reveals prints nothing at all — the steady-state pass.
		const log2 = vi.spyOn(console, "log").mockImplementation(() => {});
		log2.mockClear();
		const quiet = createDeferredWriter();
		quiet.write("  never shown");
		expect(log2).not.toHaveBeenCalled();
	});
});
