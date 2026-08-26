import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LogLevel } from "../Types.js";

/**
 * The log is the only way to observe this task in production — its result string goes
 * to the scheduler's DEBUG line, which is below the default file threshold — so what
 * lands at INFO and WARN is behaviour, not decoration, and is asserted here.
 *
 * Captured through a fake logger rather than by reading `debug.log`, so the cases stay
 * independent of the log file's location and rotation.
 */
const { logLines } = vi.hoisted(() => ({
	logLines: [] as Array<{ level: string; text: string }>,
}));

vi.mock("../Logger.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../Logger.js")>();
	// Rendered through the REAL formatter rather than by concatenating the format string
	// with its args. These lines carry their subject inside a `%s` — `[%s] armed`, `scan
	// failed for %s` — so an un-interpolated capture asserts on text production never
	// emits, and would pass just as happily if the argument were dropped. Reusing
	// `formatLogMessage` also keeps the printf rules in one place.
	const record =
		(level: LogLevel, module: string) =>
		(message: string, ...args: unknown[]): void => {
			logLines.push({ level, text: original.formatLogMessage(level, module, message, args) });
		};
	return {
		...original,
		createLogger: (module: string) => ({
			debug: record("debug", module),
			info: record("info", module),
			warn: record("warn", module),
			error: record("error", module),
		}),
	};
});

vi.mock("../dashboard/RepoRegistry.js", () => ({
	listActiveRepos: vi.fn(),
	existingWorktrees: vi.fn(),
}));
// The capability gate. Defaults to "this runtime can" in `beforeEach`, so only the
// case that is about the floor has to say otherwise.
vi.mock("../dashboard/DashboardDb.js", () => ({
	canUseDashboardDb: vi.fn(),
}));
vi.mock("../core/RepoProfile.js", () => ({
	readManualDisableFlagReadonly: vi.fn(),
}));
vi.mock("../dashboard/DbBackfill.js", () => ({
	dbRescanSessions: vi.fn(),
}));

import { readManualDisableFlagReadonly } from "../core/RepoProfile.js";
import { DAEMON_RESCAN_SOURCES } from "../core/sessions/SessionSources.js";
import { canUseDashboardDb } from "../dashboard/DashboardDb.js";
import { dbRescanSessions } from "../dashboard/DbBackfill.js";
import { existingWorktrees, listActiveRepos, type RegisteredRepo } from "../dashboard/RepoRegistry.js";
import { SESSION_RESCAN_TASK_NAME, SESSION_RESCAN_TICK_MS, sessionRescanTask } from "./SessionRescanTask.js";

const repo: RegisteredRepo = {
	repoIdentity: "https://github.com/jolliai/jolliai",
	repoName: "jolliai",
	worktreeRoot: "/w/jolliai",
	enabledAt: "2026-01-01T00:00:00.000Z",
};

/** An outcome with every field at its idle value, overridden per case. */
const outcome = (over: Partial<Awaited<ReturnType<typeof dbRescanSessions>>> = {}) => ({
	reposScanned: 1,
	reposWithoutBaseline: 0,
	discovered: 0,
	processed: 0,
	eventsApplied: 0,
	failedSources: [],
	failedEvents: 0,
	...over,
});

/**
 * The default mock, honouring `dbRescanSessions`' real seeding contract: `onSeeded` fires
 * the moment the seed has been merged, which is BEFORE any phase that can throw.
 *
 * A case that only wants a resolved value uses `mockResolvedValueOnce` and thereby skips
 * the callback — which is exactly the shape of a pass that returned before phase 1, and is
 * what the "still owed" cases below rely on.
 */
const seedingPass = async (opts: Parameters<typeof dbRescanSessions>[0]) => {
	if (opts.seedEmitted) opts.onSeeded?.();
	return outcome();
};

const infoLines = (): ReadonlyArray<string> => logLines.filter((l) => l.level === "info").map((l) => l.text);
const warnLines = (): ReadonlyArray<string> => logLines.filter((l) => l.level === "warn").map((l) => l.text);

beforeEach(() => {
	logLines.length = 0;
	vi.mocked(canUseDashboardDb).mockReturnValue(true);
	vi.mocked(listActiveRepos).mockResolvedValue([repo]);
	vi.mocked(existingWorktrees).mockReturnValue([repo.worktreeRoot]);
	vi.mocked(readManualDisableFlagReadonly).mockResolvedValue(false);
	vi.mocked(dbRescanSessions).mockImplementation(seedingPass);
});

