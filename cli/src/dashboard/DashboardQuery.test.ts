import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `volumeReachable` keeps the REAL implementation; it is wrapped only because its
// `false` answer is unreachable on POSIX, where every absolute path bottoms out at
// a live `/`. That is the same seam `RepoForget` gives its own callers, and the only
// way the volume-absent verdict can be covered on an ubuntu CI.
vi.mock("./RepoForget.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./RepoForget.js")>();
	return { ...actual, volumeReachable: vi.fn(actual.volumeReachable) };
});

import { withDashboardDb } from "./DashboardDb.js";
import type {
	DashboardScope,
	McpServerRow,
	SessionUpsertedEvent,
	StandupCommit,
	StandupModel,
	StatsEventEnvelope,
	StatsModel,
	ToolUsageRow,
} from "./DashboardModel.js";
import { MEMORY_CARDS_LIMIT, TOOL_ROWS_LIMIT } from "./DashboardModel.js";

/** UTC+8, no DST — the zone the day-boundary cases below contrast with UTC. */
const SH = "Asia/Shanghai";

import {
	buildDashboardModel,
	buildSkillDetail,
	buildToolUsagePage,
	type QueryOptions,
	STANDUP_MAX_OFFSET,
} from "./DashboardQuery.js";
import { volumeReachable } from "./RepoForget.js";
import { applyStatsEvents } from "./StatsWriter.js";

/** Every commit across a standup window's day columns, flattened newest-day-first. */
function standupCommits(standup: StandupModel | undefined): ReadonlyArray<StandupCommit> {
	return (standup?.days ?? []).flatMap((d) => d.commits);
}

/** The single commit with `hash` anywhere in the window, or undefined. */
function commitByHash(standup: StandupModel | undefined, hash: string): StandupCommit | undefined {
	return standupCommits(standup).find((c) => c.hash === hash);
}

/** The local day key of the column that holds `hash`, or undefined. */
function commitDayKey(standup: StandupModel | undefined, hash: string): string | undefined {
	return (standup?.days ?? []).find((d) => d.commits.some((c) => c.hash === hash))?.day;
}

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
 * Adds one SUPERSEDED predecessor of `rootHash` — the row an amend or a squash
 * leaves behind. It carries the same tokens/cost as the memory it precedes
 * (production copies them forward), gets its own `commits` row on the same
 * branch, and is marked as a non-root generation via `parent_hash`.
 *
 * The `commits` row is the point: an INNER JOIN on `commits` looks like it
 * filters these out and does not — `commits` keeps rows that git can no longer
 * reach, which is why `memoriesCreated` carries a separate `isReachable` pass.
 */
