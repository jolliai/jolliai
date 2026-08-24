import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartedDashboardServer } from "../dashboard/DashboardServer.js";
import type { DbBackfillProgress, DbBackfillResult } from "../dashboard/DbBackfill.js";
import type { RegisteredRepo } from "../dashboard/RepoRegistry.js";

vi.mock("../dashboard/DbBackfill.js", () => ({
	dbBackfillRepos: vi.fn(async () => [{ mode: "bootstrapped", eventsApplied: 3 }]),
}));
// executeDashboard takes the daily backup snapshot (moved here off the
// read-only server); unmocked it would open the real machine database and
// write ~/jolli_back.
vi.mock("../dashboard/Backup.js", () => ({
	opportunisticSnapshot: vi.fn().mockResolvedValue({ status: "skipped", reason: "test" }),
}));
// The launcher ends with an auto-cutover attempt. Unmocked it would run against
// the REAL repo this suite executes in (several tests pass no `cwd`, so it falls
// back to `process.cwd()`): reading its profile, stamping an attempt into it, and
// possibly running a cutover CAS against a throwaway test database.
vi.mock("../dashboard/AutoCutover.js", () => ({
	autoCutoverAllRepos: vi.fn().mockResolvedValue([]),
}));
// The history import prunes fixture entries before it reads the registry.
// Mocked because the real one is a registry read plus `existsSync` over whatever
// paths the developer's own machine has, and because a swallowed failure there
// would otherwise make this wiring untestable — `pruneDisposableRepos` never
// throws by contract.
vi.mock("../dashboard/RepoForget.js", () => ({
	pruneDisposableRepos: vi.fn(async () => []),
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
	// The roster, not `listActiveRepos`: the import hands `dbBackfillRepos` every
	// registered repo, because that is the only caller that projects a switched-off
	// repo's paused state into the database.
	readRepoRegistry: vi.fn(async () => ({ version: 1, repos: [] as RegisteredRepo[] })),
}));
vi.mock("../dashboard/DashboardDb.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../dashboard/DashboardDb.js")>();
	return { ...original, canUseDashboardDb: vi.fn(() => true) };
});
// The launcher asks whether THIS repo is disabled before writing anything to it.
// Unmocked that reads the real repo this suite runs in (several cases pass no
// `cwd`), so the answer would depend on the developer's own machine. Partial, so
// everything else RepoProfile exports keeps working for unmocked consumers.
vi.mock("../core/RepoProfile.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../core/RepoProfile.js")>();
	return { ...original, readManualDisableFlagSync: vi.fn(() => false) };
});

import { readManualDisableFlagSync } from "../core/RepoProfile.js";
import { autoCutoverAllRepos } from "../dashboard/AutoCutover.js";
import { opportunisticSnapshot } from "../dashboard/Backup.js";
import { canUseDashboardDb } from "../dashboard/DashboardDb.js";
import { DASHBOARD_HEALTH_SERVICE } from "../dashboard/DashboardServer.js";
import { dbBackfillRepos, type SessionTierSummary } from "../dashboard/DbBackfill.js";
import { pruneDisposableRepos } from "../dashboard/RepoForget.js";
import { readRepoRegistry, registerRepo } from "../dashboard/RepoRegistry.js";
import {
	createDeferredWriter,
	createProgressPrinter,
	type DashboardDeps,
	executeDashboard,
	identifyDashboardHealth,
	importDashboardHistory,
	printSessionSummary,
	registerDashboardCommand,
	resolveServerCwd,
	startForegroundDashboard,
} from "./DashboardCommand.js";

let configDir: string;

/**
 * Every seam that would bind a socket, open a browser or park on a signal.
 *
 * `waitForShutdown` resolving immediately is what keeps this suite finite:
 * `executeDashboard` awaits it last and, in production, does not return until
 * the user presses Ctrl+C. A test that forgets it does not fail — it hangs.
 */
function deps(over: Partial<DashboardDeps> = {}): DashboardDeps & {
	opened: string[];
	started: Array<{ port: number | undefined; serverCwd: string | undefined }>;
	probed: number[];
	killed: number[];
	waited: number;
	telemetryStops: number;
} {
	const opened: string[] = [];
	const started: Array<{ port: number | undefined; serverCwd: string | undefined }> = [];
	const probed: number[] = [];
	const killed: number[] = [];
	const box = { waited: 0, telemetryStops: 0 };
	// A VIRTUAL clock the fake `sleep` drives, paired with `now` below. The
	// reclaim's release wait is bounded in wall-clock time (see `reclaimPort`), so
	// a no-op `sleep` against a real `Date.now` would make the "will not let go"
	// case spin on the probe for two real seconds. Advancing the clock by exactly
	// what was slept makes that budget deterministic and instant instead.
	let clock = 0;
	return {
		configDir,
		opened,
		started,
		probed,
		killed,
		get waited() {
			return box.waited;
		},
		get telemetryStops() {
			return box.telemetryStops;
		},
		// Nothing on the port by default, so the reclaim step is a no-op unless a
		// case says otherwise.
		probeHealth: async (port: number) => {
			probed.push(port);
			return null;
		},
		killPid: (pid: number) => {
			killed.push(pid);
			return true;
		},
		sleep: async (ms: number) => {
			clock += ms;
		},
		now: () => clock,
		openBrowser: async (url: string) => {
			opened.push(url);
		},
		startServer: async (options): Promise<StartedDashboardServer> => {
			started.push({ port: options.port, serverCwd: options.serverCwd });
			return {
				server: { closeAllConnections: () => {}, close: () => {} } as unknown as Server,
				port: options.port ?? 1818,
				fellBack: false,
			};
		},
		startTelemetry: async () => ({
			stop: async () => {
				box.telemetryStops += 1;
			},
		}),
		waitForShutdown: async () => {
			box.waited += 1;
		},
		...over,
	};
}

/** Arms the machine roster the import sweeps. */
function registered(repos: RegisteredRepo[]): void {
	vi.mocked(readRepoRegistry).mockResolvedValue({ version: 1, repos });
}

beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), "jolli-cmd-"));
	// This suite's call-count assertions (e.g. opportunisticSnapshot toHaveBeenCalledTimes(1))
	// depend on cleared call state between tests. That comes from `clearMocks: true` in the
	// cli vitest config — but there is no root config, so running from the repo root rather
	// than the cli workspace leaks earlier tests' calls and the counts explode. Clear here so
	// the suite is correct under any runner (idempotent when clearMocks is already in effect).
	vi.clearAllMocks();
	// clearMocks resets implementations between tests — re-arm the defaults here.
	vi.mocked(canUseDashboardDb).mockReturnValue(true);
	vi.mocked(registerRepo).mockResolvedValue({
		repoIdentity: "r",
		repoName: "jolli",
		worktreeRoot: "/w",
		enabledAt: "t",
	});
	vi.mocked(dbBackfillRepos).mockResolvedValue([{ mode: "bootstrapped", eventsApplied: 3, repoName: "jolli" }]);
	vi.mocked(readRepoRegistry).mockResolvedValue({ version: 1, repos: [] });
	vi.mocked(pruneDisposableRepos).mockResolvedValue([]);
	// Enabled unless a case says otherwise. Re-armed here for the same reason as
	// the others: `clearMocks` drops the factory's implementation.
	vi.mocked(readManualDisableFlagSync).mockReturnValue(false);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	process.exitCode = undefined;
});

afterEach(() => {
	rmSync(configDir, { recursive: true, force: true });
	process.exitCode = undefined;
});