describe("sessionRescanTask", () => {
	it("registers under the shared name and the constant interval", () => {
		const task = sessionRescanTask();

		expect(task.name).toBe(SESSION_RESCAN_TASK_NAME);
		expect(task.tickIntervalMs).toBe(SESSION_RESCAN_TICK_MS);
	});

	it("announces once rather than on every tick", async () => {
		const task = sessionRescanTask();

		await task.run();
		await task.run();

		// The line that makes "nothing changed" distinguishable from "never ran". Once
		// per task instance: at 30-second ticks, repeating it would be 2,880 lines a day.
		expect(infoLines().filter((line) => line.includes("armed"))).toHaveLength(1);
	});

	it("reports the interval in seconds and the sources it watches", async () => {
		await sessionRescanTask(60_000).run();

		// Derived from the registry rather than spelled out, so opting another source
		// into `daemonRescan` does not have to be re-typed here.
		expect(infoLines()[0]).toContain(`[${DAEMON_RESCAN_SOURCES.map((d) => d.source).join(",")}]`);
		expect(infoLines()[0]).toContain("every 60s");
	});

	it("stops before the registry on a runtime without node:sqlite", async () => {
		// The sibling backup task gates the same way and answers `skipped`. Without this
		// the tick would throw every 30 s and the scheduler would warn 2,880 times a day
		// about a machine that cannot run the feature at all.
		vi.mocked(canUseDashboardDb).mockReturnValue(false);

		await expect(sessionRescanTask().run()).resolves.toBe("node:sqlite unavailable on this runtime");
		expect(listActiveRepos).not.toHaveBeenCalled();
		expect(dbRescanSessions).not.toHaveBeenCalled();
		// Quietly: it is a capability, not a fault. Only the once-per-instance `armed`
		// line is owed.
		expect(warnLines()).toEqual([]);
	});

	it("stops at the registry when nothing is registered", async () => {
		vi.mocked(listActiveRepos).mockResolvedValue([]);

		await expect(sessionRescanTask().run()).resolves.toBe("no registered repos");
		expect(dbRescanSessions).not.toHaveBeenCalled();
	});

	it("skips a repo the user has disabled, and never reaches the database", async () => {
		vi.mocked(readManualDisableFlagReadonly).mockResolvedValue(true);

		await expect(sessionRescanTask().run()).resolves.toBe("all 1 repo(s) disabled");
		expect(dbRescanSessions).not.toHaveBeenCalled();
	});

	it("treats any disabled checkout as disabling the repo", async () => {
		// Rows are keyed by `repoIdentity`, shared by every checkout, so there is no half
		// of the data to leave alone — the opt-out has to win.
		vi.mocked(existingWorktrees).mockReturnValue(["/w/clone-a", "/w/clone-b"]);
		vi.mocked(readManualDisableFlagReadonly).mockImplementation(async (root: string) => root === "/w/clone-b");

		await expect(sessionRescanTask().run()).resolves.toBe("all 1 repo(s) disabled");
	});

	it("logs at INFO when a conversation was actually re-read", async () => {
		vi.mocked(dbRescanSessions).mockResolvedValue(outcome({ discovered: 9, processed: 2, eventsApplied: 2 }));

		const line = await sessionRescanTask().run();

		expect(line).toBe("re-read 2 of 9 session(s) across 1 repo(s), 2 event(s) applied");
		expect(infoLines().some((l) => l.includes("re-read 2 of 9"))).toBe(true);
	});

	it("keeps an unchanged tick out of the log", async () => {
		vi.mocked(dbRescanSessions).mockResolvedValue(outcome({ discovered: 9 }));

		const line = await sessionRescanTask().run();

		// Returned for the scheduler's debug line, deliberately not raised to INFO: this
		// is the normal tick and would otherwise bury the ones that matter.
		expect(line).toBe("9 session(s) unchanged across 1 repo(s)");
		expect(infoLines().some((l) => l.includes("unchanged"))).toBe(false);
	});

	it("warns once about a missing baseline, then re-arms when it resolves and returns", async () => {
		vi.mocked(dbRescanSessions).mockResolvedValue(outcome({ reposScanned: 0, reposWithoutBaseline: 1 }));
		const task = sessionRescanTask();

		await task.run();
		await task.run();
		expect(warnLines().filter((l) => l.includes("no baseline"))).toHaveLength(1);

		// A dashboard run establishes the baseline...
		vi.mocked(dbRescanSessions).mockResolvedValue(outcome());
		await task.run();
		// ...and if it is later lost, the warning is owed again.
		vi.mocked(dbRescanSessions).mockResolvedValue(outcome({ reposScanned: 0, reposWithoutBaseline: 1 }));
		await task.run();

		expect(warnLines().filter((l) => l.includes("no baseline"))).toHaveLength(2);
	});

	it("warns about repos without a baseline even when others were scanned", async () => {
		// The silent case this closes: one baselined repo makes the tick look healthy
		// while five others are never visited, with no line anywhere saying so.
		vi.mocked(dbRescanSessions).mockResolvedValue(outcome({ reposScanned: 1, reposWithoutBaseline: 5 }));

		const line = await sessionRescanTask().run();

		// The RESULT still describes the work that happened — the warning is the only
		// place the skipped repos are reported.
		expect(line).toBe("0 session(s) unchanged across 1 repo(s)");
		expect(warnLines().some((l) => l.includes("no baseline yet for 5 of 6 repo(s)"))).toBe(true);
	});

	it("warns about a source whose scan failed", async () => {
		vi.mocked(dbRescanSessions).mockResolvedValue(outcome({ failedSources: ["codex"] }));

		await sessionRescanTask().run();

		expect(warnLines().some((l) => l.includes("scan failed for codex"))).toBe(true);
	});

	it("says a standing scan failure once, per source, and re-arms when one recovers", async () => {
		// Tracked as a SET rather than one boolean, which would be wrong in both
		// directions: a second source failing later would be swallowed by the first's
		// flag, and a recovered source would leave it stuck. Warning every tick — what
		// this did — is 5,760 lines a day counting `scanAllStores`' own line, with tick 1
		// and tick 2,880 indistinguishable.
		vi.mocked(dbRescanSessions).mockResolvedValue(outcome({ failedSources: ["codex"] }));
		const task = sessionRescanTask();

		await task.run();
		await task.run();
		expect(warnLines().filter((l) => l.includes("scan failed"))).toHaveLength(1);

		// A second source joins: said, even though the first is still failing.
		vi.mocked(dbRescanSessions).mockResolvedValue(outcome({ failedSources: ["codex", "claude"] }));
		await task.run();
		expect(warnLines().filter((l) => l.includes("scan failed"))).toHaveLength(2);
		// Names only the NEW one. (The `[codex]` prefix on every line is the source tag —
		// the filter key for this feature's whole output — not part of the message.)
		expect(warnLines().at(-1)).toContain("scan failed for claude");
		expect(warnLines().at(-1)).not.toContain("scan failed for codex");

		// Both recover, then codex fails again — owed a fresh line.
		vi.mocked(dbRescanSessions).mockResolvedValue(outcome());
		await task.run();
		vi.mocked(dbRescanSessions).mockResolvedValue(outcome({ failedSources: ["codex"] }));
		await task.run();
		expect(warnLines().filter((l) => l.includes("scan failed"))).toHaveLength(3);
	});

	it("distinguishes the three reasons a tick did nothing", async () => {
		// One all-zero result used to render as "no baseline yet for 0 repo(s) -- run
		// 'jolli dashboard' once": a command that would change nothing, a count of zero,
		// and in one case repositories that no longer exist.
		vi.mocked(dbRescanSessions).mockResolvedValue(outcome({ reposScanned: 0, idleReason: "no-sources" }));
		expect(await sessionRescanTask().run()).toBe("no source has opted in -- nothing to do");

		vi.mocked(dbRescanSessions).mockResolvedValue(outcome({ reposScanned: 0, idleReason: "no-live-repos" }));
		expect(await sessionRescanTask().run()).toBe("no live checkout for 1 repo(s)");

		vi.mocked(dbRescanSessions).mockResolvedValue(outcome({ reposScanned: 0, reposWithoutBaseline: 2 }));
		expect(await sessionRescanTask().run()).toBe("no baseline yet for 2 repo(s) -- run 'jolli dashboard' once");
	});

	it("warns once about parked events, then re-arms when they clear and return", async () => {
		// Same once-per-situation shape as the baseline warning, for the same reason: a
		// standing condition said every 30 s is 2,880 lines a day. This is the only place
		// a parked event is reported at all — nothing queries `events_raw`, and the prune
		// deletes only `projected` rows, so a failure neither surfaces nor ages out.
		vi.mocked(dbRescanSessions).mockResolvedValue(outcome({ failedEvents: 12 }));
		const task = sessionRescanTask();

		await task.run();
		await task.run();
		expect(warnLines().filter((l) => l.includes("parked unprojected"))).toHaveLength(1);
		expect(warnLines().some((l) => l.includes("12 event(s) parked unprojected"))).toBe(true);

		vi.mocked(dbRescanSessions).mockResolvedValue(outcome({ failedEvents: 0 }));
		await task.run();
		vi.mocked(dbRescanSessions).mockResolvedValue(outcome({ failedEvents: 3 }));
		await task.run();

		expect(warnLines().filter((l) => l.includes("parked unprojected"))).toHaveLength(2);
	});

	it("says nothing when no event is parked", async () => {
		await sessionRescanTask().run();

		expect(warnLines().some((l) => l.includes("parked"))).toBe(false);
	});

	it("seeds the emission gate on the first tick only, against one shared map", async () => {
		// Seeding is a full scan of the largest table. Repeating it would put that scan
		// on the 30-second path, which is the whole reason the gate lives in memory. The
		// map must be the SAME object across ticks — a fresh one per tick would record
		// nothing and the gate would never fire.
		const task = sessionRescanTask();

		await task.run();
		await task.run();
		await task.run();

		const calls = vi.mocked(dbRescanSessions).mock.calls;
		expect(calls.map((c) => c[0].seedEmitted)).toEqual([true, false, false]);
		expect(new Set(calls.map((c) => c[0].emitted)).size).toBe(1);
		expect(calls[0]?.[0].emitted).toBeInstanceOf(Map);
	});

	it("re-seeds when the tick that would have seeded threw", async () => {
		// A tick that died before phase 1 never read the log, so the seed is still owed.
		vi.mocked(dbRescanSessions).mockRejectedValueOnce(new Error("database busy"));
		const task = sessionRescanTask();

		await task.run();
		await task.run();

		expect(vi.mocked(dbRescanSessions).mock.calls.map((c) => c[0].seedEmitted)).toEqual([true, true]);
	});

	it("re-seeds when a pass RESOLVED without reaching the seed", async () => {
		// The other half, and the one a resolving early return hides: three of
		// `dbRescanSessions`' exits come before phase 1, so "the call resolved" is not
		// "the log was read". Keying the flag on the former left a process that started
		// while every checkout was missing permanently unseeded — and it then re-emitted
		// once for every already-parked session on its first productive tick.
		vi.mocked(dbRescanSessions).mockResolvedValueOnce(outcome({ reposScanned: 0, idleReason: "no-live-repos" }));
		const task = sessionRescanTask();

		await task.run();
		await task.run();

		expect(vi.mocked(dbRescanSessions).mock.calls.map((c) => c[0].seedEmitted)).toEqual([true, true]);
	});

	it("does NOT re-seed when the seed landed and a LATER phase threw", async () => {
		// The half a result field structurally could not carry. Phase 3's writer open comes
		// after the seed — write contention with a git hook is enough to throw there — so
		// keying the flag on the resolved value meant a standing fault re-ran a full scan of
		// the largest table every 30 s, while the merge it had already produced sat in
		// memory, paid for and unused.
		vi.mocked(dbRescanSessions).mockImplementationOnce(async (opts) => {
			opts.onSeeded?.();
			throw new Error("database is locked");
		});
		const task = sessionRescanTask();

		await task.run();
		await task.run();

		expect(vi.mocked(dbRescanSessions).mock.calls.map((c) => c[0].seedEmitted)).toEqual([true, false]);
	});

	it("says a database that is not there apart from a missing baseline", async () => {
		// Nothing has been imported, so `jolli dashboard` is the right advice but the
		// baseline wording is not: it reads as "your import is incomplete". A background
		// timer must not create the database itself, so this is an answer, not a repair.
		vi.mocked(dbRescanSessions).mockResolvedValue(outcome({ reposScanned: 0, idleReason: "no-database" }));

		await expect(sessionRescanTask().run()).resolves.toBe(
			"no dashboard database yet -- run 'jolli dashboard' once",
		);
	});

	it("warns once about a database that is present and unreadable", async () => {
		// The one idle answer that IS a fault, so unlike its siblings it warns. It arrives as
		// an idle reason rather than a rejection precisely so it can be said this way: as a
		// throw it was ONE warn for the daemon's entire lifetime (the dedup key is the
		// message) followed by permanent silence, for a state nothing on this path repairs.
		vi.mocked(dbRescanSessions).mockResolvedValue(outcome({ reposScanned: 0, idleReason: "database-unusable" }));
		const task = sessionRescanTask();

		await expect(task.run()).resolves.toBe("dashboard database unusable");
		await task.run();
		await task.run();

		expect(warnLines().filter((l) => l.includes("unreadable"))).toHaveLength(1);
	});

	it("re-arms the unreadable-database warning once the database is usable again", async () => {
		// The half its own comment promised and did not deliver. The `sayOnce` call lived
		// INSIDE the `database-unusable` branch and passed a constant, so the only path that
		// could have cleared the topic was the one reached when the condition still held —
		// nothing could. One transient failure (the sibling backup task holding the write lock
		// through `VACUUM INTO`, an `EMFILE`, a schema the read-only handle cannot migrate)
		// therefore spent the warning for the process, and this daemon has no idle timeout, so
		// real corruption afterwards was silent for the machine's whole uptime.
		vi.mocked(dbRescanSessions).mockResolvedValue(outcome({ reposScanned: 0, idleReason: "database-unusable" }));
		const task = sessionRescanTask();
		await task.run();
		expect(warnLines().filter((l) => l.includes("unreadable"))).toHaveLength(1);

		// A healthy tick clears the topic...
		vi.mocked(dbRescanSessions).mockResolvedValue(outcome({ reposScanned: 1 }));
		await task.run();
		expect(warnLines().filter((l) => l.includes("unreadable"))).toHaveLength(1);

		// ...so the fault returning is said again.
		vi.mocked(dbRescanSessions).mockResolvedValue(outcome({ reposScanned: 0, idleReason: "database-unusable" }));
		await task.run();

		expect(warnLines().filter((l) => l.includes("unreadable"))).toHaveLength(2);
	});

	it("warns once about a standing tick failure, then re-arms when it clears", async () => {
		// Resolving rather than rejecting is the behaviour under test. `TaskScheduler` warns
		// on every rejection and keeps the schedule, so a corrupt or unreadable
		// `jollimemory.db` — a standing condition — reached it 2,880 times a day, with tick
		// 1 and tick 2,880 indistinguishable.
		vi.mocked(dbRescanSessions).mockRejectedValue(new Error("database disk image is malformed"));
		const task = sessionRescanTask();

		await expect(task.run()).resolves.toBe("failed: database disk image is malformed");
		await task.run();
		await task.run();
		expect(warnLines().filter((l) => l.includes("tick failed"))).toHaveLength(1);
		expect(warnLines().at(-1)).toContain("database disk image is malformed");

		// A DIFFERENT fault is still said — the message is the dedup key, not a boolean.
		vi.mocked(dbRescanSessions).mockRejectedValue(new Error("disk full"));
		await task.run();
		expect(warnLines().filter((l) => l.includes("tick failed"))).toHaveLength(2);

		// And a good tick re-arms it, so a fault that returns is reported again.
		vi.mocked(dbRescanSessions).mockResolvedValue(outcome());
		await task.run();
		vi.mocked(dbRescanSessions).mockRejectedValue(new Error("disk full"));
		await task.run();
		expect(warnLines().filter((l) => l.includes("tick failed"))).toHaveLength(3);
	});

	it("passes its cap down instead of clearing the gate itself", async () => {
		// The bound is enforced where the writes happen — `dbRescanSessions` refuses a NEW
		// key once the map is full — because clearing here could not converge: the seed is
		// drawn from the same population that overflowed, so a clear plus a re-seed lands
		// back over the limit on the very next tick, every 30 s, with the gate empty the
		// whole time.
		const task = sessionRescanTask();

		await task.run();

		expect(vi.mocked(dbRescanSessions).mock.calls[0]?.[0].emittedLimit).toBe(50_000);
	});

	it("says once that the gate is full, and does not re-seed because of it", async () => {
		// Saturation is a real (bounded) cost with no other symptom: sessions past the cap
		// are re-read on every tick, as they were before the gate existed.
		vi.mocked(dbRescanSessions).mockImplementation(async (opts) => {
			if (opts.seedEmitted) opts.onSeeded?.();
			for (let i = 0; i < 50_000; i++) opts.emitted?.set(`session:r:codex:s${i}`, i);
			return outcome();
		});
		const task = sessionRescanTask();

		await task.run();
		await task.run();
		await task.run();

		expect(warnLines().filter((l) => l.includes("emission gate full"))).toHaveLength(1);
		expect(vi.mocked(dbRescanSessions).mock.calls.map((c) => c[0].seedEmitted)).toEqual([true, false, false]);
	});

	it("gives each task instance its own gate", async () => {
		// Module-scope state would leak one daemon's map into the next, which matters most
		// in tests but is also what the once-only flags avoid for the same reason.
		await sessionRescanTask().run();
		await sessionRescanTask().run();

		const calls = vi.mocked(dbRescanSessions).mock.calls;
		expect(calls[0]?.[0].emitted).not.toBe(calls[1]?.[0].emitted);
	});
});