async function seedSupersededPredecessor(
	dbPath: string,
	rootHash: string,
	predHash: string,
	opts: {
		branch: string;
		childPos: number;
		tokens: number;
		estCostUsd: number;
		committedAtMs: number;
		/** Topics the predecessor recorded — a superseded generation keeps its own. */
		topics?: ReadonlyArray<Record<string, unknown>>;
	},
): Promise<void> {
	await withDashboardDb(
		(db) => {
			const { id: repoId } = db.prepare("SELECT id FROM repos WHERE repo_identity = 'repo-1'").get() as {
				id: number;
			};
			db.prepare(
				`INSERT INTO commits (event_id, repo_id, hash, branch, message, committed_at_ms)
				 VALUES (?, ?, ?, ?, 'superseded', ?)`,
			).run(`ev-${predHash}`, repoId, predHash, opts.branch, opts.committedAtMs);
			const { id: commitId } = db
				.prepare("SELECT id FROM commits WHERE repo_id = ? AND hash = ?")
				.get(repoId, predHash) as { id: number };
			db.prepare("INSERT OR IGNORE INTO branches (name) VALUES (?)").run(opts.branch);
			const { id: branchId } = db.prepare("SELECT id FROM branches WHERE name = ?").get(opts.branch) as {
				id: number;
			};
			db.prepare("INSERT INTO commit_branches (commit_id, branch_id) VALUES (?, ?)").run(commitId, branchId);
			db.prepare(
				`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
				                       summary_json, first_seen_ms, written_at_ms, commit_date_ms)
				 VALUES (?, ?, ?, ?, ?, 1, ?, 1, 1, ?)`,
			).run(
				repoId,
				predHash,
				rootHash,
				opts.childPos,
				rootHash,
				JSON.stringify({
					commitHash: predHash,
					conversationTokens: opts.tokens,
					estimatedCostUsd: opts.estCostUsd,
					ticketId: "JOLLI-2069",
					...(opts.topics ? { topics: opts.topics } : {}),
				}),
				opts.committedAtMs,
			);
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

	/**
	 * A session whose per-response rows are INCOMPLETE must be counted by its
	 * session-level total, not by the part it has.
	 *
	 * The rule this pins used to be an existence test (`NOT EXISTS (…events…)`)
	 * where the question is completeness, and the difference was silent loss.
	 * Measured on a real database: one session of 2,048,519 tokens had a single
	 * event row worth 52,020, so 97.5% of it appeared nowhere — 2,775,239 tokens
	 * and $23.39 missing from a 30-day window. A partial row set is reachable by
	 * construction, not a parser defect: `projectSession` replaces the rows
	 * wholesale (so a read cut short by a `beforeTimestamp` cutoff writes only its
	 * slice), while `projectCommitSummary` restores `sessions` and
	 * `session_model_usage` to the full figures and has no write for this table.
	 *
	 * Both arms are asserted together, because the two failures are opposite: a
	 * predicate that is not the exact complement of the other either drops the
	 * partial session's remainder or counts the complete one twice.
	 */
	it("counts a session with partial usage rows by its session total, and a complete one by its rows", async () => {
		const partialDay = Date.parse("2026-07-28T10:00:00Z");
		const completeDay = Date.parse("2026-07-20T10:00:00Z");
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
				// Its rows account for 100 of 1000 — the shape a truncated read leaves.
				session({
					sessionId: "partial",
					updatedAtMs: partialDay,
					models: undefined,
					inputTokens: 1000,
					outputTokens: 0,
					cachedTokens: 0,
					usageEvents: [
						{
							respondedAtMs: partialDay,
							model: "claude-opus-5",
							input: 100,
							output: 0,
							cached: 0,
							dedupKey: "p1",
						},
					],
				}),
				// Its rows account for all 500.
				session({
					sessionId: "complete",
					updatedAtMs: partialDay,
					models: undefined,
					inputTokens: 500,
					outputTokens: 0,
					cachedTokens: 0,
					usageEvents: [
						{
							respondedAtMs: completeDay,
							model: "claude-opus-5",
							input: 500,
							output: 0,
							cached: 0,
							dedupKey: "c1",
						},
					],
				}),
			],
			{ dbPath, producerKind: "cli" },
		);

		const model = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "stats",
					scope: { kind: "all" },
					timeZone: "UTC",
					nowMs,
					dimension: "model",
					range: "month",
				}),
			{ dbPath },
		);
		const perDay = new Map(model.stats?.tokenBreakdown.perDay.map((d) => [d.date, d.input]) ?? []);

		// 1500, not 600 (the partial session's remainder dropped) and not 2000
		// (both arms counting it).
		expect(model.stats?.tokenBreakdown.input).toBe(1500);
		// The complete one is placed on its RESPONSE's day, eight days before the
		// session was last touched — the distribution this table exists for.
		expect(perDay.get("2026-07-20")).toBe(500);
		// The partial one falls back whole onto its session day.
		expect(perDay.get("2026-07-28")).toBe(1000);
	});

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

	// The optional sidebar rows. This builder is synchronous and the flags live in
	// a file, so the server reads them and passes them in — which makes the DEFAULT
	// the interesting case: an omitted slice must land on hidden, or a caller that
	// has never heard of the flags switches a row on by saying nothing.
	it("defaults both optional menu rows to hidden when the caller passes none", async () => {
		await seed();
		const model = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		expect(model.menus).toEqual({ knowledge: false, graph: false });
	});

	it("passes a caller's menu flags through unchanged", async () => {
		await seed();
		const model = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "stats",
					scope: { kind: "all" },
					timeZone: "UTC",
					nowMs,
					menus: { knowledge: true, graph: false },
				}),
			{ dbPath },
		);
		expect(model.menus).toEqual({ knowledge: true, graph: false });
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

	it("scopes the session feed and the series to the requested range", async () => {
		await seed();
		const forRange = async (range: "today" | "week" | "2w" | "month") =>
			withDashboardDb(
				(db) =>
					buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs, range }),
				{ dbPath },
			);

		// today-1 is an hour ago; yesterday-1 is 26 h back; old-1 is 10 days back.
		const today = await forRange("today");
		expect(today.stats?.recentSessions).toHaveLength(1);
		expect(today.stats?.series).toHaveLength(1); // one day bucket

		const week = await forRange("week");
		expect(week.stats?.recentSessions).toHaveLength(2); // old-1 excluded
		expect(week.stats?.series).toHaveLength(7);

		const month = await forRange("month");
		expect(month.stats?.recentSessions).toHaveLength(3);
		expect(month.stats?.series).toHaveLength(30);

		// The heatmap is deliberately NOT range-scoped — it is the 12-week long view.
		expect(today.stats?.heatmap).toHaveLength(84);
		expect(month.stats?.heatmap).toHaveLength(84);
	});

	it("assembles the stats view with the series, heatmap, hours and recent sessions", async () => {
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
		//
		// Deliberately not an exact-shape `toEqual`: `missing` is decided by whether
		// `/w` exists, which is a property of the machine rather than of this test
		// (it resolves to `C:\w` on Windows, and that directory does exist on some
		// developer boxes). The flag has its own tests below and in RepoForget.
		expect(model.repos).toHaveLength(1);
		expect(model.repos[0]).toMatchObject({
			repoIdentity: "repo-1",
			repoName: "jolli",
			worktreeRoot: "/w",
			sessionsThisWeek: 2,
		});
		// An active row still carries no `disabled` key at all.
		expect(model.repos[0].disabled).toBeUndefined();
		expect(model.standup).toBeUndefined();

		const stats = model.stats;
		if (!stats) throw new Error("stats missing");
		// Everything below covers the SELECTED RANGE, default 30 days.
		expect(stats.range).toBe("month");
		// today-1 + yesterday-1 + old-1 (10 days back) all fall inside 30 days;
		// only the two Claude ones carry tokens (cursor is sessions-only).
		expect(stats.recentSessions).toHaveLength(3);
		// Tokens: today-1 + old-1 carry the default model tokens;
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
		// the current one — so it moves costTrendPct without touching the series.
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
		expect(model.stats?.series.reduce((sum, p) => sum + p.estCostUsd, 0)).toBe(3);
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
		expect(standup.windowFrom).toBe("2026-07-24");
		expect(standup.windowTo).toBe("2026-07-30");
		// abc1234 landed yesterday (Jul 29); it sits in that column, and today is empty.
		expect(commitDayKey(standup, "abc1234")).toBe("2026-07-29");
		expect(commitByHash(standup, "abc1234")).toEqual(
			expect.objectContaining({
				hash: "abc1234",
				message: "feat: yesterday's commit",
				branch: "main",
				repoName: "jolli",
			}),
		);
		expect(standup.days.find((d) => d.day === "2026-07-30")?.commits ?? []).toEqual([]);
		expect(standup.workspaces).toEqual([
			{ repoName: "jolli", branch: "main", filesChanged: 6, insertions: 184, deletions: 22 },
		]);
	});

	/** A `commit.created` event on a given ISO instant, in `repo-1`. */
	const commitAt = (iso: string, hash: string, message: string): StatsEventEnvelope => ({
		producerKind: "cli",
		event: {
			type: "commit.created",
			repoIdentity: "repo-1",
			hash,
			committedAtMs: Date.parse(iso),
			message,
			branch: "main",
			branches: ["main"],
			insertions: 1,
			deletions: 0,
		},
	});

	/** `repo.enabled` for `repo-1`, the prerequisite before any commit event. */
	const repoEnabled: StatsEventEnvelope = {
		producerKind: "cli",
		event: { type: "repo.enabled", repoIdentity: "repo-1", repoName: "jolli", worktreeRoot: "/w", enabledAt: "t" },
	};

	it("windows the standup board to seven days, newest-first, ending today at offset 0", async () => {
		await applySummaryEvents(
			[
				repoEnabled,
				commitAt("2026-07-30T09:00:00Z", "c-today", "today commit"),
				commitAt("2026-07-29T09:00:00Z", "c-yest", "yesterday commit"),
				commitAt("2026-07-26T09:00:00Z", "c-sat", "saturday commit"),
				commitAt("2026-07-24T09:00:00Z", "c-edge", "window edge commit"),
				commitAt("2026-07-23T09:00:00Z", "c-older", "just before the window"),
			],
			{ producerKind: "cli", dbPath },
		);
		const model = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "standup",
					scope: { kind: "all" },
					timeZone: "UTC",
					nowMs,
					standupOffset: 0,
				}),
			{ dbPath },
		);
		const standup = model.standup;
		if (!standup) throw new Error("standup missing");
		expect(standup.today).toBe("2026-07-30");
		expect(standup.yesterday).toBe("2026-07-29");
		expect(standup.windowFrom).toBe("2026-07-24");
		expect(standup.windowTo).toBe("2026-07-30");
		// Seven columns, newest first — the mockup's Today-on-the-left order.
		expect(standup.days.map((d) => d.day)).toEqual([
			"2026-07-30",
			"2026-07-29",
			"2026-07-28",
			"2026-07-27",
			"2026-07-26",
			"2026-07-25",
			"2026-07-24",
		]);
		const byDay = Object.fromEntries(standup.days.map((d) => [d.day, d.commits.map((c) => c.hash)]));
		expect(byDay["2026-07-30"]).toEqual(["c-today"]);
		expect(byDay["2026-07-29"]).toEqual(["c-yest"]);
		expect(byDay["2026-07-26"]).toEqual(["c-sat"]);
		expect(byDay["2026-07-24"]).toEqual(["c-edge"]);
		expect(byDay["2026-07-25"]).toEqual([]);
		// A commit the day before the window is excluded, not folded into the edge column.
		const allHashes = standup.days.flatMap((d) => d.commits.map((c) => c.hash));
		expect(allHashes).not.toContain("c-older");
	});

	it("reports no newer window and no older data when offset 0 holds the earliest commit", async () => {
		await applySummaryEvents(
			[
				repoEnabled,
				commitAt("2026-07-30T09:00:00Z", "c-today", "today commit"),
				commitAt("2026-07-24T09:00:00Z", "c-edge", "window edge commit"),
			],
			{ producerKind: "cli", dbPath },
		);
		const model = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "standup",
					scope: { kind: "all" },
					timeZone: "UTC",
					nowMs,
					standupOffset: 0,
				}),
			{ dbPath },
		);
		expect(model.standup?.hasNewer).toBe(false);
		expect(model.standup?.hasOlder).toBe(false);
	});

	it("pages back a whole week at offset 1 and reports a newer window", async () => {
		await applySummaryEvents(
			[
				repoEnabled,
				commitAt("2026-07-30T09:00:00Z", "c-today", "today commit"),
				commitAt("2026-07-20T09:00:00Z", "c-lastweek", "last week commit"),
			],
			{ producerKind: "cli", dbPath },
		);
		const model = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "standup",
					scope: { kind: "all" },
					timeZone: "UTC",
					nowMs,
					standupOffset: 1,
				}),
			{ dbPath },
		);
		const standup = model.standup;
		if (!standup) throw new Error("standup missing");
		// The seven days ending Jul 23 — the week before the one ending today.
		expect(standup.offset).toBe(1);
		expect(standup.windowFrom).toBe("2026-07-17");
		expect(standup.windowTo).toBe("2026-07-23");
		expect(standup.days.map((d) => d.day)).toEqual([
			"2026-07-23",
			"2026-07-22",
			"2026-07-21",
			"2026-07-20",
			"2026-07-19",
			"2026-07-18",
			"2026-07-17",
		]);
		const byDay = Object.fromEntries(standup.days.map((d) => [d.day, d.commits.map((c) => c.hash)]));
		expect(byDay["2026-07-20"]).toEqual(["c-lastweek"]);
		// Today's commit is newer than this window and must not leak into it.
		expect(standup.days.flatMap((d) => d.commits.map((c) => c.hash))).not.toContain("c-today");
		expect(standup.hasNewer).toBe(true);
		expect(standup.hasOlder).toBe(false);
	});

	it("clamps a non-integer or negative offset to the window ending today", async () => {
		await applySummaryEvents([repoEnabled, commitAt("2026-07-30T09:00:00Z", "c-today", "today commit")], {
			producerKind: "cli",
			dbPath,
		});
		for (const bad of [1.5, -3]) {
			const model = await withDashboardDb(
				(db) =>
					buildDashboardModel(db, {
						view: "standup",
						scope: { kind: "all" },
						timeZone: "UTC",
						nowMs,
						standupOffset: bad,
					}),
				{ dbPath },
			);
			expect(model.standup?.offset).toBe(0);
			expect(model.standup?.windowTo).toBe("2026-07-30");
			expect(model.standup?.hasNewer).toBe(false);
		}
	});

	it("clamps an out-of-range offset to STANDUP_MAX_OFFSET rather than spinning addLocalDays", async () => {
		// `offset` is deep-linkable, so a crafted magnitude must not reach addLocalDays'
		// per-day loop unbounded. The clamp lands on the furthest window, one year back.
		await applySummaryEvents([repoEnabled, commitAt("2026-07-30T09:00:00Z", "c-today", "today commit")], {
			producerKind: "cli",
			dbPath,
		});
		const model = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "standup",
					scope: { kind: "all" },
					timeZone: "UTC",
					nowMs,
					standupOffset: 99_999_999,
				}),
			{ dbPath },
		);
		expect(model.standup?.offset).toBe(STANDUP_MAX_OFFSET);
		// The window is the seven days ending 52 weeks (364 days) before today.
		expect(model.standup?.windowTo).toBe("2025-07-31");
		expect(model.standup?.windowFrom).toBe("2025-07-25");
	});

	it("drops a rewritten-away commit from its day column and from hasOlder", async () => {
		// A rebase/squash leaves the pre-rewrite commit's row in `commits` forever;
		// standup is a first-person feed, so an unreachable hash is a false claim.
		await applySummaryEvents(
			[
				repoEnabled,
				commitAt("2026-07-29T09:00:00Z", "c-live", "reachable commit"),
				commitAt("2026-07-28T09:00:00Z", "c-dead", "squashed-away commit"),
				commitAt("2026-07-10T09:00:00Z", "c-old-dead", "older squashed-away commit"),
			],
			{ producerKind: "cli", dbPath },
		);
		const model = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "standup",
					scope: { kind: "all" },
					timeZone: "UTC",
					nowMs,
					standupOffset: 0,
					// Only c-live remains reachable from a ref; the other two were rewritten away.
					reachableCommits: new Map([["repo-1", new Set(["c-live"])]]),
				}),
			{ dbPath },
		);
		const standup = model.standup;
		if (!standup) throw new Error("standup missing");
		const allHashes = standup.days.flatMap((d) => d.commits.map((c) => c.hash));
		expect(allHashes).toContain("c-live");
		expect(allHashes).not.toContain("c-dead");
		// The only older commit (c-old-dead) is unreachable, so `›` stays disabled.
		expect(standup.hasOlder).toBe(false);
	});

	it("keeps hasOlder true when a reachable commit precedes the window", async () => {
		await applySummaryEvents(
			[
				repoEnabled,
				commitAt("2026-07-30T09:00:00Z", "c-today", "today commit"),
				commitAt("2026-07-10T09:00:00Z", "c-old-live", "older reachable commit"),
			],
			{ producerKind: "cli", dbPath },
		);
		const model = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "standup",
					scope: { kind: "all" },
					timeZone: "UTC",
					nowMs,
					standupOffset: 0,
					reachableCommits: new Map([["repo-1", new Set(["c-today", "c-old-live"])]]),
				}),
			{ dbPath },
		);
		expect(model.standup?.hasOlder).toBe(true);
	});

	it("disables `›` at STANDUP_MAX_OFFSET even when reachable older commits precede that window", async () => {
		// The furthest window paging can reach ends 52 weeks back; a further click is
		// clamped straight back onto it, so `›` there is a dead button. `hasOlder` must
		// respect the ceiling even though older reachable commits DO exist before the
		// window — the containment query alone would enable the arrow onto a window the
		// clamp never lets you leave. Without the `safeOffset < STANDUP_MAX_OFFSET`
		// guard this fixture reports `hasOlder: true`.
		await applySummaryEvents(
			[
				repoEnabled,
				commitAt("2026-07-30T09:00:00Z", "c-today", "today commit"),
				commitAt("2025-07-28T09:00:00Z", "c-furthest", "inside the furthest window"),
				commitAt("2025-07-01T09:00:00Z", "c-beyond", "older than the furthest window"),
			],
			{ producerKind: "cli", dbPath },
		);
		const model = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "standup",
					scope: { kind: "all" },
					timeZone: "UTC",
					nowMs,
					standupOffset: STANDUP_MAX_OFFSET,
					// All reachable: the older commit is real, so only the ceiling can disable `›`.
					reachableCommits: new Map([["repo-1", new Set(["c-today", "c-furthest", "c-beyond"])]]),
				}),
			{ dbPath },
		);
		expect(model.standup?.offset).toBe(STANDUP_MAX_OFFSET);
		expect(model.standup?.hasOlder).toBe(false);
	});

	it("buckets a 23:30 UTC commit into the next local day column under Asia/Shanghai", async () => {
		await applySummaryEvents([repoEnabled, commitAt("2026-07-29T23:30:00Z", "boundary", "edge commit")], {
			producerKind: "cli",
			dbPath,
		});
		// In UTC that commit is on Jul 29; in Shanghai (+08:00 → 07:30) it is Jul 30.
		const utc = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "standup", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		expect(commitDayKey(utc.standup, "boundary")).toBe("2026-07-29");
		const shanghai = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "standup", scope: { kind: "all" }, timeZone: SH, nowMs }),
			{ dbPath },
		);
		expect(commitDayKey(shanghai.standup, "boundary")).toBe("2026-07-30");
	});

	/** A second and third repo, each with one session, alongside `seed()`'s. */
	async function seedMoreRepos(): Promise<void> {
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
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-3",
						repoName: "third",
						worktreeRoot: "/t",
						enabledAt: "t",
					},
				},
				session({ repoIdentity: "repo-3", sessionId: "third-1", updatedAtMs: nowMs - 30_000 }),
			],
			{ producerKind: "cli", dbPath },
		);
	}

	const sessionsFor = async (identities: string[]): Promise<string[] | undefined> => {
		const scoped = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "stats",
					scope: { kind: "repo", repoIdentities: identities },
					timeZone: "UTC",
					nowMs,
				}),
			{ dbPath },
		);
		return scoped.stats?.recentSessions.map((s) => s.sessionId);
	};

	it("filters by repo scope", async () => {
		await seedMoreRepos();
		expect(await sessionsFor(["repo-2"])).toEqual(["other-1"]);
		const scoped = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "stats",
					scope: { kind: "repo", repoIdentities: ["repo-2"] },
					timeZone: "UTC",
					nowMs,
				}),
			{ dbPath },
		);
		expect(scoped.repos).toHaveLength(3); // the picker still lists every repo
		expect(scoped.scope).toEqual({ kind: "repo", repoIdentities: ["repo-2"] });
	});

	it("lists a PAUSED repo too, flagged and sorted after the active ones", async () => {
		// A paused repo's rows are never deleted and it keeps counting in the
		// aggregate KPIs, so dropping it from the list made an all-paused dashboard
		// read as "No repositories yet". It stays in the list, marked `disabled`,
		// sorted to the bottom — and still scopable, since its rows exist.
		await seedMoreRepos();
		await applySummaryEvents(
			[{ producerKind: "cli", event: { type: "repo.disabled", repoIdentity: "repo-2", disabledAt: "t2" } }],
			{ producerKind: "cli", dbPath },
		);
		const model = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		// Not dropped — every repo is present.
		expect(model.repos.map((r) => r.repoIdentity).sort()).toEqual(["repo-1", "repo-2", "repo-3"]);
		// Active first (by name), the paused one last; only it carries the flag, and
		// an active row's shape is unchanged (`disabled` absent, not `false`).
		expect(model.repos.map((r) => [r.repoName, r.disabled ?? "unset"])).toEqual([
			["jolli", "unset"],
			["third", "unset"],
			["other", true],
		]);
		// Still scopable — the paused repo's own data answers.
		expect(await sessionsFor(["repo-2"])).toEqual(["other-1"]);
	});

	it("filters to SEVERAL repos, and to neither of the others", async () => {
		await seedMoreRepos();
		expect((await sessionsFor(["repo-2", "repo-3"]))?.sort()).toEqual(["other-1", "third-1"]);
	});

	it("answers for the repos it recognizes when one token is stale", async () => {
		// A bookmark naming a repo that has since been removed, alongside a live
		// one. Dropping the whole scope would widen it silently; dropping every
		// row would blank a page the reader has real data for.
		await seedMoreRepos();
		expect(await sessionsFor(["repo-2", "repo-gone"])).toEqual(["other-1"]);
	});

	it("answers nothing — never everything — when no token resolves", async () => {
		await seedMoreRepos();
		expect(await sessionsFor(["repo-gone", "also-gone"])).toEqual([]);
	});

	it("dedupes a name and its own identity into one repo", async () => {
		// `?repo=other&repo=repo-2` is one repository asked for twice, which must
		// not become a two-element `IN (…)` naming the same row.
		await seedMoreRepos();
		const scoped = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "stats",
					scope: { kind: "repo", repoIdentities: ["other", "repo-2"] },
					timeZone: "UTC",
					nowMs,
				}),
			{ dbPath },
		);
		expect(scoped.scope).toEqual({ kind: "repo", repoIdentities: ["repo-2"] });
		expect(scoped.stats?.recentSessions.map((s) => s.sessionId)).toEqual(["other-1"]);
	});

	it("renders sensibly from an empty database — empty fun stats, no series keys", async () => {
		await applySummaryEvents([], { producerKind: "cli", dbPath }); // create schema only
		const model = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		const stats = model.stats;
		if (!stats) throw new Error("stats missing");
		expect(stats.recentSessions).toEqual([]);
		expect(stats.tokenBreakdown).toMatchObject({ input: 0, output: 0, cached: 0 });
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
		const commit = commitByHash(standup, "bare1");
		if (!commit) throw new Error("bare1 commit missing");
		expect(commit.message).toBe("");
		expect(commit).not.toHaveProperty("branch");
		expect(commit).not.toHaveProperty("insertions");
		expect(standup.workspaces[0]).not.toHaveProperty("branch");
	});

	it("treats a repo scope with no identities as all repos", async () => {
		// What a `?repo=` the browser emitted with nothing behind it parses to. It
		// is not a way to select nothing — that is what an unresolvable token does.
		await seed();
		const model = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "stats",
					scope: { kind: "repo", repoIdentities: [] },
					timeZone: "UTC",
					nowMs,
				}),
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
		// One session is enough to retire the note for good: it is a first-run hint,
		// not a running caveat. The "older activity is reconstructed" line that used
		// to take its place here was removed as permanent page furniture.
		const seeded = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		expect(seeded.coverage).toEqual([]);
	});

	it("carries no footer note on any view once there is data", async () => {
		await seed();
		const notesFor = async (view: "stats" | "standup" | "memories" | "settings") =>
			(
				await withDashboardDb(
					(db) => buildDashboardModel(db, { view, scope: { kind: "all" }, timeZone: "UTC", nowMs }),
					{ dbPath },
				)
			).coverage.map((c) => c.kind);

		// `seed()` writes sessions, so the one surviving note (the empty-database
		// first-run hint) does not apply, and nothing replaces it. Stats and standup
		// both used to print "older activity is reconstructed from commits and stored
		// summaries" here — removed from both as permanent page furniture, which is
		// what this case now pins: the footer is empty unless the DB is.
		expect(await notesFor("stats")).toEqual([]);
		expect(await notesFor("standup")).toEqual([]);
		expect(await notesFor("memories")).toEqual([]);
		expect(await notesFor("settings")).toEqual([]);
	});

	it("keeps the empty-database hint on stats alone", async () => {
		// Nothing seeded: the one state the footer still speaks in. It is scoped to
		// stats because that view's cards are all session-derived — the standup
		// board is commits-only and says "Nothing recorded." inside each column.
		const notesFor = async (view: "stats" | "standup") =>
			(
				await withDashboardDb(
					(db) => buildDashboardModel(db, { view, scope: { kind: "all" }, timeZone: "UTC", nowMs }),
					{ dbPath },
				)
			).coverage.map((c) => c.kind);

		expect(await notesFor("stats")).toEqual(["no-data"]);
		expect(await notesFor("standup")).toEqual([]);
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

		it("scopes the window to an explicit range, inclusive at both ends", async () => {
			await seed();
			// Seeded sessions land on Jul 30 (×1), Jul 29 (×1) and Jul 20 (×1).
			const july29 = await stats({ range: "custom", customFrom: "2026-07-29", customTo: "2026-07-29" });
			expect(july29.range).toBe("custom");
			expect(july29.recentSessions).toHaveLength(1);
			// The resolved bounds are echoed back, so a clamped request reads as
			// the window it actually got.
			expect(july29).toMatchObject({ rangeFrom: "2026-07-29", rangeTo: "2026-07-29" });

			const spanning = await stats({ range: "custom", customFrom: "2026-07-29", customTo: "2026-07-30" });
			expect(spanning.recentSessions).toHaveLength(2);
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
			// The feed follows the range, so it shows the window's session — not
			// whatever happens to be most recent overall.
			expect(old.recentSessions.map((s) => s.title)).toEqual(["Old work"]);
			// The heatmap keeps its own span regardless, and stays empty here.
			expect(old.heatmap).toHaveLength(84);
			expect(old.heatmap.every((cell) => cell.sessions === 0)).toBe(true);
		});
	});

	describe("concurrency", () => {
		// Two adjacent quarter-hours inside the default window.
		const B0 = Math.floor((nowMs - 3_600_000) / 900_000) * 900_000;
		const B1 = B0 + 900_000;

		const model = async () =>
			withDashboardDb(
				(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
				{ dbPath },
			);

		it("counts one agent session once even when it touched two repos", async () => {
			// `sessions` is unique on (repo_id, source, session_id), so the SAME
			// agent session in two repos is two rows with two event ids. Counting
			// event ids would report one agent as two — and this figure is
			// machine-global, which makes that certain rather than latent.
			await applyStatsEvents(
				[
					session({ repoIdentity: "repo-1", source: "cursor", sessionId: "s1", activityBuckets: [B0] }),
					session({ repoIdentity: "repo-2", source: "cursor", sessionId: "s1", activityBuckets: [B0] }),
				],
				{ producerKind: "cli", dbPath },
			);
			expect((await model()).stats?.concurrency?.peak).toBe(1);
		});

		it("reports the peak and the mean over ACTIVE buckets only", async () => {
			await applyStatsEvents(
				[
					session({ source: "claude", sessionId: "s1", activityBuckets: [B0, B1] }),
					session({ source: "codex", sessionId: "s2", activityBuckets: [B0] }),
				],
				{ producerKind: "cli", dbPath },
			);
			const stats = (await model()).stats;
			// B0 holds 2 sessions, B1 holds 1. The mean over the two ACTIVE buckets
			// is 1.5 — not 3/672, which is what dividing by the window would give.
			expect(stats?.concurrency?.peak).toBe(2);
			expect(stats?.concurrency?.meanActive).toBeCloseTo(1.5);
			expect(stats?.concurrency?.buckets).toHaveLength(2);
			expect(stats?.concurrency?.bucketMinutes).toBe(15);
		});

		it("names sources that contributed sessions but no buckets as uncovered", async () => {
			await applyStatsEvents(
				[
					session({ source: "claude", sessionId: "s1", activityBuckets: [B0] }),
					session({ source: "opencode", sessionId: "s2" }),
				],
				{ producerKind: "cli", dbPath },
			);
			const stats = (await model()).stats;
			expect(stats?.concurrency?.measuredSources).toEqual(["claude"]);
			// Uncovered, NOT "ran zero agents".
			expect(stats?.concurrency?.uncoveredSources).toEqual(["opencode"]);
		});

		it("does not call a source uncovered when its buckets merely predate the window", async () => {
			// A session enters the window by `updated_at_ms`, but its buckets are keyed
			// by its TURNS — and the two come apart in practice. A conversation resumed
			// just after midnight, or one from a source whose `updatedAt` is its store
			// row's timestamp rather than its last turn, is in-window with every bucket
			// older than the window.
			//
			// `measuredSources` correctly says it drew no bar. Deriving "uncovered" by
			// subtracting that set turned the same fact into a claim about the AGENT —
			// "this one carries no per-turn timestamps" — which is exactly what the
			// label is read as, and which is false here.
			const oldTurnMs = nowMs - 45 * 86_400_000;
			await applyStatsEvents(
				[
					session({ source: "claude", sessionId: "s1", activityBuckets: [B0] }),
					session({
						source: "opencode",
						sessionId: "resumed",
						// In-window by its update instant …
						updatedAtMs: nowMs,
						// … while its only turn is well before the 30-day window starts.
						activityBuckets: [Math.floor(oldTurnMs / 900_000) * 900_000],
					}),
				],
				{ producerKind: "cli", dbPath },
			);
			const stats = (await model()).stats;
			// It drew no bar in the window — that half is honest and unchanged.
			expect(stats?.concurrency?.measuredSources).not.toContain("opencode");
			// But it is measurable, so it must not be named as uncovered.
			expect(stats?.concurrency?.uncoveredSources).toEqual([]);
		});

		it("ignores the repo scope — concurrency is a property of the person", async () => {
			await applyStatsEvents(
				[
					session({ repoIdentity: "repo-1", source: "claude", sessionId: "s1", activityBuckets: [B0] }),
					session({ repoIdentity: "repo-2", source: "codex", sessionId: "s2", activityBuckets: [B0] }),
				],
				{ producerKind: "cli", dbPath },
			);
			const scoped = await withDashboardDb(
				(db) =>
					buildDashboardModel(db, {
						view: "stats",
						scope: { kind: "repo", repoIdentities: ["repo-1"] },
						timeZone: "UTC",
						nowMs,
					}),
				{ dbPath },
			);
			// Both agents still count: filtering here would truncate the number
			// into something with no actionable meaning.
			expect(scoped.stats?.concurrency?.peak).toBe(2);
		});

		it("omits the field entirely when no bucket falls in the window", async () => {
			await applyStatsEvents([session({ source: "claude", sessionId: "s1" })], {
				producerKind: "cli",
				dbPath,
			});
			// Absent, not a zero: under forward-only collection this is the normal
			// state for the first days after deployment.
			expect((await model()).stats?.concurrency).toBeUndefined();
		});
	});

	it("builds only the coaching payload for the journeys view", async () => {
		await withDashboardDb(() => {}, { dbPath });
		const journeysModel = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "journeys", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		expect(journeysModel.coaching).toBeDefined();
		// The feed is behind a modal served by /api/journeys; the page model no
		// longer carries the whole `JourneysModel` inline — the field is gone
		// from the type entirely, not merely left unset.
		expect("journeys" in journeysModel).toBe(false);
		expect(journeysModel.stats).toBeUndefined();
		expect(journeysModel.memories).toBeUndefined();
	});

	it("defaults the coaching window to the last 7 days, not the global month default", async () => {
		await withDashboardDb(() => {}, { dbPath });
		// No `range` supplied: Coaching diverges from the shared `DEFAULT_RANGE`
		// ("month") and opens on a 7-day window. `nowMs` is 2026-07-30, so a
		// week counting today spans 07-24 → 07-30.
		const journeysModel = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "journeys", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		expect(journeysModel.coaching?.range).toBe("week");
		expect(journeysModel.coaching?.rangeFrom).toBe("2026-07-24");
		expect(journeysModel.coaching?.rangeTo).toBe("2026-07-30");
	});

	it("lets an explicit range override the coaching 7-day default", async () => {
		await withDashboardDb(() => {}, { dbPath });
		// The divergence is a DEFAULT, not a lock: picking another preset in the
		// topbar still resolves to that preset's window.
		const journeysModel = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "journeys",
					scope: { kind: "all" },
					timeZone: "UTC",
					nowMs,
					range: "month",
				}),
			{ dbPath },
		);
		expect(journeysModel.coaching?.range).toBe("month");
		expect(journeysModel.coaching?.rangeFrom).toBe("2026-07-01");
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
		tools?: ReadonlyArray<{
			name: string;
			kind: "builtin" | "mcp" | "skill";
			server?: string;
			calls: number;
			/** Marks the bucket inferred; the writer copies it onto each of its entries. */
			detection?: "heuristic";
			plugin?: string;
			lastCallAtMs?: number;
			usage?: { input: number; output: number; cached: number; confidence: "attributed" | "estimated" };
			/** Per-entry rows. Required to reach `skill_invocations` at all — see the detection tests. */
			invocations?: ReadonlyArray<{
				at: string;
				ok: boolean;
				entryPath?: "tool" | "command";
				outcomeObserved?: boolean;
				args?: string;
				bodyChars?: number;
			}>;
		}>,
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
		expect(result?.skills[0]).toEqual({
			name: "code-review",
			kind: "skill",
			sessions: 3,
			calls: 4,
			agents: [{ source: "claude", calls: 4 }],
		});
		expect(result?.skills[1]).toEqual({
			name: "simplify",
			kind: "skill",
			sessions: 1,
			calls: 200,
			agents: [{ source: "claude", calls: 200 }],
		});
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
			{ server: "linear", sessions: 1, calls: 5, tools: 2, agents: [{ source: "claude", calls: 5 }] },
			{ server: "github", sessions: 1, calls: 1, tools: 1, agents: [{ source: "claude", calls: 1 }] },
		]);
	});

	/**
	 * One server reached through two registrations is one server.
	 *
	 * A Claude plugin's MCP entry is namespaced `plugin_<plugin>_<server>` by the
	 * host, while the repo's own `.mcp.json` registers it bare — and Jolli ships
	 * both, so a normal install produced two rows for one server: split call
	 * volume, and an inflated "N servers" total.
	 */
	it("folds a plugin-namespaced MCP server onto its bare registration", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				sessionWith("s1", [
					{ name: "jollimemory.recall", kind: "mcp", server: "jollimemory", calls: 17 },
					{
						name: "plugin_jolli_jollimemory.recall",
						kind: "mcp",
						server: "plugin_jolli_jollimemory",
						calls: 7,
					},
				]),
			],
			{ producerKind: "cli", dbPath },
		);
		const result = await usage();
		expect(result?.servers).toEqual([
			// `tools: 1`, not 2 — the tool name embeds the server, so both spellings
			// of `recall` fold too. Counting the raw column here reported a merged
			// 5-tool server as having 10.
			{ server: "jollimemory", sessions: 1, calls: 24, tools: 1, agents: [{ source: "claude", calls: 24 }] },
		]);
		// The header line's totals come from their own query and must agree.
		expect(result?.serversTotal).toBe(1);
		expect(result?.serverCallsTotal).toBe(24);
		// The by-tool split folds on the same rule.
		expect(result?.mcpTools).toEqual([
			{
				name: "jollimemory.recall",
				kind: "mcp",
				sessions: 1,
				calls: 24,
				agents: [{ source: "claude", calls: 24 }],
			},
		]);
	});

	/**
	 * The exact boundary of the fold, driven through the real query.
	 *
	 * `plugin_<plugin>_<server>` is ambiguous by construction — underscores are
	 * legal in both halves — so the rule takes the FIRST segment as the plugin
	 * name. Everything below is what that costs and what it protects: a name it
	 * cannot split confidently is left un-merged (visible, harmless) rather than
	 * merged into the wrong server (silent, wrong).
	 */
	it("folds only what it can split with certainty", async () => {
		const cases: ReadonlyArray<{ server: string; expect: string; why: string }> = [
			{ server: "plugin_jolli_jollimemory", expect: "jollimemory", why: "the real duplicate" },
			{ server: "plugin_a_b", expect: "b", why: "plugin a, server b" },
			// The cost: an underscore in the PLUGIN name makes the split wrong, so it
			// under-strips and this server simply stays separate.
			{ server: "plugin_my_plugin_linear", expect: "plugin_linear", why: "underscore in the plugin name" },
			// Guards on the prefix itself. `_` is literal in a GLOB pattern (only
			// `*`, `?` and `[` are wildcards), which is what keeps `pluginX_a_b` out
			// — the job the LIKE form needed an ESCAPE clause for.
			{ server: "plugin", expect: "plugin", why: "no segment after the prefix" },
			{ server: "pluginX_a_b", expect: "pluginX_a_b", why: "the prefix requires its underscore" },
			{ server: "notaplugin_x", expect: "notaplugin_x", why: "prefix must be at the start" },
			{ server: "jollimemory", expect: "jollimemory", why: "a bare server is untouched" },
			// The other half of that operator choice, and the sharper one: SQLite's
			// LIKE is case-INSENSITIVE for ASCII, so the LIKE form claimed this real
			// name and folded it to `Api` — silently merging a server with any
			// unrelated `Api`, which is the mis-attribution the conservative split
			// above exists to avoid. GLOB takes no collating sequence.
			{ server: "Plugin_Manager_Api", expect: "Plugin_Manager_Api", why: "the prefix is case-sensitive" },
		];
		await applySummaryEvents(
			[
				repoEvent,
				sessionWith(
					"s1",
					cases.map((c) => ({ name: `${c.server}.thing`, kind: "mcp" as const, server: c.server, calls: 1 })),
				),
			],
			{ producerKind: "cli", dbPath },
		);
		const result = await usage();
		const got = (result?.servers ?? []).map((s) => s.server).sort();
		// `plugin_jolli_jollimemory` and `jollimemory` collapse into one row, so the
		// eight inputs yield seven servers. Code-unit order, so `P` (0x50) leads and
		// `X` (0x58) precedes `_` (0x5F) — this is JS `.sort()`, not the query's own
		// ranking.
		expect(got).toEqual([
			"Plugin_Manager_Api",
			"b",
			"jollimemory",
			"notaplugin_x",
			"plugin",
			"pluginX_a_b",
			"plugin_linear",
		]);
		// No call is invented or lost by the regrouping.
		expect(result?.serverCallsTotal).toBe(cases.length);
	});

	it("splits the same MCP rows by individual tool, ranked by call volume", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				sessionWith("s1", [
					{ name: "linear.list_issues", kind: "mcp", server: "linear", calls: 9 },
					{ name: "linear.get_issue", kind: "mcp", server: "linear", calls: 2 },
				]),
				sessionWith("s2", [{ name: "linear.get_issue", kind: "mcp", server: "linear", calls: 1 }]),
			],
			{ producerKind: "cli", dbPath },
		);
		const result = await usage();
		// The two rules disagree here on purpose — list_issues has the volume (9 vs
		// 3) and get_issue has the adoption (2 sessions vs 1) — because the fixture
		// this replaced tied at 3 calls each and so passed under either one, leaving
		// the rule it named untested. Volume wins: unlike skills, both MCP lists
		// print calls and size their bars by calls.
		expect(result?.mcpTools).toEqual([
			{
				name: "linear.list_issues",
				kind: "mcp",
				sessions: 1,
				calls: 9,
				agents: [{ source: "claude", calls: 9 }],
			},
			{ name: "linear.get_issue", kind: "mcp", sessions: 2, calls: 3, agents: [{ source: "claude", calls: 3 }] },
		]);
	});

	it("ranks servers by call volume, not by the sessions that reached for them", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				// The shape of the real bug: a widely-adopted server with modest volume
				// above a narrowly-used one that dominates the calls. Ranking by
				// sessions printed 149 below 68 on a live database, and `rankedList`
				// sizes its bars against the top row, so the busier server's bar
				// overflowed to 100% and read as equal rather than as bigger.
				sessionWith("s1", [{ name: "jollimemory.recall", kind: "mcp", server: "jollimemory", calls: 1 }]),
				sessionWith("s2", [{ name: "jollimemory.recall", kind: "mcp", server: "jollimemory", calls: 1 }]),
				sessionWith("s3", [{ name: "jollimemory.recall", kind: "mcp", server: "jollimemory", calls: 1 }]),
				sessionWith("s4", [{ name: "codegraph.explore", kind: "mcp", server: "codegraph", calls: 30 }]),
			],
			{ producerKind: "cli", dbPath },
		);
		expect((await usage())?.servers.map((row) => [row.server, row.sessions, row.calls])).toEqual([
			["codegraph", 1, 30],
			["jollimemory", 3, 3],
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
		expect(result?.recallCalls).toEqual({
			name: "jollimemory.recall",
			kind: "mcp",
			sessions: 2,
			calls: 4,
			agents: [{ source: "claude", calls: 4 }],
		});
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
			// Each busier tool is reached from two separate sessions with one call
			// each, so it outranks recall's single call on volume as well as on
			// adoption — the cut is TOOL_ROWS_LIMIT rows whichever figure orders
			// them, which is the property `recallCalls` has to survive.
			...busierTools.flatMap((tool, i) => [sessionWith(`busyA${i}`, [tool]), sessionWith(`busyB${i}`, [tool])]),
			sessionWith("recall-session", [
				{ name: "jollimemory.recall", kind: "mcp", server: "jollimemory", calls: 1 },
			]),
		];
		await applySummaryEvents(events, { producerKind: "cli", dbPath });
		const result = await usage();
		expect(result?.mcpTools).toHaveLength(TOOL_ROWS_LIMIT);
		expect(result?.mcpTools.some((row) => row.name === "jollimemory.recall")).toBe(false);
		expect(result?.recallCalls).toEqual({
			name: "jollimemory.recall",
			kind: "mcp",
			sessions: 1,
			calls: 1,
			agents: [{ source: "claude", calls: 1 }],
		});
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
		expect((await usage())?.servers).toEqual([
			{ server: "linear", sessions: 2, calls: 2, tools: 2, agents: [{ source: "claude", calls: 2 }] },
		]);
	});

	it("names the agents behind one skill, most calls first, without losing the row's own totals", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				sessionWith("s1", [{ name: "code-review", kind: "skill", calls: 2 }], "claude"),
				sessionWith("s2", [{ name: "code-review", kind: "skill", calls: 5 }], "codex"),
			],
			{ producerKind: "cli", dbPath },
		);
		// The SQL groups by source as well now, so the row itself is a fold of two
		// buckets. A session has exactly one source, so both totals survive it
		// exactly — that is the property the split relies on.
		expect((await usage())?.skills).toEqual([
			{
				name: "code-review",
				kind: "skill",
				sessions: 2,
				calls: 7,
				agents: [
					{ source: "codex", calls: 5 },
					{ source: "claude", calls: 2 },
				],
			},
		]);
	});

	it("splits a server by agent from the per-tool rows, leaving its tool count undoubled", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				sessionWith("s1", [{ name: "linear.get_issue", kind: "mcp", server: "linear", calls: 3 }], "claude"),
				// The SAME tool from a second agent: `tools` must stay 1, which is why
				// the split rides on the per-tool rows instead of a `source` column
				// added to the server query's own GROUP BY.
				sessionWith("s2", [{ name: "linear.get_issue", kind: "mcp", server: "linear", calls: 1 }], "codex"),
			],
			{ producerKind: "cli", dbPath },
		);
		expect((await usage())?.servers).toEqual([
			{
				server: "linear",
				sessions: 2,
				calls: 4,
				tools: 1,
				agents: [
					{ source: "claude", calls: 3 },
					{ source: "codex", calls: 1 },
				],
			},
		]);
	});

	it("counts each agent's sessions distinctly in the per-kind totals", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				// One session, two of the server's tools. Re-summing the per-tool rows
				// would report claude with 2 sessions; its own grouping reports 1.
				sessionWith(
					"s1",
					[
						{ name: "linear.get_issue", kind: "mcp", server: "linear", calls: 1 },
						{ name: "linear.list_issues", kind: "mcp", server: "linear", calls: 1 },
					],
					"claude",
				),
				sessionWith("s2", [{ name: "github.list_prs", kind: "mcp", server: "github", calls: 5 }], "codex"),
				sessionWith("s3", [{ name: "code-review", kind: "skill", calls: 1 }], "codex"),
			],
			{ producerKind: "cli", dbPath },
		);
		const result = await usage();
		expect(result?.mcpAgents).toEqual([
			{ source: "codex", sessions: 1, calls: 5 },
			{ source: "claude", sessions: 1, calls: 2 },
		]);
		// Kinds are separate groupings: the codex session that ran a skill is not
		// in `mcpAgents`, and its MCP session is not in `skillAgents`.
		expect(result?.skillAgents).toEqual([{ source: "codex", sessions: 1, calls: 1 }]);
	});

	it("keeps the agent split on rows that rank outside the visible list", async () => {
		const many = Array.from({ length: TOOL_ROWS_LIMIT + 2 }, (_, i) =>
			sessionWith(`s${i}`, [{ name: `srv${i}.t`, kind: "mcp", server: `srv${i}`, calls: 1 }], "claude"),
		);
		await applySummaryEvents(
			[
				repoEvent,
				...many,
				// One codex call, on a server that cannot make the top TOOL_ROWS_LIMIT.
				sessionWith("sx", [{ name: "tail.t", kind: "mcp", server: "tail", calls: 1 }], "codex"),
			],
			{ producerKind: "cli", dbPath },
		);
		const result = await usage();
		expect(result?.servers).toHaveLength(TOOL_ROWS_LIMIT);
		// `mcpAgents` comes from its own untruncated grouping, so codex is still
		// named even though no visible row carries it.
		expect(result?.servers.some((row) => row.agents.some((a) => a.source === "codex"))).toBe(false);
		expect(result?.mcpAgents).toContainEqual({ source: "codex", sessions: 1, calls: 1 });
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
		expect(result?.skills).toEqual([
			{ name: "code-review", kind: "skill", sessions: 1, calls: 4, agents: [{ source: "claude", calls: 4 }] },
		]);
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
			skillsTotal: 0,
			serversTotal: 0,
			mcpToolsTotal: 0,
			skillCallsTotal: 0,
			serverCallsTotal: 0,
			sessionsWithTools: 0,
			sessionsInWindow: 1,
		});
	});

	/**
	 * A page row's identity, whichever list it came from.
	 *
	 * `ToolUsagePage` is a union discriminated on `list`, and a caller that knows
	 * which list it asked for still has to say so — the discriminant is on the
	 * page, not inferred from the argument. Spelled once here rather than narrowed
	 * at each assertion.
	 */
	const rowKey = (row: ToolUsageRow | McpServerRow): string => ("name" in row ? row.name : row.server);

	/** `TOOL_ROWS_LIMIT + 4` skills, each reached from a distinct number of sessions. */
	const manySkillEvents = (): ReadonlyArray<StatsEventEnvelope> => {
		const events: StatsEventEnvelope[] = [repoEvent];
		// Skills rank by ADOPTION, so the session count is what decides the order:
		// skill00 is reached from the most sessions, skill11 from one.
		for (let i = 0; i !== TOOL_ROWS_LIMIT + 4; i += 1) {
			const name = `skill${String(i).padStart(2, "0")}`;
			for (let s = 0; s !== TOOL_ROWS_LIMIT + 4 - i; s += 1) {
				events.push(sessionWith(`${name}-s${s}`, [{ name, kind: "skill", calls: 1 }]));
			}
		}
		return events;
	};

	it("carries the whole window's totals beside the first page, not the page's own sums", async () => {
		await applySummaryEvents(manySkillEvents(), { producerKind: "cli", dbPath });
		const result = await usage();
		// The page is 8 rows; the card's header line states 12 skills and every run
		// they made. Summing the rows on screen — what it used to do — would print
		// "8 skills" and a run count that grew with every Show more click.
		expect(result?.skills).toHaveLength(TOOL_ROWS_LIMIT);
		expect(result?.skillsTotal).toBe(TOOL_ROWS_LIMIT + 4);
		// Runs are 12 + 11 + … + 1 across every skill, of which the first page holds
		// only 12 + 11 + … + 5.
		expect(result?.skillCallsTotal).toBe(78);
		expect(result?.skills.reduce((n, row) => n + row.calls, 0)).toBe(68);
	});

	it("pages a skills list in SQL, partitioning it exactly across offsets", async () => {
		await applySummaryEvents(manySkillEvents(), { producerKind: "cli", dbPath });
		const page = async (offset: number) =>
			await withDashboardDb(
				(db) =>
					buildToolUsagePage(db, { scope: { kind: "all" }, list: "skill", offset, timeZone: "UTC", nowMs }),
				{ dbPath },
			);
		const first = await page(0);
		const second = await page(TOOL_ROWS_LIMIT);
		expect(first.rows).toHaveLength(TOOL_ROWS_LIMIT);
		expect(second.rows).toHaveLength(4);
		expect(second.offset).toBe(TOOL_ROWS_LIMIT);
		// `totalCount` travels with every page — it is the client's "there is more"
		// test, and the window keeps gaining rows while the dashboard is open.
		expect(second.totalCount).toBe(TOOL_ROWS_LIMIT + 4);
		// The two pages together are the list, with nothing repeated and nothing
		// dropped: the property OFFSET paging only has while the ORDER BY is total.
		const names = [...first.rows, ...second.rows].map(rowKey);
		expect(new Set(names).size).toBe(TOOL_ROWS_LIMIT + 4);
		expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
	});

	it("partitions rows tied on both counts, rather than repeating one and dropping another", async () => {
		// Every row here has the same sessions and the same calls, so the ranking
		// keys cannot separate them and only the name tiebreak can. Without it two
		// pages could each hand back the same row and neither the one it displaced.
		const tied = Array.from({ length: TOOL_ROWS_LIMIT + 2 }, (_, i) => `tied${String(i).padStart(2, "0")}`);
		await applySummaryEvents(
			[repoEvent, ...tied.map((name) => sessionWith(`${name}-s`, [{ name, kind: "skill", calls: 1 }]))],
			{ producerKind: "cli", dbPath },
		);
		const rows = async (offset: number) =>
			(
				await withDashboardDb(
					(db) =>
						buildToolUsagePage(db, {
							scope: { kind: "all" },
							list: "skill",
							offset,
							timeZone: "UTC",
							nowMs,
						}),
					{ dbPath },
				)
			).rows.map(rowKey);
		expect([...(await rows(0)), ...(await rows(TOOL_ROWS_LIMIT))]).toEqual(tied);
	});

	it("pages the server roll-up too, keeping each row's tool count and agent split", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				sessionWith("s1", [
					{ name: "linear.list_issues", kind: "mcp", server: "linear", calls: 9 },
					{ name: "linear.get_issue", kind: "mcp", server: "linear", calls: 2 },
				]),
				sessionWith("s2", [{ name: "github.list_prs", kind: "mcp", server: "github", calls: 4 }], "codex"),
			],
			{ producerKind: "cli", dbPath },
		);
		const page = await withDashboardDb(
			(db) =>
				buildToolUsagePage(db, {
					scope: { kind: "all" },
					list: "server",
					offset: 1,
					limit: 1,
					timeZone: "UTC",
					nowMs,
				}),
			{ dbPath },
		);
		// The agent split is its own query over the page's keys, so it has to survive
		// arriving at a nonzero offset — a fold over "every row in the window" would
		// have attributed the row that was skipped.
		expect(page).toEqual({
			list: "server",
			offset: 1,
			totalCount: 2,
			rows: [{ server: "github", sessions: 1, calls: 4, tools: 1, agents: [{ source: "codex", calls: 4 }] }],
		});
	});

	it("answers an offset past the end with an empty page rather than an error", async () => {
		await applySummaryEvents([repoEvent, sessionWith("s1", [{ name: "code-review", kind: "skill", calls: 1 }])], {
			producerKind: "cli",
			dbPath,
		});
		const page = await withDashboardDb(
			(db) =>
				buildToolUsagePage(db, { scope: { kind: "all" }, list: "skill", offset: 99, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		expect(page).toEqual({ list: "skill", offset: 99, rows: [], totalCount: 1 });
	});

	it("floors a negative or fractional offset onto the first page", async () => {
		await applySummaryEvents([repoEvent, sessionWith("s1", [{ name: "code-review", kind: "skill", calls: 1 }])], {
			producerKind: "cli",
			dbPath,
		});
		// A position has a nearest sane answer, unlike a list name — so this is
		// clamped where an unknown `list` is a 400 (see DashboardServer).
		const page = await withDashboardDb(
			(db) =>
				buildToolUsagePage(db, { scope: { kind: "all" }, list: "skill", offset: -5.7, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		expect(page.offset).toBe(0);
		expect(page.rows).toHaveLength(1);
	});

	it("floors a fractional or negative limit onto a whole page of at least one row", async () => {
		await applySummaryEvents(manySkillEvents(), { producerKind: "cli", dbPath });
		const width = async (limit: number) =>
			(
				await withDashboardDb(
					(db) =>
						buildToolUsagePage(db, {
							scope: { kind: "all" },
							list: "skill",
							offset: 0,
							limit,
							timeZone: "UTC",
							nowMs,
						}),
					{ dbPath },
				)
			).rows.length;
		// Same rule as `offset` one test up, and for the same reason: a width is a row
		// count, so a bad one has a nearest sane answer. The route already truncates
		// and clamps every HTTP-borne limit, so this is about the OTHER caller of an
		// exported function — nothing today, which is exactly when the guard is free.
		expect(await width(2.7)).toBe(2);
		expect(await width(-5)).toBe(1);
		// The two values a falsy `|| TOOL_ROWS_LIMIT` cannot tell from NaN, and so the
		// two this test has to name: both floor below one row, and one row is the answer
		// the route already gives them. Getting the default 8 here instead is the shape
		// of the bug, because 8 is a plausible page rather than a visible mistake.
		expect(await width(0)).toBe(1);
		expect(await width(0.5)).toBe(1);
		// Absent — and only absent — means one page, the size a Show more click asks for.
		expect(await width(Number.NaN)).toBe(TOOL_ROWS_LIMIT);
	});

	it("honours the page's repo scope and window, so an appended page matches the card", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				sessionWith("in-window", [{ name: "code-review", kind: "skill", calls: 1 }]),
				{
					producerKind: "cli",
					event: {
						type: "session.upserted",
						repoIdentity: "repo-1",
						source: "claude",
						sessionId: "months-ago",
						updatedAtMs: nowMs - 3_600_000,
						tools: [{ name: "ancient", kind: "skill", calls: 1, lastCallAtMs: nowMs - 120 * 86_400_000 }],
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		const page = await withDashboardDb(
			(db) =>
				buildToolUsagePage(db, {
					scope: { kind: "all" },
					list: "skill",
					offset: 0,
					range: "week",
					timeZone: "UTC",
					nowMs,
				}),
			{ dbPath },
		);
		// Windowed by the CALL's own time, exactly as the inlined first page is: a
		// page counted over a different window would append rows the card's totals
		// know nothing about.
		expect(page.rows.map(rowKey)).toEqual(["code-review"]);
		expect(page.totalCount).toBe(1);
	});

	it("surfaces a skill namespace and degrades partial legacy usage to zero", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				sessionWith("legacy-usage", [
					{
						name: "code-review",
						kind: "skill",
						calls: 1,
						plugin: "superpowers",
						usage: { input: 9, output: 4, cached: 2, confidence: "estimated" },
					},
				]),
			],
			{ producerKind: "cli", dbPath },
		);
		// These columns normally move together. A partially populated pre-migration
		// row must still render instead of crashing or losing the attributed input.
		await withDashboardDb(
			(db) => db.exec("UPDATE session_tool_use SET output_tokens = NULL, cached_tokens = NULL"),
			{ dbPath },
		);

		expect((await usage())?.skills[0]).toMatchObject({
			name: "code-review",
			plugin: "superpowers",
			usage: { input: 9, output: 0, cached: 0, confidence: "estimated", sessions: 1 },
		});
	});

	it("omits a plugin label when different plugins used the same bare skill name", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				sessionWith("team-a", [{ name: "review", kind: "skill", calls: 1, plugin: "team-a" }]),
				sessionWith("team-b", [{ name: "review", kind: "skill", calls: 1, plugin: "team-b" }]),
			],
			{ producerKind: "cli", dbPath },
		);

		const row = (await usage())?.skills.find((skill) => skill.name === "review");
		expect(row).toMatchObject({ name: "review", sessions: 2, calls: 2 });
		expect(row).not.toHaveProperty("plugin");
		const detailRow = await withDashboardDb(
			(db) => buildSkillDetail(db, { scope: { kind: "all" }, name: "review", timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		expect(detailRow).not.toHaveProperty("plugin");
	});

	/**
	 * `ToolUsageRow.detection` — the list row's inferred mark.
	 *
	 * The mark is read from `skill_invocations`, which is a DIFFERENT GRAIN from the
	 * aggregate the rest of the row comes from (one row per entry, against one per
	 * session+skill). Every case here is about that mismatch rather than about the
	 * mark itself.
	 */
	describe("inferred marking", () => {
		const entry = (at: string) => ({ at, ok: true, entryPath: "tool" as const });

		it("marks a row when any entry behind it was inferred, and leaves an observed row clean", async () => {
			await applySummaryEvents(
				[
					repoEvent,
					sessionWith(
						"s1",
						[
							{
								name: "inferred-skill",
								kind: "skill",
								calls: 1,
								detection: "heuristic",
								invocations: [entry("2026-07-30T10:00:00.000Z")],
							},
							{
								name: "observed-skill",
								kind: "skill",
								calls: 1,
								invocations: [entry("2026-07-30T10:00:00.000Z")],
							},
						],
						"codex",
					),
				],
				{ producerKind: "cli", dbPath },
			);
			const byName = new Map((await usage())?.skills.map((row) => [row.name, row]));
			expect(byName.get("inferred-skill")?.detection).toBe("heuristic");
			// Absent, not a second value — see `ToolUsageRow.detection` on why "observed"
			// and "nothing on record" deliberately share the quiet case.
			expect(byName.get("observed-skill")?.detection).toBeUndefined();
		});

		it("does not multiply the row's own figures by the number of entries behind it", async () => {
			// THE REGRESSION THIS SUITE EXISTS FOR, and the assertions are deliberately on
			// the numbers that have NOTHING to do with the mark. `skill_invocations` holds
			// one row per entry, so reaching it with a JOIN instead of the correlated
			// subquery fans the aggregate out: these four entries turn 3 calls into 12 and
			// each token sum into four times itself. Nothing throws.
			//
			// FOUR ENTRIES AGAINST THREE CALLS, not a matching count, and the mismatch is
			// the realistic shape rather than a contrivance — an inferred skill is entered
			// once per session however many paged reads produced it, so the two numbers are
			// independent by design. It also means a JOIN cannot be caught by comparing them.
			//
			// `sessions` is asserted for the opposite reason: it is a COUNT(DISTINCT) and so
			// survives the fan-out unharmed. That is what makes the bug quiet on a real
			// database — half the row keeps agreeing with itself.
			await applySummaryEvents(
				[
					repoEvent,
					sessionWith(
						"s1",
						[
							{
								name: "paged-reads",
								kind: "skill",
								calls: 3,
								detection: "heuristic",
								usage: { input: 500, output: 300, cached: 100, confidence: "attributed" },
								invocations: [
									entry("2026-07-30T10:00:00.000Z"),
									entry("2026-07-30T10:01:00.000Z"),
									entry("2026-07-30T10:02:00.000Z"),
									entry("2026-07-30T10:03:00.000Z"),
								],
							},
						],
						"codex",
					),
				],
				{ producerKind: "cli", dbPath },
			);
			const row = (await usage())?.skills[0];
			expect(row?.detection).toBe("heuristic");
			expect(row?.calls).toBe(3);
			expect(row?.sessions).toBe(1);
			expect(row?.usage).toMatchObject({ input: 500, output: 300, cached: 100 });
			// The per-agent split rides on its own query and must survive the same way.
			expect(row?.agents).toEqual([{ source: "codex", calls: 3 }]);
		});

		it("leaves an MCP tool unmarked even when a heuristic skill shares its name", async () => {
			// `skill_invocations` has no `kind` column, so the subquery matches on name
			// alone and the two lists are separated only by `t.kind` — which the subquery
			// cannot see. Without the `list` gate this MCP row inherits the skill's mark.
			await applySummaryEvents(
				[
					repoEvent,
					sessionWith(
						"s1",
						[
							{
								name: "exec",
								kind: "skill",
								calls: 1,
								detection: "heuristic",
								invocations: [entry("2026-07-30T10:00:00.000Z")],
							},
							{ name: "exec", kind: "mcp", server: "shell", calls: 1 },
						],
						"codex",
					),
				],
				{ producerKind: "cli", dbPath },
			);
			const result = await usage();
			expect(result?.skills.find((row) => row.name === "exec")?.detection).toBe("heuristic");
			expect(result?.mcpTools.find((row) => row.name === "exec")?.detection).toBeUndefined();
		});

		it("leaves a row unmarked when no entry row survives to read a detection off", async () => {
			// A count with no per-entry record — an archived commit's merged total, or a
			// transcript the agent pruned. There is nothing to read, so the row falls quiet
			// rather than claiming either nature.
			await applySummaryEvents(
				[repoEvent, sessionWith("s1", [{ name: "no-entries", kind: "skill", calls: 5 }], "codex")],
				{ producerKind: "cli", dbPath },
			);
			const row = (await usage())?.skills[0];
			expect(row?.calls).toBe(5);
			expect(row?.detection).toBeUndefined();
		});
	});

	describe("skill detail", () => {
		const detail = async (name: string) =>
			await withDashboardDb(
				(db) => buildSkillDetail(db, { scope: { kind: "all" }, name, timeZone: "UTC", nowMs }),
				{ dbPath },
			);

		it("returns undefined when the window contains no call of that skill", async () => {
			await applySummaryEvents([repoEvent], { producerKind: "cli", dbPath });
			expect(await detail("missing")).toBeUndefined();
		});

		it("projects usage, agents, sessions, commits and every per-entry detail without join fan-out", async () => {
			const firstAt = nowMs - 2 * 3_600_000;
			const lastAt = nowMs - 3_600_000;
			const hash = "d".repeat(40);
			await applySummaryEvents(
				[
					repoEvent,
					{
						producerKind: "cli",
						event: {
							type: "session.upserted",
							repoIdentity: "repo-1",
							source: "claude",
							sessionId: "rich",
							title: "Review the release",
							startedAtMs: firstAt - 60_000,
							updatedAtMs: nowMs,
							durationMs: 7_200_000,
							messageCount: 9,
							models: [
								{
									model: "claude-opus-4-8",
									provider: "anthropic",
									inputTokens: 100,
									outputTokens: 50,
									cachedTokens: 25,
								},
							],
							tokenCoverage: "full",
							tools: [
								{
									name: "code-review",
									kind: "skill",
									calls: 2,
									plugin: "superpowers",
									lastCallAtMs: lastAt,
									usage: { input: 40, output: 20, cached: 10, confidence: "attributed" },
									invocations: [
										{
											at: new Date(firstAt).toISOString(),
											ok: true,
											entryPath: "tool",
											args: "--base main",
											bodyChars: 3200,
										},
										{
											at: new Date(lastAt).toISOString(),
											ok: false,
											entryPath: "tool",
											bodyChars: 120,
										},
									],
								},
							],
						},
					},
					sessionWith(
						"inferred",
						[
							{
								name: "code-review",
								kind: "skill",
								calls: 1,
								lastCallAtMs: lastAt - 1,
								detection: "heuristic",
								usage: { input: 7, output: 3, cached: 2, confidence: "estimated" },
								invocations: [
									{ at: new Date(lastAt - 1).toISOString(), ok: true, entryPath: "command" },
								],
							},
						],
						"codex",
					),
					{
						producerKind: "cli",
						event: {
							type: "commit.created",
							repoIdentity: "repo-1",
							hash,
							branch: "main",
							branches: ["main"],
							message: "fix: review finding",
							committedAtMs: lastAt,
							filesChanged: 2,
							insertions: 12,
							deletions: 3,
						},
					},
				],
				{ producerKind: "cli", dbPath },
			);
			await seedTopicRows(dbPath, hash, ["bugfix", "bugfix", "architecture"], { commitDateMs: lastAt });
			await withDashboardDb(
				(db) => {
					const { id: repoId } = db.prepare("SELECT id FROM repos WHERE repo_identity = 'repo-1'").get() as {
						id: number;
					};
					db.prepare(
						`UPDATE memories
						    SET summary_json = json_set(summary_json,
						        '$.branch', 'main',
						        '$.commitMessage', 'fix: review finding',
						        '$.diffStats.filesChanged', 2,
						        '$.diffStats.insertions', 12,
						        '$.diffStats.deletions', 3)
						  WHERE repo_id = ? AND commit_hash = ?`,
					).run(repoId, hash);
					for (const transcriptId of ["t-rich-1", "t-rich-2"]) {
						db.prepare(
							"INSERT INTO transcripts (repo_id, transcript_id, sessions_blob, written_at_ms) VALUES (?, ?, ?, 1)",
						).run(repoId, transcriptId, Buffer.from("fixture"));
						db.prepare(
							"INSERT INTO memory_transcripts (repo_id, commit_hash, transcript_id) VALUES (?, ?, ?)",
						).run(repoId, hash, transcriptId);
						db.prepare(
							"INSERT INTO transcript_sessions (repo_id, transcript_id, session_id, source) VALUES (?, ?, 'rich', 'claude')",
						).run(repoId, transcriptId);
					}
				},
				{ dbPath },
			);

			const result = await detail("code-review");
			expect(result).toMatchObject({
				name: "code-review",
				sessions: 2,
				calls: 3,
				lastCallAtMs: lastAt,
				plugin: "superpowers",
				usage: { input: 47, output: 23, cached: 12, confidence: "estimated", sessions: 2 },
				agents: [
					{
						source: "claude",
						sessions: 1,
						calls: 2,
						usage: { input: 40, output: 20, cached: 10, confidence: "attributed", sessions: 1 },
					},
					{
						source: "codex",
						sessions: 1,
						calls: 1,
						usage: { input: 7, output: 3, cached: 2, confidence: "estimated", sessions: 1 },
					},
				],
				outcomes: { measured: 2, failed: 1, assumed: 1 },
				entryPaths: ["tool", "command"],
				detection: "heuristic",
				firstCallAtMs: firstAt,
				bodyChars: 3200,
				repos: ["jolli"],
				categories: [
					{ category: "architecture", commits: 1 },
					{ category: "bugfix", commits: 1 },
				],
			});
			expect(result?.commits).toEqual([
				{
					hash,
					repoName: "jolli",
					branch: "main",
					message: "fix: review finding",
					committedAtMs: lastAt,
					filesChanged: 2,
					insertions: 12,
					deletions: 3,
					categories: ["architecture", "bugfix"],
				},
			]);
			expect(result?.linkedSessions[0]).toMatchObject({
				sessionId: "rich",
				title: "Review the release",
				startedAtMs: firstAt - 60_000,
				durationMs: 7_200_000,
				messageCount: 9,
				model: "claude-opus-4-8",
				sessionTokens: 175,
			});
			expect(result?.invocations).toEqual([
				{ atMs: firstAt, ok: true, outcomeKnown: true, args: "--base main", bodyChars: 3200 },
				{ atMs: lastAt - 1, ok: true, outcomeKnown: false },
				{ atMs: lastAt, ok: false, outcomeKnown: true, bodyChars: 120 },
			]);
			expect(result?.sessionSeries).toEqual([
				{ atMs: lastAt - 1, tokens: 12 },
				{ atMs: lastAt, tokens: 70 },
			]);
		});

		it("keeps sparse calls visible without inventing usage, outcomes or optional session facts", async () => {
			await applySummaryEvents([repoEvent, sessionWith("sparse", [{ name: "plain", kind: "skill", calls: 5 }])], {
				producerKind: "cli",
				dbPath,
			});
			const result = await detail("plain");
			expect(result).toMatchObject({
				name: "plain",
				sessions: 1,
				calls: 5,
				agents: [{ source: "claude", sessions: 1, calls: 5 }],
				commits: [],
				categories: [],
				entryPaths: [],
				invocations: [],
				sessionSeries: [{ atMs: nowMs - 3_600_000 }],
			});
			expect(result).not.toHaveProperty("usage");
			expect(result).not.toHaveProperty("outcomes");
			expect(result).not.toHaveProperty("plugin");
			expect(result?.linkedSessions[0]).not.toHaveProperty("sessionTokens");
			expect(result?.linkedSessions[0]).not.toHaveProperty("usage");
		});

		it("keeps the newest 400 session-series points in ascending order", async () => {
			const points = Array.from({ length: 401 }, (_, i) => nowMs - (401 - i) * 60_000);
			await applySummaryEvents(
				[
					repoEvent,
					...points.map((atMs, i) =>
						sessionWith(`series-${i}`, [
							{ name: "long-running", kind: "skill", calls: 1, lastCallAtMs: atMs },
						]),
					),
				],
				{ producerKind: "cli", dbPath },
			);

			const series = (await detail("long-running"))?.sessionSeries ?? [];
			expect(series).toHaveLength(400);
			expect(series[0]?.atMs).toBe(points[1]);
			expect(series.at(-1)?.atMs).toBe(points.at(-1));
			expect(series.map((point) => point.atMs)).toEqual(
				[...series.map((point) => point.atMs)].sort((a, b) => a - b),
			);
			expect(series.some((point) => point.atMs === points[0])).toBe(false);
		});

		it("keeps a sparse linked commit and partially populated legacy token row readable", async () => {
			const hash = "e".repeat(40);
			await applySummaryEvents(
				[
					repoEvent,
					sessionWith("legacy", [
						{
							name: "legacy-skill",
							kind: "skill",
							calls: 1,
							usage: { input: 5, output: 2, cached: 1, confidence: "attributed" },
						},
					]),
				],
				{ producerKind: "cli", dbPath },
			);
			await seedTopicRows(dbPath, hash, [], { commitDateMs: nowMs - 1_000 });
			await withDashboardDb(
				(db) => {
					const { id: repoId } = db.prepare("SELECT id FROM repos WHERE repo_identity = 'repo-1'").get() as {
						id: number;
					};
					db.prepare(
						"INSERT INTO transcripts (repo_id, transcript_id, sessions_blob, written_at_ms) VALUES (?, 't-legacy', ?, 1)",
					).run(repoId, Buffer.from("fixture"));
					db.prepare(
						"INSERT INTO memory_transcripts (repo_id, commit_hash, transcript_id) VALUES (?, ?, 't-legacy')",
					).run(repoId, hash);
					db.prepare(
						"INSERT INTO transcript_sessions (repo_id, transcript_id, session_id, source) VALUES (?, 't-legacy', 'legacy', 'claude')",
					).run(repoId);
					// `full` with zero session tokens exercises the honest "known zero" path;
					// the skill row itself simulates a partially populated legacy record.
					db.prepare("UPDATE sessions SET token_coverage = 'full' WHERE session_id = 'legacy'").run();
					db.prepare(
						"UPDATE session_tool_use SET output_tokens = NULL, cached_tokens = NULL WHERE tool_name = 'legacy-skill'",
					).run();
				},
				{ dbPath },
			);

			const result = await detail("legacy-skill");
			expect(result?.commits).toEqual([
				{
					hash,
					repoName: "jolli",
					committedAtMs: nowMs - 1_000,
					categories: [],
				},
			]);
			expect(result?.usage).toMatchObject({ input: 5, output: 0, cached: 0 });
			expect(result?.linkedSessions[0]).toMatchObject({
				sessionId: "legacy",
				usage: { input: 5, output: 0, cached: 0 },
			});
			expect(result?.linkedSessions[0]).not.toHaveProperty("sessionTokens");
			expect(result?.sessionSeries).toEqual([{ atMs: nowMs - 3_600_000, tokens: 5 }]);
		});
	});
});

describe("buildDashboardModel — skill adoption band (skillDays)", () => {
	let dir: string;
	let dbPath: string;
	// 20:00 local in Asia/Shanghai, so `custom` can name today without being clamped.
	const nowMs = Date.parse("2026-07-30T12:00:00Z");
	const ZONE = "Asia/Shanghai";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jolli-band-"));
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

	/**
	 * A session whose skill rows carry their own call time.
	 *
	 * `lastCallAtMs` is what the band buckets on, and it is set per tool rather than
	 * per session: the session's own `updatedAtMs` is the COALESCE fallback, so a
	 * fixture that set only the session clock would still pass if the query read the
	 * wrong one.
	 */
	const sessionAt = (sessionId: string, callAtMs: number, skills: ReadonlyArray<string>): StatsEventEnvelope => ({
		producerKind: "cli",
		event: {
			type: "session.upserted",
			repoIdentity: "repo-1",
			source: "claude",
			sessionId,
			updatedAtMs: nowMs - 3_600_000,
			tools: skills.map((name) => ({ name, kind: "skill" as const, calls: 1, lastCallAtMs: callAtMs })),
		},
	});

	const band = async (customFrom: string, customTo: string) =>
		(
			await withDashboardDb(
				(db) =>
					buildDashboardModel(db, {
						view: "stats",
						scope: { kind: "all" },
						timeZone: ZONE,
						nowMs,
						range: "custom",
						customFrom,
						customTo,
					}),
				{ dbPath },
			)
		).stats?.toolUsage?.skillDays;

	it("buckets by LOCAL day, not by the UTC day the epoch division would give", async () => {
		await applySummaryEvents(
			[
				repoEvent,
				// 23:00 UTC on the 28th is 07:00 local on the 29th. A UTC bucket files
				// this under the 28th — the divergence the whole switch is about.
				sessionAt("s-late", Date.parse("2026-07-28T23:00:00Z"), ["deep-work"]),
				// 20:00 UTC on the 27th is 04:00 local on the 28th, i.e. inside the
				// window even though its UTC day sits before the window's first key.
				sessionAt("s-early", Date.parse("2026-07-27T20:00:00Z"), ["deep-work"]),
			],
			{ producerKind: "cli", dbPath },
		);
		expect(await band("2026-07-28", "2026-07-29")).toEqual([
			{ date: "2026-07-28", bySeries: { "deep-work": 1 } },
			{ date: "2026-07-29", bySeries: { "deep-work": 1 } },
		]);
	});

	it("emits every day of the window, including days nothing ran", async () => {
		await applySummaryEvents([repoEvent, sessionAt("s1", Date.parse("2026-07-28T04:00:00Z"), ["deep-work"])], {
			producerKind: "cli",
			dbPath,
		});
		// The chart lays bars out by index, so the two silent days have to be present
		// as empty points rather than dropped — otherwise a three-day window with one
		// active day draws one full-width bar and reads as three busy days.
		expect(await band("2026-07-28", "2026-07-30")).toEqual([
			{ date: "2026-07-28", bySeries: { "deep-work": 1 } },
			{ date: "2026-07-29", bySeries: {} },
			{ date: "2026-07-30", bySeries: {} },
		]);
	});

	it("counts a session once per skill, so one day's bar totals skill-sessions", async () => {
		const at = Date.parse("2026-07-29T04:00:00Z");
		await applySummaryEvents(
			[
				repoEvent,
				sessionAt("s1", at, ["deep-work", "code-review"]),
				// A second session reaching for one of the same skills is a second
				// session for THAT series only.
				sessionAt("s2", at, ["deep-work"]),
			],
			{ producerKind: "cli", dbPath },
		);
		expect(await band("2026-07-29", "2026-07-29")).toEqual([
			{ date: "2026-07-29", bySeries: { "deep-work": 2, "code-review": 1 } },
		]);
	});

	it("files a session under one day even when its calls straddled local midnight", async () => {
		await applySummaryEvents([repoEvent, sessionAt("s1", Date.parse("2026-07-29T01:00:00Z"), ["deep-work"])], {
			producerKind: "cli",
			dbPath,
		});
		// 01:00 UTC is 09:00 local on the 29th. The session may well have started on
		// the 28th, but `session_tool_use` keeps only this one timestamp, so the whole
		// contribution lands on the 29th — the documented cost of using the aggregate
		// table rather than `skill_invocations`.
		expect(await band("2026-07-28", "2026-07-29")).toEqual([
			{ date: "2026-07-28", bySeries: {} },
			{ date: "2026-07-29", bySeries: { "deep-work": 1 } },
		]);
	});

	it("returns a point per day even with no skill rows at all", async () => {
		await applySummaryEvents([repoEvent], { producerKind: "cli", dbPath });
		// Not an empty array — the window is what decides the point count, not the data.
		// This is why `bandHtml` tests for "no SERIES" rather than "no points": a
		// `series.length` test would never fire here and would draw an empty axis
		// instead of the "no skill invocations" note.
		expect(await band("2026-07-29", "2026-07-30")).toEqual([
			{ date: "2026-07-29", bySeries: {} },
			{ date: "2026-07-30", bySeries: {} },
		]);
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

	it("flags memoryCardsCapped only once the window holds more than one page", async () => {
		const bulk = (from: number, count: number) =>
			applySummaryEvents(
				Array.from({ length: count }, (_, i) => ({
					producerKind: "bootstrap" as const,
					event: {
						type: "commit.summary" as const,
						repoIdentity: "repo-1",
						hash: `bulk${from + i}`,
						committedAtMs: nowMs - 2 * 3_600_000,
						branch: "main",
						message: `chore: bulk ${from + i}`,
						turns: 1,
						tokens: 10,
						estCostUsd: 0.1,
						insights: [],
						references: [],
						sessionLinks: [],
					},
				})),
				{ producerKind: "cli", dbPath },
			);
		const readStats = async () =>
			(
				await withDashboardDb(
					(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
					{ dbPath },
				)
			).stats;

		await seedMemory();
		await bulk(0, MEMORY_CARDS_LIMIT - 2);
		const full = await readStats();
		// Exactly one page with nothing behind it: the feed IS the window, so the
		// subtitle must not claim a truncation that has not happened. `>= LIMIT`
		// cannot tell this case from the next one — only the un-cut count can.
		expect(full?.memoryCards).toHaveLength(MEMORY_CARDS_LIMIT);
		expect(full?.memoryCardsCapped).toBeUndefined();

		await bulk(100, 1);
		const cut = await readStats();
		expect(cut?.memoryCards).toHaveLength(MEMORY_CARDS_LIMIT);
		expect(cut?.memoryCardsCapped).toBe(true);
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
		// The card's title links here, and `/memories?hash=` resolves against
		// `memories.commit_hash` — so this has to be the MEMORY's hash, which the
		// rewrite left behind at `mem1`, and not the live `commits.hash` the alias
		// join entered from. Selecting the latter sent the click to a detail pane
		// that could not resolve, on precisely the commits this test covers.
		expect(model.stats?.decisions?.latest?.commitHash).toBe("mem1");
		expect(model.stats?.memoryCards?.map((c) => c.commitHash)).toContain("mem1");
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
		// The card renders the OWNING TOPIC'S TITLE (`t0` in this fixture), not the
		// decision prose — which is left out of the payload entirely, since the
		// card is one line wide and a real block runs to ~1,900 characters.
		expect(decisions.latest).toMatchObject({
			title: "t0",
			commitHash: "mem1",
			repoName: "jolli",
			// Addresses the memory's row from the card's title link; a repo NAME
			// cannot, since two registered repos can share one.
			repoIdentity: "repo-1",
		});
		expect(decisions.latest).not.toHaveProperty("text");
		// decisionsCaptured mirrors the card's count rather than a second query.
		expect(model.stats?.decisionsCaptured).toBe(1);
		// …and the per-row counts under Memory Activity are the same rule, so the
		// list cannot contradict the "N decisions" figure above it.
		expect(model.stats?.memoryCards.find((c) => c.commitHash === "mem1")?.decisionCount).toBe(1);
		expect(model.stats?.memoryCards.find((c) => c.commitHash === "mem2")).not.toHaveProperty("decisionCount");
		// One point per local day of the default 30-day window.
		expect(decisions.perDay).toHaveLength(30);
		expect(decisions.perDay.reduce((sum, d) => sum + d.count, 0)).toBe(1);
	});

	// `TopicSummary.title` is required by the schema, so both branches below are
	// malformed/pre-schema payloads only — but they are the only inputs that can
	// put unbounded prose where a one-line title goes, so the bound is pinned.
	describe("Decisions card title fallback", () => {
		async function seedTitlelessDecision(decisions: string): Promise<void> {
			await seedMemory();
			await withDashboardDb(
				(db) => {
					const { id } = db.prepare("SELECT id FROM repos WHERE repo_identity = 'repo-1'").get() as {
						id: number;
					};
					db.prepare("UPDATE memories SET summary_json = ? WHERE repo_id = ? AND commit_hash = 'mem1'").run(
						JSON.stringify({ commitHash: "mem1", topics: [{ title: "", decisions }] }),
						id,
					);
				},
				{ dbPath },
			);
		}

		async function latestTitle(): Promise<string | undefined> {
			const model = await withDashboardDb(
				(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
				{ dbPath },
			);
			return model.stats?.decisions?.latest?.title;
		}

		it("falls back to the clause before the first colon", async () => {
			await seedTitlelessDecision("- **Picked SQLite**: needed local durability without a server.");
			expect(await latestTitle()).toBe("Picked SQLite");
		});

		it("answers empty rather than a paragraph when the bullet has no colon to cut at", async () => {
			// Measured at 314 characters against a real decisions block: with no
			// `: ` the old fallback handed the whole bullet to a one-line card.
			const sprawling = `Rejected the second scheduler entirely ${"because it would own the same fact twice ".repeat(6)}`;
			expect(sprawling.length).toBeGreaterThan(120);
			await seedTitlelessDecision(`- **${sprawling}**`);
			expect(await latestTitle()).toBe("");
		});

		// The bound only exists to stop prose; a short colon-less bullet is a
		// perfectly good title and must survive.
		it("keeps a colon-less bullet that is already title-length", async () => {
			await seedTitlelessDecision("- **Picked SQLite over a server**");
			expect(await latestTitle()).toBe("Picked SQLite over a server");
		});
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

	/**
	 * The shape a rebase leaves behind. `commits` moves to the new hash — the ROW
	 * survives, so its `commit_branches` links and its committer date come with it
	 * — while the memory stays filed under the old hash, reachable only through
	 * `commit_aliases`. Nothing is left carrying the memory's own hash, which is
	 * what `pruneUnreachableCommits` guarantees and what makes the alias the only
	 * path to it.
	 */
	async function rebaseMem1(authorDaysAgo?: number): Promise<void> {
		await withDashboardDb(
			(db) => {
				const { id: repoId } = db.prepare("SELECT id FROM repos WHERE repo_identity = 'repo-1'").get() as {
					id: number;
				};
				db.prepare("UPDATE commits SET hash = 'mem1-rebased' WHERE repo_id = ? AND hash = 'mem1'").run(repoId);
				db.prepare(
					"INSERT INTO commit_aliases (repo_id, old_hash, target_hash, created_ms) VALUES (?, ?, ?, ?)",
				).run(repoId, "mem1-rebased", "mem1", 1);
				if (authorDaysAgo != null) {
					db.prepare("UPDATE memories SET commit_date_ms = ? WHERE repo_id = ? AND commit_hash = 'mem1'").run(
						nowMs - authorDaysAgo * 24 * 3_600_000,
						repoId,
					);
				}
			},
			{ dbPath },
		);
	}

	it.each(["branch", "ticket"] as const)(
		"keeps a rebased commit's spend on the %s axis, bucketed on its landed date",
		async (dimension) => {
			await seedMemory();
			// Two ways to lose mem1's 20k here, and this fixture arms both: joining
			// `m.commit_hash = c.hash` never reaches a memory whose hash was rewritten
			// away, and its own `commit_date_ms` is an AUTHOR date 400 days back, which
			// would fall outside the series even once the row is found.
			await rebaseMem1(400);
			const model = await withDashboardDb(
				(db) =>
					buildDashboardModel(db, {
						view: "stats",
						scope: { kind: "all" },
						dimension,
						timeZone: "UTC",
						nowMs,
					}),
				{ dbPath },
			);
			const stats = model.stats;
			if (!stats) throw new Error("stats missing");
			expect(stats.seriesDimension).toBe(dimension);
			expect(stats.series.reduce((sum, p) => sum + p.tokens, 0)).toBe(28000);
			// On TODAY — the rebased commit's committer date — and under the branch
			// the surviving `commit_branches` row still carries.
			const today = stats.series[stats.series.length - 1];
			expect(today.bySeries[dimension === "branch" ? "feature/dash" : "JOLLI-2069"]).toBe(20000);
		},
	);

	it("buckets a rebased memory's category spend on the landed committer date", async () => {
		await seedMemory();
		await seedTopicRows(dbPath, "mem1", ["bugfix", "feature", "bugfix", "security"], { tokens: 20000 });
		await seedTopicRows(dbPath, "mem2", [], { tokens: 8000, commitDateMs: nowMs - 26 * 3_600_000 });
		// The author date is stamped by the rebase helper, not by `seedTopicRows`:
		// that one is an INSERT OR IGNORE, so on a memory `seedMemory` already wrote
		// it silently changes nothing — and a fixture that cannot move the date
		// cannot exercise the fallback this test is about.
		await rebaseMem1(400);
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
		const today = stats.series[stats.series.length - 1];
		expect(today.bySeries).toEqual({ bugfix: 10000, feature: 5000, security: 5000 });
		expect(stats.series.reduce((sum, p) => sum + p.tokens, 0)).toBe(28000);
	});

	it("keeps a rebased memory in the feed when reachability is checked", async () => {
		await seedMemory();
		await rebaseMem1();
		const model = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "stats",
					scope: { kind: "all" },
					timeZone: "UTC",
					nowMs,
					// What the server passes for this view: hashes reachable from a ref.
					// The memory's own hash is not one of them any more — asking about it
					// instead of the live one drops the very card the "N of M captured"
					// line beside it has just counted through the alias.
					reachableCommits: new Map([["repo-1", new Set(["mem1-rebased", "mem2"])]]),
				}),
			{ dbPath },
		);
		expect(model.stats?.memoriesCreated).toBe(2);
		expect(model.stats?.memoryCards?.map((c) => c.commitHash)).toContain("mem1");
	});

	it("stamps a rebased memory's card with the landed date, not the author date", async () => {
		await seedMemory();
		// The half of the ordering rule the non-rebased fixture cannot reach. Once
		// nothing carries the memory's own hash the payload query has no `commits`
		// row to read, so a COALESCE that skips the alias hop falls all the way to
		// `commit_date_ms` — an AUTHOR date, here 400 days outside the window the
		// key query just selected this row FOR. Both queries read the same
		// `memory_landing.at_ms` precisely so they cannot answer differently.
		await rebaseMem1(400);
		const model = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "stats",
					scope: { kind: "all" },
					timeZone: "UTC",
					nowMs,
					reachableCommits: new Map([["repo-1", new Set(["mem1-rebased", "mem2"])]]),
				}),
			{ dbPath },
		);
		// The rebased commit's own committer date — mem1 landed today, so it also
		// still leads the feed over yesterday's mem2.
		expect(model.stats?.memoryCards?.map((c) => c.commitHash)).toEqual(["mem1", "mem2"]);
		expect(model.stats?.memoryCards?.[0]?.committedAtMs).toBe(nowMs - 3 * 3_600_000);
	});

	it("keeps a day's cost in the trend when a series key shadows Object.prototype", async () => {
		// A branch really can be named `constructor`, and `bySeries` is a plain
		// object — so on a day that branch recorded nothing, the lookup hands back
		// the INHERITED function. Read with `??` it reaches the arithmetic:
		// `number + function` is a string, the `> 0` test deciding whether a day was
		// drawn is then false, and that day's money leaves the headline the trend is
		// computed against. Both windows here hold exactly one such day.
		const summary = (hash: string, branch: string, committedAtMs: number, tokens: number, estCostUsd: number) => ({
			producerKind: "bootstrap" as const,
			event: {
				type: "commit.summary" as const,
				repoIdentity: "repo-1",
				hash,
				committedAtMs,
				branch,
				message: `chore: ${hash}`,
				turns: 1,
				tokens,
				estCostUsd,
				insights: [],
				references: [],
				sessionLinks: [],
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
				summary("today-main", "main", nowMs - 3 * 3_600_000, 20_000, 2),
				// The `constructor` series exists in this window but not on the day
				// above — which is what makes the day above read its inherited value.
				summary("yesterday-ctor", "constructor", nowMs - 27 * 3_600_000, 10_000, 1),
				// The prior window, whose only series is `main` — so it is priced the
				// same either way and the comparison isolates the current window.
				summary("prior-main", "main", nowMs - 40 * 24 * 3_600_000, 10_000, 1),
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
		expect(model.stats?.seriesKeys).toEqual(["constructor", "main"]);
		// $3 drawn against the prior window's $1. Losing the shadowed days to the
		// inherited value reads 0% here — a flat trend over a window that tripled.
		expect(model.stats?.costTrendPct).toBe(200);
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

	it.each(["category", "branch", "ticket"] as const)(
		"counts a memory once on the %s axis however many predecessors it was amended over",
		async (dimension) => {
			await seedMemory();
			await seedTopicRows(dbPath, "mem1", ["feature"], { tokens: 20000, commitDateMs: nowMs - 3 * 3_600_000 });
			const read = async () => {
				const model = await withDashboardDb(
					(db) =>
						buildDashboardModel(db, {
							view: "stats",
							scope: { kind: "all" },
							dimension,
							timeZone: "UTC",
							nowMs,
						}),
					{ dbPath },
				);
				const stats = model.stats;
				if (!stats) throw new Error("stats missing");
				return {
					tokens: stats.series.reduce((sum, p) => sum + p.tokens, 0),
					cost: stats.series.reduce((sum, p) => sum + p.estCostUsd, 0),
				};
			};
			const before = await read();

			// Three amends over the same piece of work. Each leaves a `memories`
			// row AND a `commits` row behind, so an INNER JOIN on `commits` does
			// not filter them — only `parent_hash IS NULL` does.
			for (const n of [1, 2, 3]) {
				await seedSupersededPredecessor(dbPath, "mem1", `mem1-old-${n}`, {
					branch: "feature/dash",
					childPos: n,
					tokens: 20000,
					estCostUsd: 3,
					committedAtMs: nowMs - 3 * 3_600_000,
				});
			}

			// Unchanged: superseded history is the same work, not new spend.
			expect(await read()).toEqual(before);
		},
	);

	it("counts a decision once however many predecessors recorded it", async () => {
		await seedMemory();
		const read = async () => {
			const model = await withDashboardDb(
				(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
				{ dbPath },
			);
			return { captured: model.stats?.decisionsCaptured, kept: model.stats?.decisions?.keptCount };
		};
		const before = await read();
		expect(before.captured).toBeGreaterThan(0);

		// The same defect as the axis test above, one card over: a predecessor
		// keeps its OWN topics, and every consumer of TOPIC_INSIGHTS_CTE joins
		// `commits`, which keeps the predecessor's row. Unfiltered, the decision
		// this branch reached once is counted once per amend — right beside
		// `memoriesCreated`, which filters the same history out via isReachable.
		for (const n of [1, 2]) {
			await seedSupersededPredecessor(dbPath, "mem1", `mem1-dec-${n}`, {
				branch: "feature/dash",
				childPos: 10 + n,
				tokens: 20000,
				estCostUsd: 3,
				committedAtMs: nowMs - 3 * 3_600_000,
				topics: [{ title: "Retry policy", category: "bugfix", decisions: "- Keep jittered backoff." }],
			});
		}

		expect(await read()).toEqual(before);
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

	it("marks the memory tier with a present-but-empty insights flag, fetching no content", async () => {
		// `insights` is a tier flag carried by PRESENCE, not a payload: the board
		// renders no insight text (JOLLI-2200/2201), so it is an empty array at the
		// memory tier and the server no longer runs a query to fill it. The seeded
		// memories carry decisions/todo the old code would have surfaced here.
		await seedMemory();
		const model = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "standup", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
			{ dbPath },
		);
		expect(model.standup?.insights).toEqual([]);
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
		expect(commitDayKey(standup, "mem1")).toBe(standup?.today);
		expect(commitByHash(standup, "mem1")).toMatchObject({
			hash: "mem1",
			turns: 10,
			estCostUsd: 3,
			ticketId: "JOLLI-2069",
		});
		expect(commitDayKey(standup, "mem2")).toBe(standup?.yesterday);
		const yesterday = commitByHash(standup, "mem2");
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
		expect(commitByHash(await standupOf(), "cat1")).toMatchObject({ hash: "cat1", workCategory: "feature" });
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
		expect(commitByHash(await standupOf(), "tie1")).toMatchObject({ hash: "tie1", workCategory: "bugfix" });
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
		const commit = commitByHash(await standupOf(), "raw1");
		expect(commit).toMatchObject({ hash: "raw1" });
		expect(commit).not.toHaveProperty("turns");
		expect(commit).not.toHaveProperty("estCostUsd");
		expect(commit).not.toHaveProperty("ticketId");
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
		expect(await scopeOf({ kind: "repo", repoIdentities: ["jolliai"] })).toEqual({
			kind: "repo",
			repoIdentities: ["https://github.com/jolliai/jolliai"],
		});
	});

	it("still accepts a full identity unchanged", async () => {
		await seedRepos([["https://github.com/jolliai/jolliai", "jolliai"]]);
		expect(await scopeOf({ kind: "repo", repoIdentities: ["https://github.com/jolliai/jolliai"] })).toEqual({
			kind: "repo",
			repoIdentities: ["https://github.com/jolliai/jolliai"],
		});
	});

	it("prefers an exact identity over a repo that is merely NAMED like one", async () => {
		// A repo named after someone else's remote must not shadow that remote.
		await seedRepos([
			["https://github.com/jolliai/jolliai", "jolliai"],
			["local:abc", "https://github.com/jolliai/jolliai"],
		]);
		expect(await scopeOf({ kind: "repo", repoIdentities: ["https://github.com/jolliai/jolliai"] })).toEqual({
			kind: "repo",
			repoIdentities: ["https://github.com/jolliai/jolliai"],
		});
	});

	it("refuses to guess when two repos share a name", async () => {
		await seedRepos([
			["https://github.com/one/jolli", "jolli"],
			["https://github.com/two/jolli", "jolli"],
		]);
		// Left unresolved: showing the wrong project's numbers under a
		// plausible-looking URL is worse than showing none.
		expect(await scopeOf({ kind: "repo", repoIdentities: ["jolli"] })).toEqual({
			kind: "repo",
			repoIdentities: ["jolli"],
		});
	});

	it("leaves an unknown token alone", async () => {
		await seedRepos([["https://github.com/jolliai/jolliai", "jolliai"]]);
		expect(await scopeOf({ kind: "repo", repoIdentities: ["nope"] })).toEqual({
			kind: "repo",
			repoIdentities: ["nope"],
		});
	});

	it("passes an all-repos scope through untouched", async () => {
		await seedRepos([["https://github.com/jolliai/jolliai", "jolliai"]]);
		expect(await scopeOf({ kind: "all" })).toEqual({ kind: "all" });
	});

	it("resolves each token independently — a name beside an identity", async () => {
		await seedRepos([
			["https://github.com/jolliai/jolliai", "jolliai"],
			["https://github.com/jolliai/site", "site"],
		]);
		expect(await scopeOf({ kind: "repo", repoIdentities: ["jolliai", "https://github.com/jolliai/site"] })).toEqual(
			{
				kind: "repo",
				repoIdentities: ["https://github.com/jolliai/jolliai", "https://github.com/jolliai/site"],
			},
		);
	});

	it("does not let one ambiguous name spoil the good token beside it", async () => {
		await seedRepos([
			["https://github.com/one/jolli", "jolli"],
			["https://github.com/two/jolli", "jolli"],
			["https://github.com/jolliai/site", "site"],
		]);
		expect(await scopeOf({ kind: "repo", repoIdentities: ["jolli", "site"] })).toEqual({
			kind: "repo",
			// The ambiguous one survives as-is and goes on to match nothing; the
			// unique one resolves. Dropping the ambiguous token instead would
			// silently widen the answer to "site only" without saying so.
			repoIdentities: ["jolli", "https://github.com/jolliai/site"],
		});
	});

	it("dedupes a token that names a repo already named by another", async () => {
		await seedRepos([["https://github.com/jolliai/jolliai", "jolliai"]]);
		expect(
			await scopeOf({ kind: "repo", repoIdentities: ["jolliai", "https://github.com/jolliai/jolliai"] }),
		).toEqual({ kind: "repo", repoIdentities: ["https://github.com/jolliai/jolliai"] });
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
				// ONE, not two: the payload's single topic holds a two-bullet
				// decisions block, and this counts topics that recorded a decision —
				// the same rule as `decisionsCaptured`, which is rendered directly
				// above these rows.
				decisionCount: 1,
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
		expect(await cards({ kind: "repo", repoIdentities: ["repo-1"] })).toHaveLength(1);
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

	// One per TOPIC that recorded a decision — the same rule as
	// `decisionsCaptured`, which is rendered directly above these rows (the two
	// are checked against each other in the Decisions card suite). A per-bullet
	// count would read 4 here and put two disagreeing numbers in one card.
	it("counts decisions per topic, not per bullet", async () => {
		await seedCard(
			payload({
				topics: [
					{ title: "A", category: "bugfix", decisions: "- One.\n- Two.\n- Three.", sourceCommits: ["h1"] },
					{ title: "B", category: "feature", decisions: "- Four.", sourceCommits: ["h1"] },
					{ title: "C", category: "feature", todo: "no decision here", sourceCommits: ["h1"] },
				],
			}),
		);
		const [card] = await cards();
		expect(card.decisionCount).toBe(2);
	});

	it("omits the count rather than reporting zero when no topic recorded a decision", async () => {
		await seedCard(payload({ topics: [{ title: "T", category: "feature", sourceCommits: ["h1"] }] }));
		const [card] = await cards();
		expect(card).not.toHaveProperty("decisionCount");
	});

	// `IN (hashes)` matches on the hash alone, so an all-repos dashboard whose
	// repos share a commit (a fork, a vendored tree) would add the other repo's
	// decisions to this row without the scope filter on `topic_insights.repo_id`.
	it("counts only the owning repo's decisions when two repos share a commit hash", async () => {
		await seedCard(payload());
		await applySummaryEvents(
			[
				{
					producerKind: "cli",
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-2",
						repoName: "jolli-fork",
						worktreeRoot: "/w2",
						enabledAt: "t",
					},
				},
			],
			{ producerKind: "cli", dbPath },
		);
		await withDashboardDb(
			(db) => {
				const { id } = db.prepare("SELECT id FROM repos WHERE repo_identity = 'repo-2'").get() as {
					id: number;
				};
				db.prepare(
					`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, depth,
					                       summary_json, first_seen_ms, written_at_ms, commit_date_ms)
					 VALUES (?, 'h1', NULL, NULL, 'h1', 0, ?, 1, 1, ?)`,
				).run(
					id,
					payload({
						topics: [
							{ title: "X", decisions: "- fork one.", sourceCommits: ["h1"] },
							{ title: "Y", decisions: "- fork two.", sourceCommits: ["h1"] },
						],
					}),
					Date.parse(committedAt),
				);
			},
			{ dbPath },
		);
		const byRepo = new Map((await cards()).map((c) => [c.repoIdentity, c.decisionCount]));
		expect(byRepo.get("repo-1")).toBe(1);
		expect(byRepo.get("repo-2")).toBe(2);
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
		expect(
			standupCommits(standup)
				.map((c) => c.hash)
				.sort(),
		).toEqual(["mine1", "mine2"]);
		expect(standup?.authoredBy).toBe("Me@Example.com");
	});

	it("leaves the dirty worktree unfiltered — it is this machine's own state", async () => {
		await seedSharedBranch();
		const standup = await standupOf(MINE);
		expect(standup?.workspaces).toHaveLength(1);
	});

	it("fails open on an identity with nothing usable in it, and says so by omitting authoredBy", async () => {
		await seedSharedBranch();
		for (const identity of [undefined, { emails: [], names: [] }, { emails: ["  "], names: [" "] }]) {
			const standup = await standupOf(identity);
			expect(
				standupCommits(standup)
					.map((c) => c.hash)
					.sort(),
			).toEqual(["mine1", "mine2", "theirs1"]);
			expect(standup).not.toHaveProperty("authoredBy");
		}
	});

	it("labels a name-only identity with the name", async () => {
		await seedSharedBranch();
		const standup = await standupOf({ emails: [], names: ["Me"] });
		expect(standup?.authoredBy).toBe("Me");
		expect(
			standupCommits(standup)
				.map((c) => c.hash)
				.sort(),
		).toEqual(["mine1", "mine2"]);
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

describe("knowledge & graph payloads", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "jolli-dq-kg-"));
		dbPath = join(dir, "kg.db");
		await withDashboardDb(() => {}, { dbPath });
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("passes the pre-built knowledge model through, and falls back to an empty one", async () => {
		const provided = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "knowledge",
					scope: { kind: "all" },
					timeZone: "UTC",
					nowMs: 0,
					knowledgeModel: {
						repos: [{ kb: "r", repoName: "r", detailRepo: "r", graphAvailable: true, files: [] }],
					},
				}),
			{ dbPath },
		);
		expect(provided.view).toBe("knowledge");
		expect(provided.knowledge?.repos).toHaveLength(1);

		const fallback = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "knowledge", scope: { kind: "all" }, timeZone: "UTC", nowMs: 0 }),
			{ dbPath },
		);
		expect(fallback.knowledge).toEqual({ repos: [] });
	});

	it("passes the pre-built graph model through, and falls back to an empty one", async () => {
		const provided = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "graph",
					scope: { kind: "all" },
					timeZone: "UTC",
					nowMs: 0,
					graphModel: { repos: [{ kb: "r", repoName: "r", graphAvailable: false }] },
				}),
			{ dbPath },
		);
		expect(provided.view).toBe("graph");
		expect(provided.graph?.repos).toHaveLength(1);

		const fallback = await withDashboardDb(
			(db) => buildDashboardModel(db, { view: "graph", scope: { kind: "all" }, timeZone: "UTC", nowMs: 0 }),
			{ dbPath },
		);
		expect(fallback.graph).toEqual({ repos: [] });
	});
});

describe("repo picker — checkouts that are gone", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jolli-dq-missing-"));
		dbPath = join(dir, "d.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** Rows straight into `repos`: the flag is about the path, not about events. */
	async function seedRepos(rows: ReadonlyArray<{ identity: string; root: string }>): Promise<void> {
		await withDashboardDb(
			(db) => {
				for (const { identity, root } of rows) {
					db.prepare(
						`INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at)
						 VALUES (?, 'r', ?, '1970-01-01T00:00:00.000Z')`,
					).run(identity, root);
				}
			},
			{ dbPath },
		);
	}

	async function repos(
		registryRoots?: ReadonlyMap<string, ReadonlyArray<string>>,
	): Promise<ReadonlyArray<{ repoIdentity: string; missing?: boolean; volumeUnavailable?: boolean }>> {
		const model = await withDashboardDb(
			(db) =>
				buildDashboardModel(db, {
					view: "stats",
					scope: { kind: "all" },
					timeZone: "UTC",
					nowMs: 0,
					...(registryRoots ? { registryRoots } : {}),
				}),
			{ dbPath },
		);
		return model.repos;
	}

	it("marks a row whose worktree is gone and leaves a live row's shape alone", async () => {
		await seedRepos([
			{ identity: "live", root: dir },
			{ identity: "gone", root: join(dir, "no-such-checkout") },
		]);

		const byIdentity = new Map((await repos()).map((r) => [r.repoIdentity, r]));

		// Absent, not `false`, on a live row — same contract as `disabled`.
		expect(byIdentity.get("live")?.missing).toBeUndefined();
		expect(byIdentity.get("gone")?.missing).toBe(true);
	});

	it("never marks the placeholder row an event creates before its repo registers", async () => {
		// `ensureRepoRow` stores the identity in `worktree_root`, which names no
		// directory. Marking it would put a remove control on a repo that is about
		// to register normally.
		await seedRepos([{ identity: "local:not-yet", root: "local:not-yet" }]);
		expect((await repos())[0].missing).toBeUndefined();
	});

	it("marks a row rather than dropping it — the memories stay reachable", async () => {
		await seedRepos([{ identity: "gone", root: join(dir, "no-such-checkout") }]);
		expect(await repos()).toHaveLength(1);
	});

	it("reuses the answer across renders, and re-asks once the memo is dropped", async () => {
		// This is the one filesystem call a render makes, and it is made per repo row
		// per HTTP request — so a repo on a disconnected mount would block every
		// refresh for as long as that mount takes to time out.
		const { clearWorktreeExistenceCache } = await import("./DashboardQuery.js");
		const checkout = join(dir, "checkout");
		mkdirSync(checkout, { recursive: true });
		await seedRepos([{ identity: "r", root: checkout }]);
		expect((await repos())[0].missing).toBeUndefined();

		rmSync(checkout, { recursive: true, force: true });

		// Still absent: the second render is served from the memo, which is exactly
		// what `handleForget` re-checks at action time rather than trusting.
		expect((await repos())[0].missing).toBeUndefined();

		clearWorktreeExistenceCache();
		expect((await repos())[0].missing).toBe(true);
	});

	it("does not mark a repo whose OTHER clone is still on disk", async () => {
		// `worktree_root` is projected from the registry entry's single
		// `worktreeRoot` field, but an entry is keyed by repo identity and can list
		// several clones. Judging the row alone renders a forget ✕ over a working
		// repository — which `handleForget` then refuses with a 409, so the control
		// was never actionable in the first place.
		const deadClone = join(dir, "deleted-clone");
		await seedRepos([{ identity: "two-clones", root: deadClone }]);

		expect((await repos())[0].missing).toBe(true);
		expect((await repos(new Map([["two-clones", [deadClone, dir]]])))[0].missing).toBeUndefined();
	});

	it("marks a registered repo when every recorded clone is gone", async () => {
		const roots = [join(dir, "clone-a"), join(dir, "clone-b")];
		await seedRepos([{ identity: "all-gone", root: roots[0] }]);
		expect((await repos(new Map([["all-gone", roots]])))[0].missing).toBe(true);
	});

	it("marks a placeholder row the registry lists with no surviving clone", async () => {
		// The opposite direction from the placeholder case above, and deliberately so:
		// an identity the registry lists IS registered, so it is not "about to
		// register normally" — the registry is the writer and the row its projection,
		// so the row can only be staler.
		await seedRepos([{ identity: "local:registered", root: "local:registered" }]);
		expect((await repos(new Map([["local:registered", [join(dir, "clone")]]])))[0].missing).toBe(true);
	});

	it("says the VOLUME is absent rather than claiming the folder was deleted", async () => {
		// `existsSync` answers false for both, so without this the row asserted a
		// deletion over a repository that was merely unplugged — and offered a ✕ on it.
		const onAbsentDrive = join(dir, "unmounted", "repo");
		await seedRepos([{ identity: "unplugged", root: onAbsentDrive }]);
		vi.mocked(volumeReachable).mockReturnValueOnce(false);

		const [option] = await repos();
		expect(option.missing).toBe(true);
		expect(option.volumeUnavailable).toBe(true);
	});

	it("calls it a deletion when ANY recorded path is on a volume it can reach", async () => {
		// Same rule as `classifyRegistryEntry`: one path gone from a disk that IS here
		// is a deletion, whatever the other paths are on. Only the first probe answers
		// unreachable, so the second falls through to the real walk.
		const onAbsentDrive = join(dir, "unmounted", "repo");
		const deletedLocally = join(dir, "deleted-locally");
		await seedRepos([{ identity: "mixed", root: onAbsentDrive }]);
		vi.mocked(volumeReachable).mockReturnValueOnce(false);

		const [option] = await repos(new Map([["mixed", [onAbsentDrive, deletedLocally]]]));
		expect(option.missing).toBe(true);
		expect(option.volumeUnavailable).toBeUndefined();
	});

	it("asks the filesystem nothing about the volume for a repo that is present", async () => {
		// The walk is one `existsSync` per ancestor and this is the render path, so it
		// must stay off it for the ordinary row — which is every row on a healthy machine.
		await seedRepos([{ identity: "live", root: dir }]);
		vi.mocked(volumeReachable).mockClear();

		expect((await repos())[0].missing).toBeUndefined();
		expect(volumeReachable).not.toHaveBeenCalled();
	});

	it("falls back to the row for an identity the registry does not list", async () => {
		// A row projected from an event before its repo registered has no entry at
		// all, so an empty answer for it must not read as "no live clone".
		const gone = join(dir, "unregistered");
		await seedRepos([{ identity: "orphan", root: gone }]);
		const other = new Map([["someone-else", [dir]]]);
		expect((await repos(other))[0].missing).toBe(true);
		expect((await repos(new Map([["orphan", []]])))[0].missing).toBe(true);
	});
});