describe("importDashboardHistory — the disabled repo", () => {
	it("does not re-register a repo the user disabled", async () => {
		// The registry stores no disable state, so registering means only "this repo
		// is on the machine's roster" — and a background import is no reason to put
		// a repo the user switched off back onto it. Reachable whenever the flag is
		// set while the hooks survive — an uninstall that failed after the flag was
		// persisted, which is the order `uninstall` documents — and the front door
		// reaches this on a bare `jolli`.
		vi.mocked(readManualDisableFlagSync).mockReturnValueOnce(true);
		await importDashboardHistory("/w", deps());
		expect(registerRepo).not.toHaveBeenCalled();
	});

	it("STILL runs the cutover sweep when this repo is disabled", async () => {
		// The gate covers registration and nothing else. The sweep is machine-scoped
		// and asks each repo's own profile for itself, so hoisting the decision to
		// `cwd` would let one switched-off repository cancel the cutover for every
		// other repo on the machine — the whole point of making the sweep plural.
		vi.mocked(readManualDisableFlagSync).mockReturnValueOnce(true);
		await importDashboardHistory("/w", deps());
		expect(autoCutoverAllRepos).toHaveBeenCalledTimes(1);
	});

	it("still sweeps every registered repo when this one is disabled", async () => {
		// The import is machine-scoped — it walks the registry, not `cwd` — so one
		// repo's opt-out must not stop the others being brought up to date.
		vi.mocked(readManualDisableFlagSync).mockReturnValueOnce(true);
		await importDashboardHistory("/w", deps());
		expect(dbBackfillRepos).toHaveBeenCalledTimes(1);
	});

	it("says why the repo was left out", async () => {
		vi.mocked(readManualDisableFlagSync).mockReturnValueOnce(true);
		await importDashboardHistory("/w", deps());
		expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain("disabled here");
	});
});

describe("importDashboardHistory — the fixture prune", () => {
	const forgotten = (identity: string) => ({
		identity,
		removedFromRegistry: true,
		repoRowDeleted: true,
		childRowsDeleted: 0,
		pendingEventsDeleted: 0,
	});

	it("prunes before reading the registry, so a fixture is not imported on its way out", async () => {
		const order: string[] = [];
		vi.mocked(pruneDisposableRepos).mockImplementation(async () => {
			order.push("prune");
			return [];
		});
		vi.mocked(readRepoRegistry).mockImplementation(async () => {
			order.push("read");
			return { version: 1, repos: [] };
		});

		await importDashboardHistory("/w", deps());

		expect(order).toEqual(["prune", "read"]);
	});

	it("says on screen how many entries it removed", async () => {
		// `log.info` alone is not enough: it is suppressed from the terminal in CLI
		// mode, and these removals are irreversible.
		vi.mocked(pruneDisposableRepos).mockResolvedValue([forgotten("local:a"), forgotten("local:b")]);

		await importDashboardHistory("/w", deps());

		const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
		expect(printed).toContain("Removed 2 temporary-checkout entries");
	});

	it("says nothing when there was nothing to remove", async () => {
		await importDashboardHistory("/w", deps());
		const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
		expect(printed).not.toContain("temporary-checkout");
	});

	it("uses the singular for one entry", async () => {
		vi.mocked(pruneDisposableRepos).mockResolvedValue([forgotten("local:a")]);
		await importDashboardHistory("/w", deps());
		const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
		expect(printed).toContain("Removed 1 temporary-checkout entry");
	});

	it("counts only the entries that were actually removed", async () => {
		// `pruneDisposableRepos` reports one result per VICTIM, failures included: a
		// repo whose rows a locked database kept comes back with `error` set and its
		// registry entry still in place. Counting the array claimed a removal for it.
		vi.mocked(pruneDisposableRepos).mockResolvedValue([
			forgotten("local:a"),
			{ ...forgotten("local:b"), removedFromRegistry: false, repoRowDeleted: false, error: "database is locked" },
		]);

		await importDashboardHistory("/w", deps());

		const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
		expect(printed).toContain("Removed 1 temporary-checkout entry");
		expect(printed).not.toContain("Removed 2");
		// And the failure is reported rather than netted off — silence would read as
		// "there was nothing to prune".
		expect(printed).toContain("1 temporary-checkout entry could not be removed");
	});

	it("reports a prune that removed nothing at all", async () => {
		vi.mocked(pruneDisposableRepos).mockResolvedValue([
			{ ...forgotten("local:a"), removedFromRegistry: false, repoRowDeleted: false, error: "database is locked" },
			{ ...forgotten("local:b"), removedFromRegistry: false, repoRowDeleted: false, error: "database is locked" },
		]);

		await importDashboardHistory("/w", deps());

		const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
		expect(printed).not.toContain("Removed");
		expect(printed).toContain("2 temporary-checkout entries could not be removed");
	});
});

describe("no foreground caller throttles the cutover", () => {
	// The throttle is a FAILURE backoff — a repo that cut over short-circuits
	// ahead of it — so on a typed command the only thing it can suppress is the
	// user's own retry. Both of these used to pass one, and `jolli dashboard`
	// silently skipping the attempt is what sent a real user to `jolli cutover`.
	// It is now the TYPE that guarantees this: `AutoCutoverSweepOptions` has no
	// `throttle` field at all, so a foreground caller cannot ask for one even by
	// mistake. These two assert the weaker thing a test still can — that no key
	// smuggling a backoff reaches the sweep — and exist mainly to fail loudly if
	// someone re-adds the option to the interface.
	it("does not on the import path — `jolli enable` and the front door", async () => {
		await importDashboardHistory("/w", deps());
		const [opts] = vi.mocked(autoCutoverAllRepos).mock.calls[0] ?? [];
		expect(Object.keys(opts ?? {})).not.toContain("throttle");
	});

	it("does not on `jolli dashboard`, which is where it was measured", async () => {
		await executeDashboard("stats", {}, deps());
		const [opts] = vi.mocked(autoCutoverAllRepos).mock.calls[0] ?? [];
		expect(Object.keys(opts ?? {})).not.toContain("throttle");
	});

	it("hands the sweep `cwd` to try first", async () => {
		// Ordering only — the sweep covers the whole roster either way. The user is
		// standing in this repo, so an interrupted pass has already tried the one
		// they were most likely waiting on.
		await importDashboardHistory("/w", deps());
		expect(autoCutoverAllRepos).toHaveBeenCalledWith(expect.objectContaining({ preferFirst: "/w" }));
	});
});

/**
 * The attempt is a silent tens-of-seconds step at the very end of both commands,
 * and in `jolli dashboard` it runs after a banner that says "Press Ctrl+C to
 * stop". Interrupting it costs the two-hour throttle slot as well as the attempt,
 * so the announcement is the whole mitigation — and it has to be tied to work
 * ACTUALLY starting, or it becomes a line on every run that nobody reads.
 */
