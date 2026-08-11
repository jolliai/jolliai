import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withDashboardDb } from "./DashboardDb.js";
import type { DashboardScope, SessionUpsertedEvent, StatsEventEnvelope, StatsModel } from "./DashboardModel.js";
import { TOOL_ROWS_LIMIT } from "./DashboardModel.js";
import {
	addLocalDays,
	buildDashboardModel,
	computeStreak,
	localDayKey,
	localHour,
	machineTimeZone,
	type QueryOptions,
	startOfLocalDay,
} from "./DashboardQuery.js";
import { applyStatsEvents } from "./StatsWriter.js";

/**
 * Seeds one memories row plus its `memory_topics` rows — the source the
 * query-time category label and the category axis read. Stats events cannot
 * carry this: category belongs to a topic, and topics reach the database
 * through the orphan import, not through the event stream.
 */
async function seedTopicRows(
	dbPath: string,
	hash: string,
	categories: ReadonlyArray<string | null>,
	opts: { tokens?: number; estCostUsd?: number; commitDateMs?: number } = {},
): Promise<void> {
	await withDashboardDb(
		(db) => {
			const { id } = db.prepare("SELECT id FROM repos WHERE repo_identity = 'repo-1'").get() as { id: number };
			const summary = {
				commitHash: hash,
				...(opts.tokens != null ? { conversationTokens: opts.tokens } : {}),
				...(opts.estCostUsd != null ? { estimatedCostUsd: opts.estCostUsd } : {}),
			};
			db.prepare(
				`INSERT OR IGNORE INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
				                                 summary_json, first_seen_ms, written_at_ms, commit_date_ms)
				 VALUES (?, ?, NULL, NULL, ?, 0, ?, 1, 1, ?)`,
			).run(id, hash, hash, JSON.stringify(summary), opts.commitDateMs ?? 1);
			categories.forEach((category, pos) => {
				db.prepare(
					"INSERT INTO memory_topics (repo_id, commit_hash, pos, category, title) VALUES (?, ?, ?, ?, ?)",
				).run(id, hash, pos, category, `topic ${pos}`);
			});
		},
		{ dbPath },
	);
}

/**
 * Applies stats events AND mirrors production's live memories refresh
 * (fcafe610): the worker upserts each stored summary into `memories` at the
 * same moment it emits commit.summary, and the A3b queries read the memory
 * columns — so a fixture that only projected events would leave every
 * enrichment read empty.
 */
async function applySummaryEvents(
	entries: Parameters<typeof applyStatsEvents>[0],
	opts: Parameters<typeof applyStatsEvents>[1],
): Promise<void> {
	await applyStatsEvents(entries, opts);
	const summaries = entries
		.map((e) => e.event)
		.filter((e): e is Extract<typeof e, { type: "commit.summary" }> => e.type === "commit.summary");
	if (summaries.length === 0 || !opts.dbPath) return;
	await withDashboardDb(
		(db) => {
			for (const event of summaries) {
				const { id } = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(event.repoIdentity) as {
					id: number;
				};
				const summary = {
					commitHash: event.hash,
					...(event.turns != null ? { conversationTurns: event.turns } : {}),
					...(event.tokens != null ? { conversationTokens: event.tokens } : {}),
					...(event.estCostUsd != null ? { estimatedCostUsd: event.estCostUsd } : {}),
					...(event.ticketId != null ? { ticketId: event.ticketId } : {}),
					// Insights are DERIVED from topics (decisions/todo) at query
					// time — the summary schema has no insights field, so the
					// fixture stores them the way real summaries do.
					...(event.insights
						? {
								topics: event.insights.map((i, n) => ({
									title: `t${n}`,
									...(i.kind === "todo" ? { todo: i.text } : { decisions: i.text }),
								})),
							}
						: {}),
				};
				db.prepare(
					`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
					                       summary_json, first_seen_ms, written_at_ms, commit_date_ms)
					 VALUES (?, ?, NULL, NULL, ?, 0, ?, 1, 1, ?)
					 ON CONFLICT(repo_id, commit_hash) DO UPDATE SET
					   summary_json = excluded.summary_json, commit_date_ms = excluded.commit_date_ms`,
				).run(id, event.hash, event.hash, JSON.stringify(summary), event.committedAtMs);
			}
		},
		{ dbPath: opts.dbPath },
	);
}

const SH = "Asia/Shanghai"; // UTC+8, no DST
const LA = "America/Los_Angeles"; // DST

describe("time-zone engine", () => {
	it("assigns a 23:30 UTC session to the NEXT local day in Asia/Shanghai", () => {
		const ms = Date.parse("2026-07-29T23:30:00Z"); // 07:30 on the 30th in Shanghai
		expect(localDayKey(ms, SH)).toBe("2026-07-30");
		expect(localDayKey(ms, "UTC")).toBe("2026-07-29");
	});

	it("computes local midnight boundaries, not UTC ones", () => {
		const ms = Date.parse("2026-07-30T10:00:00Z");
		// Shanghai midnight of Jul 30 = Jul 29 16:00 UTC.
		expect(startOfLocalDay(ms, SH)).toBe(Date.parse("2026-07-29T16:00:00Z"));
		expect(startOfLocalDay(ms, "UTC")).toBe(Date.parse("2026-07-30T00:00:00Z"));
	});

	it("handles the 23-hour spring-forward day in America/Los_Angeles", () => {
		// 2026-03-08: DST starts, 02:00 → 03:00. The day is 23 hours long.
		const midnight = startOfLocalDay(Date.parse("2026-03-08T20:00:00Z"), LA);
		expect(localDayKey(midnight, LA)).toBe("2026-03-08");
		const nextMidnight = addLocalDays(midnight, 1, LA);
		expect(localDayKey(nextMidnight, LA)).toBe("2026-03-09");
		expect(nextMidnight - midnight).toBe(23 * 3_600_000);
	});

	it("handles the 25-hour fall-back day", () => {
		// 2026-11-01: DST ends. The day is 25 hours long.
		const midnight = startOfLocalDay(Date.parse("2026-11-01T20:00:00Z"), LA);
		const nextMidnight = addLocalDays(midnight, 1, LA);
		expect(nextMidnight - midnight).toBe(25 * 3_600_000);
	});

	it("addLocalDays walks backwards too", () => {
		const ms = Date.parse("2026-07-30T10:00:00Z");
		expect(localDayKey(addLocalDays(ms, -1, SH), SH)).toBe("2026-07-29");
		expect(localDayKey(addLocalDays(ms, 0, SH), SH)).toBe("2026-07-30");
	});

	it("localHour reports the wall-clock hour in the requested zone", () => {
		const ms = Date.parse("2026-07-29T23:30:00Z");
		expect(localHour(ms, SH)).toBe(7); // 07:30 next day
		expect(localHour(ms, "UTC")).toBe(23);
	});

	it("machineTimeZone returns a resolvable IANA name", () => {
		expect(() => new Intl.DateTimeFormat("en", { timeZone: machineTimeZone() })).not.toThrow();
	});
});

describe("computeStreak", () => {
	const now = Date.parse("2026-07-30T12:00:00Z");
	const day = (offset: number) => addLocalDays(now, offset, "UTC") + 3_600_000;

	it("counts consecutive days ending today", () => {
		expect(computeStreak([day(0), day(-1), day(-2)], "UTC", now)).toBe(3);
	});

	it("tolerates an inactive morning — a streak ending yesterday still counts", () => {
		expect(computeStreak([day(-1), day(-2)], "UTC", now)).toBe(2);
	});

	it("breaks on a gap and is 0 with no recent activity", () => {
		expect(computeStreak([day(0), day(-2)], "UTC", now)).toBe(1);
		expect(computeStreak([day(-5)], "UTC", now)).toBe(0);
		expect(computeStreak([], "UTC", now)).toBe(0);
	});
});

