import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withDashboardDb } from "./DashboardDb.js";
import type { SeriesDimension, StatsEventEnvelope } from "./DashboardModel.js";
import { buildDashboardModel } from "./DashboardQuery.js";
import {
	BUILT_KIND,
	buildRollup,
	buildRollupQuietly,
	forgetRollupDays,
	ROLLUP_AXES,
	ROLLUP_KINDS,
	readAvailableDays,
	readRollupSeries,
	TOKENS_KIND,
} from "./StatsRollup.js";
import { applyStatsEvents } from "./StatsWriter.js";

const UTC = "UTC";
/** 2026-07-30 12:00 UTC — "today" for every case here. */
const NOW = Date.parse("2026-07-30T12:00:00Z");
const day = (key: string, hour = 10) => Date.parse(`${key}T${String(hour).padStart(2, "0")}:00:00Z`);

function session(
	id: string,
	atMs: number,
	usage: ReadonlyArray<{ respondedAtMs: number; model: string; input: number; output: number }>,
): StatsEventEnvelope {
	return {
		event: {
			type: "session.upserted",
			repoIdentity: "repo-1",
			source: "claude",
			sessionId: id,
			updatedAtMs: atMs,
			messageCount: 2,
			usageEvents: usage.map((u) => ({ ...u, cached: 0, estCostUsd: 0.5, dedupKey: `${id}:${u.respondedAtMs}` })),
		},
		producerKind: "cli",
	};
}

