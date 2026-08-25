import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withDashboardDb } from "./DashboardDb.js";
import type { DashboardScope, SeriesDimension, StatsEventEnvelope } from "./DashboardModel.js";
import { readAxisRows, readDatedUsage } from "./StatsSeries.js";
import { applyStatsEvents } from "./StatsWriter.js";

/**
 * The cover test's PARTITION property, asserted directly.
 *
 * `readDatedUsage` and `readAxisRows` each union two arms — sessions whose
 * per-response rows account for all their tokens, and every other session — and
 * the whole correctness of the spend numbers rests on those two arms being
 * complements: overlap double-counts a session's spend, a gap loses it. The
 * arms are now a CTE join and its outer counterpart rather than a predicate and
 * `NOT` of it, so "they are complements" is no longer visible from the SQL's
 * shape and has to be measured.
 *
 * Every case below therefore builds a database holding one session of each shape
 * the rule distinguishes, and checks the union against the session-level totals.
 */

const NOW = Date.parse("2026-07-30T12:00:00Z");
const day = (key: string, hour = 10) => Date.parse(`${key}T${String(hour).padStart(2, "0")}:00:00Z`);
const ALL: DashboardScope = { kind: "all" };
const WINDOW = [0, Date.parse("2027-01-01T00:00:00Z")] as const;

/**
 * One session, with explicit control over the two things the cover test compares:
 * the session-level total and the per-response rows that may or may not add up to it.
 *
 * `models` mirrors the session total on purpose, because that is what a real
 * producer writes — and the `model` axis needs it. That axis is the one whose
 * FALLBACK arm reads `session_model_usage` rather than `sessions` (the other two
 * take the session row itself), so a fixture that supplied only `usageEvents`
 * would make an uncovered session contribute to `agent` and `project` and vanish
 * from `model`. That asymmetry is the production shape, not a defect: the model
 * name is not a column on `sessions`, so there is nowhere else for it to come
 * from.
 */
function session(
	id: string,
	atMs: number,
	total: { input: number; output: number; cached?: number },
	usage: ReadonlyArray<{ respondedAtMs: number; model: string; input: number; output: number }> = [],
): StatsEventEnvelope {
	return {
		event: {
			type: "session.upserted",
			repoIdentity: "repo-1",
			source: "claude",
			sessionId: id,
			updatedAtMs: atMs,
			messageCount: 2,
			inputTokens: total.input,
			outputTokens: total.output,
			cachedTokens: total.cached ?? 0,
			models: [
				{
					model: "m1",
					inputTokens: total.input,
					outputTokens: total.output,
					cachedTokens: total.cached ?? 0,
					estCostUsd: 0,
				},
			],
			usageEvents: usage.map((u) => ({
				...u,
				cached: 0,
				estCostUsd: 0,
				dedupKey: `${id}:${u.respondedAtMs}`,
			})),
		},
		producerKind: "cli",
	} as StatsEventEnvelope;
}