describe("buildDashboardModel", () => {
	let dir: string;
	let dbPath: string;
	// Fixed "now": 2026-07-30 12:00 UTC.
	const nowMs = Date.parse("2026-07-30T12:00:00Z");

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jolli-query-"));
		dbPath = join(dir, "dashboard.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const session = (over: Partial<SessionUpsertedEvent>): StatsEventEnvelope => ({
		producerKind: "cli",
		event: {
			type: "session.upserted",
			repoIdentity: "repo-1",
			source: "claude",
			sessionId: "s",
			updatedAtMs: nowMs,
			messageCount: 3,
			models: [
				{
					model: "claude-opus-4-8",
					provider: "anthropic",
					inputTokens: 1000,
					outputTokens: 500,
					cachedTokens: 100,
					estCostUsd: 1.5,
				},
			],
			tokenCoverage: "full",
			...over,
		},
	});

	async function seed(): Promise<void> {
		await applySummaryEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w",
						enabledAt: "t",
					},
				},
				session({
					sessionId: "today-1",
					title: "Fix bug",
					updatedAtMs: nowMs - 3_600_000,
					durationMs: 90 * 60_000,
				}),
				session({
					sessionId: "yesterday-1",
					updatedAtMs: nowMs - 26 * 3_600_000,
					source: "cursor",
					models: [],
					tokenCoverage: "sessions-only",
				}),
				session({ sessionId: "old-1", updatedAtMs: nowMs - 10 * 86_400_000 }),
				{
					producerKind: "cli",
					event: {
						type: "commit.created",
						repoIdentity: "repo-1",
						hash: "abc1234",
						committedAtMs: nowMs - 25 * 3_600_000,
						message: "feat: yesterday's commit",
						branch: "main",
						branches: ["main"],
						insertions: 10,
						deletions: 2,
					},
				},
				{
					producerKind: "cli",
					event: {
						type: "worktree.status",
						repoIdentity: "repo-1",
						branch: "main",
						filesChanged: 6,
						insertions: 184,
						deletions: 22,
						observedAtMs: nowMs,
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
	}

	it("serves every group-by axis, and falls back to model for memory-only axes at tier 0", async () => {
		await seed();
		const axis = async (dimension: "model" | "agent" | "project" | "branch" | "ticket" | "category") =>
			withDashboardDb(
				(db) =>
					buildDashboardModel(db, {
						view: "stats",
						scope: { kind: "all" },
						timeZone: "UTC",
						nowMs,
						dimension,
						range: "month",
					}),
				{ dbPath },
			);

		// Available without memory: model + agent (session usage) and project (repo).
		expect((await axis("model")).stats?.seriesDimension).toBe("model");
		expect((await axis("agent")).stats?.seriesKeys).toEqual(["claude", "cursor"]);
		expect((await axis("project")).stats?.seriesKeys).toEqual(["jolli"]);

		// Memory-only axes degrade to model rather than render an empty chart.
		for (const dimension of ["branch", "ticket", "category"] as const) {
			const model = await axis(dimension);
			expect(model.tier).toBe("installed");
			expect(model.stats?.seriesDimension).toBe("model");
		}
	});

	it("exposes the price-table date", async () => {
		await seed();
		const model = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		// Seeded sessions carry no pricesAsOf, so the field stays absent rather
		// than inventing a date for figures whose price basis is unknown.
		expect(model.stats?.pricesAsOf).toBeUndefined();
	});

	it("scopes KPIs and the series to the requested range, and labels them with it", async () => {
		await seed();
		const forRange = async (range: "today" | "week" | "2w" | "month") =>
			withDashboardDb(
				(db) =>
					buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs, range }),
				{ dbPath },
			);

		// today-1 is an hour ago; yesterday-1 is 26 h back; old-1 is 10 days back.
		const today = await forRange("today");
		expect(today.stats?.kpis.find((k) => k.key === "sessions")).toMatchObject({
			value: "1",
			label: "sessions today",
		});
		expect(today.stats?.series).toHaveLength(1); // one day bucket

		const week = await forRange("week");
		expect(week.stats?.kpis.find((k) => k.key === "sessions")?.value).toBe("2"); // old-1 excluded
		expect(week.stats?.series).toHaveLength(7);

		const month = await forRange("month");
		expect(month.stats?.kpis.find((k) => k.key === "sessions")?.value).toBe("3");
		expect(month.stats?.series).toHaveLength(30);

		// The heatmap is deliberately NOT range-scoped — it is the 12-week long view.
		expect(today.stats?.heatmap).toHaveLength(84);
		expect(month.stats?.heatmap).toHaveLength(84);
	});

	it("assembles the stats view with KPIs, heatmap, hours and recent sessions", async () => {
		await seed();
		const model = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		expect(model.view).toBe("stats");
		expect(model.tier).toBe("installed");
		expect(model.timeZone).toBe("UTC");
		// `sessionsThisWeek` is the sidebar's per-repo meta figure — both seeded
		// sessions land inside the 7-day window.
		expect(model.repos).toEqual([
			{ repoIdentity: "repo-1", repoName: "jolli", worktreeRoot: "/w", sessionsThisWeek: 2 },
		]);
		expect(model.standup).toBeUndefined();

		const stats = model.stats;
		if (!stats) throw new Error("stats missing");
		// KPIs cover the SELECTED RANGE, default 30 days, and
		// the labels carry that window so a figure can't be misread as today's.
		expect(stats.range).toBe("month");
		// today-1 + yesterday-1 + old-1 (10 days back) all fall inside 30 days;
		// only the two Claude ones carry tokens (cursor is sessions-only).
		expect(stats.kpis.find((k) => k.key === "sessions")).toMatchObject({ value: "3", label: "sessions · 30d" });
		expect(stats.kpis.find((k) => k.key === "tokens")?.value).toBe("3.2k");
		expect(stats.kpis.find((k) => k.key === "cost")?.value).toBe("$3.00");
		// cached share = 200 cached / (2000 input + 200 cached)
		expect(stats.kpis.find((k) => k.key === "cached")?.value).toBe("9%");
		// Where your tokens went: today-1 + old-1 carry the default model tokens;
		// yesterday-1 is sessions-only (cursor) and contributes nothing.
		expect(stats.tokenBreakdown).toMatchObject({ input: 2000, output: 1000, cached: 200 });
		expect(stats.tokenBreakdown.perDay).toHaveLength(30);
		expect(stats.tokenBreakdown.perDay.reduce((sum, d) => sum + d.input, 0)).toBe(2000);
		// Below the memory tier these stay ABSENT so the card renders the
		// mockup's "—" rather than claiming a real zero.
		expect(stats.memoriesCreated).toBeUndefined();
		expect(stats.decisionsCaptured).toBeUndefined();
		expect(stats.decisions).toBeUndefined();
		// totalCommits needs no memory data, so it stays defined at every tier —
		// the one commit.created event in the window ("abc1234").
		expect(stats.totalCommits).toBe(1);
		// No sessions in the preceding 30-day window to compare against.
		expect(stats.costTrendPct).toBeUndefined();

		// (range behaviour itself is pinned by the "time range" cases below)

		// 30-day series has one bucket per local day, keyed by model.
		expect(stats.series).toHaveLength(30);
		expect(stats.seriesKeys).toEqual(["claude-opus-4-8"]);
		const today = stats.series[stats.series.length - 1];
		expect(today.bySeries["claude-opus-4-8"]).toBe(1600);

		// Heatmap: 84 days; the commit-only day counts commits, not sessions.
		expect(stats.heatmap).toHaveLength(84);
		const commitDay = stats.heatmap.find((c) => c.date === "2026-07-29");
		expect(commitDay).toMatchObject({ sessions: 1, commits: 1 }); // yesterday-1 session + commit

		// Hours histogram covers 0..23 and counts window sessions.
		expect(stats.hours).toHaveLength(24);
		expect(stats.hours.reduce((sum, h) => sum + h.sessions, 0)).toBe(3);

		// Fun stats: the 90-minute session is legendary.
		expect(stats.fun.legendarySessionMinutes).toBe(90);
		expect(stats.fun.legendarySessionTitle).toBe("Fix bug");
		expect(stats.fun.biggestDayTokens).toBeGreaterThan(0);

		// Recent sessions, newest first, with live flag from recency.
		expect(stats.recentSessions[0]).toMatchObject({ sessionId: "today-1", repoName: "jolli", isLive: false });
	});

	it("reports a cost trend once the preceding window has priced sessions", async () => {
		await seed();
		// 40 days back: inside the prior 30-day window (days 30–60 back), outside
		// the current one — so it moves costTrendPct without touching stats.kpis.
		await applySummaryEvents(
			[
				session({
					sessionId: "prior-1",
					updatedAtMs: nowMs - 40 * 86_400_000,
					models: [
						{
							model: "claude-opus-4-8",
							provider: "anthropic",
							inputTokens: 500,
							outputTokens: 200,
							cachedTokens: 0,
							estCostUsd: 2,
						},
					],
				}),
			],
			{ producerKind: "cli", dbPath },
		);
		const model = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		// Current window's $3.00 (unchanged) vs the prior window's $2.00 → +50%.
		expect(model.stats?.kpis.find((k) => k.key === "cost")?.value).toBe("$3.00");
		expect(model.stats?.costTrendPct).toBe(50);
	});

	it("marks a just-updated session live", async () => {
		await applySummaryEvents([session({ sessionId: "live-1", updatedAtMs: nowMs - 60_000 })], {
			producerKind: "cli",
			dbPath,
		});
		const model = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		expect(model.stats?.recentSessions[0].isLive).toBe(true);
	});

	it("assembles the standup view with yesterday/today buckets and workspaces", async () => {
		await seed();
		const model = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "standup", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		const standup = model.standup;
		if (!standup) throw new Error("standup missing");
		expect(standup.today).toBe("2026-07-30");
		expect(standup.yesterday).toBe("2026-07-29");
		expect(standup.yesterdaySessions.map((s) => s.sessionId)).toEqual(["yesterday-1"]);
		expect(standup.yesterdayCommits).toEqual([
			expect.objectContaining({
				hash: "abc1234",
				message: "feat: yesterday's commit",
				branch: "main",
				repoName: "jolli",
			}),
		]);
		expect(standup.todaySessions.map((s) => s.sessionId)).toEqual(["today-1"]);
		expect(standup.todayCommits).toEqual([]);
		expect(standup.workspaces).toEqual([
			{ repoName: "jolli", branch: "main", filesChanged: 6, insertions: 184, deletions: 22 },
		]);
	});

	it("moves a 23:30 UTC session into the next local day under Asia/Shanghai", async () => {
		await applySummaryEvents(
			[session({ sessionId: "boundary", updatedAtMs: Date.parse("2026-07-29T23:30:00Z") })],
			{
				producerKind: "cli",
				dbPath,
			},
		);
		// In UTC that session is "yesterday"; in Shanghai it is "today".
		const utc = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "standup", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		expect(utc.standup?.yesterdaySessions.map((s) => s.sessionId)).toEqual(["boundary"]);
		const shanghai = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "standup", scope: { kind: "all" }, timeZone: SH, nowMs }),
			{ dbPath },
		);
		expect(shanghai.standup?.todaySessions.map((s) => s.sessionId)).toEqual(["boundary"]);
	});

	it("filters by repo scope", async () => {
		await seed();
		await applySummaryEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-2",
						repoName: "other",
						worktreeRoot: "/o",
						enabledAt: "t",
					},
				},
				session({ repoIdentity: "repo-2", sessionId: "other-1", updatedAtMs: nowMs - 60_000 }),
			],
			{ producerKind: "cli", dbPath },
		);
		const scoped = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "stats",
					scope: { kind: "repo", repoIdentity: "repo-2" },
					timeZone: "UTC",
					nowMs,
				}),
			{ dbPath },
		);
		expect(scoped.stats?.recentSessions.map((s) => s.sessionId)).toEqual(["other-1"]);
		expect(scoped.repos).toHaveLength(2); // the selector still lists every repo
	});

	it("renders sensibly from an empty database — zero KPIs, empty fun stats, no series keys", async () => {
		await applySummaryEvents([], { producerKind: "cli", dbPath }); // create schema only
		const model = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		const stats = model.stats;
		if (!stats) throw new Error("stats missing");
		expect(stats.kpis.find((k) => k.key === "sessions")?.value).toBe("0");
		expect(stats.kpis.find((k) => k.key === "cached")?.value).toBe("—");
		expect(stats.seriesKeys).toEqual([]);
		expect(stats.fun).toMatchObject({ legendarySessionMinutes: 0, biggestDayTokens: 0, nightOwlSharePct: 0 });
		expect(stats.fun.legendarySessionTitle).toBeUndefined();
		expect(stats.fun.biggestDayDate).toBeUndefined();
	});

	it("fills row-level fallbacks: untitled sessions, commits without stats, detached worktrees", async () => {
		await applySummaryEvents(
			[
				session({ sessionId: "untitled", updatedAtMs: nowMs - 60_000, models: [] }),
				{
					producerKind: "cli",
					event: {
						type: "commit.created",
						repoIdentity: "repo-1",
						hash: "bare1",
						committedAtMs: nowMs - 3_600_000,
					},
				},
				{
					producerKind: "cli",
					event: {
						type: "worktree.status",
						repoIdentity: "repo-1",
						filesChanged: 1,
						insertions: 1,
						deletions: 0,
						observedAtMs: nowMs,
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		const model = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "standup", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		const standup = model.standup;
		if (!standup) throw new Error("standup missing");
		expect(standup.todaySessions[0].title).toBe("claude session");
		const commit = standup.todayCommits[0];
		expect(commit.message).toBe("");
		expect(commit).not.toHaveProperty("branch");
		expect(commit).not.toHaveProperty("insertions");
		expect(standup.workspaces[0]).not.toHaveProperty("branch");
	});

	it("treats a repo scope without an identity as all repos", async () => {
		await seed();
		const model = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "repo" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		expect(model.stats?.recentSessions.length).toBeGreaterThan(0);
	});

	it("reports honest coverage notes", async () => {
		// Empty DB (schema only): no data.
		const empty = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		expect(empty.coverage.map((c) => c.kind)).toEqual(["no-data"]);

		// A repo mid-bootstrap adds NOTHING. The in-progress import used to push a
		// note onto every view; the state is still tracked (it drives resume), it
		// just no longer speaks from the foot of the page.
		await applySummaryEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w",
						enabledAt: "t",
					},
				},
				session({ sessionId: "s1" }),
			],
			{ producerKind: "cli", dbPath },
		);
		const seeded = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		expect(seeded.coverage.map((c) => c.kind)).toEqual(["sessions-window"]);
	});

	it("keeps the session caveats off views that show no session activity", async () => {
		await seed();
		const notesFor = async (view: "stats" | "standup" | "memories") =>
			(
				await withDashboardDb(
					(db) => buildDashboardModel(db, { view, scope: { kind: "all" }, timeZone: "UTC", nowMs }),
					{ dbPath },
				)
			).coverage.map((c) => c.kind);

		// The activity views carry the caveat about how their timeline is built.
		expect(await notesFor("stats")).toEqual(["sessions-window"]);
		expect(await notesFor("standup")).toEqual(["sessions-window"]);
		// Memories renders stored summaries, not a session timeline, so a note about
		// how session history is reconstructed qualifies nothing there — and with the
		// import note gone it now carries no coverage note at all.
		expect(await notesFor("memories")).toEqual([]);
		expect(await notesFor("repositories" as "stats")).toEqual([]);
	});

	describe("custom range", () => {
		const stats = async (over: Partial<QueryOptions> = {}) =>
			(
				await withDashboardDb(
					(db) =>
						buildDashboardModel(db, {
							view: "stats",
							scope: { kind: "all" },
							timeZone: "UTC",
							nowMs,
							...over,
						}),
					{ dbPath },
				)
			).stats as StatsModel;

		it("reports resolved bounds for a preset as well as a custom window", async () => {
			await seed();
			// Presets end today and span RANGE_DAYS counting today: "week" is
			// Jul 24–30, not Jul 23–30.
			expect(await stats({ range: "week" })).toMatchObject({
				range: "week",
				rangeFrom: "2026-07-24",
				rangeTo: "2026-07-30",
			});
			expect(await stats({ range: "today" })).toMatchObject({
				range: "today",
				rangeFrom: "2026-07-30",
				rangeTo: "2026-07-30",
			});
		});

		it("scopes the KPIs to an explicit window, inclusive at both ends", async () => {
			await seed();
			// Seeded sessions land on Jul 30 (×1), Jul 29 (×1) and Jul 20 (×1).
			const july29 = await stats({ range: "custom", customFrom: "2026-07-29", customTo: "2026-07-29" });
			expect(july29.range).toBe("custom");
			expect(july29.kpis.find((k) => k.key === "sessions")?.value).toBe("1");
			// The label carries the window so a KPI can never be misread as today's.
			expect(july29.kpis.find((k) => k.key === "sessions")?.label).toBe("sessions · 07-29→07-29");

			const spanning = await stats({ range: "custom", customFrom: "2026-07-29", customTo: "2026-07-30" });
			expect(spanning.kpis.find((k) => k.key === "sessions")?.value).toBe("2");
		});

		it("clamps a future `to` and an over-long `from` instead of rejecting them", async () => {
			await seed();
			const future = await stats({ range: "custom", customFrom: "2026-07-29", customTo: "2027-01-01" });
			expect(future).toMatchObject({ range: "custom", rangeFrom: "2026-07-29", rangeTo: "2026-07-30" });

			// 366 local days back from Jul 30 2026 inclusive → Jul 30 2025.
			const ancient = await stats({ range: "custom", customFrom: "2019-01-01", customTo: "2026-07-30" });
			expect(ancient).toMatchObject({ range: "custom", rangeFrom: "2025-07-30" });
		});

		it("falls back to the default preset on a malformed, impossible or reversed pair", async () => {
			await seed();
			const fallback = { range: "month", rangeFrom: "2026-07-01", rangeTo: "2026-07-30" };
			// Not a day key at all.
			expect(await stats({ range: "custom", customFrom: "nope", customTo: "2026-07-30" })).toMatchObject(
				fallback,
			);
			// Well-formed but not a real day — Date.UTC would silently roll it into March.
			expect(await stats({ range: "custom", customFrom: "2026-02-31", customTo: "2026-07-30" })).toMatchObject(
				fallback,
			);
			// Reversed: swapping it would answer a question nobody asked.
			expect(await stats({ range: "custom", customFrom: "2026-07-30", customTo: "2026-07-01" })).toMatchObject(
				fallback,
			);
			// Only one bound supplied.
			expect(await stats({ range: "custom", customFrom: "2026-07-01" })).toMatchObject(fallback);
			// Entirely in the future — both clamps pull past each other.
			expect(await stats({ range: "custom", customFrom: "2027-01-01", customTo: "2027-02-01" })).toMatchObject(
				fallback,
			);
		});

		it("scans beyond the 12-week sweep when the window predates it", async () => {
			await applySummaryEvents(
				[
					{
						producerKind: "cli",
						event: {
							type: "repo.enabled",
							repoIdentity: "repo-1",
							repoName: "jolli",
							worktreeRoot: "/w",
							enabledAt: "t",
						},
					},
					// 200 days back — outside HEATMAP_DAYS (84), so the shared sweep
					// cannot supply it and the range needs its own query.
					session({ sessionId: "ancient-1", updatedAtMs: nowMs - 200 * 86_400_000, title: "Old work" }),
				],
				{ producerKind: "cli", dbPath },
			);
			const old = await stats({ range: "custom", customFrom: "2026-01-10", customTo: "2026-01-12" });
			expect(old.kpis.find((k) => k.key === "sessions")?.value).toBe("1");
			// The feed follows the range, so it shows the window's session — not
			// whatever happens to be most recent overall.
			expect(old.recentSessions.map((s) => s.title)).toEqual(["Old work"]);
			// The heatmap keeps its own span regardless, and stays empty here.
			expect(old.heatmap).toHaveLength(84);
			expect(old.heatmap.every((cell) => cell.sessions === 0)).toBe(true);
		});
	});
});