describe("the cutover sweep is announced", () => {
	type SweepEntry = Awaited<ReturnType<typeof autoCutoverAllRepos>>[number];

	/** A sweep in which each named repo really begins an attempt and lands in `state`. */
	function sweepOf(...entries: Array<{ repoName: string; state: SweepEntry["state"] }>): void {
		vi.mocked(autoCutoverAllRepos).mockImplementation(async (opts) => {
			for (const e of entries) opts?.onAttemptStart?.(e.repoName);
			return entries.map((e) => ({
				repoName: e.repoName,
				root: `/${e.repoName}`,
				state: e.state,
				attempted: true,
			}));
		});
	}

	const printed = (): string => vi.mocked(console.log).mock.calls.flat().join("\n");

	it("warns not to interrupt, before the wait rather than after it", async () => {
		sweepOf({ repoName: "jolliai", state: "cutover" });
		await importDashboardHistory("/w", deps());
		expect(printed()).toContain("Leave it running");
	});

	it("warns ONCE however many repos it attempts", async () => {
		// The heading is per sweep, not per repo — N copies of a two-line banner is
		// how a warning becomes something the user scrolls past.
		sweepOf(
			{ repoName: "one", state: "cutover" },
			{ repoName: "two", state: "cutover" },
			{ repoName: "three", state: "uncutover" },
		);
		await importDashboardHistory("/w", deps());
		expect(printed().match(/Leave it running/g)).toHaveLength(1);
	});

	it("names each repo and its outcome", async () => {
		sweepOf({ repoName: "one", state: "cutover" }, { repoName: "two", state: "uncutover" });
		await importDashboardHistory("/w", deps());
		expect(printed()).toContain("one — now served from SQLite");
		expect(printed()).toContain("two — not switched this time");
	});

	it("gives the restart advice once, and only when something moved", async () => {
		sweepOf({ repoName: "one", state: "cutover" }, { repoName: "two", state: "cutover" });
		await importDashboardHistory("/w", deps());
		expect(printed().match(/Restart IDEs/g)).toHaveLength(1);
	});

	it("says a sweep that switched nothing is not a failure, and where to look", async () => {
		// The case most likely to read as broken: the user waited and has nothing on
		// screen to show for it.
		sweepOf({ repoName: "one", state: "uncutover" });
		await importDashboardHistory("/w", deps());
		expect(printed()).not.toContain("Restart IDEs");
		expect(printed()).toContain("Nothing switched this time");
		expect(printed()).toContain("jolli cutover --status");
	});

	it("stays silent when no repo began an attempt", async () => {
		// The common case on a settled machine: every repo short-circuits on its
		// route. This is why the heading hangs off `onAttemptStart` rather than being
		// printed before the call.
		vi.mocked(autoCutoverAllRepos).mockResolvedValue([
			{ repoName: "one", root: "/one", state: "cutover", attempted: false },
		]);
		await importDashboardHistory("/w", deps());
		expect(printed()).not.toContain("Leave it running");
		expect(printed()).not.toContain("Restart IDEs");
		expect(printed()).not.toContain("Nothing switched this time");
	});

	it("announces on the dashboard too — the caller that invited the Ctrl+C", async () => {
		sweepOf({ repoName: "jolliai", state: "cutover" });
		await executeDashboard("stats", {}, deps());
		expect(printed()).toContain("Leave it running");
	});

	/**
	 * A repo the engine has refused on grounds no retry can change is the one
	 * "nothing happened" that the user has to act on, and this is the only place
	 * it surfaces: the closing line says "nothing switched this time" (which a
	 * healthy repo also gets) and `--status` says `uncutover` (which every
	 * not-yet-swept repo says).
	 */
	describe("a blocked repo", () => {
		const BLOCKED: SweepEntry = {
			repoName: "stuck",
			root: "/stuck",
			state: "skipped",
			attempted: false,
			blocked: {
				code: "no-summary-rows",
				reason: "the import stored no memories from /stuck although its orphan tip lists some",
				witness: "1.0.0|/stuck@abc",
				at: 1_770_000_000_000,
			},
		};

		it("is named with its reason and a repair, even though nothing was attempted", async () => {
			vi.mocked(autoCutoverAllRepos).mockResolvedValue([BLOCKED]);
			await importDashboardHistory("/w", deps());
			expect(printed()).toContain("stuck — cannot switch to SQLite");
			expect(printed()).toContain("stored no memories");
			expect(printed()).toContain("jolli doctor");
			// Not dressed up as work in progress: nothing ran, so the wait banner and
			// the per-attempt outcome lines must stay away.
			expect(printed()).not.toContain("Leave it running");
			expect(printed()).not.toContain("not switched this time");
		});

		it("is reported alongside the repos that did move", async () => {
			// One blocked repo must not swallow the sweep's normal report, and a repo
			// that switched must not swallow the warning.
			vi.mocked(autoCutoverAllRepos).mockImplementation(async (opts) => {
				opts?.onAttemptStart?.("healthy");
				return [BLOCKED, { repoName: "healthy", root: "/healthy", state: "cutover", attempted: true }];
			});
			await importDashboardHistory("/w", deps());
			expect(printed()).toContain("stuck — cannot switch to SQLite");
			expect(printed()).toContain("healthy — now served from SQLite");
			expect(printed()).toContain("Restart IDEs");
		});
	});
});

describe("importDashboardHistory", () => {
	it("registers the repo and imports, without spawning a server or a browser", async () => {
		const d = deps();
		await importDashboardHistory("/w", d);
		expect(registerRepo).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/w" }));
		expect(dbBackfillRepos).toHaveBeenCalledTimes(1);
		// The whole point of the split: enable must not bind a port or open a browser.
		expect(d.started).toEqual([]);
		expect(d.opened).toEqual([]);
	});

	it("stays silent below the node:sqlite floor", async () => {
		vi.mocked(canUseDashboardDb).mockReturnValueOnce(false);
		await importDashboardHistory("/w", deps());
		expect(registerRepo).not.toHaveBeenCalled();
		expect(dbBackfillRepos).not.toHaveBeenCalled();
	});

	it("imports anyway when the cwd is not a repo", async () => {
		vi.mocked(registerRepo).mockRejectedValueOnce(new Error("not a git repo"));
		await importDashboardHistory("/w", deps());
		expect(dbBackfillRepos).toHaveBeenCalledTimes(1);
	});

	it("never throws when the import fails", async () => {
		vi.mocked(dbBackfillRepos).mockRejectedValueOnce(new Error("db locked"));
		await expect(importDashboardHistory("/w", deps())).resolves.toBeUndefined();
	});

	it("says nothing when every registered repo was skipped as dead", async () => {
		// A repo whose every recorded worktree is gone is dropped before the sweep
		// and returns no result, so there is nothing this report may claim about it.
		// Counting the registry instead printed "✓ All 0 memories already migrated."
		registered([{ repoIdentity: "r", repoName: "jolli", worktreeRoot: "/gone", enabledAt: "t" }]);
		vi.mocked(dbBackfillRepos).mockResolvedValue([]);
		await importDashboardHistory("/w", deps());
		expect(vi.mocked(console.log).mock.calls.flat().join("\n")).not.toMatch(/migrated/i);
	});

	it("counts the repos that were swept, not the ones that were registered", async () => {
		registered([
			{ repoIdentity: "r1", repoName: "a", worktreeRoot: "/a", enabledAt: "t" },
			{ repoIdentity: "r2", repoName: "b", worktreeRoot: "/b", enabledAt: "t" },
			{ repoIdentity: "r3", repoName: "gone", worktreeRoot: "/gone", enabledAt: "t" },
		]);
		vi.mocked(dbBackfillRepos).mockResolvedValue([
			{ mode: "updated", eventsApplied: 1, repoName: "a", sotImport: { nodes: 2, updated: 2 } },
			{ mode: "updated", eventsApplied: 1, repoName: "b", sotImport: { nodes: 1, updated: 1 } },
		] as unknown as Awaited<ReturnType<typeof dbBackfillRepos>>);
		await importDashboardHistory("/w", deps());
		expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain("across 2 repo(s)");
	});

	it("names the repos with no checkout on disk, once, without calling it a failure", async () => {
		// The only place this reaches the user: the backfill's own log line is at
		// `debug`, which CLI mode keeps off the terminal, so an unmounted share
		// silently stopped importing. It is NOT a migration failure — that wording
		// belongs to `skipped`, and this repo may be back on the next launch.
		registered([
			{ repoIdentity: "r1", repoName: "a", worktreeRoot: "/a", enabledAt: "t" },
			{ repoIdentity: "r2", repoName: "on-a-nas", worktreeRoot: "/mnt/nas/x", enabledAt: "t" },
		]);
		vi.mocked(dbBackfillRepos).mockResolvedValue([
			{ mode: "updated", eventsApplied: 1, repoName: "a", sotImport: { nodes: 2, updated: 0 } },
			{ mode: "unavailable", eventsApplied: 0, repoName: "on-a-nas" },
		] as unknown as Awaited<ReturnType<typeof dbBackfillRepos>>);
		await importDashboardHistory("/w", deps());
		const out = vi.mocked(console.log).mock.calls.flat().join("\n");
		expect(out).toContain("Skipped 1 repo(s) with no checkout on disk (on-a-nas)");
		expect(out).not.toMatch(/migration failed/i);
		// Counted out of the migration report too — it was never swept, so it is not
		// one of the repos the "already migrated" line is speaking for.
		expect(out).not.toContain("across");
	});

	it("samples distinct names instead of printing the whole dead-entry list", async () => {
		// Measured on a real registry: 132 unavailable entries, most named `repo`
		// (test fixtures from before the isolatedHome fix). Printed in full they
		// buried the result line under them, and "repo, repo, repo" identifies
		// nothing anyway. Nothing prunes that file, so the count only grows.
		registered([{ repoIdentity: "r1", repoName: "a", worktreeRoot: "/a", enabledAt: "t" }]);
		const dead = ["repo", "repo", "repo", "frepo", "bare-fenced", "trepo"].map((repoName, i) => ({
			mode: "unavailable",
			eventsApplied: 0,
			repoName,
			id: i,
		}));
		vi.mocked(dbBackfillRepos).mockResolvedValue([
			{ mode: "updated", eventsApplied: 1, repoName: "a", sotImport: { nodes: 1, updated: 0 } },
			...dead,
		] as unknown as Awaited<ReturnType<typeof dbBackfillRepos>>);
		await importDashboardHistory("/w", deps());
		const out = vi.mocked(console.log).mock.calls.flat().join("\n");
		// The COUNT is every entry; the sample is distinct names, capped at three.
		expect(out).toContain("Skipped 6 repo(s) with no checkout on disk (repo, frepo, bare-fenced, +1 more)");
	});

	it("stays silent when every registered repo is switched off, and says nothing about it", async () => {
		// The paused rows exist so the sweep can project `repos.disabled_at`, NOT so a
		// report can count them: they gate this whole block (`worked.length === 0`),
		// size "across N repo(s)", and are the population `printSessionSummary` speaks
		// for. Leave them in `worked` and a machine whose every repo is off prints a
		// full ✓ report about repos it deliberately did not touch.
		//
		// Unlike `unavailable`, they are not announced either. An unmounted share is
		// something the user is still waiting on; this is their own decision, already
		// visible as the paused row on the page they are opening.
		registered([
			{ repoIdentity: "r1", repoName: "off-a", worktreeRoot: "/a", enabledAt: "t" },
			{ repoIdentity: "r2", repoName: "off-b", worktreeRoot: "/b", enabledAt: "t" },
		]);
		vi.mocked(dbBackfillRepos).mockResolvedValue([
			{ mode: "disabled", eventsApplied: 0, repoName: "off-a" },
			{ mode: "disabled", eventsApplied: 0, repoName: "off-b" },
		] as unknown as Awaited<ReturnType<typeof dbBackfillRepos>>);
		await importDashboardHistory("/w", deps());
		const out = vi.mocked(console.log).mock.calls.flat().join("\n");
		expect(out).not.toMatch(/migrated/i);
		expect(out).not.toContain("across");
		expect(out).not.toMatch(/off-a|off-b/);
	});

	it("stays silent about migration when every registered repo is unavailable", async () => {
		// `results` is no longer empty in this case, so the quiet rule has to read
		// past the unavailable rows or it prints "✓ All 0 memories already migrated."
		registered([{ repoIdentity: "r1", repoName: "gone", worktreeRoot: "/gone", enabledAt: "t" }]);
		vi.mocked(dbBackfillRepos).mockResolvedValue([
			{ mode: "unavailable", eventsApplied: 0, repoName: "gone" },
		] as unknown as Awaited<ReturnType<typeof dbBackfillRepos>>);
		await importDashboardHistory("/w", deps());
		const out = vi.mocked(console.log).mock.calls.flat().join("\n");
		expect(out).toContain("Skipped 1 repo(s)");
		expect(out).not.toMatch(/migrated/i);
	});
});