describe("stats rollup", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jolli-rollup-"));
		dbPath = join(dir, "dashboard.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// Zone-scoped on purpose. `applyStatsEvents` settles days too (that is the
	// production wiring), in the MACHINE's zone — so an unscoped read here would
	// mix two calendars and the assertion would depend on where the test runs.
	const rollupRows = async (tz: string = UTC) =>
		withDashboardDb(
			(db) =>
				db
					.prepare(
						`SELECT repo_id, day, kind, series_key, value, cost_usd FROM stats_daily
						  WHERE tz = ? ORDER BY day, kind, series_key`,
					)
					.all(tz) as ReadonlyArray<Record<string, unknown>>,
			{ dbPath },
		);

	it("keeps the kind namespace free of collisions with the axis names", () => {
		// `tokens` and `built` are invented here while the rest come from the
		// dimension union; a new dimension taking one of those names would make a
		// day's token split readable as an axis, with nothing to notice.
		//
		// This only means anything because `ROLLUP_AXES` is DERIVED from
		// `SeriesDimension`. Against the hand-written list it replaced, it asserted
		// that a list did not contain a name — which says nothing about the union,
		// and stayed green for a dimension the list had simply never been told about.
		const axes: ReadonlyArray<SeriesDimension> = ROLLUP_AXES;
		expect(axes).not.toContain(TOKENS_KIND as SeriesDimension);
		expect(axes).not.toContain(BUILT_KIND as SeriesDimension);
		expect(new Set(ROLLUP_KINDS).size).toBe(ROLLUP_KINDS.length);
	});

	it("caches every dimension the page can draw, so none reads zero on a settled day", () => {
		// The failure this guards is silent and one-directional: an axis absent from
		// `ROLLUP_AXES` is never built, but `buildSeries` still treats every settled
		// day as covered — the cache answers nothing for that kind and the live pass
		// fills only `plan.live`, so the axis loses its whole cached history while
		// still drawing a plausible chart. `SeriesDimension` is spelled out here on
		// purpose: deriving both sides from one constant would assert nothing.
		const everyDimension: ReadonlyArray<SeriesDimension> = [
			"model",
			"agent",
			"project",
			"branch",
			"ticket",
			"category",
		];
		expect([...ROLLUP_AXES].sort()).toEqual([...everyDimension].sort());
	});

	it("settles a past day and marks it available", async () => {
		await applyStatsEvents(
			[
				session("s1", day("2026-07-28", 23), [
					{ respondedAtMs: day("2026-07-28", 9), model: "claude-opus-5", input: 100, output: 10 },
					{ respondedAtMs: day("2026-07-28", 21), model: "claude-opus-5", input: 200, output: 20 },
				]),
			],
			{ producerKind: "cli", dbPath, now: () => NOW },
		);
		await withDashboardDb((db) => buildRollup(db, { now: () => NOW, timeZone: UTC }), { dbPath });

		const tokens = (await rollupRows()).filter((r) => r.kind === TOKENS_KIND && r.day === "2026-07-28");
		expect(tokens.map((r) => [r.series_key, r.value])).toEqual([
			["cached", 0],
			["input", 300],
			["output", 30],
		]);

		const available = await withDashboardDb((db) => readAvailableDays(db, UTC, ["2026-07-28", "2026-07-29"], NOW), {
			dbPath,
		});
		expect(available.has("2026-07-28")).toBe(true);
		// A quiet day is still settled — the sentinel is what separates "computed,
		// nothing happened" from "never computed".
		expect(available.has("2026-07-29")).toBe(true);
	});

	it("a build that does not know every migration in the file settles no day", async () => {
		// Nothing refuses such a database, but the CACHE is a different question from
		// the source tables: the expiry test reads every source table's write stamp, and
		// a build that does not know a table added since cannot see it change — it would
		// settle an already-incomplete day and keep serving it. Declining costs a
		// recomputation per render.
		//
		// The condition is "the log names a migration I do not have", not "the version
		// number is higher". The number moved only with DDL, so it missed a newer build
		// whose change added no columns and fired for one whose additions this build
		// reads perfectly well.
		await applyStatsEvents(
			[
				session("s1", day("2026-07-28", 23), [
					{ respondedAtMs: day("2026-07-28", 9), model: "m", input: 1, output: 1 },
				]),
			],
			{ producerKind: "cli", dbPath, now: () => NOW },
		);
		await withDashboardDb((db) => db.exec("DELETE FROM stats_daily"), { dbPath });
		await withDashboardDb(
			(db) => {
				db.prepare(
					`INSERT INTO schema_migrations (slot, name, outcome, applied_by, applied_at_ms, duration_ms, ddl)
					 VALUES (99, '2099-01-01-0000-from-the-future', 'applied', 'cli/99.0.0', 0, 0, '')`,
				).run();
				buildRollupQuietly(db, { now: () => NOW, timeZone: UTC });
			},
			{ dbPath },
		);
		expect(await rollupRows()).toEqual([]);

		// And a build that DOES know every migration settles it on the next write, so
		// the only cost was the delay.
		await withDashboardDb(
			(db) => {
				db.prepare("DELETE FROM schema_migrations WHERE name = '2099-01-01-0000-from-the-future'").run();
				buildRollupQuietly(db, { now: () => NOW, timeZone: UTC });
			},
			{ dbPath },
		);
		expect((await rollupRows()).length).toBeGreaterThan(0);
	});

	it("never settles today, however many times it runs", async () => {
		await applyStatsEvents(
			[session("s1", NOW, [{ respondedAtMs: NOW, model: "claude-opus-5", input: 5, output: 5 }])],
			{ producerKind: "cli", dbPath, now: () => NOW },
		);
		await withDashboardDb((db) => buildRollup(db, { now: () => NOW, timeZone: UTC }), { dbPath });

		const days = new Set((await rollupRows()).map((r) => r.day));
		expect(days.has("2026-07-30")).toBe(false);
		const available = await withDashboardDb((db) => readAvailableDays(db, UTC, ["2026-07-30"], NOW), { dbPath });
		expect(available.size).toBe(0);
	});

	it("expires a settled day when a source row lands on it afterwards", async () => {
		await withDashboardDb((db) => buildRollup(db, { now: () => NOW, timeZone: UTC }), { dbPath });
		const before = await withDashboardDb((db) => readAvailableDays(db, UTC, ["2026-07-28"], NOW), { dbPath });
		expect(before.has("2026-07-28")).toBe(true);

		// A session discovered later, carrying a response that belongs to the 28th.
		//
		// ⚠ `skipRollup`, because the subject here is the READ-side staleness check
		// and the write path settles days of its own accord — in the MACHINE's
		// zone, which on a UTC machine is the very calendar this case asserts in.
		// There the write would re-settle the 28th (correctly, with the new row in
		// it) before the read ever looked, stamping `built_at_ms` from the same
		// `now` as the row it just wrote — so the day reads as fresh and this
		// assertion inverts, on that machine only. Skipping the settle is safe by
		// construction: the cache is derived, and a day nobody settles is computed
		// live.
		await applyStatsEvents(
			[
				session("late", day("2026-07-29", 8), [
					{ respondedAtMs: day("2026-07-28", 9), model: "claude-opus-5", input: 70, output: 7 },
				]),
			],
			{ producerKind: "cli", dbPath, now: () => NOW + 60_000, skipRollup: true },
		);

		const after = await withDashboardDb((db) => readAvailableDays(db, UTC, ["2026-07-28"], NOW), { dbPath });
		expect(after.has("2026-07-28")).toBe(false);
	});

	/**
	 * A REWRITTEN commit is where the staleness test and the axes used to date one
	 * memory differently, and the difference is a permanently wrong number.
	 *
	 * The memory stays filed under its pre-rewrite hash, so it has no `commits` row
	 * of its own and the axes reach the surviving commit through `commit_aliases` —
	 * landing the spend on that commit's committer date. The staleness scan used to
	 * spell its own `COALESCE(c.committed_at_ms, m.commit_date_ms)`, which for this
	 * shape falls through to the AUTHOR date: it expired a day nothing was drawn on
	 * and left the day that really changed serving its old numbers. Both now go
	 * through `MEMORY_LANDED_AT_MS`.
	 */
	it("expires the day a rewritten commit's memory actually lands on", async () => {
		const landed = "2026-07-28";
		const authored = "2026-07-20";
		await withDashboardDb(
			(db) => {
				db.prepare(
					`INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at)
					 VALUES ('repo-1', 'r', '/r', '1970-01-01T00:00:00.000Z')`,
				).run();
				const repoId = (db.prepare("SELECT id FROM repos").get() as { id: number }).id;
				db.prepare(
					`INSERT INTO commits (event_id, repo_id, hash, branch, message, committed_at_ms, written_at_ms)
					 VALUES ('c:new', ?, 'newhash', 'main', 'm', ?, ?)`,
				).run(repoId, day(landed), day(landed));
				// tokens / est_cost_usd are GENERATED from summary_json.
				db.prepare(
					`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
					                       summary_json, first_seen_ms, written_at_ms, commit_date_ms)
					 VALUES (?, 'oldhash', NULL, NULL, 'oldhash', 0, ?, ?, ?, ?)`,
				).run(
					repoId,
					JSON.stringify({ conversationTokens: 500, estimatedCostUsd: 0.5 }),
					day(landed),
					day(landed),
					day(authored),
				);
				db.prepare(
					`INSERT INTO commit_aliases (repo_id, old_hash, target_hash, created_ms)
					 VALUES (?, 'newhash', 'oldhash', ?)`,
				).run(repoId, day(landed));
				buildRollup(db, { now: () => NOW, timeZone: UTC });
			},
			{ dbPath },
		);
		const before = await withDashboardDb((db) => readAvailableDays(db, UTC, [landed, authored], NOW), { dbPath });
		expect([...before].sort()).toEqual([authored, landed]);

		// A memory-only write: re-summarising touches no `commits` row, so the
		// commit-side arm of the scan cannot cover for a wrong landing expression.
		await withDashboardDb(
			(db) => db.prepare("UPDATE memories SET written_at_ms = ? WHERE commit_hash = 'oldhash'").run(NOW + 60_000),
			{ dbPath },
		);

		const after = await withDashboardDb((db) => readAvailableDays(db, UTC, [landed, authored], NOW), { dbPath });
		expect(after.has(landed)).toBe(false);
		// And the author date's day is NOT the one that expired — the old spelling
		// had this exactly the wrong way round.
		expect(after.has(authored)).toBe(true);
	});

	it("leaves settled days alone when the only new activity is dated today", async () => {
		// The property the staleness scan's day bound rests on: today is never a
		// candidate (it is still accumulating), so a row dated today cannot invalidate
		// any settled day. That was already true — the bound is what stops such rows
		// being READ, which on a machine older than the horizon was every row written
		// in the last ~90 days, materialised and day-keyed one at a time on the
		// writer's lock. See `readSourcesWrittenSince`.
		await applyStatsEvents(
			[
				session("s1", day("2026-07-28", 12), [
					{ respondedAtMs: day("2026-07-28", 9), model: "claude-opus-5", input: 100, output: 0 },
				]),
			],
			{ producerKind: "cli", dbPath, now: () => NOW },
		);
		await withDashboardDb((db) => buildRollup(db, { now: () => NOW, timeZone: UTC }), { dbPath });
		expect(
			(await withDashboardDb((db) => readAvailableDays(db, UTC, ["2026-07-28"], NOW), { dbPath })).has(
				"2026-07-28",
			),
		).toBe(true);

		// A brand-new session on NOW's own day, written afterwards.
		await applyStatsEvents(
			[
				session("s2", day("2026-07-30", 11), [
					{ respondedAtMs: day("2026-07-30", 11), model: "claude-opus-5", input: 900, output: 0 },
				]),
			],
			{ producerKind: "cli", dbPath, now: () => NOW + 60_000 },
		);

		const after = await withDashboardDb((db) => readAvailableDays(db, UTC, ["2026-07-28"], NOW), { dbPath });
		expect(after.has("2026-07-28")).toBe(true);
	});

	/**
	 * Pruning an unreachable commit MOVES its memory to another day, and the day it
	 * moves TO has to be forgotten as well.
	 *
	 * `pruneUnreachableCommits` restated the landing rule by hand as
	 * `m.commit_date_ms`, on the reasoning that the expression "falls back to" that
	 * column once the commit row is gone. It skips the middle term — and a prune IS
	 * the alias case, so the memory actually lands on the ALIASING commit's
	 * committer date. The result: the author-date day was forgotten (it had not
	 * changed) and the day that really changed kept serving a number missing this
	 * memory, for ever, since an old day gets no further writes. It now asks
	 * `MEMORY_LANDED_AT_SQL` after the delete.
	 */
	it("expires the day a pruned commit's memory moves TO, not its author date", async () => {
		const authored = "2026-07-20"; // commit_date_ms — the wrong answer
		const pruned = "2026-07-25"; // the unreachable commit's own day
		const landed = "2026-07-28"; // the surviving aliasing commit's day
		const { pruneUnreachableCommits } = await import("./DbBackfill.js");
		await withDashboardDb(
			(db) => {
				db.prepare(
					`INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at)
					 VALUES ('repo-1', 'r', '/r', '1970-01-01T00:00:00.000Z')`,
				).run();
				const repoId = (db.prepare("SELECT id FROM repos").get() as { id: number }).id;
				const insertCommit = db.prepare(
					`INSERT INTO commits (event_id, repo_id, hash, branch, message, committed_at_ms, written_at_ms)
					 VALUES (?, ?, ?, 'main', 'm', ?, ?)`,
				);
				insertCommit.run("c:new", repoId, "newhash", day(landed), day(landed));
				insertCommit.run("c:old", repoId, "oldhash", day(pruned), day(pruned));
				db.prepare(
					`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
					                       summary_json, first_seen_ms, written_at_ms, commit_date_ms)
					 VALUES (?, 'oldhash', NULL, NULL, 'oldhash', 0, ?, ?, ?, ?)`,
				).run(
					repoId,
					JSON.stringify({ conversationTokens: 500, estimatedCostUsd: 0.5 }),
					day(pruned),
					day(pruned),
					day(authored),
				);
				db.prepare(
					`INSERT INTO commit_aliases (repo_id, old_hash, target_hash, created_ms)
					 VALUES (?, 'newhash', 'oldhash', ?)`,
				).run(repoId, day(landed));
				buildRollup(db, { now: () => NOW, timeZone: UTC });
			},
			{ dbPath },
		);
		const before = await withDashboardDb((db) => readAvailableDays(db, UTC, [authored, pruned, landed], NOW), {
			dbPath,
		});
		expect([...before].sort()).toEqual([authored, pruned, landed]);

		// `newhash` survives, `oldhash` does not — the shape a rebase leaves behind.
		await withDashboardDb((db) => pruneUnreachableCommits(db, "repo-1", new Set(["newhash"])), { dbPath });

		const after = await withDashboardDb((db) => readAvailableDays(db, UTC, [authored, pruned, landed], NOW), {
			dbPath,
		});
		// The day it stopped being counted on, and the day it moved to.
		expect(after.has(pruned)).toBe(false);
		expect(after.has(landed)).toBe(false);
		// The author date never had this memory on it and must be left alone — the
		// hand-written spelling forgot exactly this one and nothing else.
		expect(after.has(authored)).toBe(true);
	});

	it("rebuilds an expired day to the new numbers rather than adding to the old", async () => {
		await applyStatsEvents(
			[
				session("s1", day("2026-07-28", 12), [
					{ respondedAtMs: day("2026-07-28", 9), model: "claude-opus-5", input: 100, output: 0 },
				]),
			],
			{ producerKind: "cli", dbPath, now: () => NOW },
		);
		await withDashboardDb((db) => buildRollup(db, { now: () => NOW, timeZone: UTC }), { dbPath });

		// The same session re-read with one more response — the row is replaced,
		// so a rebuild that added instead of replacing would report 300.
		await applyStatsEvents(
			[
				session("s1", day("2026-07-28", 12), [
					{ respondedAtMs: day("2026-07-28", 9), model: "claude-opus-5", input: 100, output: 0 },
					{ respondedAtMs: day("2026-07-28", 15), model: "claude-opus-5", input: 100, output: 0 },
				]),
			],
			{ producerKind: "cli", dbPath, now: () => NOW + 60_000 },
		);
		await withDashboardDb((db) => buildRollup(db, { now: () => NOW + 120_000, timeZone: UTC }), { dbPath });

		const input = (await rollupRows()).find((r) => r.day === "2026-07-28" && r.series_key === "input");
		expect(input?.value).toBe(200);
	});

	it("stops at the day budget and drains the rest on the next call", async () => {
		const built = await withDashboardDb((db) => buildRollup(db, { now: () => NOW, timeZone: UTC, maxDays: 3 }), {
			dbPath,
		});
		expect(built).toBe(3);
		// Newest first: the days a reader is about to ask for settle before the
		// ones nobody has open.
		const days = [...new Set((await rollupRows()).map((r) => r.day))].sort();
		expect(days).toEqual(["2026-07-27", "2026-07-28", "2026-07-29"]);

		const more = await withDashboardDb((db) => buildRollup(db, { now: () => NOW, timeZone: UTC, maxDays: 2 }), {
			dbPath,
		});
		expect(more).toBe(2);
		expect([...new Set((await rollupRows()).map((r) => r.day))].sort()).toEqual([
			"2026-07-25",
			"2026-07-26",
			"2026-07-27",
			"2026-07-28",
			"2026-07-29",
		]);
	});

	it("answers nothing for an empty day list, without opening the cache", async () => {
		// The read path asks this for whatever window the caller has; a window that
		// covers no day at all must answer "none are cached" rather than fall
		// through to a query with no bounds.
		const available = await withDashboardDb((db) => readAvailableDays(db, UTC, [], NOW), { dbPath });
		expect(available.size).toBe(0);
	});

	it("settles nothing when the budget is zero", async () => {
		// The budget is what keeps this off the writer's lock for long. Zero has to
		// mean zero: a build loop that treated it as "no limit" would hold the lock
		// for the whole 90-day horizon on the one call that asked for the opposite.
		const built = await withDashboardDb((db) => buildRollup(db, { now: () => NOW, timeZone: UTC, maxDays: 0 }), {
			dbPath,
		});
		expect(built).toBe(0);
		expect(await rollupRows()).toEqual([]);
	});

	it("settles nothing more once the horizon is caught up", async () => {
		// Zero is the steady state, not an error: every call after the backlog
		// drains re-reads the sentinels, finds every day settled and writes nothing.
		const first = await withDashboardDb((db) => buildRollup(db, { now: () => NOW, timeZone: UTC, maxDays: 90 }), {
			dbPath,
		});
		expect(first).toBe(90);
		const again = await withDashboardDb((db) => buildRollup(db, { now: () => NOW, timeZone: UTC, maxDays: 90 }), {
			dbPath,
		});
		expect(again).toBe(0);
	});

	it("takes its own clock when the caller supplies none", async () => {
		// The production caller (`applyStatsEvents`) passes one; the daemon's does
		// not. A missing clock must not settle "today" — the day the wall clock is
		// in is still accumulating, whichever way the caller got it.
		const built = await withDashboardDb((db) => buildRollup(db, { timeZone: UTC }), { dbPath });
		expect(built).toBe(14);
		const today = new Date().toISOString().slice(0, 10);
		expect(new Set((await rollupRows()).map((r) => r.day)).has(today)).toBe(false);
	});

	it("still answers for a settled day whose key names no real calendar date", async () => {
		// 2026-02-30 round-trips to March, so `dayKeyToMidnight` refuses it and the
		// scan cannot derive its bounds from that key. Both fallbacks are therefore
		// the WIDEST range rather than the narrowest: over-reading costs one scan,
		// while an empty range would report every stale day as fresh — and a NaN one
		// would hang `addLocalDays`.
		await withDashboardDb(
			(db) =>
				db
					.prepare(
						`INSERT INTO stats_daily (repo_id, tz, day, kind, series_key, value, cost_usd,
						                          built_at_ms, updated_at_ms)
						 VALUES (0, ?, '2026-02-30', ?, '', 0, 0, ?, ?)`,
					)
					.run(UTC, BUILT_KIND, NOW, NOW),
			{ dbPath },
		);
		const available = await withDashboardDb((db) => readAvailableDays(db, UTC, ["2026-02-30"], NOW), { dbPath });
		expect(available.has("2026-02-30")).toBe(true);
	});

	it("caches each zone separately rather than handing one reader another's midnight", async () => {
		// 23:00 UTC on the 28th is already the 29th in Shanghai.
		await applyStatsEvents(
			[
				session("s1", day("2026-07-28", 23), [
					{ respondedAtMs: day("2026-07-28", 23), model: "claude-opus-5", input: 90, output: 0 },
				]),
			],
			{ producerKind: "cli", dbPath, now: () => NOW },
		);
		await withDashboardDb(
			(db) => {
				buildRollup(db, { now: () => NOW, timeZone: UTC, maxDays: 5 });
				buildRollup(db, { now: () => NOW, timeZone: "Asia/Shanghai", maxDays: 5 });
			},
			{ dbPath },
		);
		const utc = (await rollupRows(UTC)).filter((r) => r.series_key === "input" && r.value === 90);
		const sh = (await rollupRows("Asia/Shanghai")).filter((r) => r.series_key === "input" && r.value === 90);
		expect(utc.map((r) => r.day)).toEqual(["2026-07-28"]);
		expect(sh.map((r) => r.day)).toEqual(["2026-07-29"]);
	});

	it("forgets a day in every zone, since one instant is two calendar days", async () => {
		await withDashboardDb(
			(db) => {
				buildRollup(db, { now: () => NOW, timeZone: UTC, maxDays: 3 });
				buildRollup(db, { now: () => NOW, timeZone: "Asia/Shanghai", maxDays: 3 });
			},
			{ dbPath },
		);
		await withDashboardDb((db) => forgetRollupDays(db, [day("2026-07-28", 23)]), { dbPath });

		const remaining = await withDashboardDb(
			(db) =>
				readAvailableDays(db, UTC, ["2026-07-28", "2026-07-29"], NOW).has("2026-07-28") ||
				readAvailableDays(db, "Asia/Shanghai", ["2026-07-29"], NOW).has("2026-07-29"),
			{ dbPath },
		);
		// The UTC 28th and the Shanghai 29th are the same instant's day; both go.
		expect(remaining).toBe(false);
	});

	it("forgets a day whose only responses were dropped by a transcript rewrite", async () => {
		await applyStatsEvents(
			[
				session("s1", day("2026-07-29", 12), [
					{ respondedAtMs: day("2026-07-27", 9), model: "claude-opus-5", input: 100, output: 0 },
					{ respondedAtMs: day("2026-07-29", 9), model: "claude-opus-5", input: 50, output: 0 },
				]),
			],
			{ producerKind: "cli", dbPath, now: () => NOW },
		);
		await withDashboardDb((db) => buildRollup(db, { now: () => NOW, timeZone: UTC, maxDays: 10 }), { dbPath });
		expect((await rollupRows()).find((r) => r.day === "2026-07-27" && r.series_key === "input")?.value).toBe(100);

		// The agent compacts its transcript and the 27th's response stops existing.
		// A removed row leaves no write stamp, so nothing expires that day on its
		// own — only the 29th, which still has a response, would look stale.
		await applyStatsEvents(
			[
				session("s1", day("2026-07-29", 12), [
					{ respondedAtMs: day("2026-07-29", 9), model: "claude-opus-5", input: 50, output: 0 },
				]),
			],
			{ producerKind: "cli", dbPath, now: () => NOW + 60_000 },
		);
		await withDashboardDb((db) => buildRollup(db, { now: () => NOW + 120_000, timeZone: UTC, maxDays: 10 }), {
			dbPath,
		});

		const rows = await rollupRows();
		expect(rows.find((r) => r.day === "2026-07-27" && r.series_key === "input")).toBeUndefined();
		expect(rows.find((r) => r.day === "2026-07-29" && r.series_key === "input")?.value).toBe(50);
	});

	it("reads back per-repo rows summed across the scope", async () => {
		await applyStatsEvents(
			[
				session("s1", day("2026-07-28", 12), [
					{ respondedAtMs: day("2026-07-28", 9), model: "claude-opus-5", input: 100, output: 0 },
				]),
				{
					event: {
						type: "session.upserted",
						repoIdentity: "repo-2",
						source: "claude",
						sessionId: "s2",
						updatedAtMs: day("2026-07-28", 12),
						messageCount: 1,
						usageEvents: [
							{
								respondedAtMs: day("2026-07-28", 9),
								model: "claude-opus-5",
								input: 40,
								output: 0,
								cached: 0,
								dedupKey: "s2:a",
							},
						],
					},
					producerKind: "cli",
				},
			],
			{ producerKind: "cli", dbPath, now: () => NOW },
		);
		await withDashboardDb((db) => buildRollup(db, { now: () => NOW, timeZone: UTC }), { dbPath });

		const [all, one] = await withDashboardDb(
			(db) =>
				[
					readRollupSeries(db, UTC, TOKENS_KIND, ["2026-07-28"], { kind: "all" }),
					readRollupSeries(db, UTC, TOKENS_KIND, ["2026-07-28"], {
						kind: "repo",
						repoIdentities: ["repo-1"],
					}),
				] as const,
			{ dbPath },
		);
		expect(all.find((r) => r.series_key === "input")?.value).toBe(140);
		expect(one.find((r) => r.series_key === "input")?.value).toBe(100);
	});
});