describe("buildDashboardModel — tool usage", () => {
	let dir: string;
	let dbPath: string;
	const nowMs = Date.parse("2026-07-30T12:00:00Z");

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jolli-tools-"));
		dbPath = join(dir, "dashboard.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const repoEvent: StatsEventEnvelope = {
		producerKind: "cli",
		event: {
			type: "repo.enabled",
			repoIdentity: "repo-1",
			repoName: "jolli",
			worktreeRoot: "/w",
			enabledAt: "t",
		},
	};

	const sessionWith = (
		sessionId: string,
		tools?: ReadonlyArray<{ name: string; kind: "builtin" | "mcp" | "skill"; server?: string; calls: number }>,
		source: "claude" | "codex" | "cline" = "claude",
	): StatsEventEnvelope => ({
		producerKind: "cli",
		event: {
			type: "session.upserted",
			repoIdentity: "repo-1",
			source,
			sessionId,
			updatedAtMs: nowMs - 3_600_000,
			...(tools ? { tools } : {}),
		},
	});

	const usage = async () =>
		(
			await withDashboardDb(
				(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
				{ dbPath },
			)
		).stats?.toolUsage;

	it("ranks by sessions that reached for a tool, not by raw call volume", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				// One session hammered /simplify 200 times...
				sessionWith("s1", [{ name: "simplify", kind: "skill", calls: 200 }]),
				// ...while /code-review shows up across three separate sessions.
				sessionWith("s2", [{ name: "code-review", kind: "skill", calls: 1 }]),
				sessionWith("s3", [{ name: "code-review", kind: "skill", calls: 2 }]),
				sessionWith("s4", [{ name: "code-review", kind: "skill", calls: 1 }]),
			],
			{ producerKind: "cli", dbPath },
		);
		const result = await usage();
		expect(result?.skills[0]).toEqual({ name: "code-review", kind: "skill", sessions: 3, calls: 4 });
		expect(result?.skills[1]).toEqual({ name: "simplify", kind: "skill", sessions: 1, calls: 200 });
	});

	it("rolls MCP tools up to their server and counts its distinct tools", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				sessionWith("s1", [
					{ name: "linear.list_issues", kind: "mcp", server: "linear", calls: 3 },
					{ name: "linear.get_issue", kind: "mcp", server: "linear", calls: 2 },
					{ name: "github.list_prs", kind: "mcp", server: "github", calls: 1 },
				]),
			],
			{ producerKind: "cli", dbPath },
		);
		const result = await usage();
		expect(result?.servers).toEqual([
			// One session using two of the server's tools is ONE session, never two.
			{ server: "linear", sessions: 1, calls: 5, tools: 2 },
			{ server: "github", sessions: 1, calls: 1, tools: 1 },
		]);
	});

	it("splits the same MCP rows by individual tool, ranked by adoption", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				sessionWith("s1", [
					{ name: "linear.list_issues", kind: "mcp", server: "linear", calls: 3 },
					{ name: "linear.get_issue", kind: "mcp", server: "linear", calls: 2 },
				]),
				sessionWith("s2", [{ name: "linear.get_issue", kind: "mcp", server: "linear", calls: 1 }]),
			],
			{ producerKind: "cli", dbPath },
		);
		const result = await usage();
		// linear.get_issue reached across two sessions outranks list_issues' one,
		// even though list_issues has more raw calls — same adoption-first rule
		// as skills.
		expect(result?.mcpTools).toEqual([
			{ name: "linear.get_issue", kind: "mcp", sessions: 2, calls: 3 },
			{ name: "linear.list_issues", kind: "mcp", sessions: 1, calls: 3 },
		]);
	});

	it("pulls out recall's own row alongside mcpTools", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				sessionWith("s1", [{ name: "jollimemory.recall", kind: "mcp", server: "jollimemory", calls: 3 }]),
				sessionWith("s2", [{ name: "jollimemory.recall", kind: "mcp", server: "jollimemory", calls: 1 }]),
			],
			{ producerKind: "cli", dbPath },
		);
		const result = await usage();
		expect(result?.recallCalls).toEqual({ name: "jollimemory.recall", kind: "mcp", sessions: 2, calls: 4 });
	});

	it("still finds recall's row once it is pushed out of mcpTools' top slots", async () => {
		const busierTools = Array.from({ length: TOOL_ROWS_LIMIT }, (_, i) => ({
			name: `server${i}.tool`,
			kind: "mcp" as const,
			server: `server${i}`,
			calls: 1,
		}));
		const events = [
			repoEvent,
			// Each busier tool is reached from two separate sessions — strictly
			// outranking recall's single session by adoption — while recall itself
			// is only called once.
			...busierTools.flatMap((tool, i) => [sessionWith(`busyA${i}`, [tool]), sessionWith(`busyB${i}`, [tool])]),
			sessionWith("recall-session", [
				{ name: "jollimemory.recall", kind: "mcp", server: "jollimemory", calls: 1 },
			]),
		];
		await applySummaryEvents(events, { producerKind: "cli", dbPath });
		const result = await usage();
		expect(result?.mcpTools).toHaveLength(TOOL_ROWS_LIMIT);
		expect(result?.mcpTools.some((row) => row.name === "jollimemory.recall")).toBe(false);
		expect(result?.recallCalls).toEqual({ name: "jollimemory.recall", kind: "mcp", sessions: 1, calls: 1 });
	});

	it("leaves recallCalls undefined when recall was never called", async () => {
		await applySummaryEvents(
			[repoEvent, sessionWith("s1", [{ name: "linear.list_issues", kind: "mcp", server: "linear", calls: 1 }])],
			{ producerKind: "cli", dbPath },
		);
		expect((await usage())?.recallCalls).toBeUndefined();
	});

	it("counts a server's sessions distinctly, not as the max over its tools", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				sessionWith("s1", [{ name: "linear.list_issues", kind: "mcp", server: "linear", calls: 1 }]),
				sessionWith("s2", [{ name: "linear.get_issue", kind: "mcp", server: "linear", calls: 1 }]),
			],
			{ producerKind: "cli", dbPath },
		);
		// Two sessions, one tool each: the per-tool max was 1 and undercounted by half.
		expect((await usage())?.servers).toEqual([{ server: "linear", sessions: 2, calls: 2, tools: 2 }]);
	});

	it("reports coverage from all sessions and names the sources it cannot see inside", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				sessionWith("s1", [{ name: "Bash", kind: "builtin", calls: 4 }]),
				// Cline (VS Code) sessions are counted but carry no tool records at all
				// — its transcripts express tool results only as prose.
				sessionWith("s2", undefined, "cline"),
				sessionWith("s3", undefined, "cline"),
			],
			{ producerKind: "cli", dbPath },
		);
		const result = await usage();
		// 1 of 3, from `sessions` — a join over session_tool_use could only ever
		// have seen the one session that has rows.
		expect(result?.sessionsWithTools).toBe(1);
		expect(result?.sessionsInWindow).toBe(3);
		expect(result?.uncoveredSources).toEqual(["cline"]);
	});

	it("does not call a readable source uncovered just because it used no tools", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				// A Claude session that genuinely called nothing. Claude transcripts DO
				// record tool calls, so this zero is a real zero — reporting "claude"
				// as uncovered made the page claim its transcripts cannot be read.
				sessionWith("s1", undefined, "claude"),
				sessionWith("s2", undefined, "cline"),
			],
			{ producerKind: "cli", dbPath },
		);
		const result = await usage();
		expect(result?.uncoveredSources).toEqual(["cline"]);
		expect(result?.sessionsWithTools).toBe(0);
		expect(result?.sessionsInWindow).toBe(2);
	});

	it("counts a session whose CALL is in the window but whose own time is not", async () => {
		// The ranked rows are windowed by call time; the coverage denominator is
		// windowed by the session's own. A long-running session that last updated
		// weeks ago but called a tool an hour ago is in one and not the other, so
		// the page printed "1 session" for the tool directly above "from 0 of 0
		// sessions in this window".
		await applySummaryEvents(
			[
				repoEvent,
				{
					producerKind: "cli",
					event: {
						type: "session.upserted",
						repoIdentity: "repo-1",
						source: "claude",
						sessionId: "long-running",
						updatedAtMs: nowMs - 90 * 86_400_000,
						tools: [{ name: "code-review", kind: "skill", calls: 4, lastCallAtMs: nowMs - 3_600_000 }],
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		const result = await usage();
		expect(result?.skills).toEqual([{ name: "code-review", kind: "skill", sessions: 1, calls: 4 }]);
		expect(result?.sessionsInWindow).toBe(1);
		expect(result?.sessionsWithTools).toBe(1);
	});

	it("does not count a session whose own time is in the window but whose calls are not", async () => {
		// The mirror of the case above, and the other way the caveat can contradict
		// the table it sits under. A session touched an hour ago whose only tool call
		// was four months back is in the denominator (its own clock puts it here) but
		// its call is in no ranked row — both rankings window by call time. Counting
		// it as "with tools" printed "1 of 1 sessions" above an empty table.
		await applySummaryEvents(
			[
				repoEvent,
				{
					producerKind: "cli",
					event: {
						type: "session.upserted",
						repoIdentity: "repo-1",
						source: "claude",
						sessionId: "touched-today",
						updatedAtMs: nowMs - 3_600_000,
						tools: [{ name: "old-skill", kind: "skill", calls: 2, lastCallAtMs: nowMs - 120 * 86_400_000 }],
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		const result = await usage();
		expect(result?.skills).toEqual([]);
		expect(result?.sessionsInWindow).toBe(1);
		expect(result?.sessionsWithTools).toBe(0);
	});

	it("treats a stored 0 as no time at all, falling back to the session's own", async () => {
		// 0 is the one value a bare COALESCE cannot survive: it is not NULL, so the
		// row resolves to epoch 0 and leaves every window — while meaning exactly
		// what NULL means, "this parser could not stamp a time". Neither writer can
		// store one (both wrap their MAX in NULLIF), so the row below is written by
		// hand: the point of handling it at the READ is that it also covers a writer
		// that does not yet exist, which the migration this replaced could not.
		await applySummaryEvents([repoEvent, sessionWith("zeroed", [{ name: "Bash", kind: "builtin", calls: 3 }])], {
			producerKind: "cli",
			dbPath,
		});
		await withDashboardDb((db) => db.exec("UPDATE session_tool_use SET last_call_at_ms = 0"), { dbPath });

		const result = await usage();
		// Windowed by the session's `updated_at_ms` (an hour ago), not by epoch 0.
		expect(result?.sessionsInWindow).toBe(1);
		expect(result?.sessionsWithTools).toBe(1);
	});

	it("is empty, not absent, when nothing recorded a tool call", async () => {
		await applySummaryEvents([repoEvent, sessionWith("s1", undefined, "codex")], { producerKind: "cli", dbPath });
		expect(await usage()).toMatchObject({
			skills: [],
			mcpTools: [],
			servers: [],
			sessionsWithTools: 0,
			sessionsInWindow: 1,
		});
	});
});

describe("buildDashboardModel — recall usage", () => {
	let dir: string;
	let dbPath: string;
	const nowMs = Date.parse("2026-07-30T12:00:00Z");

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jolli-recall-"));
		dbPath = join(dir, "dashboard.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const repoEvent: StatsEventEnvelope = {
		producerKind: "cli",
		event: {
			type: "repo.enabled",
			repoIdentity: "repo-1",
			repoName: "jolli",
			worktreeRoot: "/w",
			enabledAt: "t",
		},
	};

	/** One session, with no recall of its own — receipts are their own events now. */
	const sessionWith = (
		sessionId: string,
		source: "claude" | "codex" = "claude",
		updatedAtMs: number = nowMs - 3_600_000,
	): StatsEventEnvelope => ({
		producerKind: "cli",
		event: { type: "session.upserted", repoIdentity: "repo-1", source, sessionId, updatedAtMs },
	});

	/** One recall call, as the surface that served it recorded it. */
	const recall = (
		outcome: {
			hit: boolean;
			commitCount: number;
			commits: ReadonlyArray<{ hash: string; date: string }>;
		},
		over: { atMs?: number; sessionId?: string; surface?: "mcp" | "cli" } = {},
	): StatsEventEnvelope => ({
		producerKind: "cli",
		event: {
			type: "recall.observed",
			repoIdentity: "repo-1",
			surface: over.surface ?? "mcp",
			atMs: over.atMs ?? nowMs - 3_600_000,
			...(over.sessionId ? { sessionId: over.sessionId } : {}),
			outcome,
		},
	});

	const hit = (hash: string, date: string) => ({ hit: true, commitCount: 1, commits: [{ hash, date }] });
	const miss = { hit: false, commitCount: 0, commits: [] };

	const recallUsage = async () =>
		(
			await withDashboardDb(
				(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
				{ dbPath },
			)
		).stats?.recallUsage;

	it("splits calls into used vs set aside and computes the served percentage", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				recall(hit("a".repeat(40), "2026-07-20"), { atMs: nowMs - 3_600_000 }),
				recall(miss, { atMs: nowMs - 3_500_000 }),
				recall(hit("b".repeat(40), "2026-07-25"), { atMs: nowMs - 3_400_000 }),
			],
			{ producerKind: "cli", dbPath },
		);
		const result = await recallUsage();
		expect(result?.usedCalls).toBe(2);
		expect(result?.setAsideCalls).toBe(1);
		expect(result?.contextServedPct).toBe(67); // round(2/3 * 100)
	});

	it("counts a CLI recall exactly like an MCP one, and splits them by surface", async () => {
		// The whole point of the receipt: before it, only an MCP call inside a
		// Claude session could ever be seen here.
		await applySummaryEvents(
			[
				repoEvent,
				recall(hit("a".repeat(40), "2026-07-20"), { surface: "cli", atMs: nowMs - 3_600_000 }),
				recall(miss, { surface: "mcp", atMs: nowMs - 3_500_000 }),
			],
			{ producerKind: "cli", dbPath },
		);
		const result = await recallUsage();
		expect(result?.usedCalls).toBe(1);
		expect(result?.bySurface).toEqual([
			{ surface: "cli", calls: 1 },
			{ surface: "mcp", calls: 1 },
		]);
	});

	it("counts distinct memories used, deduped by hash, and flags ones older than 30 days", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				// Same hash served twice — counts once.
				recall(hit("a".repeat(40), "2026-07-25"), { atMs: nowMs - 3_600_000 }),
				recall(hit("a".repeat(40), "2026-07-25"), { atMs: nowMs - 3_500_000 }),
				// A second, distinct memory older than 30 days as of nowMs (2026-07-30).
				recall(hit("b".repeat(40), "2026-06-01"), { atMs: nowMs - 3_400_000 }),
			],
			{ producerKind: "cli", dbPath },
		);
		const result = await recallUsage();
		expect(result?.distinctMemoriesUsed).toBe(2);
		expect(result?.staleMemoriesUsed).toBe(1);
	});

	it("counts sessions that got usable context out of all sessions in the window", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				sessionWith("s1"),
				sessionWith("s2"),
				sessionWith("s3", "codex"),
				recall(hit("a".repeat(40), "2026-07-25"), { sessionId: "s1", atMs: nowMs - 3_600_000 }),
				recall(miss, { sessionId: "s2", atMs: nowMs - 3_500_000 }),
			],
			{ producerKind: "cli", dbPath },
		);
		const result = await recallUsage();
		expect(result?.sessionsWithContext).toBe(1);
		expect(result?.sessionsInWindow).toBe(3);
	});

	it("counts a recalling session that has no sessions row yet", async () => {
		// A receipt is written at the edge the moment `recall` is called; the
		// `sessions` row only appears when StopHook or the editor tick runs. With
		// the denominator taken from `sessions` alone, a fresh agent that recalled
		// on its first turn rendered "1 of 0 sessions got prior context".
		await applySummaryEvents(
			[repoEvent, recall(hit("a".repeat(40), "2026-07-25"), { sessionId: "brand-new", atMs: nowMs - 60_000 })],
			{ producerKind: "cli", dbPath },
		);
		const result = await recallUsage();
		expect(result?.sessionsWithContext).toBe(1);
		expect(result?.sessionsInWindow).toBe(1);
	});

	it("counts a session-less call in the totals but attributes it to no session", async () => {
		// `jolli recall` typed at a shell prompt: a real call, no session to own it.
		await applySummaryEvents(
			[repoEvent, sessionWith("s1"), recall(hit("a".repeat(40), "2026-07-25"), { surface: "cli" })],
			{ producerKind: "cli", dbPath },
		);
		const result = await recallUsage();
		expect(result?.usedCalls).toBe(1);
		expect(result?.sessionsWithContext).toBe(0);
		expect(result?.callsWithoutSession).toBe(1);
	});

	it("counts session-less calls on their own, so a mixed window can say so", async () => {
		// `callsWithoutSession` is the statement "some receipt names no session",
		// which `sessionsWithContext === 0` ("no receipt names one") cannot make.
		// Both halves count: a set-aside call outside a session is just as
		// unattributable as a used one.
		await applySummaryEvents(
			[
				repoEvent,
				sessionWith("s1"),
				recall(hit("a".repeat(40), "2026-07-25"), { sessionId: "s1", atMs: nowMs - 3_600_000 }),
				recall(hit("b".repeat(40), "2026-07-25"), { surface: "cli", atMs: nowMs - 3_500_000 }),
				recall(miss, { surface: "cli", atMs: nowMs - 3_400_000 }),
			],
			{ producerKind: "cli", dbPath },
		);
		const result = await recallUsage();
		expect(result?.sessionsWithContext).toBe(1);
		expect(result?.callsWithoutSession).toBe(2);
	});

	/**
	 * Seeds the `jollimemory` recall REFERENCE — the only receipt-less channel
	 * that timestamps each call, and therefore the only one that can place a
	 * pre-receipt call on a day. Written directly because it reaches the database
	 * through the orphan import, not through the event stream.
	 */
	const seedRecallReference = async (atIsos: ReadonlyArray<string>): Promise<void> => {
		await withDashboardDb(
			(db) => {
				const { id } = db.prepare("SELECT id FROM repos WHERE repo_identity = 'repo-1'").get() as {
					id: number;
				};
				// Entry-line form (`ACCUMULATED_ENTRY_RE`), one per call, distinct query
				// texts so the accumulator does not collapse them into one.
				const body = atIsos.map((at, i) => `- \`query ${i}\` — ${at}`).join("\n");
				// `referenced_at` is NOT NULL exactly for a reference (schema CHECK); the
				// value is the row's own bookmark time, which the per-call entry lines in
				// `body_md` are what this test actually reads.
				db.prepare(
					`INSERT INTO context
					   (repo_id, kind, context_key, source, native_id, referenced_at, title, body_md, created_at_ms)
					 VALUES (?, 'reference', 'jollimemory:recall', 'jollimemory', 'recall', ?, 'Recall', ?, 1)`,
				).run(id, atIsos[0] ?? "2026-07-01T00:00:00.000Z", body);
			},
			{ dbPath },
		);
	};

	it("buckets receipts by their own day, so a multi-day window shows a bar per day", async () => {
		// The regression this pins: `daily` is the ONLY per-day series on the card,
		// and a chart holding one bar is indistinguishable from a broken one — so
		// "receipts land in their own day" has to be asserted, not assumed.
		const day = 86_400_000;
		await applySummaryEvents(
			[
				repoEvent,
				recall(hit("a".repeat(40), "2026-07-25"), { atMs: nowMs - 4 * day }),
				// Two calls on ONE day, a second apart. Not the same instant: a receipt
				// is keyed on `statsEventId`, whose only distinguishing part for a call
				// is when it happened, so two receipts sharing a millisecond converge on
				// one row by design (`ON CONFLICT(receipt_id) DO UPDATE`).
				recall(hit("b".repeat(40), "2026-07-25"), { atMs: nowMs - 2 * day }),
				recall(miss, { atMs: nowMs - 2 * day + 1_000 }),
				recall(hit("c".repeat(40), "2026-07-25"), { atMs: nowMs }),
			],
			{ producerKind: "cli", dbPath },
		);
		const result = await recallUsage();
		const active = (result?.daily ?? []).filter((d) => d.used > 0 || d.setAside > 0);
		expect(active).toEqual([
			{ date: "2026-07-26", used: 1, setAside: 0 },
			{ date: "2026-07-28", used: 1, setAside: 1 },
			{ date: "2026-07-30", used: 1, setAside: 0 },
		]);
		// Every day of the window is present, zeros included — that is what lets
		// the chart draw an axis instead of floating three bars in blank space.
		expect(result?.daily.length).toBeGreaterThan(3);
	});

	it("reports the first receipt's day unwindowed, as the series' starting boundary", async () => {
		await applySummaryEvents(
			[repoEvent, recall(hit("a".repeat(40), "2026-07-25"), { atMs: nowMs - 2 * 86_400_000 })],
			{ producerKind: "cli", dbPath },
		);
		expect((await recallUsage())?.receiptsSinceDate).toBe("2026-07-28");
	});

	it("leaves the starting boundary absent when nothing has ever been receipted", async () => {
		await applySummaryEvents([repoEvent], { producerKind: "cli", dbPath });
		expect((await recallUsage())?.receiptsSinceDate).toBeUndefined();
	});

	it("places a receipt-less call on its own day from the reference's timestamp", async () => {
		// Pre-receipt history: the call is known and dated, its OUTCOME is not.
		await applySummaryEvents([repoEvent], { producerKind: "cli", dbPath });
		await seedRecallReference(["2026-07-28T04:00:00.000Z", "2026-07-28T05:00:00.000Z"]);
		const result = await recallUsage();
		expect(result?.callsWithoutReceipt).toBe(2);
		expect(result?.daily.find((d) => d.date === "2026-07-28")).toEqual({
			date: "2026-07-28",
			used: 0,
			setAside: 0,
			estimated: 2,
		});
	});

	it("drops the estimate on any day a receipt already covers, so one call is never counted twice", async () => {
		// From the day receipts shipped, BOTH channels see the same call — the
		// reference extractor bookmarks exactly the recalls the serving code
		// receipted. Summing them would double that day.
		await applySummaryEvents(
			[repoEvent, recall(hit("a".repeat(40), "2026-07-25"), { atMs: Date.parse("2026-07-28T06:00:00Z") })],
			{ producerKind: "cli", dbPath },
		);
		await seedRecallReference(["2026-07-28T06:00:00.000Z", "2026-07-26T06:00:00.000Z"]);
		const result = await recallUsage();
		// The receipted day is told by its receipt alone...
		expect(result?.daily.find((d) => d.date === "2026-07-28")).toEqual({
			date: "2026-07-28",
			used: 1,
			setAside: 0,
		});
		// ...while a day with no receipt keeps its estimate.
		expect(result?.daily.find((d) => d.date === "2026-07-26")?.estimated).toBe(1);
	});

	it("omits `estimated` entirely on an ordinary day", async () => {
		// The field means "evidence with no recorded outcome". Emitting a 0 on
		// every point would put the key on every series for every machine.
		await applySummaryEvents([repoEvent, recall(hit("a".repeat(40), "2026-07-25"))], {
			producerKind: "cli",
			dbPath,
		});
		expect((await recallUsage())?.daily.every((d) => !("estimated" in d))).toBe(true);
	});

	it("reports skill invocations separately, so they cannot move the hit rate", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				{
					producerKind: "cli",
					event: {
						type: "session.upserted",
						repoIdentity: "repo-1",
						source: "claude",
						sessionId: "s1",
						updatedAtMs: nowMs - 3_600_000,
						tools: [{ name: "jolli-recall", kind: "skill", calls: 3 }],
					},
				} as StatsEventEnvelope,
				recall(hit("a".repeat(40), "2026-07-25"), { sessionId: "s1" }),
			],
			{ producerKind: "cli", dbPath },
		);
		const result = await recallUsage();
		expect(result?.skillInvocations).toBe(3);
		expect(result?.usedCalls).toBe(1);
		expect(result?.contextServedPct).toBe(100);
	});

	it("buckets calls into the daily series, summing back to the totals", async () => {
		await applySummaryEvents(
			[repoEvent, recall(hit("a".repeat(40), "2026-07-25")), recall(miss, { atMs: nowMs - 3_500_000 })],
			{ producerKind: "cli", dbPath },
		);
		const result = await recallUsage();
		const totalUsed = result?.daily.reduce((sum, d) => sum + d.used, 0);
		const totalSetAside = result?.daily.reduce((sum, d) => sum + d.setAside, 0);
		expect(totalUsed).toBe(1);
		expect(totalSetAside).toBe(1);
	});

	it("windows a call by its own atMs, not by any session's updatedAtMs", async () => {
		// A session updated (e.g. re-summarized) inside the window, but whose one
		// recall call actually happened weeks earlier, outside the window — must
		// NOT be counted as "today"'s call.
		const staleCallMs = Date.parse("2026-05-01T00:00:00Z");
		await applySummaryEvents(
			[repoEvent, sessionWith("s1"), recall(hit("a".repeat(40), "2026-07-25"), { atMs: staleCallMs })],
			{ producerKind: "cli", dbPath },
		);
		expect((await recallUsage())?.usedCalls).toBe(0);
	});

	it("counts a call inside the window even when its session last updated outside the window", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				sessionWith("s1", "claude", Date.parse("2026-06-01T00:00:00Z")),
				recall(hit("a".repeat(40), "2026-07-25"), { sessionId: "s1", atMs: nowMs - 3_600_000 }),
			],
			{ producerKind: "cli", dbPath },
		);
		const result = await recallUsage();
		expect(result?.usedCalls).toBe(1);
		// The session itself last updated outside the window, but its in-window
		// call must still be reflected in the denominator — otherwise the page
		// reports the nonsensical "1 of 0 sessions got prior context".
		expect(result?.sessionsWithContext).toBe(1);
		expect(result?.sessionsInWindow).toBe(1);
	});

	/** One session carrying recall tool rows, with an explicit per-call time. */
	const sessionWithRecallTools = (
		sessionId: string,
		tools: ReadonlyArray<{ name: string; kind: "skill" | "mcp"; server?: string; lastCallAtMs?: number }>,
		updatedAtMs: number = nowMs - 3_600_000,
		source: "claude" | "codex" = "claude",
	): StatsEventEnvelope =>
		({
			producerKind: "cli",
			event: {
				type: "session.upserted",
				repoIdentity: "repo-1",
				source,
				sessionId,
				updatedAtMs,
				tools: tools.map((t) => ({ ...t, calls: 1 })),
			},
		}) as StatsEventEnvelope;

	it("ranks the Skills panel by the call's own time too, matching the Recall card", async () => {
		// Same rows, same table, two panels: a bucket that lands in the window for
		// one and outside it for the other is a contradiction with no resolution
		// available to the reader.
		await applySummaryEvents(
			[
				repoEvent,
				sessionWithRecallTools(
					"fresh-call",
					[{ name: "jolli-recall", kind: "skill", lastCallAtMs: nowMs - 3_600_000 }],
					Date.parse("2026-05-01T00:00:00Z"),
				),
			],
			{ producerKind: "cli", dbPath },
		);
		const model = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		expect(model.stats?.toolUsage.skills).toEqual([{ name: "jolli-recall", kind: "skill", sessions: 1, calls: 1 }]);
		expect(model.stats?.recallUsage.skillInvocations).toBe(1);
	});

	it("windows a tool row by the CALL's own time, not by its session's", async () => {
		// The defect this column exists for: a session updated inside the window
		// whose recall actually happened months ago was filed under today, and a
		// call made an hour ago inside a long-running session was filed under
		// whenever that session last updated.
		await applySummaryEvents(
			[
				repoEvent,
				sessionWithRecallTools("stale-call", [
					{ name: "jolli-recall", kind: "skill", lastCallAtMs: Date.parse("2026-05-01T00:00:00Z") },
				]),
				sessionWithRecallTools(
					"fresh-call",
					[{ name: "jolli-recall", kind: "skill", lastCallAtMs: nowMs - 3_600_000 }],
					Date.parse("2026-05-01T00:00:00Z"),
				),
			],
			{ producerKind: "cli", dbPath },
		);
		// One in, one out — and note the two sessions' `updatedAtMs` say the exact
		// opposite, which is what the old windowing read.
		expect((await recallUsage())?.skillInvocations).toBe(1);
	});

	it("falls back to the session's time for a row whose parser stamped none", async () => {
		// Rows written before the column existed, and sources whose parsers cannot
		// supply a per-call time, hold NULL — a bare comparison against NULL is
		// false, so without COALESCE every one of them would silently vanish from
		// every window rather than keep its old placement.
		await applySummaryEvents(
			[repoEvent, sessionWithRecallTools("untimed", [{ name: "jolli-recall", kind: "skill" }])],
			{ producerKind: "cli", dbPath },
		);
		expect((await recallUsage())?.skillInvocations).toBe(1);
	});

	it("counts a skill run that left no MCP call and no attributable receipt", async () => {
		// The CLI-fallback recall: a `kind='skill'` row and nothing else. It used
		// to be invisible — `callsWithoutReceipt` only ever looked at MCP rows.
		await applySummaryEvents(
			[
				repoEvent,
				sessionWithRecallTools("codex-1", [{ name: "jolli-recall", kind: "skill" }], undefined, "codex"),
			],
			{ producerKind: "cli", dbPath },
		);
		const result = await recallUsage();
		expect(result?.skillRunsWithoutTrace).toBe(1);
		// Kept OUT of the call bound: a skill run that never recalled looks the same.
		expect(result?.callsWithoutReceipt).toBe(0);
		expect(result?.usedCalls).toBe(0);
	});

	it("does not count a skill run whose session also carries the MCP call", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				sessionWithRecallTools("claude-1", [
					{ name: "jolli:recall", kind: "skill" },
					{ name: "jollimemory.recall", kind: "mcp", server: "jollimemory" },
				]),
			],
			{ producerKind: "cli", dbPath },
		);
		expect((await recallUsage())?.skillRunsWithoutTrace).toBe(0);
	});

	it("does not count a skill run whose session has a receipt of its own", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				sessionWithRecallTools("claude-2", [{ name: "jolli-recall", kind: "skill" }]),
				recall(hit("a".repeat(40), "2026-07-25"), { sessionId: "claude-2", surface: "cli" }),
			],
			{ producerKind: "cli", dbPath },
		);
		expect((await recallUsage())?.skillRunsWithoutTrace).toBe(0);
	});

	it("subtracts session-less receipts, so a CLI recall is not counted twice", async () => {
		// codex/opencode export no session id, so their CLI receipt lands
		// unattributed — the same call the skill row describes. Counting both
		// would report one recall as two.
		await applySummaryEvents(
			[
				repoEvent,
				sessionWithRecallTools("codex-2", [{ name: "jolli-recall", kind: "skill" }], undefined, "codex"),
				recall(hit("a".repeat(40), "2026-07-25"), { surface: "cli" }),
			],
			{ producerKind: "cli", dbPath },
		);
		const result = await recallUsage();
		expect(result?.callsWithoutSession).toBe(1);
		expect(result?.skillRunsWithoutTrace).toBe(0);
	});

	it("is empty, not absent, when nothing made a recall call", async () => {
		await applySummaryEvents([repoEvent, sessionWith("s1", "codex")], { producerKind: "cli", dbPath });
		expect(await recallUsage()).toMatchObject({
			usedCalls: 0,
			setAsideCalls: 0,
			contextServedPct: 0,
			distinctMemoriesUsed: 0,
			staleMemoriesUsed: 0,
			sessionsWithContext: 0,
			sessionsInWindow: 1,
			bySurface: [],
			skillInvocations: 0,
		});
	});
});