describe("identifyDashboardHealth — what a launch is allowed to signal", () => {
	it("accepts the current payload, which names the service", () => {
		expect(identifyDashboardHealth({ ok: true, pid: 4242, service: DASHBOARD_HEALTH_SERVICE })).toEqual({
			pid: 4242,
		});
	});

	it("rejects a bare {ok, pid} — the payload any local service might answer", () => {
		// The regression this guards: `reclaimPort` SIGTERMs whatever pid it is
		// handed, so accepting this shape means killing an unrelated service that
		// happens to hold 1818 — or, more likely, an explicit `--port` aimed at a
		// dev server.
		expect(identifyDashboardHealth({ ok: true, pid: 4242 })).toBeNull();
	});

	it("accepts the legacy detached server's four-field payload", () => {
		// It predates the marker and SURVIVES the upgrade that added it, so without
		// this arm a freshly upgraded CLI could never take its port back and would
		// serve on the fallback for as long as that process lived.
		expect(identifyDashboardHealth({ ok: true, pid: 4242, port: 1818, schemaVersion: 12 })).toEqual({ pid: 4242 });
	});

	it("rejects a half-legacy payload — it is the two fields TOGETHER that identify it", () => {
		expect(identifyDashboardHealth({ ok: true, pid: 4242, port: 1818 })).toBeNull();
		expect(identifyDashboardHealth({ ok: true, pid: 4242, schemaVersion: 12 })).toBeNull();
	});

	it("rejects a foreign marker, a missing or non-numeric pid, ok:false, and non-objects", () => {
		expect(identifyDashboardHealth({ ok: true, pid: 1, service: "some-other-tool" })).toBeNull();
		expect(identifyDashboardHealth({ ok: true, service: DASHBOARD_HEALTH_SERVICE })).toBeNull();
		expect(identifyDashboardHealth({ ok: true, pid: "4242", service: DASHBOARD_HEALTH_SERVICE })).toBeNull();
		expect(identifyDashboardHealth({ ok: false, pid: 1, service: DASHBOARD_HEALTH_SERVICE })).toBeNull();
		expect(identifyDashboardHealth(null)).toBeNull();
		expect(identifyDashboardHealth("ok")).toBeNull();
	});

	it("rejects pid 0 and negatives — `process.kill` reads those as a process GROUP", () => {
		// Not input hygiene. `process.kill(0)` signals every process in THIS
		// process's group, so accepting a `pid: 0` body means the launch SIGTERMs
		// itself and whatever shares its group — the user's shell pipeline included.
		// A negative names the group `-pid`, which is the same weapon aimed further.
		for (const pid of [0, -1, -4242]) {
			expect(identifyDashboardHealth({ ok: true, pid, service: DASHBOARD_HEALTH_SERVICE })).toBeNull();
			expect(identifyDashboardHealth({ ok: true, pid, port: 1818, schemaVersion: 12 })).toBeNull();
		}
		// Not a process id either, and it throws ERR_OUT_OF_RANGE rather than
		// signalling anything — rejected here so the throw is never reached.
		expect(identifyDashboardHealth({ ok: true, pid: 4.5, service: DASHBOARD_HEALTH_SERVICE })).toBeNull();
		expect(identifyDashboardHealth({ ok: true, pid: Number.NaN, service: DASHBOARD_HEALTH_SERVICE })).toBeNull();
	});

	it("marks a responder from another pid namespace foreign rather than signallable", () => {
		const local = { platform: "win32", host: "DESKTOP-1" };
		// The measured case: a dashboard inside WSL answering a Windows CLI. Its pid
		// is real in WSL and means nothing here — resolving it locally finds either
		// nothing or an unrelated process, and killing that one neither frees the
		// port nor leaves a trace.
		expect(
			identifyDashboardHealth(
				{ ok: true, pid: 1873602, service: DASHBOARD_HEALTH_SERVICE, platform: "linux", host: "DESKTOP-1" },
				local,
			),
		).toEqual({ pid: 1873602, foreign: true });
		// A container on the same platform is caught by the hostname instead — its
		// default is the container id.
		expect(
			identifyDashboardHealth(
				{ ok: true, pid: 31, service: DASHBOARD_HEALTH_SERVICE, platform: "win32", host: "3f1c9a2b7e04" },
				local,
			),
		).toEqual({ pid: 31, foreign: true });
	});

	it("treats a matching namespace, and an unstated one, as reachable", () => {
		const local = { platform: "win32", host: "DESKTOP-1" };
		expect(
			identifyDashboardHealth(
				{ ok: true, pid: 4242, service: DASHBOARD_HEALTH_SERVICE, platform: "win32", host: "DESKTOP-1" },
				local,
			),
		).toEqual({ pid: 4242 });
		// No evidence either way is NOT evidence of foreignness: every build before
		// these two fields existed, and the legacy detached server, say nothing.
		// Gating on their absence would make all of them unreclaimable, which is the
		// exact failure the legacy arm was added to avoid.
		expect(identifyDashboardHealth({ ok: true, pid: 4242, service: DASHBOARD_HEALTH_SERVICE }, local)).toEqual({
			pid: 4242,
		});
		expect(identifyDashboardHealth({ ok: true, pid: 4242, port: 1818, schemaVersion: 12 }, local)).toEqual({
			pid: 4242,
		});
	});
});