/**
 * The safety net for the whole cache: for every axis, the same data read
 * through settled days and read live must produce byte-identical cards.
 *
 * This is the test that would catch a divergence between the two paths, and
 * divergence here is not loud — a cached day is a plausible number, so a page
 * built half from cache would look fine and simply be wrong. Anything added to
 * `stats_daily` needs a case here, or the cache path is unguarded for it.
 */
describe("cached and live days agree", () => {
	let dir: string;
	let dbPath: string;
	const nowMs = Date.parse("2026-07-30T12:00:00Z");

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jolli-rollup-eq-"));
		dbPath = join(dir, "dashboard.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** Sessions, commits and memories with topics — enough to feed all six axes. */
	async function seed(): Promise<void> {
		await applyStatsEvents(
			[
				session("s1", day("2026-07-27", 12), [
					{ respondedAtMs: day("2026-07-27", 9), model: "claude-opus-5", input: 100, output: 10 },
					{ respondedAtMs: day("2026-07-28", 9), model: "claude-sonnet-5", input: 200, output: 20 },
				]),
				session("s2", day("2026-07-29", 12), [
					{ respondedAtMs: day("2026-07-29", 9), model: "claude-opus-5", input: 300, output: 30 },
				]),
				// Today, so the live path always has at least one day of its own.
				session("s3", nowMs, [{ respondedAtMs: nowMs, model: "claude-opus-5", input: 7, output: 7 }]),
				{
					event: {
						type: "commit.created",
						repoIdentity: "repo-1",
						hash: "a".repeat(40),
						branch: "main",
						message: "JOLLI-1 first",
						committedAtMs: day("2026-07-28", 11),
						branches: ["main", "feature"],
					},
					producerKind: "cli",
				},
			],
			{ producerKind: "cli", dbPath, now: () => nowMs },
		);
		// Memory rows with topics: the category, branch and ticket axes all read
		// them, and only an orphan import writes them in production.
		await withDashboardDb(
			(db) => {
				const { id } = db.prepare("SELECT id FROM repos WHERE repo_identity = 'repo-1'").get() as {
					id: number;
				};
				const hash = "a".repeat(40);
				// tokens / est_cost_usd / ticket_id are generated from this JSON, so
				// they can only be seeded through it.
				const summaryJson = JSON.stringify({
					commitHash: hash,
					conversationTokens: 900,
					estimatedCostUsd: 1.25,
					ticketId: "JOLLI-1",
				});
				db.prepare(
					`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
					                       summary_json, first_seen_ms, written_at_ms, commit_date_ms)
					 VALUES (?, ?, NULL, NULL, ?, 0, ?, 1, 1, ?)`,
				).run(id, hash, hash, summaryJson, day("2026-07-28", 11));
				["refactor", "docs"].forEach((category, pos) => {
					db.prepare(
						"INSERT INTO memory_topics (repo_id, commit_hash, pos, category, title) VALUES (?, ?, ?, ?, ?)",
					).run(id, hash, pos, category, `topic ${pos}`);
				});
			},
			{ dbPath },
		);
	}

	const model = (dimension: SeriesDimension) =>
		withDashboardDb(
			(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: UTC, nowMs, dimension }),
			{ dbPath },
		);

	for (const dimension of ROLLUP_AXES) {
		it(`matches on the ${dimension} axis`, async () => {
			await seed();
			// Everything the writer settled along the way, so this really is the
			// uncached path rather than "whatever happened to be cached".
			await withDashboardDb((db) => db.prepare("DELETE FROM stats_daily").run(), { dbPath });
			const live = await model(dimension);

			await withDashboardDb((db) => buildRollup(db, { now: () => nowMs, timeZone: UTC, maxDays: 60 }), {
				dbPath,
			});
			const cached = await model(dimension);

			// Everything integral is compared SERIALISED rather than with `toEqual`,
			// which ignores key order — and key order is one of the two ways these
			// paths drifted on real data. Token counts are integers after rounding,
			// so identity is the right bar for them and is reachable.
			const withoutCost = (m: typeof live) =>
				JSON.stringify((m.stats?.series ?? []).map(({ estCostUsd: _cost, ...rest }) => rest));
			expect(withoutCost(cached)).toBe(withoutCost(live));
			expect(cached.stats?.seriesKeys).toEqual(live.stats?.seriesKeys);
			expect(JSON.stringify(cached.stats?.tokenBreakdown.perDay)).toBe(
				JSON.stringify(live.stats?.tokenBreakdown.perDay),
			);

			// Cost is the one figure identity is the WRONG bar for: it is a float
			// sum and the two paths sum in different groupings. They agree to
			// ~1e-13 on real data, nine orders below the cent this is ever
			// displayed to; demanding more would only invite a quantisation that
			// makes the disagreement rarer and larger. See buildSeries.
			const costs = (m: typeof live) => (m.stats?.series ?? []).map((p) => p.estCostUsd);
			for (const [i, c] of costs(cached).entries()) expect(c).toBeCloseTo(costs(live)[i] ?? 0, 9);
		});
	}

	it("does not double-count a settled day sitting between two live ones", async () => {
		await seed();
		await withDashboardDb(
			(db) => {
				buildRollup(db, { now: () => nowMs, timeZone: UTC, maxDays: 60 });
				// Expire the 27th and the 29th, leaving the 28th settled INSIDE the
				// range the live pass has to cover. Filtering by range alone would
				// count the 28th twice — the one way this cache can overstate.
				db.prepare("DELETE FROM stats_daily WHERE tz = ? AND day IN (?, ?)").run(
					UTC,
					"2026-07-27",
					"2026-07-29",
				);
			},
			{ dbPath },
		);
		const cached = await model("model");
		const perDay = new Map((cached.stats?.tokenBreakdown.perDay ?? []).map((d) => [d.date, d.input]));
		expect(perDay.get("2026-07-28")).toBe(200);
	});
});