describe("buildDashboardModel — memory tier (phase 2)", () => {
	let dir: string;
	let dbPath: string;
	const nowMs = Date.parse("2026-07-30T12:00:00Z");

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jolli-query2-"));
		dbPath = join(dir, "dashboard.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	async function seedMemory(): Promise<void> {
		await applySummaryEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w",
						enabledAt: "t",
					},
				},
				{
					producerKind: "bootstrap",
					event: {
						type: "commit.summary",
						repoIdentity: "repo-1",
						hash: "mem1",
						committedAtMs: nowMs - 3 * 3_600_000, // today
						branch: "feature/dash",
						message: "feat: memory commit",
						turns: 10,
						tokens: 20000,
						estCostUsd: 3,
						ticketId: "JOLLI-2069",
						insights: [
							{ kind: "decision", text: "picked sqlite" },
							{ kind: "todo", text: "CI flaky" },
						],
						references: [],
						sessionLinks: [],
					},
				},
				{
					producerKind: "bootstrap",
					event: {
						type: "commit.summary",
						repoIdentity: "repo-1",
						hash: "mem2",
						committedAtMs: nowMs - 26 * 3_600_000, // yesterday
						branch: "main",
						message: "fix: other",
						turns: 4,
						tokens: 8000,
						estCostUsd: 1,
						insights: [{ kind: "todo", text: "keep orphan branch?" }],
						references: [],
						sessionLinks: [],
					},
				},
				{
					producerKind: "cli",
					event: {
						type: "commit.created",
						repoIdentity: "repo-1",
						hash: "mem1",
						committedAtMs: nowMs - 3 * 3_600_000,
						branches: ["feature/dash"],
					},
				},
				{
					producerKind: "cli",
					event: {
						type: "commit.created",
						repoIdentity: "repo-1",
						hash: "mem2",
						committedAtMs: nowMs - 26 * 3_600_000,
						branches: ["main"],
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
	}

	it("detects the memory tier", async () => {
		await seedMemory();
		const model = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		expect(model.tier).toBe("memory");
	});

	it("counts both commits as captured — Memory Activity's denominator and gap count", async () => {
		await seedMemory();
		const model = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		// mem1 and mem2 each have both a commit.created row and a commit.summary
		// memory row, so neither is a gap: totalCommits === memoriesCreated.
		expect(model.stats?.totalCommits).toBe(2);
		expect(model.stats?.memoriesCreated).toBe(2);
	});

	it("windows memory cards on the committer date, matching the captured count", async () => {
		await seedMemory();
		// A rebased commit: authored days ago (what `CommitSummary.commitDate`
		// records, via `%aI`), landed today (what the collector records, via
		// `%cI`). The captured count has always used the committer date; the card
		// list used the author date, so the header counted a memory the feed
		// below it did not render.
		await withDashboardDb(
			(db) => {
				const { id: repoId } = db.prepare("SELECT id FROM repos WHERE repo_identity = 'repo-1'").get() as {
					id: number;
				};
				db.prepare("UPDATE memories SET commit_date_ms = ? WHERE repo_id = ? AND commit_hash = 'mem1'").run(
					nowMs - 400 * 24 * 3_600_000,
					repoId,
				);
			},
			{ dbPath },
		);
		const model = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		expect(model.stats?.memoriesCreated).toBe(2);
		expect(model.stats?.memoryCards?.map((c) => c.commitHash).sort()).toEqual(["mem1", "mem2"]);
	});

	it("orders and stamps memory cards on the committer date the page was selected by", async () => {
		await seedMemory();
		// Same rebased shape as above: mem1 landed today but was AUTHORED 400 days
		// ago. The page is selected and windowed on the committer date, so ordering
		// the payload query by `commit_date_ms` re-sorted it by author date behind
		// the selection — and the card then rendered a timestamp outside the very
		// window it was chosen for.
		await withDashboardDb(
			(db) => {
				const { id: repoId } = db.prepare("SELECT id FROM repos WHERE repo_identity = 'repo-1'").get() as {
					id: number;
				};
				db.prepare("UPDATE memories SET commit_date_ms = ? WHERE repo_id = ? AND commit_hash = 'mem1'").run(
					nowMs - 400 * 24 * 3_600_000,
					repoId,
				);
			},
			{ dbPath },
		);
		const model = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		// mem1 is the most recently LANDED commit, so it leads the feed.
		expect(model.stats?.memoryCards?.map((c) => c.commitHash)).toEqual(["mem1", "mem2"]);
		expect(model.stats?.memoryCards?.[0]?.committedAtMs).toBe(nowMs - 3 * 3_600_000);
	});

	it("credits a rewritten commit as captured through commit_aliases, decision included", async () => {
		await seedMemory();
		// Simulate mem1 getting rebased/amended after it was summarized: the live
		// commit row moves to a new hash, but the memory stays filed under the old
		// one — reachable only through commit_aliases (old_hash -> target_hash).
		await withDashboardDb(
			(db) => {
				const { id: repoId } = db.prepare("SELECT id FROM repos WHERE repo_identity = 'repo-1'").get() as {
					id: number;
				};
				db.prepare("UPDATE commits SET hash = 'mem1-rebased' WHERE repo_id = ? AND hash = 'mem1'").run(repoId);
				db.prepare(
					"INSERT INTO commit_aliases (repo_id, old_hash, target_hash, created_ms) VALUES (?, ?, ?, ?)",
				).run(repoId, "mem1-rebased", "mem1", 1);
			},
			{ dbPath },
		);
		const model = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		// Without the alias join, mem1-rebased would read as a gap and mem1's
		// decision ("picked sqlite") would disappear from the count entirely.
		expect(model.stats?.totalCommits).toBe(2);
		expect(model.stats?.memoriesCreated).toBe(2);
		expect(model.stats?.decisions?.keptCount).toBe(1);
	});

	it("assembles the Decisions card from mined commit decisions, latest first", async () => {
		await seedMemory();
		const model = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		// mem1 carries a decision ("picked sqlite"); mem2 carries only a todo.
		const decisions = model.stats?.decisions;
		if (!decisions) throw new Error("decisions missing");
		expect(decisions.keptCount).toBe(1);
		expect(decisions.repoCount).toBe(1);
		expect(decisions.latest).toMatchObject({ text: "picked sqlite", commitHash: "mem1", repoName: "jolli" });
		// decisionsCaptured mirrors the card's count rather than a second query.
		expect(model.stats?.decisionsCaptured).toBe(1);
		// One point per local day of the default 30-day window.
		expect(decisions.perDay).toHaveLength(30);
		expect(decisions.perDay.reduce((sum, d) => sum + d.count, 0)).toBe(1);
	});

	it("builds the branch dimension from memory-enriched commits", async () => {
		await seedMemory();
		const model = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "stats",
					scope: { kind: "all" },
					dimension: "branch",
					timeZone: "UTC",
					nowMs,
				}),
			{ dbPath },
		);
		const stats = model.stats;
		if (!stats) throw new Error("stats missing");
		expect(stats.seriesDimension).toBe("branch");
		expect(stats.seriesKeys).toEqual(["feature/dash", "main"]);
		const total = stats.series.reduce((sum, p) => sum + p.tokens, 0);
		expect(total).toBe(28000);
	});

	it("apportions a multi-branch commit so the day totals do not multiply", async () => {
		await seedMemory();
		// `commit_branches` is a per-branch `git rev-list` union, so a commit on
		// `main` is also listed under every feature branch based off it. Without
		// apportionment each extra branch added the commit's whole spend to the
		// day again — five branches turned a 20k-token commit into 120k.
		await applySummaryEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "commit.created",
						repoIdentity: "repo-1",
						hash: "mem1",
						committedAtMs: nowMs - 3 * 3_600_000,
						branches: ["feature/dash", "main", "release/1.x"],
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		const model = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "stats",
					scope: { kind: "all" },
					dimension: "branch",
					timeZone: "UTC",
					nowMs,
				}),
			{ dbPath },
		);
		const stats = model.stats;
		if (!stats) throw new Error("stats missing");
		expect(stats.seriesKeys).toEqual(["feature/dash", "main", "release/1.x"]);
		// Still the real total, with mem1's 20k split three ways across the axis.
		expect(stats.series.reduce((sum, p) => sum + p.tokens, 0)).toBe(28000);
		const today = stats.series[stats.series.length - 1];
		expect(today.tokens).toBe(20000);
	});

	it("builds the category dimension from memory_topics, sharing a commit's tokens across them", async () => {
		await seedMemory();
		// mem1 (20k tokens, today) spans four topics: bugfix ×2, feature, security.
		// The share is per TOPIC — 5k each — so security shows its 5k instead of
		// vanishing because it never wins a vote. mem2 (8k, yesterday) has no
		// topics and lands whole in '(uncategorised)'.
		await seedTopicRows(dbPath, "mem1", ["bugfix", "feature", "bugfix", "security"], {
			tokens: 20000,
			commitDateMs: nowMs - 3 * 3_600_000,
		});
		await seedTopicRows(dbPath, "mem2", [], { tokens: 8000, commitDateMs: nowMs - 26 * 3_600_000 });
		const model = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "stats",
					scope: { kind: "all" },
					dimension: "category",
					timeZone: "UTC",
					nowMs,
				}),
			{ dbPath },
		);
		const stats = model.stats;
		if (!stats) throw new Error("stats missing");
		expect(stats.seriesDimension).toBe("category");
		expect(stats.seriesKeys).toEqual(["(uncategorised)", "bugfix", "feature", "security"]);
		const today = stats.series[stats.series.length - 1];
		expect(today.bySeries).toEqual({ bugfix: 10000, feature: 5000, security: 5000 });
		const yesterday = stats.series[stats.series.length - 2];
		expect(yesterday.bySeries).toEqual({ "(uncategorised)": 8000 });
		// Sharing keeps the axis summing to the real total — the property the old
		// per-commit mode existed to protect.
		expect(stats.series.reduce((sum, p) => sum + p.tokens, 0)).toBe(28000);
	});

	it("builds the ticket dimension with a (no ticket) bucket", async () => {
		await seedMemory();
		const model = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "stats",
					scope: { kind: "all" },
					dimension: "ticket",
					timeZone: "UTC",
					nowMs,
				}),
			{ dbPath },
		);
		expect(model.stats?.seriesKeys).toEqual(["(no ticket)", "JOLLI-2069"]);
	});

	it("falls back to the model dimension when branch is requested below the memory tier", async () => {
		await applySummaryEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w",
						enabledAt: "t",
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		const model = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "stats",
					scope: { kind: "all" },
					dimension: "branch",
					timeZone: "UTC",
					nowMs,
				}),
			{ dbPath },
		);
		expect(model.tier).toBe("installed");
		expect(model.stats?.seriesDimension).toBe("model");
	});

	it("supports the agent dimension at any tier", async () => {
		await seedMemory();
		await applySummaryEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "session.upserted",
						repoIdentity: "repo-1",
						source: "codex",
						sessionId: "cx1",
						updatedAtMs: nowMs - 3_600_000,
						inputTokens: 500,
						outputTokens: 200,
						cachedTokens: 0,
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		const model = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "stats",
					scope: { kind: "all" },
					dimension: "agent",
					timeZone: "UTC",
					nowMs,
				}),
			{ dbPath },
		);
		expect(model.stats?.seriesDimension).toBe("agent");
		expect(model.stats?.seriesKeys).toEqual(["codex"]);
	});

	it("surfaces standup insights ordered risks-first from the window's commits", async () => {
		await seedMemory();
		const model = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "standup", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		const insights = model.standup?.insights;
		if (!insights) throw new Error("insights missing at memory tier");
		// Derivation reality: summaries carry decisions/todo per topic, nothing
		// else — todo ranks ahead of decision in the risk ordering.
		expect(insights.map((i) => i.kind)).toEqual(["todo", "todo", "decision"]);
		expect(insights[0]).toMatchObject({
			text: "CI flaky",
			commitHash: "mem1",
			repoName: "jolli",
		});
	});

	it("omits standup insights entirely below the memory tier", async () => {
		await applySummaryEvents([], { producerKind: "cli", dbPath }); // schema only
		const model = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "standup", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		expect(model.standup?.insights).toBeUndefined();
	});

	const standupOf = async () =>
		(
			await withDashboardDb(
				(db) => buildDashboardModel(db, { view: "standup", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
				{ dbPath },
			)
		).standup;

	it("carries the memory-tier commit columns the board's outcome rows read", async () => {
		await seedMemory();
		const standup = await standupOf();
		// mem1 landed today and names a ticket; mem2 landed yesterday and does not.
		expect(standup?.todayCommits[0]).toMatchObject({
			hash: "mem1",
			turns: 10,
			estCostUsd: 3,
			ticketId: "JOLLI-2069",
		});
		const yesterday = standup?.yesterdayCommits[0];
		expect(yesterday).toMatchObject({ hash: "mem2", turns: 4, estCostUsd: 1 });
		// Absent, not zero or empty: the row has to be able to omit what it does not
		// know rather than render "$0.00 est" as if that were measured.
		expect(yesterday).not.toHaveProperty("ticketId");
		expect(yesterday).not.toHaveProperty("workCategory");
	});

	it("derives the work-category label from the commit's topics at query time", async () => {
		await applySummaryEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w",
						enabledAt: "t",
					},
				},
				{
					producerKind: "cli",
					event: {
						type: "commit.summary",
						repoIdentity: "repo-1",
						hash: "cat1",
						committedAtMs: nowMs - 3_600_000,
						message: "feat: categorised",
						insights: [{ kind: "todo", text: "add the test" }],
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		// Mode: two feature topics outvote one ux topic.
		await seedTopicRows(dbPath, "cat1", ["feature", "ux", "feature"]);
		expect((await standupOf())?.todayCommits[0]).toMatchObject({ hash: "cat1", workCategory: "feature" });
	});

	it("breaks label ties toward the first-appearing category — the stored copy's exact rule", async () => {
		// 15% of this repo's commits tie at the top, so the tie is not an edge
		// case: moving the mode from write time to query time must not re-bucket
		// them. The old collector's stable sort over Map insertion order resolved
		// a tie to the category whose topic appears FIRST in the array.
		await applySummaryEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w",
						enabledAt: "t",
					},
				},
				{
					producerKind: "cli",
					event: {
						type: "commit.summary",
						repoIdentity: "repo-1",
						hash: "tie1",
						committedAtMs: nowMs - 3_600_000,
						message: "feat: tied",
						turns: 1,
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		// bugfix and ux both count 2; bugfix's first topic sits at pos 0.
		await seedTopicRows(dbPath, "tie1", ["bugfix", "ux", "ux", "bugfix"]);
		expect((await standupOf())?.todayCommits[0]).toMatchObject({ hash: "tie1", workCategory: "bugfix" });
	});

	it("leaves the memory-tier columns off a commit only git reported", async () => {
		await applySummaryEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w",
						enabledAt: "t",
					},
				},
				{
					producerKind: "cli",
					event: {
						type: "commit.created",
						repoIdentity: "repo-1",
						hash: "raw1",
						committedAtMs: nowMs - 3_600_000,
						message: "chore: no summary yet",
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		const commit = (await standupOf())?.todayCommits[0];
		expect(commit).toMatchObject({ hash: "raw1" });
		expect(commit).not.toHaveProperty("turns");
		expect(commit).not.toHaveProperty("estCostUsd");
		expect(commit).not.toHaveProperty("ticketId");
	});

	it("dates every standup insight by the commit that raised it", async () => {
		await seedMemory();
		const insights = (await standupOf())?.insights ?? [];
		expect(insights.length).toBeGreaterThan(0);
		expect(insights.every((insight) => typeof insight.committedAtMs === "number")).toBe(true);
		// "CI flaky" came out of mem1, which landed three hours before now.
		expect(insights.find((insight) => insight.text === "CI flaky")?.committedAtMs).toBe(nowMs - 3 * 3_600_000);
	});
});