describe("startForegroundDashboard — reclaiming the port", () => {
	/** A dashboard answering on the preferred port. */
	function occupiedBy(pid: number, over: Partial<DashboardDeps> = {}) {
		let alive = true;
		const d = deps({
			probeHealth: async (port: number) => (alive && port === 1818 ? { pid } : null),
			killPid: (killedPid: number) => {
				if (killedPid === pid) alive = false;
				return true;
			},
			...over,
		});
		return d;
	}

	it("kills the dashboard already on the preferred port, then binds it", async () => {
		const d = occupiedBy(4242);
		await startForegroundDashboard("stats", { cwd: "/w" }, d);
		// Bound the port it just freed rather than falling through to 18118.
		expect(d.started).toHaveLength(1);
		expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain("Stopped the dashboard already running");
	});

	it("leaves a foreign service on the port alone", async () => {
		// Anything that does not answer our own /health is not ours to signal —
		// killing whatever holds 1818 would take down an unrelated local service.
		const d = deps();
		await startForegroundDashboard("stats", { cwd: "/w" }, d);
		expect(d.probed).toContain(1818);
		expect(d.killed).toEqual([]);
	});

	it("never signals itself", async () => {
		// A probe that somehow answers with our own pid must not make this process
		// kill itself on the way to binding.
		const d = deps({ probeHealth: async () => ({ pid: process.pid }) });
		await startForegroundDashboard("stats", { cwd: "/w" }, d);
		expect(d.killed).toEqual([]);
	});

	it("reclaims the explicit --port rather than the default", async () => {
		// Its own recorder: an injected `probeHealth` replaces the one `deps()`
		// records through, so `d.probed` would stay empty here.
		const asked: number[] = [];
		const d = deps({
			probeHealth: async (port: number) => {
				asked.push(port);
				return { pid: 99 };
			},
		});
		await startForegroundDashboard("stats", { cwd: "/w", port: 3000 }, d);
		expect(asked[0]).toBe(3000);
		expect(d.killed).toEqual([99]);
	});

	it("binds anyway when the previous dashboard will not let go, and does not claim it stopped", async () => {
		// The probe keeps answering, so the release wait times out. Falling through is
		// the pre-existing behaviour: the bind loop moves to the next candidate.
		const d = deps({ probeHealth: async () => ({ pid: 77 }), killPid: () => true });
		await startForegroundDashboard("stats", { cwd: "/w" }, d);
		expect(d.started).toHaveLength(1);
		const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
		// `killPid` answers whether the SIGNAL was delivered, never whether the
		// process died. Reporting this as "Stopped" put that line directly above the
		// fallback line saying the same port was still in use — one port, two
		// contradictory sentences, and the first one false.
		expect(printed).not.toContain("Stopped the dashboard");
		expect(printed).toContain("still holding the port");
	});

	it("names a dashboard it found but could not stop", async () => {
		// Measured case: a dashboard inside WSL answers a Windows CLI on loopback
		// and reports a Linux process id that does not exist on the Windows side.
		// Reporting that as "nothing there" left the port silently changing.
		const d = deps({ probeHealth: async () => ({ pid: 1873602 }), killPid: () => false });
		await startForegroundDashboard("stats", { cwd: "/w" }, d);
		const printed = vi.mocked(console.log).mock.calls.flat().join("\n");
		expect(printed).not.toContain("Stopped the dashboard");
		expect(printed).toContain("could not be stopped from here");
	});

	it("never signals a responder that proved it is in another pid namespace", async () => {
		// `killPid` answering false is what the case above relies on, and it only
		// answers false while nothing local happens to hold that id. When something
		// does, the signal LANDS — on a stranger — the port stays held, and the
		// outcome is indistinguishable from a slow release. So the decision has to
		// be made before `killPid` is reached, not from its answer.
		const d = deps({
			probeHealth: async () => ({ pid: 1873602, foreign: true }),
			killPid: () => true,
		});
		await startForegroundDashboard("stats", { cwd: "/w" }, d);
		expect(d.killed).toEqual([]);
		expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain("could not be stopped from here");
	});

	it("reclaims the fallback port too, so an occupied 1818 cannot leave two dashboards", async () => {
		// The scenario, with nothing unusual in it: an unrelated local service holds
		// 1818, so the first launch falls back to 18118. A second launch that only
		// reclaimed its preferred port would find 1818 not ours, 18118 taken by the
		// first dashboard, and land on an OS-assigned one — two dashboards running
		// concurrent imports and cutover attempts against one database.
		// Its own recorders: injected seams replace the ones `deps()` records
		// through, so `d.probed` / `d.killed` would stay empty here.
		const asked: number[] = [];
		const killed: number[] = [];
		let alive = true;
		const d = deps({
			probeHealth: async (port: number) => {
				asked.push(port);
				return alive && port === 18118 ? { pid: 4242 } : null;
			},
			killPid: (pid: number) => {
				killed.push(pid);
				alive = false;
				return true;
			},
		});
		await startForegroundDashboard("stats", { cwd: "/w" }, d);
		expect(asked).toContain(18118);
		expect(killed).toEqual([4242]);
		expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(
			"Stopped the dashboard already running on port 18118",
		);
	});

	it("keeps an explicit --port to that port alone", async () => {
		// The bind's own candidate list is one long under `--port`, so reclaiming the
		// defaults would kill a dashboard this launch is not competing with.
		const asked: number[] = [];
		const d = deps({
			probeHealth: async (port: number) => {
				asked.push(port);
				return null;
			},
		});
		await startForegroundDashboard("stats", { cwd: "/w", port: 3000 }, d);
		expect(asked).toEqual([3000]);
	});
});