describe("StatsSeries cover test", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jolli-series-"));
		dbPath = join(dir, "dashboard.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/**
	 * The four shapes the rule distinguishes, in one database:
	 *
	 *  - `covered`   — rows sum to the session total: counted by its events.
	 *  - `partial`   — rows exist but fall short (the measured 97.5%-loss shape):
	 *                  counted by its session total, NOT by its rows.
	 *  - `bare`      — no rows at all: counted by its session total.
	 *  - `zero-bare` — no rows and no tokens. `0 >= 0` makes the sum comparison
	 *                  alone call this "covered", which is why the existence half
	 *                  is not redundant; it must land in the fallback arm so its
	 *                  series key still registers.
	 */
	const seed = async () => {
		await applyStatsEvents(
			[
				session("covered", day("2026-07-28", 23), { input: 100, output: 10 }, [
					{ respondedAtMs: day("2026-07-28", 9), model: "m1", input: 60, output: 6 },
					{ respondedAtMs: day("2026-07-28", 21), model: "m1", input: 40, output: 4 },
				]),
				session("partial", day("2026-07-29", 23), { input: 1000, output: 100 }, [
					{ respondedAtMs: day("2026-07-29", 9), model: "m1", input: 10, output: 1 },
				]),
				session("bare", day("2026-07-29", 12), { input: 500, output: 50 }),
				session("zero-bare", day("2026-07-29", 13), { input: 0, output: 0 }),
			],
			{ producerKind: "cli", dbPath, now: () => NOW },
		);
	};

	/** Session-level totals straight from `sessions`, the figure the union must reproduce. */
	const sessionTotals = async () =>
		withDashboardDb(
			(db) =>
				db
					.prepare(
						`SELECT session_id, input_tokens + output_tokens + cached_tokens AS total
						   FROM sessions ORDER BY session_id`,
					)
					.all() as ReadonlyArray<{ session_id: string; total: number }>,
			{ dbPath },
		);

	it("counts every session exactly once across the two arms", async () => {
		// The property the arms exist to have. A third spelling on either side —
		// or a LEFT JOIN filter that forgets `cov.id IS NULL` — breaks it in one of
		// two directions, and both are silent: a gap loses a session's whole spend,
		// an overlap doubles it.
		await seed();
		const totals = await sessionTotals();
		const expected = totals.reduce((sum, r) => sum + r.total, 0);
		const rows = await withDashboardDb((db) => readDatedUsage(db, ALL, WINDOW[0], WINDOW[1]), { dbPath });
		const actual = rows.reduce((sum, r) => sum + r.input + r.output + r.cached, 0);
		expect(actual).toBe(expected);
	});

	it("dates a covered session by its responses and an uncovered one by its session stamp", async () => {
		// The reason the split exists at all: a conversation spanning days should
		// contribute to each of them, which only its per-response rows can express.
		await seed();
		const rows = await withDashboardDb((db) => readDatedUsage(db, ALL, WINDOW[0], WINDOW[1]), { dbPath });
		const stamps = rows.map((r) => r.bucket_at_ms).sort((a, b) => a - b);
		// `covered`'s two responses land on their own instants, not on its 23:00 stamp.
		expect(stamps).toContain(day("2026-07-28", 9));
		expect(stamps).toContain(day("2026-07-28", 21));
		expect(stamps).not.toContain(day("2026-07-28", 23));
		// `partial` is counted by its session stamp, and its lone response is NOT
		// counted separately — that is the double-count the negation prevents.
		expect(stamps).toContain(day("2026-07-29", 23));
		expect(stamps).not.toContain(day("2026-07-29", 9));
	});

	it("keeps a zero-token session with no rows on the axis", async () => {
		// `0 >= 0` reads as "covered" to the sum comparison alone, and an events arm
		// has nothing to contribute for it — so without the existence half this
		// session disappears from the legend entirely.
		await seed();
		const rows = await withDashboardDb((db) => readAxisRows(db, ALL, "agent", WINDOW[0], WINDOW[1]), { dbPath });
		expect(rows.some((r) => r.bucket_at_ms === day("2026-07-29", 13))).toBe(true);
	});

	it("reproduces the session totals on every axis that reads the cover test", async () => {
		// model / agent / project all union the same two arms. An axis whose join
		// drifted would still draw a plausible chart — it just would not add up.
		await seed();
		const totals = await sessionTotals();
		const expected = totals.reduce((sum, r) => sum + r.total, 0);
		for (const dimension of ["model", "agent", "project"] as ReadonlyArray<SeriesDimension>) {
			const rows = await withDashboardDb((db) => readAxisRows(db, ALL, dimension, WINDOW[0], WINDOW[1]), {
				dbPath,
			});
			expect(
				rows.reduce((sum, r) => sum + r.tokens, 0),
				`axis ${dimension}`,
			).toBe(expected);
		}
	});

	it("counts nothing twice when a session's rows exceed its stored total", async () => {
		// `>=`, not `=`: rows that overshoot are the more detailed record and are
		// trusted — but the session must still be counted once, by the events arm.
		await applyStatsEvents(
			[
				session("over", day("2026-07-28", 23), { input: 10, output: 1 }, [
					{ respondedAtMs: day("2026-07-28", 9), model: "m1", input: 100, output: 10 },
				]),
			],
			{ producerKind: "cli", dbPath, now: () => NOW },
		);
		const rows = await withDashboardDb((db) => readDatedUsage(db, ALL, WINDOW[0], WINDOW[1]), { dbPath });
		expect(rows).toHaveLength(1);
		expect(rows[0]?.bucket_at_ms).toBe(day("2026-07-28", 9));
	});
});