describe("repo scope resolution (?repo= token)", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jolli-scope-"));
		dbPath = join(dir, "dashboard.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** Registers repos as `(identity, name)` pairs. */
	async function seedRepos(pairs: ReadonlyArray<readonly [string, string]>): Promise<void> {
		await applySummaryEvents(
			pairs.map(([repoIdentity, repoName]) => ({
				producerKind: "cli" as const,
				event: {
					type: "repo.enabled" as const,
					repoIdentity,
					repoName,
					worktreeRoot: `/w/${repoName}`,
					enabledAt: "2026-07-01T00:00:00.000Z",
				},
			})),
			{ producerKind: "cli", dbPath },
		);
	}

	const scopeOf = (scope: DashboardScope): Promise<DashboardScope> =>
		withDashboardDb((db) => buildDashboardModel(db, { view: "stats", scope }).scope, { dbPath });

	it("accepts a repo name and echoes back the stored identity", async () => {
		await seedRepos([["https://github.com/jolliai/jolliai", "jolliai"]]);
		expect(await scopeOf({ kind: "repo", repoIdentity: "jolliai" })).toEqual({
			kind: "repo",
			repoIdentity: "https://github.com/jolliai/jolliai",
		});
	});

	it("still accepts a full identity unchanged", async () => {
		await seedRepos([["https://github.com/jolliai/jolliai", "jolliai"]]);
		expect(await scopeOf({ kind: "repo", repoIdentity: "https://github.com/jolliai/jolliai" })).toEqual({
			kind: "repo",
			repoIdentity: "https://github.com/jolliai/jolliai",
		});
	});

	it("prefers an exact identity over a repo that is merely NAMED like one", async () => {
		// A repo named after someone else's remote must not shadow that remote.
		await seedRepos([
			["https://github.com/jolliai/jolliai", "jolliai"],
			["local:abc", "https://github.com/jolliai/jolliai"],
		]);
		expect(await scopeOf({ kind: "repo", repoIdentity: "https://github.com/jolliai/jolliai" })).toEqual({
			kind: "repo",
			repoIdentity: "https://github.com/jolliai/jolliai",
		});
	});

	it("refuses to guess when two repos share a name", async () => {
		await seedRepos([
			["https://github.com/one/jolli", "jolli"],
			["https://github.com/two/jolli", "jolli"],
		]);
		// Left unresolved: showing the wrong project's numbers under a
		// plausible-looking URL is worse than showing none.
		expect(await scopeOf({ kind: "repo", repoIdentity: "jolli" })).toEqual({
			kind: "repo",
			repoIdentity: "jolli",
		});
	});

	it("leaves an unknown token alone", async () => {
		await seedRepos([["https://github.com/jolliai/jolliai", "jolliai"]]);
		expect(await scopeOf({ kind: "repo", repoIdentity: "nope" })).toEqual({
			kind: "repo",
			repoIdentity: "nope",
		});
	});

	it("passes an all-repos scope through untouched", async () => {
		await seedRepos([["https://github.com/jolliai/jolliai", "jolliai"]]);
		expect(await scopeOf({ kind: "all" })).toEqual({ kind: "all" });
	});
});