describe("startForegroundDashboard", () => {
	it("binds, opens the plain page URL and hands back an unresolved wait", async () => {
		const d = deps();
		const dashboard = await startForegroundDashboard("standup", { cwd: "/w" }, d);
		expect(d.started).toHaveLength(1);
		// No `?t=` — the URL is hand-openable, which is why the token was dropped.
		expect(d.opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/dashboard\/standup$/);
		// Returning BEFORE the wait is the whole point of the split: the caller
		// decides what runs while the page is already up.
		expect(d.waited).toBe(0);
		await dashboard.waitForShutdown();
		expect(d.waited).toBe(1);
	});

	it("passes the resolved repo root as the server's cwd", async () => {
		const d = deps();
		await startForegroundDashboard("stats", { cwd: process.cwd() }, d);
		// Whatever resolveServerCwd answers, it must reach the server — that value
		// is what the Settings page's repo-scoped actions act on.
		expect(d.started[0]?.serverCwd).toBe(await resolveServerCwd(process.cwd()));
	});

	it("honours --no-open", async () => {
		const d = deps();
		await startForegroundDashboard("stats", { cwd: "/w", open: false }, d);
		expect(d.opened).toEqual([]);
	});

	it("a browser failure is non-fatal — the server is still up", async () => {
		const d = deps({
			openBrowser: async () => {
				throw new Error("no display");
			},
		});
		await expect(startForegroundDashboard("stats", { cwd: "/w" }, d)).resolves.toBeDefined();
	});

	it("announces the port it fell back to", async () => {
		const d = deps({
			startServer: async () => ({
				server: { closeAllConnections: () => {}, close: () => {} } as unknown as Server,
				port: 18118,
				fellBack: true,
			}),
		});
		await startForegroundDashboard("stats", { cwd: "/w" }, d);
		// With no state record and no reuse probe, this line is the only signal
		// that something else already holds the preferred port.
		expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(
			"Port 1818 was in use — serving on 18118 instead.",
		);
	});

	it("names BOTH preferred ports when the bind landed on an OS-assigned one", async () => {
		// Reaching a third candidate means 1818 AND 18118 were taken. Naming only
		// 1818 there is true but reads as though the documented fallback were still
		// free — the one thing the user would try next.
		const d = deps({
			startServer: async () => ({
				server: { closeAllConnections: () => {}, close: () => {} } as unknown as Server,
				port: 54321,
				fellBack: true,
			}),
		});
		await startForegroundDashboard("stats", { cwd: "/w" }, d);
		expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(
			"Ports 1818 and 18118 were in use — serving on 54321 instead.",
		);
	});

	it("stops telemetry through the shutdown seam, not on its own", async () => {
		const d = deps();
		const dashboard = await startForegroundDashboard("stats", { cwd: "/w" }, d);
		expect(d.telemetryStops).toBe(0);
		await dashboard.waitForShutdown();
		// The injected seam does not stop it; the DEFAULT one does. What this pins
		// is that nothing else stops it early — a stopped flusher would silently
		// strand every beacon event for the rest of the session.
		expect(d.telemetryStops).toBe(0);
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

	it("registers the repo, binds, opens the page, then backfills, then waits", async () => {
		const d = deps();
		await executeDashboard("standup", { cwd: "/w" }, d);
		expect(registerRepo).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/w" }));
		expect(d.started).toHaveLength(1);
		expect(d.opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/dashboard\/standup$/);
		expect(dbBackfillRepos).toHaveBeenCalledTimes(1);
		// The import runs while the page is already serving — that ordering is why
		// a first-run sweep does not leave the browser on a blank tab.
		expect(d.waited).toBe(1);
	});

	it("does not return until the shutdown seam resolves", async () => {
		let release = (): void => {};
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const d = deps({ waitForShutdown: () => blocked });
		let returned = false;
		const run = executeDashboard("stats", { cwd: "/w" }, d).then((ok) => {
			returned = true;
			return ok;
		});
		// Everything else runs to completion; the command then parks on the signal.
		// Explicit timeout because `vi.waitFor` ignores this suite's 60s `testTimeout`
		// and defaults to 1000ms — too tight for this deep async chain once the full
		// suite + coverage starves the event loop (it reaches `dbBackfillRepos` in
		// ~200ms in isolation). See the `testTimeout` note in vite.config.ts.
		await vi.waitFor(() => expect(dbBackfillRepos).toHaveBeenCalledTimes(1), { timeout: 10_000 });
		await vi.waitFor(() => expect(opportunisticSnapshot).toHaveBeenCalledTimes(1), { timeout: 10_000 });
		expect(returned).toBe(false);
		release();
		await expect(run).resolves.toBe(true);
	});

	it("sweeps the cutover unthrottled, AFTER the import", async () => {
		// Ordering is the load-bearing half: the import is what fills the database
		// from the branch, which is what makes the containment compare likely to
		// pass, so an attempt ahead of it would mostly measure the old state.
		const d = deps();
		await executeDashboard("stats", { cwd: "/w" }, d);
		expect(autoCutoverAllRepos).toHaveBeenCalledWith(expect.objectContaining({ preferFirst: "/w" }));
		expect(vi.mocked(dbBackfillRepos).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(autoCutoverAllRepos).mock.invocationCallOrder[0] as number,
		);
	});

	it("a launch that never bound does not import, cut over or wait", async () => {
		const d = deps({
			startServer: async () => {
				throw new Error("EADDRINUSE");
			},
		});
		await expect(executeDashboard("stats", {}, d)).resolves.toBe(false);
		expect(dbBackfillRepos).not.toHaveBeenCalled();
		expect(autoCutoverAllRepos).not.toHaveBeenCalled();
		expect(d.waited).toBe(0);
	});

	it("opens the dashboard for a disabled repo but writes nothing to that repo", async () => {
		vi.mocked(readManualDisableFlagSync).mockReturnValueOnce(true);
		const d = deps();
		await expect(executeDashboard("stats", { cwd: "/w" }, d)).resolves.toBe(true);
		// The page is machine-level, so it still opens with the other repos' data.
		expect(d.opened).toHaveLength(1);
		// `registerRepo` would add this repo back to the machine's roster — and a
		// page open is not an explicit re-enable.
		expect(registerRepo).not.toHaveBeenCalled();
		// The cutover sweep DOES still run, and that is the point of it being plural:
		// it asks each repo's own profile for itself, so the fence it may leave behind
		// is never left in a repo the user switched off — while the OTHER repos on the
		// machine still get their switch. Hoisting the decision to `cwd` is what used
		// to let one opt-out cancel the whole machine's cutover.
		expect(autoCutoverAllRepos).toHaveBeenCalledTimes(1);
	});

	it("still takes the machine snapshot when the launching repo is disabled", async () => {
		// The backup belongs to the database, not to `cwd`: one repo's opt-out must
		// not silently stop the machine's backups.
		vi.mocked(readManualDisableFlagSync).mockReturnValueOnce(true);
		await executeDashboard("stats", { cwd: "/w" }, deps());
		expect(opportunisticSnapshot).toHaveBeenCalledTimes(1);
	});

	it("tells the user why their repo is missing from the dashboard", async () => {
		vi.mocked(readManualDisableFlagSync).mockReturnValueOnce(true);
		await executeDashboard("stats", { cwd: "/w" }, deps());
		// `log.info` is suppressed in the terminal by design, so this has to be said
		// on the output the user actually sees.
		const printed = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
		expect(printed.some((line) => line.includes("disabled here"))).toBe(true);
	});

	it("takes the daily snapshot in this process", async () => {
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

	it("a backfill failure warns but does not fail the command", async () => {
		vi.mocked(dbBackfillRepos).mockRejectedValueOnce(new Error("db locked"));
		await expect(executeDashboard("stats", {}, deps())).resolves.toBe(true);
	});
});

describe("seam threading and import reporting", () => {
	it("runs with a bare deps object — no configDir, dbPath or now", async () => {
		// Exercises the falsy side of every optional-seam spread: registerRepo and
		// pruneDisposableRepos get no configDir, dbBackfillRepos no dbPath and no now.
		await importDashboardHistory("/w", {});
		expect(dbBackfillRepos).toHaveBeenCalledTimes(1);
		expect(registerRepo).toHaveBeenCalledWith({ cwd: "/w" });
		expect(vi.mocked(pruneDisposableRepos).mock.calls[0]?.[0]).toEqual({});
		expect(vi.mocked(dbBackfillRepos).mock.calls[0]?.[1]).not.toHaveProperty("dbPath");
		expect(vi.mocked(dbBackfillRepos).mock.calls[0]?.[1]).not.toHaveProperty("now");
	});

	it("threads configDir, dbPath and now through the prune, import and cutover sweep", async () => {
		await importDashboardHistory("/w", { configDir: "/cfg", dbPath: "/db", now: () => 7 });
		expect(registerRepo).toHaveBeenCalledWith({ cwd: "/w", configDir: "/cfg" });
		expect(vi.mocked(pruneDisposableRepos).mock.calls[0]?.[0]).toMatchObject({ configDir: "/cfg", dbPath: "/db" });
		expect(vi.mocked(dbBackfillRepos).mock.calls[0]?.[1]).toMatchObject({ dbPath: "/db" });
		expect(vi.mocked(dbBackfillRepos).mock.calls[0]?.[1]?.now?.()).toBe(7);
		expect(autoCutoverAllRepos).toHaveBeenCalledWith(expect.objectContaining({ dbPath: "/db" }));
	});

	it("titles the block by the tier that has work, forwarding each event to the printer", async () => {
		// dbBackfillRepos drives onProgress: a `commits` event reveals the history
		// header, a `memories` event the migration header (the first reveal wins), and
		// a `sessions` event falls through to the printer without revealing either.
		vi.mocked(dbBackfillRepos).mockImplementationOnce(async (_repos, opts) => {
			const base = { repoName: "a", repoIndex: 1, repoTotal: 1, total: undefined } as const;
			opts?.onProgress?.({ ...base, kind: "commits", done: 0 } as never);
			opts?.onProgress?.({ ...base, kind: "memories", done: 1 } as never);
			opts?.onProgress?.({ ...base, kind: "sessions", done: 0 } as never);
			return [{ mode: "bootstrapped", repoName: "a", sotImport: { nodes: 1, updated: 1 } }] as never;
		});

		await importDashboardHistory("/w", deps());

		const out = vi.mocked(console.log).mock.calls.flat().join("\n");
		// First reveal wins — a commits event arrived first, so the block is titled as
		// history indexing, not migration.
		expect(out).toContain("Indexing your git history");
	});

	it("names each skipped repo under the migration header and counts a single migrated memory", async () => {
		registered([
			{ repoIdentity: "r1", repoName: "a", worktreeRoot: "/a", enabledAt: "t" },
			{ repoIdentity: "r2", repoName: "b", worktreeRoot: "/b", enabledAt: "t" },
		]);
		vi.mocked(dbBackfillRepos).mockResolvedValue([
			// Has sotImport → the reduce reads its nodes/updated (the left side of `?.`).
			{ mode: "bootstrapped", repoName: "a", sotImport: { nodes: 1, updated: 1 } },
			// No sotImport → the reduce takes the `?? 0` fallback.
			{ mode: "recovered", repoName: "b" },
			// A skipped repo WITH an error, and one WITHOUT → both sides of `?? "unknown error"`.
			{ mode: "skipped", repoName: "c", error: "boom" },
			{ mode: "skipped", repoName: "d" },
		] as unknown as Awaited<ReturnType<typeof dbBackfillRepos>>);

		await importDashboardHistory("/w", deps());

		const out = vi.mocked(console.log).mock.calls.flat().join("\n");
		expect(out).toContain("c — migration failed: boom");
		expect(out).toContain("d — migration failed: unknown error");
		// One memory migrated (only `a` carried a node) → the singular noun.
		expect(out).toContain("Migrated 1 memory");
	});

	it("passes a valid --port through and binds it", async () => {
		const d = deps();
		await executeDashboard("stats", { cwd: "/w", port: "8080" }, d);
		expect(d.started[0]?.port).toBe(8080);
	});

	it("rejects a --port at or below zero and above the 16-bit ceiling", async () => {
		await expect(executeDashboard("stats", { cwd: "/w", port: "0" }, deps())).resolves.toBe(false);
		await expect(executeDashboard("stats", { cwd: "/w", port: "70000" }, deps())).resolves.toBe(false);
	});

	it("threads dbPath through the bind and the machine-db ensure step", async () => {
		const dbPath = join(configDir, "dash.db");
		const d = deps({ dbPath });
		await executeDashboard("stats", { cwd: "/w" }, d);
		expect(d.started).toHaveLength(1);
		expect(autoCutoverAllRepos).toHaveBeenCalledWith(expect.objectContaining({ dbPath }));
	});

	it("registers with no configDir when deps omits one", async () => {
		const dbPath = join(configDir, "dash-noconfig.db");
		await executeDashboard("stats", { cwd: "/w" }, deps({ configDir: undefined, dbPath }));
		expect(registerRepo).toHaveBeenCalledWith({ cwd: "/w" });
	});

	it("reports a failure to create the dashboard database as a message and returns false", async () => {
		// ensureDashboardDbExists throws when its parent path is a regular file — the
		// launch reports it and bails rather than crashing.
		const blocker = join(configDir, "not-a-dir");
		writeFileSync(blocker, "x");
		const errors: string[] = [];
		vi.mocked(console.error).mockImplementation((...a: unknown[]) => {
			errors.push(a.map(String).join(" "));
		});
		const ok = await executeDashboard("stats", { cwd: "/w" }, deps({ dbPath: join(blocker, "x.db") }));
		expect(ok).toBe(false);
		expect(errors.join("\n")).toContain("could not create the dashboard database");
	});

	it("resolves the server cwd from process.cwd() when no cwd is given", async () => {
		const d = deps();
		await startForegroundDashboard("stats", {}, d);
		expect(d.started).toHaveLength(1);
		expect(d.started[0]?.serverCwd).toBe(await resolveServerCwd(process.cwd()));
	});

	it("threads dbPath into the bound server options", async () => {
		const dbPath = join(configDir, "fg.db");
		const d = deps({ dbPath });
		await startForegroundDashboard("stats", { cwd: "/w" }, d);
		expect(d.started).toHaveLength(1);
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
		expect(flags).toEqual(expect.arrayContaining(["--port", "--no-open", "--cwd"]));
		// `--stop` went with the background server: Ctrl+C is the stop now, and a
		// flag that signalled a recorded pid has nothing left to signal.
		expect(flags).not.toContain("--stop");
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
	const event = (over: Partial<DbBackfillProgress>): DbBackfillProgress => ({
		repoName: "jolliai",
		kind: "memories",
		done: 1,
		total: 3_214,
		repoIndex: 1,
		repoTotal: 1,
		...over,
	});

	/** Drives `done` from 1..total, returning every line the printer emitted. */
	function drive(total: number, over: Partial<DbBackfillProgress> = {}, from = 1): string[] {
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
		// `firstRun` — only a bootstrap can take minutes. A sweep triggered by a
		// moved branch tip skips `--numstat` for stored commits and finishes in under
		// a second, so the patience note must not ride along with it.
		printer.onProgress(event({ kind: "commits", done: 0, total: undefined, firstRun: true }));
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
				event({
					repoName,
					repoIndex,
					repoTotal: 2,
					kind: "commits",
					done: 0,
					total: undefined,
					firstRun: true,
				}),
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

	it("keeps two same-named repos apart, because the name is not unique", () => {
		// `deriveRepoName` is the last path/URL segment, so two clones of one project
		// (or two unrelated `app` directories) collide. A name-keyed reset never fires
		// on the collision: the second repo printed no heading, no phase labels, and
		// its whole run appeared under the FIRST repo's heading.
		const lines: string[] = [];
		const printer = createProgressPrinter({ log: (line) => lines.push(line) });
		for (const repoIndex of [1, 2] as const) {
			printer.onProgress(event({ repoName: "app", repoIndex, repoTotal: 2, kind: "sessions", done: 0 }));
		}
		expect(lines).toEqual(["  app (1/2)", "  Reading AI sessions…", "  app (2/2)", "  Reading AI sessions…"]);
	});

	it("prints the per-agent breakdown when the session tier ends", () => {
		const lines: string[] = [];
		const printer = createProgressPrinter({ log: (line) => lines.push(line) });
		printer.onProgress(event({ kind: "sessions", done: 0, total: undefined }));
		printer.onProgress(
			event({
				kind: "sessions",
				// Nonzero, which is exactly why the breakdown branch must run before the
				// commit-only counter rule that would otherwise drop this event.
				done: 18,
				total: undefined,
				sessionBreakdown: {
					claude: { discovered: 18, processed: 14, skipped: 4 },
					codex: { discovered: 6, processed: 4, skipped: 2 },
				},
			}),
		);
		expect(lines).toEqual([
			"  Reading AI sessions…",
			"      claude  18 found, 14 processed, 4 skipped",
			"      codex    6 found,  4 processed, 2 skipped",
		]);
	});

	it("adds no breakdown lines for a repo whose window turned up nothing", () => {
		const lines: string[] = [];
		const printer = createProgressPrinter({ log: (line) => lines.push(line) });
		printer.onProgress(event({ kind: "sessions", done: 0, total: undefined }));
		printer.onProgress(event({ kind: "sessions", done: 0, total: undefined, sessionBreakdown: {} }));
		expect(lines).toEqual(["  Reading AI sessions…"]);
	});

	it("defaults its writer to console.log when no log seam is injected", () => {
		// The `deps.log ?? CONSOLE_OUTPUT.log` fallback — with no seam it prints
		// straight to the console (spied in beforeEach).
		const printer = createProgressPrinter();
		printer.onProgress(event({ kind: "sessions", done: 0, total: undefined }));
		expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain("Reading AI sessions…");
	});

	it("prints a phase label once per detail, dropping a repeat", () => {
		const lines: string[] = [];
		const printer = createProgressPrinter({ log: (line) => lines.push(line) });
		printer.onProgress(event({ kind: "summaries", done: 0, total: undefined }));
		printer.onProgress(event({ kind: "summaries", done: 0, total: undefined }));
		expect(lines).toEqual(["  Indexing stored memories…"]);
	});

	it("prints no commit counter below the progress floor", () => {
		const lines: string[] = [];
		const printer = createProgressPrinter({ log: (line) => lines.push(line) });
		// done>0 so it is past the phase-label branch, total<PROGRESS_MIN_TOTAL so the
		// quarter counter is suppressed — the whole event produces nothing.
		printer.onProgress(event({ kind: "commits", done: 10, total: 50 }));
		expect(lines).toEqual([]);
	});
});

describe("printSessionSummary", () => {
	const result = (sessions?: SessionTierSummary): DbBackfillResult => ({
		mode: "recovered",
		eventsApplied: 0,
		repoName: "jolliai",
		...(sessions ? { sessions } : {}),
	});

	/** Shorthand for one agent's row: found / processed / skipped. */
	const agent = (discovered: number, processed: number, skipped: number) => ({ discovered, processed, skipped });

	/**
	 * Builds one repo's tier summary from per-agent counts.
	 *
	 * The summary carries conversation IDENTITIES alongside the counts, because the
	 * report merges by conversation rather than by adding the repos' numbers — so a
	 * fixture has to name its conversations. Ids are synthesised per agent as
	 * `<source><tag>-<n>` from 1, with the processed set taken off the front and the
	 * skipped set immediately after it; any remainder is discovered-but-neither, which
	 * is the undateable session the totals must not derive by subtraction.
	 *
	 * `tag` is what decides whether two repos claim the SAME conversations (same tag —
	 * the coarse-attribution case the merge has to collapse) or different ones.
	 */
	function tier(bySource: Record<string, ReturnType<typeof agent>>, tag = ""): SessionTierSummary {
		const keys = { discovered: [] as string[], processed: [] as string[], skipped: [] as string[] };
		let discovered = 0;
		let processed = 0;
		let skipped = 0;
		for (const [source, counts] of Object.entries(bySource)) {
			const ids = Array.from({ length: counts.discovered }, (_, i) => `${source}:${source}${tag}-${i + 1}`);
			keys.discovered.push(...ids);
			keys.processed.push(...ids.slice(0, counts.processed));
			keys.skipped.push(...ids.slice(counts.processed, counts.processed + counts.skipped));
			discovered += counts.discovered;
			processed += counts.processed;
			skipped += counts.skipped;
		}
		return { discovered, processed, skipped, bySource, keys };
	}

	/** Returns every line the summary printed. */
	function render(results: ReadonlyArray<DbBackfillResult>): string[] {
		const lines: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
			lines.push(String(line ?? ""));
		});
		try {
			printSessionSummary(results);
		} finally {
			log.mockRestore();
		}
		return lines;
	}

	it("states both counts outright, then all three per agent", () => {
		const lines = render([result(tier({ claude: agent(18, 14, 4), codex: agent(6, 4, 2) }))]);
		// Numbers right-padded into columns: the reader is comparing agents against each
		// other, which ragged numbers turn into a per-line parse.
		expect(lines).toEqual([
			"  ✓ 24 AI conversations in the last 7 days: 18 processed, 6 skipped",
			"      claude  18 found, 14 processed, 4 skipped",
			"      codex    6 found,  4 processed, 2 skipped",
		]);
	});

	it("uses the same sentence on a converged run, with a zero in it", () => {
		// A silent branch makes a converged re-run look identical to a run that never
		// happened; a DIFFERENT sentence would read as a different kind of event.
		// The agent still appears: "24 found, 0 processed" is what says the tier looked
		// and found nothing new, which an omitted row would spell as "codex absent".
		const lines = render([result(tier({ codex: agent(24, 0, 24) }))]);
		expect(lines).toEqual([
			"  ✓ 24 AI conversations in the last 7 days: 0 processed, 24 skipped",
			"      codex  24 found, 0 processed, 24 skipped",
		]);
	});

	it("does not derive the skip count by subtraction", () => {
		// A session with an unparseable instant is neither processed nor skipped, so
		// `discovered - processed` would overstate the skips. Reporting the real count.
		const lines = render([result(tier({ claude: agent(10, 4, 3) }))]);
		expect(lines[0]).toContain("4 processed, 3 skipped");
		expect(lines[1]).toContain("10 found, 4 processed, 3 skipped");
	});

	it("uses the singular for one conversation", () => {
		const lines = render([result(tier({ claude: agent(1, 1, 0) }))]);
		expect(lines[0]).toContain("1 AI conversation in the last 7 days");
	});

	it("adds up repos that turned up different conversations, busiest agent first", () => {
		// Alphabetical order would bury the agent the user actually works in. All three
		// numbers merge, not just the processed one — otherwise a reader cannot tell a
		// converged agent from one whose transcripts could not be read.
		const lines = render([
			result(tier({ codex: agent(3, 2, 1), claude: agent(7, 4, 3) }, "-a")),
			result(tier({ claude: agent(11, 7, 4), kimi: agent(3, 2, 1) }, "-b")),
		]);
		expect(lines).toEqual([
			"  ✓ 24 AI conversations in the last 7 days: 15 processed, 9 skipped",
			"      claude  18 found, 11 processed, 7 skipped",
			"      codex    3 found,  2 processed, 1 skipped",
			"      kimi     3 found,  2 processed, 1 skipped",
		]);
	});

	it("counts a conversation once when several repos claim it", () => {
		// Cursor's global store records no workspace for a composer, so every in-window
		// composer is claimed by every repo Cursor has a workspace for — and two clones of
		// one project claim an identical set outright. Adding the repos' counts reported
		// one conversation once per registered repo, so the headline grew with how many
		// repos the user had registered and was only ever wrong on their own machine.
		const claimed = () => result(tier({ cursor: agent(5, 5, 0) }));
		const lines = render([claimed(), claimed(), claimed()]);
		expect(lines).toEqual([
			"  ✓ 5 AI conversations in the last 7 days: 5 processed, 0 skipped",
			"      cursor  5 found, 5 processed, 0 skipped",
		]);
	});

	it("reports a shared conversation as processed when any repo read it", () => {
		// The same conversation read here and already-current there is a conversation this
		// run read. Taking the last repo's answer instead would make the headline depend
		// on registry order.
		const lines = render([result(tier({ claude: agent(1, 1, 0) })), result(tier({ claude: agent(1, 0, 1) }))]);
		expect(lines).toEqual([
			"  ✓ 1 AI conversation in the last 7 days: 1 processed, 0 skipped",
			"      claude  1 found, 1 processed, 0 skipped",
		]);
	});

	it("breaks an agent tie alphabetically, so the block is stable across runs", () => {
		const lines = render([result(tier({ kimi: agent(2, 2, 0), claude: agent(2, 2, 0) }))]);
		expect(lines.slice(1)).toEqual([
			"      claude  2 found, 2 processed, 0 skipped",
			"      kimi    2 found, 2 processed, 0 skipped",
		]);
	});

	it("prints the headline alone when the window turned up nothing", () => {
		// An empty split is not a reason to withhold the headline: the run still
		// happened, and a list of zeroes for absent tools says less than no list.
		const lines = render([result(tier({}))]);
		expect(lines).toEqual(["  ✓ 0 AI conversations in the last 7 days: 0 processed, 0 skipped"]);
	});

	it("says nothing when no repo reached the session tier", () => {
		expect(render([result(undefined)])).toEqual([]);
		expect(render([])).toEqual([]);
	});
});

describe("createDeferredWriter", () => {
	it("holds every line until something reveals it, then prints in order", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		// `console.log` is already spied in the global beforeEach, so vi.spyOn hands
		// back that same instance carrying earlier tests' calls; clear it here (as the
		// third case below already does) so the absolute-sequence assertions hold even
		// when clearMocks is not in effect — e.g. run from the repo root rather than
		// the cli workspace, where no vitest config applies it.
		log.mockClear();
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
		log.mockClear(); // shared spy — drop earlier tests' calls (see the case above)
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

describe("resolveServerCwd", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "jolli-servercwd-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("resolves to the git top level when the cwd is inside a repo", async () => {
		const root = mkdtempSync(join(tmpdir(), "jolli-root-"));
		try {
			const resolved = await resolveServerCwd(tmp, async () => root);
			expect(resolved).toBe(root);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("falls back to process.cwd() when --cwd does not exist", async () => {
		const missing = join(tmp, "does-not-exist");
		// base becomes process.cwd(); the injected getRoot echoes it back.
		const resolved = await resolveServerCwd(missing, async (c) => c);
		expect(resolved).toBe(process.cwd());
	});

	it("keeps the validated dir when it is not inside a git repo", async () => {
		const resolved = await resolveServerCwd(tmp, async () => {
			throw new Error("not a git repository");
		});
		expect(resolved).toBe(tmp);
	});

	it("ignores a git root that no longer exists", async () => {
		const resolved = await resolveServerCwd(tmp, async () => join(tmp, "gone"));
		expect(resolved).toBe(tmp);
	});
});