describe("memory cards feed", () => {
	let dir: string;
	let dbPath: string;
	const nowMs = Date.parse("2026-07-30T12:00:00Z");
	const committedAt = "2026-07-29T16:54:00.000Z";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jolli-cards-"));
		dbPath = join(dir, "dashboard.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** A summary payload shaped like the ones the importer stores. */
	const payload = (over: Record<string, unknown> = {}): string =>
		JSON.stringify({
			version: "5",
			commitHash: "h1",
			commitMessage: "fix: token refresh race in gateway retries",
			commitAuthor: "dev",
			commitDate: committedAt,
			branch: "fix-auth-refresh",
			generatedAt: committedAt,
			commitType: "commit",
			recap: "A recap sentence.",
			topics: [
				{
					title: "Token refresh",
					category: "bugfix",
					decisions: "- **Keep jittered backoff**: contention was the disease.\n- Second decision.",
					sourceCommits: ["h1"],
				},
			],
			conversationTurns: 3,
			estimatedCostUsd: 2.29,
			diffStats: { filesChanged: 2, insertions: 58, deletions: 11 },
			// The summarizer that wrote the summary — must NOT be shown as the
			// model that did the work.
			llm: { model: "claude-haiku-4-5" },
			conversationModels: [
				{ model: "claude-opus-4-8", provider: "anthropic", input: 10, output: 100, cached: 0 },
				{ model: "claude-fable-5", provider: "anthropic", input: 10, output: 900, cached: 0 },
			],
			...over,
		});

	/** Seeds a repo plus one SOT memory node whose payload is `json`. */
	async function seedCard(json: string, hash = "h1"): Promise<void> {
		await applySummaryEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w",
						enabledAt: "t",
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		await withDashboardDb(
			(db) => {
				const { id } = db.prepare("SELECT id FROM repos WHERE repo_identity = 'repo-1'").get() as {
					id: number;
				};
				// One row per commit: identity, topology and content together.
				db.prepare(
					`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
					                       summary_json, first_seen_ms, written_at_ms, commit_date_ms)
					 VALUES (?, ?, NULL, NULL, ?, 0, ?, 1, 1, ?)`,
				).run(id, hash, hash, json, Date.parse(committedAt));
			},
			{ dbPath },
		);
	}

	const cards = (scope: DashboardScope = { kind: "all" }): Promise<StatsModel["memoryCards"]> =>
		withDashboardDb(
			(db) =>
				(buildDashboardModel(db, { view: "stats", scope, nowMs, timeZone: "UTC" }).stats as StatsModel)
					.memoryCards,
			{ dbPath },
		);

	it("builds a card from the stored summary", async () => {
		await seedCard(payload());
		expect(await cards()).toEqual([
			{
				repoIdentity: "repo-1",
				commitHash: "h1",
				title: "fix: token refresh race in gateway retries",
				category: "bugfix",
				severity: "minor",
				committedAtMs: Date.parse(committedAt),
				decision: "Keep jittered backoff: contention was the disease.",
				estCostUsd: 2.29,
				turns: 3,
				insertions: 58,
				deletions: 11,
				branch: "fix-auth-refresh",
				model: "claude-fable-5",
				repoName: "jolli",
			},
		]);
	});

	it("keeps Memory Activity cards when the dashboard is scoped to their repository", async () => {
		await seedCard(payload());
		expect(await cards({ kind: "repo", repoIdentity: "repo-1" })).toHaveLength(1);
	});

	it("shows the model that did the work, not the one that wrote the summary", async () => {
		await seedCard(payload());
		const [card] = await cards();
		expect(card.model).toBe("claude-fable-5"); // most output tokens
		expect(card.model).not.toBe("claude-haiku-4-5"); // summary.llm.model
	});

	it("falls back to the recap when no topic recorded a decision", async () => {
		await seedCard(payload({ topics: [{ title: "T", category: "feature", sourceCommits: ["h1"] }] }));
		const [card] = await cards();
		expect(card.decision).toBe("A recap sentence.");
		expect(card.category).toBe("feature");
	});

	it("omits the decision entirely when there is neither", async () => {
		await seedCard(payload({ topics: [], recap: undefined }));
		const [card] = await cards();
		expect(card.decision).toBeUndefined();
	});

	it("reads severity off the diff magnitude", async () => {
		await seedCard(payload({ diffStats: { filesChanged: 9, insertions: 400, deletions: 120 } }));
		expect((await cards())[0].severity).toBe("major");
	});

	it("picks the dominant category when topics disagree", async () => {
		await seedCard(
			payload({
				topics: [
					{ title: "A", category: "docs", sourceCommits: ["h1"] },
					{ title: "B", category: "feature", sourceCommits: ["h1"] },
					{ title: "C", category: "feature", sourceCommits: ["h1"] },
				],
			}),
		);
		expect((await cards())[0].category).toBe("feature");
	});

	it("orders newest first and respects the window", async () => {
		await seedCard(payload(), "h1");
		await withDashboardDb(
			(db) => {
				const { id } = db.prepare("SELECT id FROM repos WHERE repo_identity = 'repo-1'").get() as {
					id: number;
				};
				// Inside the window, one day older.
				db.prepare(
					`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
					                       summary_json, first_seen_ms, written_at_ms, commit_date_ms)
					 VALUES (?, 'h2', NULL, NULL, 'h2', 0, ?, 1, 1, ?)`,
				).run(id, payload({ commitHash: "h2", commitMessage: "older" }), Date.parse(committedAt) - 86_400_000);
				// Long before the window — must not appear.
				db.prepare(
					`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
					                       summary_json, first_seen_ms, written_at_ms, commit_date_ms)
					 VALUES (?, 'h3', NULL, NULL, 'h3', 0, ?, 1, 1, ?)`,
				).run(id, payload({ commitHash: "h3" }), Date.parse("2025-01-01T00:00:00Z"));
			},
			{ dbPath },
		);
		expect((await cards()).map((c) => c.commitHash)).toEqual(["h1", "h2"]);
	});
});

describe("memory cards — sparse summaries", () => {
	let dir: string;
	let dbPath: string;
	const nowMs = Date.parse("2026-07-30T12:00:00Z");
	const committedAt = "2026-07-29T16:54:00.000Z";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jolli-cards2-"));
		dbPath = join(dir, "dashboard.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** Seeds one node whose payload holds only what a caller passes. */
	async function seed(extra: Record<string, unknown>): Promise<void> {
		await applySummaryEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w",
						enabledAt: "t",
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		const json = JSON.stringify({
			version: "5",
			commitHash: "h1",
			commitAuthor: "dev",
			commitDate: committedAt,
			generatedAt: committedAt,
			commitType: "commit",
			...extra,
		});
		await withDashboardDb(
			(db) => {
				const { id } = db.prepare("SELECT id FROM repos WHERE repo_identity = 'repo-1'").get() as {
					id: number;
				};
				db.prepare(
					`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
					                       summary_json, first_seen_ms, written_at_ms, commit_date_ms)
					 VALUES (?, 'h1', NULL, NULL, 'h1', 0, ?, 1, 1, ?)`,
				).run(id, json, Date.parse(committedAt));
			},
			{ dbPath },
		);
	}

	const card = (): Promise<StatsModel["memoryCards"][number]> =>
		withDashboardDb(
			(db) =>
				(
					buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, nowMs, timeZone: "UTC" })
						.stats as StatsModel
				).memoryCards[0],
			{ dbPath },
		);

	it("omits every optional field a bare summary never recorded", async () => {
		await seed({});
		expect(await card()).toEqual({
			repoIdentity: "repo-1",
			commitHash: "h1",
			title: "",
			severity: "minor",
			committedAtMs: Date.parse(committedAt),
			repoName: "jolli",
		});
	});

	it("reports no model when the summary lists none", async () => {
		await seed({ conversationModels: [] });
		expect((await card()).model).toBeUndefined();
	});

	it("ignores a model entry with no name and takes the next best", async () => {
		await seed({
			conversationModels: [
				{ provider: "anthropic", output: 9_000 },
				{ model: "claude-opus-5", provider: "anthropic", output: 5 },
			],
		});
		expect((await card()).model).toBe("claude-opus-5");
	});

	it("treats a model with no output count as zero rather than skipping it", async () => {
		await seed({ conversationModels: [{ model: "claude-haiku-4-5", provider: "anthropic" }] });
		expect((await card()).model).toBe("claude-haiku-4-5");
	});

	it("moves past a topic whose decision block holds no bullet text", async () => {
		await seed({
			recap: "the recap",
			topics: [
				{ title: "A", decisions: "-\n- \n", sourceCommits: ["h1"] },
				{ title: "B", decisions: "- The real decision.", sourceCommits: ["h1"] },
			],
		});
		expect((await card()).decision).toBe("The real decision.");
	});

	it("counts a one-sided diff for severity", async () => {
		await seed({ diffStats: { filesChanged: 1, deletions: 500 } });
		const c = await card();
		expect(c.severity).toBe("major");
		expect(c.insertions).toBeUndefined();
		expect(c.deletions).toBe(500);
	});
});

describe("standup author filter", () => {
	let dir: string;
	let dbPath: string;
	const nowMs = Date.parse("2026-07-30T12:00:00Z");
	const MINE = { emails: ["Me@Example.com"], names: ["Me"] };

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jolli-author-"));
		dbPath = join(dir, "dashboard.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/**
	 * A shared branch as it actually looks after a fetch: my commit, a teammate's,
	 * one of mine recorded under a name but no email (an import, or a rewritten
	 * noreply address), plus a session and a dirty worktree.
	 */
	async function seedSharedBranch(): Promise<void> {
		const commit = (hash: string, message: string, author: { name?: string; email?: string }) => ({
			producerKind: "cli" as const,
			event: {
				type: "commit.created" as const,
				repoIdentity: "repo-1",
				hash,
				committedAtMs: nowMs - 3_600_000,
				message,
				...(author.name ? { authorName: author.name } : {}),
				...(author.email ? { authorEmail: author.email } : {}),
			},
		});
		await applySummaryEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w",
						enabledAt: "t",
					},
				},
				// Lower-case on the row, mixed-case in the identity: emails are matched
				// case-folded, so this pair has to match.
				commit("mine1", "feat: my work", { name: "Me", email: "me@example.com" }),
				commit("theirs1", "release: intellij 0.99.11", {
					name: "Teammate",
					email: "teammate@example.com",
				}),
				commit("mine2", "fix: also mine", { name: "Me" }),
				{
					producerKind: "cli",
					event: {
						type: "session.upserted",
						repoIdentity: "repo-1",
						source: "claude",
						sessionId: "s1",
						updatedAtMs: nowMs - 3_600_000,
						inputTokens: 10,
						outputTokens: 5,
						cachedTokens: 0,
					},
				},
				{
					producerKind: "cli",
					event: {
						type: "worktree.status",
						repoIdentity: "repo-1",
						branch: "main",
						filesChanged: 1,
						insertions: 2,
						deletions: 3,
						observedAtMs: nowMs,
					},
				},
				// A memory on the teammate's commit only — its todo is what the Risks
				// column would otherwise ask the reader to answer for.
				{
					producerKind: "bootstrap",
					event: {
						type: "commit.summary",
						repoIdentity: "repo-1",
						hash: "theirs1",
						committedAtMs: nowMs - 3_600_000,
						message: "release: intellij 0.99.11",
						insights: [{ kind: "todo", text: "someone else's TODO" }],
						references: [],
						sessionLinks: [],
					},
				},
				{
					producerKind: "bootstrap",
					event: {
						type: "commit.summary",
						repoIdentity: "repo-1",
						hash: "mine1",
						committedAtMs: nowMs - 3_600_000,
						message: "feat: my work",
						insights: [{ kind: "todo", text: "my own TODO" }],
						references: [],
						sessionLinks: [],
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
	}

	const standupOf = async (authorIdentity?: QueryOptions["authorIdentity"]) =>
		(
			await withDashboardDb(
				(db) =>
					buildDashboardModel(db, {
						view: "standup",
						scope: { kind: "all" },
						timeZone: "UTC",
						nowMs,
						...(authorIdentity ? { authorIdentity } : {}),
					}),
				{ dbPath },
			)
		).standup;

	it("keeps only the local identity's commits, matching email case-insensitively or name", async () => {
		await seedSharedBranch();
		const standup = await standupOf(MINE);
		expect(standup?.todayCommits.map((c) => c.hash).sort()).toEqual(["mine1", "mine2"]);
		expect(standup?.authoredBy).toBe("Me@Example.com");
	});

	it("drops a teammate's TODO out of the Risks column", async () => {
		await seedSharedBranch();
		const insights = (await standupOf(MINE))?.insights ?? [];
		expect(insights.map((i) => i.text)).toEqual(["my own TODO"]);
	});

	it("leaves sessions and the dirty worktree unfiltered — they are this machine's own state", async () => {
		await seedSharedBranch();
		const standup = await standupOf(MINE);
		expect(standup?.todaySessions.map((s) => s.sessionId)).toEqual(["s1"]);
		expect(standup?.workspaces).toHaveLength(1);
	});

	it("fails open on an identity with nothing usable in it, and says so by omitting authoredBy", async () => {
		await seedSharedBranch();
		for (const identity of [undefined, { emails: [], names: [] }, { emails: ["  "], names: [" "] }]) {
			const standup = await standupOf(identity);
			expect(standup?.todayCommits.map((c) => c.hash).sort()).toEqual(["mine1", "mine2", "theirs1"]);
			expect(standup).not.toHaveProperty("authoredBy");
			expect((standup?.insights ?? []).length).toBe(2);
		}
	});

	it("labels a name-only identity with the name", async () => {
		await seedSharedBranch();
		const standup = await standupOf({ emails: [], names: ["Me"] });
		expect(standup?.authoredBy).toBe("Me");
		expect(standup?.todayCommits.map((c) => c.hash).sort()).toEqual(["mine1", "mine2"]);
	});

	it("never filters the stats page — repo activity is not a first-person question", async () => {
		await seedSharedBranch();
		const model = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "stats",
					scope: { kind: "all" },
					timeZone: "UTC",
					nowMs,
					authorIdentity: MINE,
				}),
			{ dbPath },
		);
		expect(model.stats?.totalCommits).toBe(3);
	});
});
