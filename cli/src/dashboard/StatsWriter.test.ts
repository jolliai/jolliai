import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogLevel, TranscriptSource } from "../Types.js";
import type { DashboardDbHandle } from "./DashboardDb.js";
import { withDashboardDb } from "./DashboardDb.js";
import type {
	CommitCreatedEvent,
	CommitSummaryEvent,
	SessionUpsertedEvent,
	StatsEventEnvelope,
	WorktreeStatusEvent,
} from "./DashboardModel.js";
import { STATS_EVENT_SCHEMA_VERSION } from "./DashboardModel.js";
import {
	applyStatsEvents,
	countStuckEvents,
	drainPending,
	observeWorktree,
	pruneProjectedEvents,
	unparkStuckEvents,
} from "./StatsWriter.js";

vi.mock("../core/GitOps.js", () => ({
	execGit: vi.fn(),
}));

/**
 * The `tag` a caller hands {@link pruneProjectedEvents} is a diagnostic contract, not
 * decoration: the daemon's 30-second re-scan promises that one `grep AgentScan` returns
 * everything that pass emitted. So what reaches the log is behaviour here.
 *
 * Rendered through the REAL formatter rather than by concatenating the format string with
 * its args. The tag arrives as a `%s`, so an un-interpolated capture would pass just as
 * happily if the argument were dropped — which is the exact regression this pins.
 */
const { logLines } = vi.hoisted(() => ({ logLines: [] as Array<{ level: string; text: string }> }));

vi.mock("../Logger.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../Logger.js")>();
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

import { execGit } from "../core/GitOps.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-statsw-"));
	dbPath = join(dir, "dashboard.db");
	logLines.length = 0;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const envelope = (
	event: SessionUpsertedEvent | CommitCreatedEvent | CommitSummaryEvent | WorktreeStatusEvent,
): StatsEventEnvelope => ({
	event,
	producerKind: "cli",
});

const session = (over: Partial<SessionUpsertedEvent> = {}): SessionUpsertedEvent => ({
	type: "session.upserted",
	repoIdentity: "repo-1",
	source: "claude",
	sessionId: "s1",
	updatedAtMs: 1_700_000_000_000,
	messageCount: 4,
	models: [
		{
			model: "claude-opus-5",
			provider: "anthropic",
			inputTokens: 100,
			outputTokens: 50,
			cachedTokens: 25,
			estCostUsd: 0.5,
		},
	],
	tokenCoverage: "full",
	...over,
});

const commit = (over: Partial<CommitCreatedEvent> = {}): CommitCreatedEvent => ({
	type: "commit.created",
	repoIdentity: "repo-1",
	hash: "abc123",
	committedAtMs: 1_700_000_100_000,
	message: "feat: something",
	branches: ["main"],
	...over,
});

async function query<T>(sql: string, ...params: unknown[]): Promise<T[]> {
	return withDashboardDb((db) => db.prepare(sql).all(...params) as T[], { dbPath });
}

describe("applyStatsEvents — projection", () => {
	it("projects a session with its model split and totals derived from it", async () => {
		const result = await applyStatsEvents([envelope(session())], { producerKind: "cli", dbPath });
		expect(result).toEqual({ accepted: 1, projected: 1, pending: 0 });

		const rows = await query<{
			input_tokens: number;
			output_tokens: number;
			cached_tokens: number;
			model: string;
			token_coverage: string;
		}>("SELECT input_tokens, output_tokens, cached_tokens, model, token_coverage FROM sessions");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			input_tokens: 100,
			output_tokens: 50,
			cached_tokens: 25,
			model: "claude-opus-5",
			token_coverage: "full",
		});
		const usage = await query<{ model: string; input_tokens: number }>(
			"SELECT model, input_tokens FROM session_model_usage",
		);
		expect(usage).toEqual([{ model: "claude-opus-5", input_tokens: 100 }]);
	});

	it("is idempotent — the same event twice leaves one row and one set of tokens", async () => {
		await applyStatsEvents([envelope(session())], { producerKind: "cli", dbPath });
		await applyStatsEvents([envelope(session())], { producerKind: "cli", dbPath });
		// Upserted, not appended: a replay cannot double-count. Asserted on the
		// detail row itself now that nothing stores a derived copy of it — which
		// is also why a replay can no longer disagree with an aggregate.
		const totals = await query<{ n: number; input_tokens: number }>(
			`SELECT COUNT(*) AS n, COALESCE(SUM(s.input_tokens), 0) AS input_tokens
			   FROM sessions s JOIN repos r ON r.id = s.repo_id
			  WHERE r.repo_identity = 'repo-1'`,
		);
		expect(totals[0]).toEqual({ n: 1, input_tokens: 100 });
	});

	it("replaces the model split wholesale on re-upsert", async () => {
		await applyStatsEvents([envelope(session())], { producerKind: "cli", dbPath });
		await applyStatsEvents(
			[
				envelope(
					session({
						models: [
							{
								model: "claude-haiku-4-5",
								provider: "anthropic",
								inputTokens: 10,
								outputTokens: 5,
								cachedTokens: 0,
							},
						],
					}),
				),
			],
			{ producerKind: "cli", dbPath },
		);
		const usage = await query<{ model: string }>("SELECT model FROM session_model_usage");
		expect(usage).toEqual([{ model: "claude-haiku-4-5" }]);
	});

	it("falls back to scalar token fields when no model split is present", async () => {
		await applyStatsEvents(
			[envelope(session({ models: [], inputTokens: 7, outputTokens: 3, cachedTokens: 1, estCostUsd: 0.1 }))],
			{ producerKind: "cli", dbPath },
		);
		const rows = await query<{ input_tokens: number; est_cost_usd: number }>(
			"SELECT input_tokens, est_cost_usd FROM sessions",
		);
		expect(rows[0]).toEqual({ input_tokens: 7, est_cost_usd: 0.1 });
	});

	it("keeps the model split when a usage-less re-read sends models: []", async () => {
		await applyStatsEvents([envelope(session())], { producerKind: "cli", dbPath });
		const before = await query<{ n: number }>("SELECT COUNT(*) AS n FROM session_model_usage");
		expect(before[0].n).toBeGreaterThan(0);
		// `models: []` with no scalar token fields is "tokens unobserved", the
		// same shape the carry-forward above recognises. Deleting the split on it
		// left the session reporting tokens in the KPI row while the model
		// dimension reported none — the orphaned state this guard exists for.
		await applyStatsEvents([envelope(session({ models: [] }))], { producerKind: "cli", dbPath });
		expect(await query<{ n: number }>("SELECT COUNT(*) AS n FROM session_model_usage")).toEqual(before);
		expect(await query<{ input_tokens: number }>("SELECT input_tokens FROM sessions")).toEqual([
			{ input_tokens: 100 },
		]);
	});

	it("leaves session cost NULL when no model carries an estimate and the event has none", async () => {
		await applyStatsEvents(
			[
				envelope(
					session({
						models: [
							{
								model: "unpriced",
								provider: "unknown",
								inputTokens: 5,
								outputTokens: 5,
								cachedTokens: 0,
							},
						],
					}),
				),
			],
			{ producerKind: "cli", dbPath },
		);
		const rows = await query<{ est_cost_usd: number | null; input_tokens: number }>(
			"SELECT est_cost_usd, input_tokens FROM sessions",
		);
		expect(rows[0]).toEqual({ est_cost_usd: null, input_tokens: 5 });
	});

	it("projects a commit and replaces its branch set", async () => {
		await applyStatsEvents([envelope(commit())], { producerKind: "cli", dbPath });
		await applyStatsEvents([envelope(commit({ branches: ["feature/x"] }))], { producerKind: "cli", dbPath });
		const branches = await query<{ branch: string }>(
			"SELECT b.name AS branch FROM commit_branches cb JOIN branches b ON b.id = cb.branch_id",
		);
		expect(branches).toEqual([{ branch: "feature/x" }]);
		const commits = await query<{ n: number }>("SELECT COUNT(*) AS n FROM commits");
		expect(commits[0].n).toBe(1);
	});

	it("keeps existing branch links when the event does not carry a branch set", async () => {
		await applyStatsEvents([envelope(commit())], { producerKind: "cli", dbPath });
		const noBranches = commit();
		const { branches: _dropped, ...rest } = noBranches;
		await applyStatsEvents([envelope(rest as CommitCreatedEvent)], { producerKind: "cli", dbPath });
		const branches = await query<{ branch: string }>(
			"SELECT b.name AS branch FROM commit_branches cb JOIN branches b ON b.id = cb.branch_id",
		);
		expect(branches).toEqual([{ branch: "main" }]);
	});

	it("projects worktree status latest-wins per branch, with '' for detached HEAD", async () => {
		const status: WorktreeStatusEvent = {
			type: "worktree.status",
			repoIdentity: "repo-1",
			filesChanged: 3,
			insertions: 10,
			deletions: 2,
			observedAtMs: 1_700_000_000_000,
		};
		await applyStatsEvents([envelope(status)], { producerKind: "cli", dbPath });
		await applyStatsEvents([envelope({ ...status, filesChanged: 5, observedAtMs: 1_700_000_060_000 })], {
			producerKind: "cli",
			dbPath,
		});
		const rows = await query<{ branch_key: string; files_changed: number }>(
			"SELECT branch_key, files_changed FROM worktree_status",
		);
		expect(rows).toEqual([{ branch_key: "", files_changed: 5 }]);
	});

	it("projects repo.enabled and repo.disabled, and re-enable clears disabled_at", async () => {
		const enabled = {
			type: "repo.enabled" as const,
			repoIdentity: "repo-1",
			repoName: "jolli",
			worktreeRoot: "/w",
			enabledAt: "2026-01-01T00:00:00Z",
		};
		await applyStatsEvents([{ event: enabled, producerKind: "cli" }], { producerKind: "cli", dbPath });
		await applyStatsEvents(
			[
				{
					event: { type: "repo.disabled", repoIdentity: "repo-1", disabledAt: "2026-02-01T00:00:00Z" },
					producerKind: "cli",
				},
			],
			{ producerKind: "cli", dbPath },
		);
		let rows = await query<{ disabled_at: string | null }>("SELECT disabled_at FROM repos");
		expect(rows[0].disabled_at).toBe("2026-02-01T00:00:00Z");
		await applyStatsEvents([{ event: enabled, producerKind: "cli" }], { producerKind: "cli", dbPath });
		rows = await query<{ disabled_at: string | null }>("SELECT disabled_at FROM repos");
		expect(rows[0].disabled_at).toBeNull();
	});

	it("upgrades a placeholder repo row when the registry projection arrives later", async () => {
		await applyStatsEvents([envelope(session())], { producerKind: "cli", dbPath });
		let rows = await query<{ repo_name: string }>("SELECT repo_name FROM repos");
		expect(rows[0].repo_name).toBe("repo-1"); // placeholder = identity
		await applyStatsEvents(
			[
				{
					event: {
						type: "repo.enabled",
						repoIdentity: "repo-1",
						repoName: "jolli",
						worktreeRoot: "/w",
						enabledAt: "t",
					},
					producerKind: "cli",
				},
			],
			{ producerKind: "cli", dbPath },
		);
		rows = await query<{ repo_name: string }>("SELECT repo_name FROM repos");
		expect(rows[0].repo_name).toBe("jolli");
	});

	it("lands sessions and commits on the same repo, spanning both timestamps", async () => {
		// Was an assertion on a stored activity span; the span is gone with the
		// aggregate, so what is left to pin is that both event kinds project onto
		// the one repo with their own timestamps intact — which is what any
		// read-time span is now derived from.
		await applyStatsEvents([envelope(session()), envelope(commit())], { producerKind: "cli", dbPath });
		const span = await query<{ first_ms: number; last_ms: number; commits: number }>(
			`SELECT (SELECT MIN(updated_at_ms) FROM sessions) AS first_ms,
			        (SELECT MAX(committed_at_ms) FROM commits) AS last_ms,
			        (SELECT COUNT(*) FROM commits) AS commits`,
		);
		expect(span[0]).toEqual({
			first_ms: 1_700_000_000_000,
			last_ms: 1_700_000_100_000,
			commits: 1,
		});
	});
});

describe("write-ahead log", () => {
	it("marks accepted events projected in events_raw", async () => {
		await applyStatsEvents([envelope(session())], { producerKind: "cli", dbPath });
		const rows = await query<{ projection_status: string; type: string }>(
			"SELECT projection_status, type FROM events_raw",
		);
		expect(rows).toEqual([{ projection_status: "projected", type: "session.upserted" }]);
	});

	it("drains rows a crashed writer left pending — the recovery contract", async () => {
		// Simulate the crash window: Tx1 committed (pending row durable), Tx2 never ran.
		await withDashboardDb(
			(db) => {
				db.prepare(
					`INSERT INTO events_raw (event_id, repo_identity, type, schema_version, received_at, data_json)
				 VALUES (?, ?, 'session.upserted', ?, 't', ?)`,
				).run("session:repo-1:claude:s1", "repo-1", STATS_EVENT_SCHEMA_VERSION, JSON.stringify(session()));
			},
			{ dbPath },
		);

		// The next writer (here: an empty batch) picks it up.
		const result = await applyStatsEvents([], { producerKind: "cli", dbPath });
		expect(result.projected).toBe(1);
		const sessions = await query<{ n: number }>("SELECT COUNT(*) AS n FROM sessions");
		expect(sessions[0].n).toBe(1);
	});

	it("parks events from a newer producer as pending instead of dropping them", async () => {
		await withDashboardDb(
			(db) => {
				db.prepare(
					`INSERT INTO events_raw (event_id, type, schema_version, received_at, data_json)
				 VALUES ('e', 'session.upserted', ?, 't', '{}')`,
				).run(STATS_EVENT_SCHEMA_VERSION + 1);
			},
			{ dbPath },
		);
		const result = await applyStatsEvents([], { producerKind: "cli", dbPath });
		// pending: 0, not 1 — the row is parked in the table (asserted below) but
		// is not part of the backlog this build can ever work off, and `pending` is
		// a cursor gate rather than a table census. See the head-of-line test.
		expect(result).toMatchObject({ projected: 0, pending: 0 });
		const rows = await query<{ projection_status: string; attempts: number }>(
			"SELECT projection_status, attempts FROM events_raw",
		);
		// Untouched: no attempt burned on an event this build cannot understand.
		expect(rows).toEqual([{ projection_status: "pending", attempts: 0 }]);
	});

	it("reports the rows the claim LIMIT never reached as pending", async () => {
		// `DbBackfill.applyBatches` refuses to advance the summaries cursor while
		// anything is unprojected, so `pending` has to mean exactly that. The
		// tally it replaces counted only future-schema rows plus this pass's own
		// failures — so a first tick with more sessions than one batch reported a
		// clean drain over hundreds of events that were still waiting.
		await withDashboardDb(
			(db) => {
				for (let i = 0; i < 505; i++) {
					db.prepare(
						`INSERT INTO events_raw (event_id, repo_identity, type, schema_version, received_at, data_json)
					 VALUES (?, 'repo-1', 'session.upserted', ?, 't', ?)`,
					).run(
						`session:repo-1:claude:s${i}`,
						STATS_EVENT_SCHEMA_VERSION,
						JSON.stringify(session({ sessionId: `s${i}` })),
					);
				}
			},
			{ dbPath },
		);
		const result = await applyStatsEvents([], { producerKind: "cli", dbPath });
		expect(result.projected).toBe(500);
		expect(result.pending).toBe(5);
	});

	it("scopes pending to the repos the caller is reporting on", async () => {
		// `events_raw` is machine-global but the caller's gate is per-repo:
		// `DbBackfill` asks "may I advance repo-1's summaries cursor?". Counting
		// another repo's in-flight rows answers a question nobody asked and holds
		// repo-1 back for a reason repo-1 cannot act on. Unlike the future-schema
		// case this one is self-healing, so it is scoped rather than an error.
		await withDashboardDb(
			(db) => {
				const insert = db.prepare(
					`INSERT INTO events_raw (event_id, repo_identity, type, schema_version, received_at, data_json)
					 VALUES (?, ?, 'session.upserted', ?, 't', ?)`,
				);
				// repo-1's own row goes in FIRST: the claim is `ORDER BY seq LIMIT n`,
				// so seeding it behind repo-2's overflow would leave it genuinely
				// undrained and `pending: 1` would be the right answer for the wrong
				// reason — the assertion has to fail only when the SCOPE is missing.
				insert.run(
					"session:repo-1:claude:mine",
					"repo-1",
					STATS_EVENT_SCHEMA_VERSION,
					JSON.stringify(session({ sessionId: "mine" })),
				);
				for (let i = 0; i < 505; i++) {
					insert.run(
						`session:repo-2:claude:o${i}`,
						"repo-2",
						STATS_EVENT_SCHEMA_VERSION,
						JSON.stringify(session({ repoIdentity: "repo-2", sessionId: `o${i}` })),
					);
				}
			},
			{ dbPath },
		);
		// One drain: 500 rows claimed — repo-1's, plus 499 of repo-2's. repo-2 is
		// left with 6 undrained, which are none of repo-1's business.
		const scoped = await withDashboardDb((db) => drainPending(db, { pendingScope: ["repo-1"] }), { dbPath });
		expect(scoped.projected).toBe(500);
		expect(scoped.pending).toBe(0);
		// Asserted against the table, not a second drain: re-running the drain to
		// prove the backlog exists would consume it, and `pending: 0` above would
		// then pass for the trivial reason that nothing was left either way. The
		// empty-scope fallback to a global count is covered by the LIMIT test.
		expect(
			await query<{ n: number }>(
				"SELECT COUNT(*) AS n FROM events_raw WHERE projection_status = 'pending' AND repo_identity = 'repo-2'",
			),
		).toEqual([{ n: 6 }]);
	});

	it("un-parks an unknown-type event once a build that understands it drains", async () => {
		// The promise `projectEvent`'s default throw makes — "the event survives
		// for a build that understands it" — was not kept: the claim selects
		// 'pending' and nothing reset 'failed'. Only THAT reason is revivable; a
		// genuinely defective event must stay parked rather than burn its attempt
		// budget again on every drain.
		await withDashboardDb(
			(db) => {
				db.prepare(
					`INSERT INTO events_raw (event_id, type, schema_version, received_at, data_json)
				 VALUES ('future', 'commit.vibes', ?, 't', '{"type":"commit.vibes"}')`,
				).run(STATS_EVENT_SCHEMA_VERSION);
				db.prepare(
					`INSERT INTO events_raw (event_id, type, schema_version, received_at, data_json)
				 VALUES ('bad', 'session.upserted', ?, 't', 'not json')`,
				).run(STATS_EVENT_SCHEMA_VERSION);
			},
			{ dbPath },
		);
		for (let i = 0; i < 5; i++) await applyStatsEvents([], { producerKind: "cli", dbPath });
		expect(
			await query<{ event_id: string; failed_kind: string | null }>(
				"SELECT event_id, failed_kind FROM events_raw WHERE projection_status = 'failed' ORDER BY event_id",
			),
		).toEqual([
			{ event_id: "bad", failed_kind: "error" },
			{ event_id: "future", failed_kind: "unknown-type" },
		]);

		// Now this build knows the type: the row returns to the queue, attempts
		// reset. The defective one is untouched.
		await withDashboardDb(
			(db) => db.prepare("UPDATE events_raw SET type = 'session.upserted' WHERE event_id = 'future'").run(),
			{ dbPath },
		);
		await withDashboardDb(
			(db) =>
				db
					.prepare("UPDATE events_raw SET data_json = ? WHERE event_id = 'future'")
					.run(JSON.stringify(session())),
			{ dbPath },
		);
		const result = await applyStatsEvents([], { producerKind: "cli", dbPath });
		expect(result.projected).toBe(1);
		expect(await query("SELECT event_id FROM events_raw WHERE projection_status = 'failed'")).toEqual([
			{ event_id: "bad" },
		]);
	});

	it("leaves a pre-migration parked row alone rather than reviving it on a guess", async () => {
		// The other half of the COALESCE in `REVIVABLE_PREDICATE`. `failed_kind` arrived in a
		// migration, so a row parked by an older build carries NULL — no recorded reason at
		// all. The drain must not treat that as `unknown-type`: it would reset the attempt
		// budget of a row that may be genuinely defective, on every writable open, forever.
		// `COALESCE(failed_kind, '')` yields `''`, which matches nothing, so the row stays
		// parked — and the count is what has to surface it instead.
		await withDashboardDb(
			(db) => {
				db.prepare(
					`INSERT INTO events_raw (event_id, type, schema_version, received_at, data_json,
					                         projection_status, attempts, failed_kind)
				 VALUES ('legacy', 'session.upserted', ?, 't', ?, 'failed', 5, NULL)`,
				).run(STATS_EVENT_SCHEMA_VERSION, JSON.stringify(session()));
			},
			{ dbPath },
		);

		await applyStatsEvents([], { producerKind: "cli", dbPath });

		// Not revived: still failed, attempts untouched. A projectable `data_json` is used
		// deliberately — if the drain HAD claimed it the row would have projected and left
		// 'failed', so a defective payload could not tell the two outcomes apart.
		expect(
			await query<{ projection_status: string; attempts: number }>(
				"SELECT projection_status, attempts FROM events_raw WHERE event_id = 'legacy'",
			),
		).toEqual([{ projection_status: "failed", attempts: 5 }]);
	});

	it("poison-pills an event that keeps failing, without blocking the rest", async () => {
		await withDashboardDb(
			(db) => {
				db.prepare(
					`INSERT INTO events_raw (event_id, type, schema_version, received_at, data_json)
				 VALUES ('bad', 'session.upserted', ?, 't', 'not json')`,
				).run(STATS_EVENT_SCHEMA_VERSION);
			},
			{ dbPath },
		);
		// Five drains: the row burns its attempts and lands on 'failed'.
		for (let i = 0; i < 5; i++) await applyStatsEvents([], { producerKind: "cli", dbPath });
		const rows = await query<{ projection_status: string; attempts: number }>(
			"SELECT projection_status, attempts FROM events_raw",
		);
		expect(rows).toEqual([{ projection_status: "failed", attempts: 5 }]);
		// A good event still projects.
		const result = await applyStatsEvents([envelope(session())], { producerKind: "cli", dbPath });
		expect(result.projected).toBe(1);
	});

	it("parks an event type it has no projection for instead of marking it projected", async () => {
		// The switch had no default, so an unknown type fell straight through, was
		// stamped 'projected', and `pruneProjectedEvents` deleted it 14 days later.
		// That is the version-skew loss the WAL exists to prevent — `schema_version`
		// gates payload CHANGES and cannot gate a NEW type. Parking keeps the bytes
		// (only 'projected' is prunable) and logs loudly, so a build that understands
		// the type can still be the one to read it.
		await withDashboardDb(
			(db) => {
				db.prepare(
					`INSERT INTO events_raw (event_id, type, schema_version, received_at, data_json)
				 VALUES ('future', 'commit.vibes', ?, 't', '{"type":"commit.vibes"}')`,
				).run(STATS_EVENT_SCHEMA_VERSION);
			},
			{ dbPath },
		);
		for (let i = 0; i < 5; i++) await applyStatsEvents([], { producerKind: "cli", dbPath });

		expect(await query("SELECT projection_status FROM events_raw")).toEqual([{ projection_status: "failed" }]);
		// Retention only ever deletes 'projected', so the payload survives.
		const { pruneProjectedEvents } = await import("./StatsWriter.js");
		await withDashboardDb((db) => pruneProjectedEvents(db, () => Date.parse("2099-01-01")), { dbPath });
		expect(await query("SELECT event_id FROM events_raw")).toEqual([{ event_id: "future" }]);
	});

	it("records provenance on the raw rows", async () => {
		await applyStatsEvents(
			[
				{
					event: session(),
					producerKind: "stop-hook",
					producerVersion: "1.2.3",
					occurredAtMs: 1_700_000_000_000,
				},
			],
			{
				producerKind: "cli",
				dbPath,
				now: () => 1_700_000_005_000,
			},
		);
		const rows = await query<{
			producer_kind: string;
			producer_version: string;
			occurred_at: string;
			received_at: string;
		}>("SELECT producer_kind, producer_version, occurred_at, received_at FROM events_raw");
		expect(rows[0]).toEqual({
			producer_kind: "stop-hook",
			producer_version: "1.2.3",
			occurred_at: "2023-11-14T22:13:20.000Z",
			received_at: "2023-11-14T22:13:25.000Z",
		});
	});

	it("drainPending on an empty queue is a no-op", async () => {
		const result = await withDashboardDb((db) => drainPending(db), { dbPath });
		expect(result).toEqual({ projected: 0, pending: 0 });
	});

	it("future-schema rows do not head-of-line block an older build's own rows", async () => {
		// Supported version skew: a newer VS Code build writes events this CLI
		// cannot project. They must stay pending — but the claim is
		// `ORDER BY seq LIMIT n`, so if they are merely SKIPPED inside the loop,
		// a batch's worth of them at the head means the old build never reaches
		// its own rows and its projections stall silently.
		await withDashboardDb(
			(db) => {
				const insert = db.prepare(
					`INSERT INTO events_raw (event_id, repo_identity, type, schema_version, producer_kind,
					                         received_at, data_json, projection_status)
					 VALUES (?, ?, ?, ?, 'vscode', '2026-08-01T00:00:00.000Z', ?, 'pending')`,
				);
				for (let i = 0; i < 600; i++) {
					insert.run(
						`future-${i}`,
						"repo-1",
						"session.upserted",
						99,
						JSON.stringify({ type: "from-future" }),
					);
				}
				// Behind that wall, one ordinary event this build understands.
				// Written raw (not via applyStatsEvents, which projects inline) so
				// it is genuinely queued behind the future rows.
				insert.run(
					"ours-1",
					"repo-1",
					"session.upserted",
					STATS_EVENT_SCHEMA_VERSION,
					JSON.stringify(session()),
				);
			},
			{ dbPath },
		);

		const result = await withDashboardDb((db) => drainPending(db), { dbPath });
		expect(result.projected).toBe(1);
		// Reported as a CLEAR backlog even though 600 rows are still pending in the
		// table. `pending` gates `DbBackfill`'s summaries cursor, and a future-schema
		// row can never be claimed by this build — `attempts` stays 0, so it never
		// ages out either. Counting it stalls that cursor permanently, for every
		// repo, and each pass then re-collects the whole index. The rows staying
		// parked is asserted below; that is the "deferred, never dropped" promise.
		expect(result.pending).toBe(0);
		const rows = await withDashboardDb(
			(db) =>
				db
					.prepare("SELECT projection_status, COUNT(*) AS n FROM events_raw GROUP BY projection_status")
					.all() as Array<{ projection_status: string; n: number }>,
			{ dbPath },
		);
		expect(rows).toEqual([
			{ projection_status: "pending", n: 600 },
			{ projection_status: "projected", n: 1 },
		]);
	});
});

describe("observeWorktree", () => {
	it("parses shortstat into a worktree.status event", async () => {
		vi.mocked(execGit).mockResolvedValue({
			stdout: " 6 files changed, 184 insertions(+), 22 deletions(-)\n",
			stderr: "",
			exitCode: 0,
		});
		const event = await observeWorktree("repo-1", "/w", "main", () => 42);
		expect(event).toEqual({
			type: "worktree.status",
			repoIdentity: "repo-1",
			branch: "main",
			filesChanged: 6,
			insertions: 184,
			deletions: 22,
			observedAtMs: 42,
		});
	});

	it("reports a clean tree as zeros and omits the branch when detached", async () => {
		vi.mocked(execGit).mockResolvedValue({ stdout: "\n", stderr: "", exitCode: 0 });
		const event = await observeWorktree("repo-1", "/w", undefined, () => 42);
		expect(event).toMatchObject({ filesChanged: 0, insertions: 0, deletions: 0 });
		expect(event).not.toHaveProperty("branch");
	});

	it("returns null when git fails (e.g. a repo with no commits)", async () => {
		vi.mocked(execGit).mockResolvedValue({ stdout: "", stderr: "fatal: bad revision 'HEAD'", exitCode: 128 });
		expect(await observeWorktree("repo-1", "/w", "main")).toBeNull();
	});
});

describe("session_tool_use projection", () => {
	const sessionEvent = (over: Record<string, unknown> = {}) =>
		({
			event: {
				type: "session.upserted" as const,
				repoIdentity: "repo-1",
				source: "claude" as const,
				sessionId: "s1",
				updatedAtMs: 1_700_000_000_000,
				...over,
			},
			producerKind: "cli" as const,
		}) as StatsEventEnvelope;

	const tools = async () =>
		withDashboardDb(
			(db) =>
				db
					.prepare("SELECT tool_name, kind, server, calls FROM session_tool_use ORDER BY kind, tool_name")
					.all() as Array<Record<string, unknown>>,
			{ dbPath },
		);

	it("keeps a skill and a builtin of the same name apart", async () => {
		// The PK carries `kind` precisely so these two do not collide into one row.
		await applyStatsEvents(
			[
				sessionEvent({
					tools: [
						{ name: "review", kind: "builtin", calls: 1 },
						{ name: "review", kind: "skill", calls: 4 },
					],
				}),
			],
			{ producerKind: "cli", dbPath },
		);
		expect(await tools()).toEqual([
			{ tool_name: "review", kind: "builtin", server: null, calls: 1 },
			{ tool_name: "review", kind: "skill", server: null, calls: 4 },
		]);
	});

	it("REPLACES the set on re-read rather than accumulating counts", async () => {
		await applyStatsEvents([sessionEvent({ tools: [{ name: "Bash", kind: "builtin", calls: 3 }] })], {
			producerKind: "cli",
			dbPath,
		});
		// A fuller re-read of the same transcript reports the total, not a delta.
		await applyStatsEvents([sessionEvent({ tools: [{ name: "Bash", kind: "builtin", calls: 5 }] })], {
			producerKind: "cli",
			dbPath,
		});
		expect(await tools()).toEqual([{ tool_name: "Bash", kind: "builtin", server: null, calls: 5 }]);
	});

	it("leaves rows alone when tools are absent — a tool-blind producer must not erase them", async () => {
		await applyStatsEvents([sessionEvent({ tools: [{ name: "Bash", kind: "builtin", calls: 3 }] })], {
			producerKind: "cli",
			dbPath,
		});
		await applyStatsEvents([sessionEvent({ title: "renamed" })], { producerKind: "cli", dbPath });
		expect(await tools()).toEqual([{ tool_name: "Bash", kind: "builtin", server: null, calls: 3 }]);
	});

	it("stores an empty set as empty — the session really called nothing", async () => {
		await applyStatsEvents([sessionEvent({ tools: [{ name: "Bash", kind: "builtin", calls: 3 }] })], {
			producerKind: "cli",
			dbPath,
		});
		await applyStatsEvents([sessionEvent({ tools: [] })], { producerKind: "cli", dbPath });
		expect(await tools()).toEqual([]);
	});
});

describe("session_activity projection", () => {
	const readBuckets = (db: DashboardDbHandle) =>
		(
			db.prepare("SELECT bucket_ms FROM session_activity ORDER BY bucket_ms").all() as ReadonlyArray<{
				bucket_ms: number;
			}>
		).map((r) => r.bucket_ms);

	const readRows = (db: DashboardDbHandle) =>
		db.prepare("SELECT bucket_ms, recorded_at_ms FROM session_activity ORDER BY bucket_ms").all() as ReadonlyArray<{
			bucket_ms: number;
			recorded_at_ms: number;
		}>;

	it("stores one row per bucket and KEEPS ones a later read no longer sees", async () => {
		await applyStatsEvents([envelope(session({ activityBuckets: [1_700_000_000_000, 1_700_000_900_000] }))], {
			producerKind: "cli",
			dbPath,
		});
		await withDashboardDb(
			(db) => {
				expect(readBuckets(db)).toEqual([1_700_000_000_000, 1_700_000_900_000]);
			},
			{ dbPath },
		);

		// A truncating host, or Devin regenerating onto a different main chain,
		// makes a full re-read return a NON-superset. The developer was still
		// present in the dropped bucket and the transcript can no longer prove
		// it, so this table must not take the re-read's word for its absence.
		await applyStatsEvents([envelope(session({ activityBuckets: [1_700_000_000_000] }))], {
			producerKind: "cli",
			dbPath,
		});
		await withDashboardDb(
			(db) => {
				expect(readBuckets(db)).toEqual([1_700_000_000_000, 1_700_000_900_000]);
			},
			{ dbPath },
		);
	});

	it("stamps recorded_at_ms at insert and does not bump it on re-observation", async () => {
		await applyStatsEvents([envelope(session({ activityBuckets: [1_700_000_000_000] }))], {
			producerKind: "cli",
			dbPath,
			now: () => 5_000,
		});
		// The 60 s tick re-reads the same session and finds one further bucket.
		// Only the NEW row may carry the new instant — bumping the old one would
		// re-present already-synced history to a cursor reading this column.
		await applyStatsEvents([envelope(session({ activityBuckets: [1_700_000_000_000, 1_700_000_900_000] }))], {
			producerKind: "cli",
			dbPath,
			now: () => 9_000,
		});
		await withDashboardDb(
			(db) => {
				expect(readRows(db)).toEqual([
					{ bucket_ms: 1_700_000_000_000, recorded_at_ms: 5_000 },
					{ bucket_ms: 1_700_000_900_000, recorded_at_ms: 9_000 },
				]);
			},
			{ dbPath },
		);
	});

	it("leaves stored buckets alone when the field is ABSENT", async () => {
		await applyStatsEvents([envelope(session({ activityBuckets: [1_700_000_000_000] }))], {
			producerKind: "cli",
			dbPath,
		});
		// A producer that cannot see timestamps re-upserts the same session.
		await applyStatsEvents([envelope(session())], { producerKind: "cli", dbPath });
		await withDashboardDb(
			(db) => {
				expect(readBuckets(db)).toEqual([1_700_000_000_000]);
			},
			{ dbPath },
		);
	});

	// The inverse of what this asserted before insert-only. `[]` still MEANS
	// "observed, measured none" and stays distinct from absent everywhere else —
	// it just no longer authorises a delete, because "I saw none this time" is
	// not evidence that a bucket recorded earlier never happened.
	it("adds nothing and removes nothing when an observed read found none", async () => {
		await applyStatsEvents([envelope(session({ activityBuckets: [1_700_000_000_000] }))], {
			producerKind: "cli",
			dbPath,
		});
		await applyStatsEvents([envelope(session({ activityBuckets: [] }))], { producerKind: "cli", dbPath });
		await withDashboardDb(
			(db) => {
				expect(readBuckets(db)).toEqual([1_700_000_000_000]);
			},
			{ dbPath },
		);
	});
});

describe("skill_invocations projection", () => {
	/**
	 * Buckets are typed loosely and cast through `unknown` on purpose: two cases below
	 * build shapes no scanner produces — a builtin bucket carrying invocations, and an
	 * entry whose instant is unparseable — because those are exactly the inputs the
	 * writer's guards exist for, and a `ToolCallCount` literal cannot express them.
	 */
	const sessionEvent = (tools: ReadonlyArray<Record<string, unknown>>, source: TranscriptSource = "claude") =>
		({
			event: {
				type: "session.upserted" as const,
				repoIdentity: "repo-1",
				source,
				sessionId: "s1",
				updatedAtMs: 1_700_000_000_000,
				tools,
			},
			producerKind: "cli" as const,
		}) as unknown as StatsEventEnvelope;

	const invocations = async () =>
		query<Record<string, unknown>>(
			`SELECT skill_name, at_ms, ok, ok_confidence, detection, entry_path, args, body_chars
			   FROM skill_invocations ORDER BY at_ms`,
		);

	const skillBucket = (over: Record<string, unknown> = {}) => ({
		name: "code-review",
		kind: "skill",
		calls: 1,
		invocations: [{ at: "2026-08-01T10:00:00.000Z", ok: true, entryPath: "tool" }],
		...over,
	});

	it("writes one row per entry, with the outcome marked as READ for a mechanism that reports one", async () => {
		await applyStatsEvents([sessionEvent([skillBucket()])], { producerKind: "cli", dbPath });
		expect(await invocations()).toEqual([
			{
				skill_name: "code-review",
				at_ms: Date.parse("2026-08-01T10:00:00.000Z"),
				ok: 1,
				ok_confidence: "observed",
				detection: null,
				entry_path: "tool",
				args: null,
				body_chars: null,
			},
		]);
	});

	it("marks the outcome as DEFAULTED for a mechanism with no result record", async () => {
		// A slash command carries a hard-coded `ok: true` because failure is not knowable
		// there. The row keeps that assertion and says it was not read — which is what
		// stops the failure count treating it as a measured success.
		await applyStatsEvents(
			[
				sessionEvent([
					skillBucket({ invocations: [{ at: "2026-08-01T10:00:00.000Z", ok: true, entryPath: "command" }] }),
				]),
			],
			{ producerKind: "cli", dbPath },
		);
		expect(await invocations()).toMatchObject([{ ok: 1, ok_confidence: "assumed", entry_path: "command" }]);
	});

	it("marks an unresolved result-capable invocation as DEFAULTED", async () => {
		await applyStatsEvents(
			[
				sessionEvent([
					skillBucket({
						invocations: [
							{
								at: "2026-08-01T10:00:00.000Z",
								ok: true,
								entryPath: "tool",
								outcomeObserved: false,
							},
						],
					}),
				]),
			],
			{ producerKind: "cli", dbPath },
		);
		expect(await invocations()).toMatchObject([{ ok: 1, ok_confidence: "assumed", entry_path: "tool" }]);
	});

	it("copies the skill-level heuristic mark onto every one of its entries", async () => {
		await applyStatsEvents(
			[
				sessionEvent(
					[
						skillBucket({
							detection: "heuristic",
							invocations: [
								{ at: "2026-08-01T10:00:00.000Z", ok: true, entryPath: "tool" },
								{ at: "2026-08-01T11:00:00.000Z", ok: true, entryPath: "tool" },
							],
						}),
					],
					"codex",
				),
			],
			{ producerKind: "cli", dbPath },
		);
		expect(await invocations()).toMatchObject([
			{ detection: "heuristic", ok_confidence: "assumed" },
			{ detection: "heuristic", ok_confidence: "assumed" },
		]);
	});

	it("keeps args and the injected body size", async () => {
		await applyStatsEvents(
			[
				sessionEvent([
					skillBucket({
						invocations: [
							{
								at: "2026-08-01T10:00:00.000Z",
								ok: true,
								entryPath: "tool",
								args: "--changed",
								bodyChars: 3619,
							},
						],
					}),
				]),
			],
			{ producerKind: "cli", dbPath },
		);
		expect(await invocations()).toMatchObject([{ args: "--changed", body_chars: 3619 }]);
	});

	it("converges on the same row when the same entry is read again", async () => {
		// The producing scan is whole-conversation, so every pass re-reads every entry it
		// already saw. Keyed on the instant they land back on their own row.
		await applyStatsEvents([sessionEvent([skillBucket()])], { producerKind: "cli", dbPath });
		await applyStatsEvents([sessionEvent([skillBucket()])], { producerKind: "cli", dbPath });
		expect(await invocations()).toHaveLength(1);
	});

	it("corrects an optimistic outcome on the next read", async () => {
		// A window that closed mid-invocation reports `ok: true`; the re-read that sees the
		// result must be able to overwrite it, not be coalesced away.
		await applyStatsEvents(
			[
				sessionEvent([
					skillBucket({
						invocations: [
							{
								at: "2026-08-01T10:00:00.000Z",
								ok: true,
								entryPath: "tool",
								outcomeObserved: false,
							},
						],
					}),
				]),
			],
			{ producerKind: "cli", dbPath },
		);
		await applyStatsEvents(
			[
				sessionEvent([
					skillBucket({
						invocations: [
							{
								at: "2026-08-01T10:00:00.000Z",
								ok: false,
								entryPath: "tool",
								outcomeObserved: true,
							},
						],
					}),
				]),
			],
			{ producerKind: "cli", dbPath },
		);
		expect(await invocations()).toMatchObject([{ ok: 0, ok_confidence: "observed" }]);
	});

	it("does not let a later unresolved read downgrade an observed outcome", async () => {
		const at = "2026-08-01T10:00:00.000Z";
		await applyStatsEvents(
			[
				sessionEvent([
					skillBucket({
						invocations: [{ at, ok: false, entryPath: "tool", outcomeObserved: true }],
					}),
				]),
			],
			{ producerKind: "cli", dbPath },
		);
		await applyStatsEvents(
			[
				sessionEvent([
					skillBucket({
						invocations: [{ at, ok: true, entryPath: "tool", outcomeObserved: false }],
					}),
				]),
			],
			{ producerKind: "cli", dbPath },
		);
		expect(await invocations()).toMatchObject([{ ok: 0, ok_confidence: "observed" }]);
	});

	it("keeps a stored body size when a later read reports none", async () => {
		// COALESCE'd, unlike the outcome: both describe one fixed past event, and a pass
		// that read no body has nothing better to offer than what is already stored.
		await applyStatsEvents(
			[
				sessionEvent([
					skillBucket({
						invocations: [{ at: "2026-08-01T10:00:00.000Z", ok: true, entryPath: "tool", bodyChars: 3619 }],
					}),
				]),
			],
			{ producerKind: "cli", dbPath },
		);
		await applyStatsEvents([sessionEvent([skillBucket()])], { producerKind: "cli", dbPath });
		expect(await invocations()).toMatchObject([{ body_chars: 3619 }]);
	});

	it("does NOT delete rows the newer read no longer mentions", async () => {
		// A compacted conversation stops mentioning entries that did happen. The aggregate
		// is rebuilt; the detail is add-or-update, so the history survives.
		await applyStatsEvents(
			[
				sessionEvent([
					skillBucket({
						calls: 2,
						invocations: [
							{ at: "2026-08-01T10:00:00.000Z", ok: true, entryPath: "tool" },
							{ at: "2026-08-01T11:00:00.000Z", ok: true, entryPath: "tool" },
						],
					}),
				]),
			],
			{ producerKind: "cli", dbPath },
		);
		await applyStatsEvents(
			[
				sessionEvent([
					skillBucket({ invocations: [{ at: "2026-08-01T11:00:00.000Z", ok: true, entryPath: "tool" }] }),
				]),
			],
			{ producerKind: "cli", dbPath },
		);
		expect(await invocations()).toHaveLength(2);
	});

	it("skips an entry whose instant cannot be parsed — it could not key a row", async () => {
		// Kimi's converter yields "" for a malformed wire timestamp.
		await applyStatsEvents([sessionEvent([skillBucket({ invocations: [{ at: "", ok: true }] })])], {
			producerKind: "cli",
			dbPath,
		});
		expect(await invocations()).toEqual([]);
	});

	it("ignores invocations on a bucket that is not a skill", async () => {
		await applyStatsEvents(
			[
				sessionEvent([
					{
						name: "Bash",
						kind: "builtin",
						calls: 1,
						invocations: [{ at: "2026-08-01T10:00:00.000Z", ok: true, entryPath: "tool" }],
					},
				]),
			],
			{ producerKind: "cli", dbPath },
		);
		expect(await invocations()).toEqual([]);
	});

	it("stores the providing plugin on the aggregate row", async () => {
		await applyStatsEvents([sessionEvent([skillBucket({ plugin: "superpowers" })])], {
			producerKind: "cli",
			dbPath,
		});
		expect(
			await query<{ plugin: string | null }>("SELECT plugin FROM session_tool_use WHERE kind = 'skill'"),
		).toEqual([{ plugin: "superpowers" }]);
	});

	it("stores the skill's origin root — the only provenance a non-namespacing host has", async () => {
		// Cursor does not namespace plugin skills, so `plugin` is permanently NULL there
		// and the ROOT is the only thing separating a plugin-supplied skill from the
		// repo's own. Both columns exist because they answer different questions.
		await applyStatsEvents([sessionEvent([skillBucket({ originRoot: "plugin-bundle" })])], {
			producerKind: "cli",
			dbPath,
		});
		expect(
			await query<{ plugin: string | null; origin_root: string | null }>(
				"SELECT plugin, origin_root FROM session_tool_use WHERE kind = 'skill'",
			),
		).toEqual([{ plugin: null, origin_root: "plugin-bundle" }]);
	});

	it("lets a MOVED skill re-root itself, unlike a namespace", async () => {
		// A skill really does move between roots (a repo gains `.cursor/skills/` when
		// `.agents/skills/` stops supplying it) and the scanner already resolves that by
		// taking its newest observation — so an incoming value must WIN rather than be
		// coalesced away. Contrast the enrichment test below, where absence preserves.
		await applyStatsEvents([sessionEvent([skillBucket({ originRoot: "repo-agents" })])], {
			producerKind: "cli",
			dbPath,
		});
		await applyStatsEvents([sessionEvent([skillBucket({ originRoot: "repo-cursor" })])], {
			producerKind: "cli",
			dbPath,
		});
		expect(
			await query<{ origin_root: string | null }>(
				"SELECT origin_root FROM session_tool_use WHERE kind = 'skill'",
			),
		).toEqual([{ origin_root: "repo-cursor" }]);
	});

	it("keeps stored skill enrichment when a later read cannot reproduce it", async () => {
		await applyStatsEvents(
			[
				sessionEvent([
					skillBucket({
						plugin: "superpowers",
						lastCallAtMs: 1_754_041_600_000,
						usage: { input: 7, output: 11, cached: 5, confidence: "attributed" },
					}),
				]),
			],
			{
				producerKind: "cli",
				dbPath,
			},
		);
		await applyStatsEvents([sessionEvent([skillBucket()])], { producerKind: "cli", dbPath });
		expect(
			await query<Record<string, unknown>>(
				`SELECT last_call_at_ms, input_tokens, output_tokens, cached_tokens, usage_confidence, plugin,
				        origin_root
				   FROM session_tool_use WHERE kind = 'skill'`,
			),
		).toEqual([
			{
				last_call_at_ms: 1_754_041_600_000,
				input_tokens: 7,
				output_tokens: 11,
				cached_tokens: 5,
				usage_confidence: "attributed",
				plugin: "superpowers",
				origin_root: null,
			},
		]);
	});

	it("keeps a stored origin root when a later read reports none", async () => {
		// The other half of the rule above: "the incoming value wins" applies to a read
		// that HAS one. A pass that could not resolve a path at all (a slice with no
		// skill block in it) must not blank a root an earlier read established.
		await applyStatsEvents([sessionEvent([skillBucket({ originRoot: "repo-agents" })])], {
			producerKind: "cli",
			dbPath,
		});
		await applyStatsEvents([sessionEvent([skillBucket()])], { producerKind: "cli", dbPath });
		expect(
			await query<{ origin_root: string | null }>(
				"SELECT origin_root FROM session_tool_use WHERE kind = 'skill'",
			),
		).toEqual([{ origin_root: "repo-agents" }]);
	});

	it("coerces a fractional-millisecond lastCallAtMs to an integer without failing the projection", async () => {
		// Hermes' `messages.timestamp` is a REAL (float epoch seconds), so a reader
		// that multiplies by 1000 without rounding leaks a fractional millisecond into
		// `ToolCallCount.lastCallAtMs`. `session_tool_use.last_call_at_ms` is INTEGER,
		// which SQLite would reject with "cannot store REAL value in INTEGER column",
		// taking the whole `commit.summary` projection down under retry. The reader has
		// been rounded at the source (HermesTranscriptReader), but the sink is the type
		// contract — so a bad value here is truncated rather than throwing.
		//
		// 1787729417.26218 * 1000 = 1787729417262.18 — the exact shape captured from
		// this machine's Hermes state.db when the bug was diagnosed.
		await applyStatsEvents([sessionEvent([skillBucket({ lastCallAtMs: 1_787_729_417_262.18 })])], {
			producerKind: "cli",
			dbPath,
		});
		const rows = await query<{ last_call_at_ms: number }>(
			"SELECT last_call_at_ms FROM session_tool_use WHERE kind = 'skill'",
		);
		expect(rows).toEqual([{ last_call_at_ms: 1_787_729_417_262 }]);
	});

	it("stores null for a NaN/Infinity lastCallAtMs — treats non-finite floats as 'no time'", async () => {
		// A reader that mis-computes a float can produce NaN; keep that from being
		// stored as a bogus epoch instant. Non-finite → null, matching how the readers
		// themselves gate the field with `Number.isFinite`.
		await applyStatsEvents([sessionEvent([skillBucket({ lastCallAtMs: Number.NaN })])], {
			producerKind: "cli",
			dbPath,
		});
		expect(
			await query<{ last_call_at_ms: number | null }>(
				"SELECT last_call_at_ms FROM session_tool_use WHERE kind = 'skill'",
			),
		).toEqual([{ last_call_at_ms: null }]);
	});
});

describe("recall.observed projection", () => {
	const recallEvent = (over: Record<string, unknown> = {}) =>
		({
			event: {
				type: "recall.observed" as const,
				repoIdentity: "repo-1",
				surface: "mcp" as const,
				atMs: 1_700_000_000_000,
				outcome: { hit: true, commitCount: 1, commits: [{ hash: "a".repeat(40), date: "2026-07-01" }] },
				...over,
			},
			producerKind: "cli" as const,
		}) as StatsEventEnvelope;

	const receipts = async () =>
		withDashboardDb(
			(db) =>
				db
					.prepare(
						"SELECT receipt_id, at_ms, surface, session_id, hit, commit_count, commits_json FROM recall_receipts ORDER BY at_ms",
					)
					.all() as Array<Record<string, unknown>>,
			{ dbPath },
		);

	it("stores one row per call, with the served commits", async () => {
		await applyStatsEvents([recallEvent({ sessionId: "s1" })], { producerKind: "cli", dbPath });
		expect(await receipts()).toEqual([
			{
				receipt_id: "recall:repo-1:mcp:1700000000000",
				at_ms: 1_700_000_000_000,
				surface: "mcp",
				session_id: "s1",
				hit: 1,
				commit_count: 1,
				commits_json: JSON.stringify([{ hash: "a".repeat(40), date: "2026-07-01" }]),
			},
		]);
	});

	it("stores a miss with no commits payload", async () => {
		await applyStatsEvents([recallEvent({ outcome: { hit: false, commitCount: 0, commits: [] } })], {
			producerKind: "cli",
			dbPath,
		});
		expect(await receipts()).toEqual([
			expect.objectContaining({ hit: 0, commit_count: 0, commits_json: null, session_id: null }),
		]);
	});

	it("keeps calls from the two surfaces apart even at the same instant", async () => {
		await applyStatsEvents([recallEvent(), recallEvent({ surface: "cli" })], { producerKind: "cli", dbPath });
		expect((await receipts()).map((r) => r.surface).sort()).toEqual(["cli", "mcp"]);
	});

	it("converges on one row when the same event is applied twice", async () => {
		// The drain can replay a claimed-but-uncommitted row; a receipt must not
		// become two calls because of it.
		await applyStatsEvents([recallEvent()], { producerKind: "cli", dbPath });
		await applyStatsEvents([recallEvent({ outcome: { hit: false, commitCount: 0, commits: [] } })], {
			producerKind: "cli",
			dbPath,
		});
		const rows = await receipts();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ hit: 0, commit_count: 0, commits_json: null });
	});

	it("seeds a repos row for a repo nothing else has registered yet", async () => {
		await applyStatsEvents([recallEvent({ repoIdentity: "brand-new" })], { producerKind: "cli", dbPath });
		const row = await withDashboardDb(
			(db) =>
				db.prepare("SELECT repo_identity FROM repos WHERE repo_identity = 'brand-new'").get() as
					| Record<string, unknown>
					| undefined,
			{ dbPath },
		);
		expect(row).toEqual({ repo_identity: "brand-new" });
	});
});

describe("commit_files projection", () => {
	const commitEvent = (over: Record<string, unknown> = {}) =>
		({
			event: {
				type: "commit.created" as const,
				repoIdentity: "repo-1",
				hash: "abc",
				committedAtMs: 1_700_000_000_000,
				message: "feat: x",
				...over,
			},
			producerKind: "cli" as const,
		}) as StatsEventEnvelope;

	const paths = async () =>
		withDashboardDb(
			(db) =>
				db.prepare("SELECT path, insertions, deletions FROM commit_files ORDER BY path").all() as Array<
					Record<string, unknown>
				>,
			{ dbPath },
		);

	it("stores a binary file with NULL counts rather than zeros", async () => {
		await applyStatsEvents(
			[commitEvent({ files: [{ path: "docs/logo.png" }, { path: "src/a.ts", insertions: 3, deletions: 1 }] })],
			{ producerKind: "cli", dbPath },
		);
		expect(await paths()).toEqual([
			{ path: "docs/logo.png", insertions: null, deletions: null },
			{ path: "src/a.ts", insertions: 3, deletions: 1 },
		]);
	});

	it("REPLACES the set when files are supplied — an amend that drops a file drops its row", async () => {
		await applyStatsEvents(
			[
				commitEvent({
					files: [
						{ path: "src/a.ts", insertions: 3 },
						{ path: "src/gone.ts", insertions: 1 },
					],
				}),
			],
			{ producerKind: "cli", dbPath },
		);
		await applyStatsEvents([commitEvent({ files: [{ path: "src/a.ts", insertions: 9 }] })], {
			producerKind: "cli",
			dbPath,
		});
		expect(await paths()).toEqual([{ path: "src/a.ts", insertions: 9, deletions: null }]);
	});

	it("leaves the set alone when files are absent — the live path must not erase bootstrap's work", async () => {
		await applyStatsEvents([commitEvent({ files: [{ path: "src/a.ts", insertions: 3, deletions: 0 }] })], {
			producerKind: "cli",
			dbPath,
		});
		// A producer that could not afford the numstat pass re-upserts the commit.
		await applyStatsEvents([commitEvent({ message: "feat: x (amended)" })], { producerKind: "cli", dbPath });
		expect(await paths()).toEqual([{ path: "src/a.ts", insertions: 3, deletions: 0 }]);
	});

	it("stores an empty set as empty — a merge commit really did show no diff", async () => {
		await applyStatsEvents([commitEvent({ files: [{ path: "src/a.ts", insertions: 1 }] })], {
			producerKind: "cli",
			dbPath,
		});
		await applyStatsEvents([commitEvent({ files: [] })], { producerKind: "cli", dbPath });
		expect(await paths()).toEqual([]);
	});
});

describe("commit.summary projection", () => {
	const summaryEvent = (over: Record<string, unknown> = {}) =>
		({
			event: {
				type: "commit.summary" as const,
				repoIdentity: "repo-1",
				hash: "abc",
				committedAtMs: 1_700_000_000_000,
				branch: "main",
				message: "feat: x",
				turns: 8,
				tokens: 12000,
				estCostUsd: 1.75,
				ticketId: "JOLLI-2069",
				insights: [
					{ kind: "decision" as const, text: "picked WAL" },
					{ kind: "todo" as const, text: "add index", addressedTo: "joe" },
				],
				references: [{ source: "linear", nativeId: "JOLLI-2069", title: "Dash", url: "https://l/x" }],
				sessionLinks: [
					{ source: "claude" as const, sessionId: "s1", confidence: "exact" as const, messageCount: 9 },
				],
				...over,
			},
			producerKind: "bootstrap" as const,
		}) as StatsEventEnvelope;

	it("creates the commit row when the summary arrives before commit.created — base columns only", async () => {
		// The enrichment columns are gone (A3b): what the projection still owns
		// is the commits row itself; turns/tokens/cost/ticket live on memories.
		await applyStatsEvents([summaryEvent()], { producerKind: "bootstrap", dbPath });
		const rows = await withDashboardDb(
			(db) => db.prepare("SELECT hash, branch, message FROM commits").all() as Array<Record<string, unknown>>,
			{ dbPath },
		);
		expect(rows).toEqual([{ hash: "abc", branch: "main", message: "feat: x" }]);
	});

	it("keeps branch/message when a plain commit.created upserts the same commit afterwards", async () => {
		await applyStatsEvents([summaryEvent()], { producerKind: "bootstrap", dbPath });
		await applyStatsEvents([envelope(commit({ hash: "abc" }))], { producerKind: "cli", dbPath });
		const rows = await withDashboardDb(
			(db) => db.prepare("SELECT branch, author_name FROM commits").all() as Array<Record<string, unknown>>,
			{ dbPath },
		);
		expect(rows[0].branch).toBe("main");
	});

	it("seeds a minimal session row for a link whose session was never live-discovered", async () => {
		await applyStatsEvents([summaryEvent()], { producerKind: "bootstrap", dbPath });
		const sessions = await withDashboardDb(
			(db) =>
				db
					.prepare("SELECT session_id, message_count, updated_at_ms, token_coverage FROM sessions")
					.all() as Array<Record<string, unknown>>,
			{ dbPath },
		);
		expect(sessions).toEqual([
			{ session_id: "s1", message_count: 9, updated_at_ms: 1_700_000_000_000, token_coverage: "sessions-only" },
		]);
	});

	it("seeds real usage and a model split when the link carries the transcript's own attribution", async () => {
		await applyStatsEvents(
			[
				summaryEvent({
					sessionLinks: [
						{
							source: "claude" as const,
							sessionId: "s1",
							confidence: "exact" as const,
							messageCount: 9,
							models: [
								{
									model: "claude-opus-5",
									provider: "anthropic",
									inputTokens: 100,
									outputTokens: 50,
									cachedTokens: 25,
									estCostUsd: 0.5,
								},
							],
						},
					],
				}),
			],
			{ producerKind: "bootstrap", dbPath },
		);
		const rows = await query<{
			input_tokens: number;
			output_tokens: number;
			cached_tokens: number;
			est_cost_usd: number;
			token_coverage: string;
		}>("SELECT input_tokens, output_tokens, cached_tokens, est_cost_usd, token_coverage FROM sessions");
		expect(rows).toEqual([
			{ input_tokens: 100, output_tokens: 50, cached_tokens: 25, est_cost_usd: 0.5, token_coverage: "full" },
		]);
		const usage = await query<{ model: string; input_tokens: number }>(
			"SELECT model, input_tokens FROM session_model_usage",
		);
		expect(usage).toEqual([{ model: "claude-opus-5", input_tokens: 100 }]);
	});

	it("never overwrites a live-discovered session row when seeding a link", async () => {
		await applyStatsEvents([envelope(session({ sessionId: "s1" }))], { producerKind: "cli", dbPath });
		await applyStatsEvents([summaryEvent()], { producerKind: "bootstrap", dbPath });
		const sessions = await withDashboardDb(
			(db) =>
				db.prepare("SELECT input_tokens, message_count FROM sessions").all() as Array<Record<string, unknown>>,
			{ dbPath },
		);
		// The live row's tokens and count survive; the seed's message_count=9 did not clobber them.
		expect(sessions[0].input_tokens).toBe(100);
		expect(sessions[0].message_count).toBe(4);
	});

	it("upgrades a previously-seeded sessions-only row once a later sweep supplies usageByModel", async () => {
		// First sweep: the summary carries no per-model attribution yet (e.g. the
		// transcript retention window had already dropped it) — seeds sessions-only.
		await applyStatsEvents([summaryEvent()], { producerKind: "bootstrap", dbPath });
		let rows = await query<{ token_coverage: string; input_tokens: number }>(
			"SELECT token_coverage, input_tokens FROM sessions",
		);
		expect(rows).toEqual([{ token_coverage: "sessions-only", input_tokens: 0 }]);

		// A later re-run of commit.summary generation resolves usageByModel for the
		// same session — the existing row must upgrade in place, not stay stuck at 0.
		await applyStatsEvents(
			[
				summaryEvent({
					sessionLinks: [
						{
							source: "claude" as const,
							sessionId: "s1",
							confidence: "exact" as const,
							messageCount: 9,
							models: [
								{
									model: "claude-opus-5",
									provider: "anthropic",
									inputTokens: 100,
									outputTokens: 50,
									cachedTokens: 25,
									estCostUsd: 0.5,
								},
							],
						},
					],
				}),
			],
			{ producerKind: "bootstrap", dbPath },
		);
		rows = await query<{ token_coverage: string; input_tokens: number }>(
			"SELECT token_coverage, input_tokens FROM sessions",
		);
		expect(rows).toEqual([{ token_coverage: "full", input_tokens: 100 }]);
		const usage = await query<{ model: string; input_tokens: number }>(
			"SELECT model, input_tokens FROM session_model_usage",
		);
		expect(usage).toEqual([{ model: "claude-opus-5", input_tokens: 100 }]);
	});

	it("never downgrades an already-full seeded row when a later link has no models", async () => {
		await applyStatsEvents(
			[
				summaryEvent({
					sessionLinks: [
						{
							source: "claude" as const,
							sessionId: "s1",
							confidence: "exact" as const,
							messageCount: 9,
							models: [
								{
									model: "claude-opus-5",
									provider: "anthropic",
									inputTokens: 100,
									outputTokens: 50,
									cachedTokens: 25,
									estCostUsd: 0.5,
								},
							],
						},
					],
				}),
			],
			{ producerKind: "bootstrap", dbPath },
		);
		await applyStatsEvents([summaryEvent()], { producerKind: "bootstrap", dbPath });
		const rows = await query<{ token_coverage: string; input_tokens: number }>(
			"SELECT token_coverage, input_tokens FROM sessions",
		);
		expect(rows).toEqual([{ token_coverage: "full", input_tokens: 100 }]);
	});

	it("seeds tool calls from a link whose memory recorded them", async () => {
		await applyStatsEvents(
			[
				summaryEvent({
					sessionLinks: [
						{
							source: "claude" as const,
							sessionId: "s1",
							confidence: "exact" as const,
							messageCount: 9,
							tools: [
								{ name: "Bash", kind: "builtin" as const, calls: 3 },
								{
									name: "jollimemory.recall",
									kind: "mcp" as const,
									server: "jollimemory",
									calls: 2,
								},
							],
						},
					],
				}),
			],
			{ producerKind: "bootstrap", dbPath },
		);
		const rows = await query<{ tool_name: string; kind: string; server: string | null; calls: number }>(
			"SELECT tool_name, kind, server, calls FROM session_tool_use ORDER BY tool_name",
		);
		expect(rows).toEqual([
			{ tool_name: "Bash", kind: "builtin", server: null, calls: 3 },
			{ tool_name: "jollimemory.recall", kind: "mcp", server: "jollimemory", calls: 2 },
		]);
	});

	it("seeds nothing when the memory recorded no tools, and stays idempotent on replay", async () => {
		// The `if (link.tools !== undefined)` gate: a memory written before the field
		// existed must not be read as "this session called nothing".
		await applyStatsEvents([summaryEvent()], { producerKind: "bootstrap", dbPath });
		await applyStatsEvents([summaryEvent()], { producerKind: "bootstrap", dbPath });
		expect(await query("SELECT * FROM session_tool_use")).toEqual([]);
	});

	it("leaves a live-discovered session's tool rows alone — the live read is the fuller one", async () => {
		// A live `session.upserted` parses the WHOLE transcript; a memory owns only the
		// slices its commit consumed. Seeding over the live row would trade a complete
		// count for a partial one.
		await applyStatsEvents(
			[envelope(session({ sessionId: "s1", tools: [{ name: "Bash", kind: "builtin", calls: 42 }] }))],
			{ producerKind: "cli", dbPath },
		);
		await applyStatsEvents(
			[
				summaryEvent({
					sessionLinks: [
						{
							source: "claude" as const,
							sessionId: "s1",
							confidence: "exact" as const,
							messageCount: 9,
							tools: [{ name: "Bash", kind: "builtin" as const, calls: 1 }],
						},
					],
				}),
			],
			{ producerKind: "bootstrap", dbPath },
		);
		const rows = await query<{ calls: number }>("SELECT calls FROM session_tool_use");
		expect(rows).toEqual([{ calls: 42 }]);
	});

	it("replays to the same tool rows rather than accumulating them", async () => {
		// Idempotency is what forbids summing a session's slices across commits: the
		// same event must project to the same rows however many times it drains.
		const withTools = summaryEvent({
			sessionLinks: [
				{
					source: "claude" as const,
					sessionId: "s1",
					confidence: "exact" as const,
					messageCount: 9,
					tools: [{ name: "Bash", kind: "builtin" as const, calls: 3 }],
				},
			],
		});
		await applyStatsEvents([withTools], { producerKind: "bootstrap", dbPath });
		await applyStatsEvents([withTools], { producerKind: "bootstrap", dbPath });
		expect(await query<{ calls: number }>("SELECT calls FROM session_tool_use")).toEqual([{ calls: 3 }]);
	});

	it("a re-emit without sessionLinks seeds nothing and stays idempotent", async () => {
		await applyStatsEvents([summaryEvent()], { producerKind: "bootstrap", dbPath });
		await applyStatsEvents([summaryEvent({ sessionLinks: undefined })], { producerKind: "bootstrap", dbPath });
		const sessions = await withDashboardDb(
			(db) => (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n,
			{ dbPath },
		);
		expect(sessions).toBe(1);
	});
});

describe("events_raw retention (§11 defect 2)", () => {
	const DAY = 86_400_000;

	/** Inserts a raw event row directly, so its age and status can be dictated. */
	function seedEvent(db: DashboardDbHandle, status: string, receivedAt: string): void {
		db.prepare(
			`INSERT INTO events_raw (event_id, repo_identity, type, schema_version, received_at, data_json, projection_status)
			 VALUES ('e', 'r', 'session.upserted', 1, ?, '{}', ?)`,
		).run(receivedAt, status);
	}

	it("prunes projected rows past the retention window and keeps recent ones", async () => {
		const now = Date.parse("2026-07-31T12:00:00Z");
		const remaining = await withDashboardDb(
			(db) => {
				seedEvent(db, "projected", new Date(now - 30 * DAY).toISOString());
				seedEvent(db, "projected", new Date(now - 20 * DAY).toISOString());
				seedEvent(db, "projected", new Date(now - 2 * DAY).toISOString());
				expect(pruneProjectedEvents(db, () => now)).toBe(2);
				return (db.prepare("SELECT COUNT(*) AS n FROM events_raw").get() as { n: number }).n;
			},
			{ dbPath },
		);
		expect(remaining).toBe(1);
	});

	it("swallows a failing delete — housekeeping must not fail a completed write", async () => {
		const broken = {
			prepare: () => {
				throw new Error("disk I/O error");
			},
		} as unknown as DashboardDbHandle;
		expect(pruneProjectedEvents(broken, () => Date.parse("2026-07-31T12:00:00Z"))).toBe(0);
	});

	it("tags the FAILURE line too, so one grep returns the whole pass", () => {
		// The tag exists because the daemon's re-scan promises that one `grep AgentScan`
		// returns everything it emitted. Tagging only the success line left the pair's one
		// report of a real fault as the single thing that grep drops — and DEBUG is exactly
		// the level someone raises before running it, so the line was present, relevant and
		// filtered out.
		const broken = {
			prepare: () => {
				throw new Error("disk I/O error");
			},
		} as unknown as DashboardDbHandle;
		const now = () => Date.parse("2026-07-31T12:00:00Z");

		expect(pruneProjectedEvents(broken, now, "AgentScan: ")).toBe(0);
		expect(pruneProjectedEvents(broken, now)).toBe(0);

		const skipped = logLines.filter((line) => line.text.includes("event pruning skipped"));
		expect(skipped).toHaveLength(2);
		expect(skipped[0]?.text).toContain("AgentScan: event pruning skipped");
		// And the default stays empty, so the two user-triggered callers' output is
		// byte-identical to what it was before the tag existed.
		expect(skipped[1]?.text).not.toContain("AgentScan");
	});

	it("never prunes pending or failed rows, however old", async () => {
		const now = Date.parse("2026-07-31T12:00:00Z");
		const statuses = await withDashboardDb(
			(db) => {
				// A year old: pending is the crash-recovery record a later writer
				// drains, failed is the evidence for something that needs looking at.
				seedEvent(db, "pending", new Date(now - 365 * DAY).toISOString());
				seedEvent(db, "failed", new Date(now - 365 * DAY).toISOString());
				expect(pruneProjectedEvents(db, () => now)).toBe(0);
				return (
					db.prepare("SELECT projection_status FROM events_raw ORDER BY seq").all() as Array<{
						projection_status: string;
					}>
				).map((r) => r.projection_status);
			},
			{ dbPath },
		);
		expect(statuses).toEqual(["pending", "failed"]);
	});

	it("runs as part of a normal apply, so the log cannot grow unbounded", async () => {
		const now = Date.parse("2026-07-31T12:00:00Z");
		await withDashboardDb((db) => seedEvent(db, "projected", new Date(now - 60 * DAY).toISOString()), { dbPath });

		await applyStatsEvents([envelope(session())], { producerKind: "cli", dbPath, now: () => now });

		const old = await withDashboardDb(
			(db) =>
				(
					db
						.prepare("SELECT COUNT(*) AS n FROM events_raw WHERE received_at < ?")
						.get(new Date(now - 30 * DAY).toISOString()) as { n: number }
				).n,
			{ dbPath },
		);
		expect(old).toBe(0);
	});
});

describe("countStuckEvents", () => {
	/**
	 * A handle whose NARROWED count fails and whose un-narrowed fallback would succeed.
	 *
	 * The second half is what gives these cases teeth. A fake that throws on every
	 * statement cannot tell a rethrow from a degradation — the fallback would throw the same
	 * error and the assertion would pass either way — so deleting the guard outright, the
	 * crudest form of the regression, would go unnoticed. Here a degradation returns 7.
	 */
	function failingFirstStatement(message: string): DashboardDbHandle {
		let statements = 0;
		return {
			prepare: () => {
				statements += 1;
				if (statements === 1) throw new Error(message);
				return { get: () => ({ n: 7 }) };
			},
		} as unknown as DashboardDbHandle;
	}

	it("rethrows a genuine fault rather than counting around it", () => {
		// The degradation is narrowed to one SQLite message deliberately: on a pre-migration
		// schema the un-narrowed count is the exact answer, but corruption or a permissions
		// change must still surface. Nothing pinned this half — both existing cases
		// (DbBackfill.test.ts) exercise only the degradation — so turning the rethrow into
		// `return 0`, or dropping the guard so everything degrades, each reads as a harmless
		// simplification of a defensive catch while reporting a broken database as a number.
		expect(() => countStuckEvents(failingFirstStatement("database disk image is malformed"))).toThrow(/malformed/);
	});

	it("rethrows a DIFFERENT missing column, so the pattern cannot be widened", () => {
		// `/no such column/i` is the tempting simplification, and it is wrong: a column
		// missing for any other reason is real schema drift, not the one shape whose
		// un-narrowed count is provably exact. Only `failed_kind` has that property.
		expect(() => countStuckEvents(failingFirstStatement("no such column: time_updated"))).toThrow(/time_updated/);
	});

	it("degrades for exactly that one message, answering with the un-narrowed count", () => {
		expect(countStuckEvents(failingFirstStatement("no such column: failed_kind"))).toBe(7);
	});
});

describe("projectSession — monotonic guard", () => {
	/**
	 * The guard only fires against a row whose instant is TRANSCRIPT-DERIVED, which it
	 * recognises by `started_at_ms` / `duration_ms` — `readKnownSessions`' read-receipt
	 * pair. So what arms it in the cases below is those two columns, NOT the `title` this
	 * helper also sets: a FAILED transcript read writes a title too, which is exactly why
	 * `title` is part of neither predicate (see `projectSession`, and the case further
	 * down that a title-based test walked straight into). The title is here only to keep
	 * the event production-shaped — `resolveTitle` yields one for any transcript with a
	 * first user message, which is every conversation that has content.
	 */
	const read = (over: Partial<SessionUpsertedEvent> = {}): SessionUpsertedEvent =>
		session({ title: "a real conversation", startedAtMs: 1_699_999_000_000, durationMs: 1_000, ...over });

	/**
	 * `updated_at_ms` is ASSIGNED by the UPSERT, not MAX'd, so without the guard an
	 * older event silently rewinds the row — and takes the model split and the tool set
	 * with it, since both are replace-wholesale.
	 *
	 * Reachable because insertion order is not observation order: four independent
	 * processes emit for one session, and a producer that observed an older version can
	 * still write later. It self-heals on the next pass, which is why it went unnoticed.
	 */
	it("does not let an older event rewind the stored session", async () => {
		const newer = read({ updatedAtMs: 1_700_000_200_000, messageCount: 9 });
		const older = read({ updatedAtMs: 1_700_000_000_000, messageCount: 4 });

		await applyStatsEvents([envelope(newer)], { producerKind: "cli", dbPath });
		await applyStatsEvents([envelope(older)], { producerKind: "vscode", dbPath });

		expect(await query("SELECT updated_at_ms, message_count FROM sessions")).toEqual([
			{ updated_at_ms: 1_700_000_200_000, message_count: 9 },
		]);
	});

	it("does not let an older event replace the newer event's model split", async () => {
		const newer = read({
			updatedAtMs: 1_700_000_200_000,
			models: [{ model: "claude-opus-5", inputTokens: 900, outputTokens: 90, cachedTokens: 0 }],
		});
		const older = read({
			updatedAtMs: 1_700_000_000_000,
			models: [{ model: "claude-haiku-4-5", inputTokens: 1, outputTokens: 1, cachedTokens: 0 }],
		});

		await applyStatsEvents([envelope(newer)], { producerKind: "cli", dbPath });
		await applyStatsEvents([envelope(older)], { producerKind: "vscode", dbPath });

		expect(await query("SELECT model, input_tokens FROM session_model_usage")).toEqual([
			{ model: "claude-opus-5", input_tokens: 900 },
		]);
	});

	it("does not let a pathless hook row block the later full disk read", async () => {
		await applyStatsEvents([envelope(read({ updatedAtMs: 1_700_000_000_000, messageCount: 4 }))], {
			producerKind: "cli",
			dbPath,
		});
		await applyStatsEvents(
			[
				envelope(
					session({
						updatedAtMs: 1_700_000_200_000,
						metadataOnly: true,
						messageCount: undefined,
						models: undefined,
						tokenCoverage: undefined,
					}),
				),
			],
			{ producerKind: "stop-hook", dbPath },
		);
		// The hook's wall clock is newer than the transcript, but must not become the
		// content high-water mark when it carried no content at all.
		expect(await query("SELECT updated_at_ms, message_count FROM sessions")).toEqual([
			{ updated_at_ms: 1_700_000_000_000, message_count: 4 },
		]);

		await applyStatsEvents([envelope(read({ updatedAtMs: 1_700_000_100_000, messageCount: 9 }))], {
			producerKind: "recovery",
			dbPath,
		});
		expect(await query("SELECT updated_at_ms, message_count FROM sessions")).toEqual([
			{ updated_at_ms: 1_700_000_100_000, message_count: 9 },
		]);
	});

	it("still projects a real read whose instant PRE-DATES a commit-summary seed", async () => {
		// The guard's one dangerous shape, and it is the common one rather than an edge.
		// A commit summary stamps its seeded `sessions` row with `committedAtMs`, which is
		// later than the conversation's last turn — measured on one real machine, 42 of 56
		// stored session links. `dbBackfillRepo` applies summaries BEFORE sessions, so on
		// a fresh import the seed always lands first, and a guard that compared against it
		// dropped the real read whole while reporting the event as projected. Permanent:
		// the stub is not a read receipt, so every later pass re-read and dropped it again.
		await applyStatsEvents(
			[
				envelope({
					type: "commit.summary",
					repoIdentity: "repo-1",
					hash: "abc123",
					committedAtMs: 1_700_000_100_000,
					title: "feat: thing",
					sessionLinks: [{ source: "claude", sessionId: "s1", messageCount: 2 }],
				} as unknown as CommitSummaryEvent),
			],
			{ producerKind: "cli", dbPath },
		);
		expect(await query("SELECT updated_at_ms, title FROM sessions")).toEqual([
			{ updated_at_ms: 1_700_000_100_000, title: null },
		]);

		await applyStatsEvents(
			[
				envelope(
					read({
						updatedAtMs: 1_700_000_000_000,
						messageCount: 40,
						tools: [{ name: "Bash", kind: "builtin", calls: 3 }],
					}),
				),
			],
			{ producerKind: "cli", dbPath },
		);

		expect(await query("SELECT updated_at_ms, title, started_at_ms, message_count FROM sessions")).toEqual([
			{
				updated_at_ms: 1_700_000_000_000,
				title: "a real conversation",
				started_at_ms: 1_699_999_000_000,
				message_count: 40,
			},
		]);
		expect(await query("SELECT tool_name, calls FROM session_tool_use")).toEqual([{ tool_name: "Bash", calls: 3 }]);
	});

	it("still projects a real read whose instant PRE-DATES a FAILED read's stub", async () => {
		// The guard's OTHER dangerous shape, and the one a title-based provenance test
		// walked straight into. A failed transcript read writes `{title, updated_at_ms}`
		// and nothing else, stamped with the `sessions.json` instant — the last turn plus
		// the hook's delay, not anything a transcript said. Claude's Stop hook is
		// `async: true` and races the agent's own append, so this is an ordinary event.
		// 48 h later `pruneStale` drops the registry row and the 7-day back-fill sees only
		// the disk copy, whose mtime is EARLIER — so the good read arrives with the
		// SMALLER instant and has to land anyway.
		//
		// The same stub-then-read shape at an EQUAL instant is deliberately NOT a second
		// case. `prior.updated_at_ms > event.updatedAtMs` is false there whatever the
		// provenance test answers, so no mutation of the guard can make such a case fail
		// and it pins nothing — it was written, measured to be inert, and removed. A
		// larger stub instant is what makes provenance the only thing deciding.
		const stub = session({
			title: "a real conversation",
			updatedAtMs: 1_700_000_200_000,
			models: [],
			tokenCoverage: "sessions-only",
			messageCount: undefined,
		});
		await applyStatsEvents([envelope(stub)], { producerKind: "vscode", dbPath });
		// The shape that made this reachable: a title, and neither receipt column.
		expect(await query("SELECT updated_at_ms, title, started_at_ms, duration_ms FROM sessions")).toEqual([
			{ updated_at_ms: 1_700_000_200_000, title: "a real conversation", started_at_ms: null, duration_ms: null },
		]);

		await applyStatsEvents(
			[
				envelope(
					read({
						updatedAtMs: 1_700_000_000_000,
						messageCount: 40,
						tools: [{ name: "Bash", kind: "builtin", calls: 3 }],
					}),
				),
			],
			{ producerKind: "cli", dbPath },
		);

		// The whole payload, not just the instant — this is what used to be discarded
		// while the event was recorded as successfully projected.
		expect(await query("SELECT updated_at_ms, started_at_ms, duration_ms, message_count FROM sessions")).toEqual([
			{
				updated_at_ms: 1_700_000_000_000,
				started_at_ms: 1_699_999_000_000,
				duration_ms: 1_000,
				message_count: 40,
			},
		]);
		expect(await query("SELECT tool_name, calls FROM session_tool_use")).toEqual([{ tool_name: "Bash", calls: 3 }]);
	});

	it("still projects an event carrying the SAME instant", async () => {
		// STRICTLY greater, never `>=`. BOTH rows are real reads here, so the provenance
		// test passes and the comparison is genuinely what decides — which is the point of
		// the case: a re-read at an unchanged mtime is how a fixed parser or a bumped
		// `SESSION_READ_GENERATION` heals a row projected from less, and `>=` would drop
		// every one of them.
		const first = read({ updatedAtMs: 1_700_000_000_000, messageCount: 4 });
		const reread = read({ updatedAtMs: 1_700_000_000_000, messageCount: 12 });

		await applyStatsEvents([envelope(first)], { producerKind: "vscode", dbPath });
		await applyStatsEvents([envelope(reread)], { producerKind: "cli", dbPath });

		expect(await query("SELECT updated_at_ms, message_count FROM sessions")).toEqual([
			{ updated_at_ms: 1_700_000_000_000, message_count: 12 },
		]);
	});

	it("marks a skipped event projected rather than failed, so the prune can reach it", async () => {
		// "Nothing to do" is a form of completion. Parking it as `failed` instead would
		// keep it forever — `pruneProjectedEvents` only ever deletes `projected` rows.
		//
		// Both events are real reads, so a skip actually happens; and the row assertion is
		// what lets this case fail at all. Without the guard the older event projects
		// normally and the status is `projected` either way, so the status alone cannot
		// tell the two worlds apart.
		await applyStatsEvents([envelope(read({ updatedAtMs: 1_700_000_200_000, messageCount: 9 }))], {
			producerKind: "cli",
			dbPath,
		});
		await applyStatsEvents([envelope(read({ updatedAtMs: 1_700_000_000_000, messageCount: 4 }))], {
			producerKind: "cli",
			dbPath,
		});

		const statuses = await query<{ projection_status: string }>(
			"SELECT projection_status FROM events_raw ORDER BY seq",
		);
		expect(statuses.every((r) => r.projection_status === "projected")).toBe(true);
		// The skip really happened — otherwise this is the older event's 4.
		expect(await query("SELECT message_count FROM sessions")).toEqual([{ message_count: 9 }]);
	});
});

describe("projectSession — duplicate model entries", () => {
	/**
	 * A deterministic poison shape before the conflict clause: the split is deleted and
	 * re-inserted per projection, so two entries naming one model hit the
	 * `(session_event_id, model)` primary key. The projection threw, the event burned
	 * its five attempts and parked as `failed`, and because the collision comes from
	 * the transcript's own content it reproduced on every re-read.
	 */
	it("sums two entries naming the same model instead of failing the projection", async () => {
		const event = session({
			models: [
				{ model: "claude-opus-5", inputTokens: 100, outputTokens: 50, cachedTokens: 25, estCostUsd: 0.5 },
				{ model: "claude-opus-5", inputTokens: 10, outputTokens: 5, cachedTokens: 2, estCostUsd: 0.25 },
			],
		});

		const result = await applyStatsEvents([envelope(event)], { producerKind: "cli", dbPath });

		expect(result.pending).toBe(0);
		expect(
			await query(
				"SELECT model, input_tokens, output_tokens, cached_tokens, est_cost_usd FROM session_model_usage",
			),
		).toEqual([
			{ model: "claude-opus-5", input_tokens: 110, output_tokens: 55, cached_tokens: 27, est_cost_usd: 0.75 },
		]);
	});

	it("keeps a wholly unpriced model NULL rather than summing it to zero", async () => {
		// NULL means "unpriced", not zero. `0 + 0` would store a priced 0.00, which every
		// downstream reader treats as a real answer rather than a missing one.
		const event = session({
			models: [
				{ model: "some-local-model", inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
				{ model: "some-local-model", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
			],
		});

		await applyStatsEvents([envelope(event)], { producerKind: "cli", dbPath });

		expect(await query("SELECT model, input_tokens, est_cost_usd FROM session_model_usage")).toEqual([
			{ model: "some-local-model", input_tokens: 11, est_cost_usd: null },
		]);
	});
});

describe("session_usage_events — spend lands on the day it happened", () => {
	const at = (ms: number) => () => ms;
	const DAY1 = Date.parse("2026-03-01T10:00:00Z");
	const DAY3 = Date.parse("2026-03-03T09:00:00Z");

	// THE assertion this whole table exists for. Before it, a conversation's
	// entire spend was filed under `sessions.updated_at_ms` — one timestamp for
	// the lot — so a session opened on the 1st and continued on the 3rd reported
	// $0 on the 1st and everything on the 3rd.
	it("splits one session across the days it actually spanned", async () => {
		await applyStatsEvents(
			[
				envelope(
					session({
						updatedAtMs: DAY3,
						usageEvents: [
							{
								respondedAtMs: DAY1,
								model: "claude-opus-5",
								input: 100,
								output: 10,
								cached: 0,
								dedupKey: "a",
							},
							{
								respondedAtMs: DAY3,
								model: "claude-opus-5",
								input: 200,
								output: 20,
								cached: 0,
								dedupKey: "b",
							},
						],
					}),
				),
			],
			{ producerKind: "cli", dbPath, now: at(9_000) },
		);

		const rows = await query<{ responded_at_ms: number; input_tokens: number }>(
			"SELECT * FROM session_usage_events ORDER BY responded_at_ms",
		);
		expect(rows.map((r) => [r.responded_at_ms, r.input_tokens])).toEqual([
			[DAY1, 100],
			[DAY3, 200],
		]);
		// The session row still says "last active on the 3rd" — that is what it
		// means, and it is no longer what the daily numbers are built from.
		const [s] = await query<{ updated_at_ms: number }>("SELECT * FROM sessions");
		expect(s?.updated_at_ms).toBe(DAY3);
	});

	it("converges on re-read instead of doubling", async () => {
		const events = [
			{ respondedAtMs: DAY1, model: "claude-opus-5", input: 100, output: 10, cached: 0, dedupKey: "a" },
		];
		for (const now of [1_000, 2_000]) {
			await applyStatsEvents([envelope(session({ usageEvents: events }))], {
				producerKind: "cli",
				dbPath,
				now: at(now),
			});
		}
		const rows = await query<{ updated_at_ms: number }>("SELECT * FROM session_usage_events");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.updated_at_ms).toBe(2_000);
	});

	// `undefined` means "this source cannot report per-response usage" — every
	// source but Claude today. It must not erase what a capable read collected.
	it("leaves existing rows alone when the producer cannot see per-response usage", async () => {
		const events = [
			{ respondedAtMs: DAY1, model: "claude-opus-5", input: 100, output: 10, cached: 0, dedupKey: "a" },
		];
		await applyStatsEvents([envelope(session({ usageEvents: events }))], {
			producerKind: "cli",
			dbPath,
			now: at(1_000),
		});
		await applyStatsEvents([envelope(session({ usageEvents: undefined, messageCount: 9 }))], {
			producerKind: "cli",
			dbPath,
			now: at(2_000),
		});

		expect(await query("SELECT * FROM session_usage_events")).toHaveLength(1);
	});

	it("clears stored events when a re-read sees usage but nothing datable", async () => {
		const events = [
			{ respondedAtMs: DAY1, model: "claude-opus-5", input: 100, output: 10, cached: 0, dedupKey: "a" },
		];
		await applyStatsEvents([envelope(session({ usageEvents: events }))], {
			producerKind: "cli",
			dbPath,
			now: at(1_000),
		});
		await applyStatsEvents([envelope(session({ usageEvents: [], messageCount: 9 }))], {
			producerKind: "cli",
			dbPath,
			now: at(2_000),
		});

		expect(await query("SELECT * FROM session_usage_events")).toHaveLength(0);
	});

	it("falls back to the line position when the source cannot name the response", async () => {
		await applyStatsEvents(
			[
				envelope(
					session({
						usageEvents: [
							{ respondedAtMs: DAY1, model: "", input: 1, output: 1, cached: 0 },
							{ respondedAtMs: DAY3, model: "", input: 2, output: 2, cached: 0 },
						],
					}),
				),
			],
			{ producerKind: "cli", dbPath, now: at(1_000) },
		);
		const rows = await query<{ dedup_key: string }>("SELECT * FROM session_usage_events ORDER BY dedup_key");
		expect(rows.map((r) => r.dedup_key)).toEqual(["line:0", "line:1"]);
	});
});

describe("sync stamps", () => {
	const at = (ms: number) => () => ms;

	it("stamps the session and both child tables on the live path", async () => {
		await applyStatsEvents([envelope(session({ tools: [{ name: "Edit", kind: "builtin", calls: 3 }] }))], {
			producerKind: "cli",
			dbPath,
			now: at(9_000),
		});

		const [s] = await query<{ written_at_ms: number; updated_at_ms: number }>("SELECT * FROM sessions");
		expect(s?.written_at_ms).toBe(9_000);
		// The business clock still says what the event said, not when we wrote it.
		expect(s?.updated_at_ms).toBe(1_700_000_000_000);

		const [m] = await query<{ updated_at_ms: number }>("SELECT * FROM session_model_usage");
		expect(m?.updated_at_ms).toBe(9_000);
		const [t] = await query<{ updated_at_ms: number }>("SELECT * FROM session_tool_use");
		expect(t?.updated_at_ms).toBe(9_000);
	});

	it("moves the stamp when a token-less re-read rewrites the row", async () => {
		await applyStatsEvents([envelope(session())], { producerKind: "cli", dbPath, now: at(1_000) });
		await applyStatsEvents([envelope(session({ messageCount: 9 }))], {
			producerKind: "cli",
			dbPath,
			now: at(2_000),
		});

		const [s] = await query<{ written_at_ms: number }>("SELECT * FROM sessions");
		expect(s?.written_at_ms).toBe(2_000);
	});

	it("preserves an existing full row when a re-read reports no usage", async () => {
		// The downgrade F3 guards against: a Claude transcript whose retention window
		// dropped its per-turn usage re-reads with no models, so the collector leaves
		// `tokenCoverage` absent. The merge must PRESERVE the `full` the row already
		// carries — the token counts on the same row already fall back to their existing
		// values, so clearing the coverage flag alone would make the row contradict itself.
		await applyStatsEvents([envelope(session())], { producerKind: "cli", dbPath });
		const [before] = await query<{ token_coverage: string; input_tokens: number }>("SELECT * FROM sessions");
		expect(before?.token_coverage).toBe("full");

		await applyStatsEvents([envelope(session({ models: undefined, tokenCoverage: undefined }))], {
			producerKind: "cli",
			dbPath,
		});
		const [after] = await query<{ token_coverage: string; input_tokens: number }>("SELECT * FROM sessions");
		expect(after?.token_coverage).toBe("full");
		expect(after?.input_tokens).toBe(before?.input_tokens);
	});

	it("defaults an absent tokenCoverage to sessions-only on first write", async () => {
		await applyStatsEvents([envelope(session({ models: undefined, tokenCoverage: undefined }))], {
			producerKind: "cli",
			dbPath,
		});
		const [row] = await query<{ token_coverage: string }>("SELECT * FROM sessions");
		expect(row?.token_coverage).toBe("sessions-only");
	});

	// THE regression this column exists for. `projectCommitSummary` upgrades a
	// `sessions-only` row to `full` without touching `updated_at_ms` — correctly,
	// since the only clock it holds is the commit's. A sync keyed on that column
	// would never learn the token split improved; the stamp is what makes it visible.
	it("moves the stamp on a sessions-only -> full upgrade, leaving the business clock alone", async () => {
		await applyStatsEvents([envelope(session({ models: undefined, tokenCoverage: "sessions-only" }))], {
			producerKind: "cli",
			dbPath,
			now: at(1_000),
		});
		const [before] = await query<{ updated_at_ms: number; written_at_ms: number; token_coverage: string }>(
			"SELECT * FROM sessions",
		);
		expect(before?.token_coverage).toBe("sessions-only");

		await applyStatsEvents(
			[
				{
					event: {
						type: "commit.summary",
						repoIdentity: "repo-1",
						hash: "abc123",
						committedAtMs: 1_700_000_500_000,
						sessionLinks: [
							{
								source: "claude",
								sessionId: "s1",
								confidence: "exact",
								models: [
									{
										model: "claude-opus-5",
										provider: "anthropic",
										inputTokens: 10,
										outputTokens: 5,
										cachedTokens: 0,
										estCostUsd: 0.1,
									},
								],
							},
						],
					},
					producerKind: "cli",
				} as unknown as StatsEventEnvelope,
			],
			{ producerKind: "cli", dbPath, now: at(5_000) },
		);

		const [after] = await query<{ updated_at_ms: number; written_at_ms: number; token_coverage: string }>(
			"SELECT * FROM sessions",
		);
		expect(after?.token_coverage).toBe("full");
		// Business clock untouched — the commit's time is not the session's.
		expect(after?.updated_at_ms).toBe(before?.updated_at_ms);
		// …but the row changed, so the stamp moved and a sync will pick it up.
		expect(after?.written_at_ms).toBe(5_000);
	});

	it("moves the stamp on the tool-use conflict branch", async () => {
		// Two buckets with the same (name, kind) inside one event take the
		// ON CONFLICT path, which is a write like any other.
		await applyStatsEvents(
			[
				envelope(
					session({
						tools: [
							{ name: "Edit", kind: "builtin", calls: 1 },
							{ name: "Edit", kind: "builtin", calls: 7 },
						],
					}),
				),
			],
			{ producerKind: "cli", dbPath, now: at(4_000) },
		);

		const rows = await query<{ calls: number; updated_at_ms: number }>("SELECT * FROM session_tool_use");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.calls).toBe(7);
		expect(rows[0]?.updated_at_ms).toBe(4_000);
	});

	it("stamps recall receipts", async () => {
		await applyStatsEvents(
			[
				{
					event: {
						type: "recall.observed",
						repoIdentity: "repo-1",
						atMs: 1_700_000_300_000,
						surface: "mcp",
						outcome: { hit: true, commitCount: 1, commits: [{ hash: "abc123", date: "2026-08-01" }] },
					},
					producerKind: "cli",
				} as unknown as StatsEventEnvelope,
			],
			{ producerKind: "cli", dbPath, now: at(7_000) },
		);

		const [r] = await query<{ at_ms: number; updated_at_ms: number }>("SELECT * FROM recall_receipts");
		expect(r?.at_ms).toBe(1_700_000_300_000);
		expect(r?.updated_at_ms).toBe(7_000);
	});
});

describe("unparkStuckEvents", () => {
	/**
	 * Parks one genuinely-defective event (`error`) and one whose type this build
	 * does not recognise (`unknown-type`, type not in `KNOWN_EVENT_TYPES`). BOTH are
	 * stuck for this build: `drainPending` only auto-revives `unknown-type` rows
	 * whose type IS known, so nothing returns either of these to the queue on its
	 * own — which is why `unparkStuckEvents` (sharing `REVIVABLE_PREDICATE` with the
	 * count `probeParkedEvents` reports) must reach both.
	 */
	async function parkTwo(): Promise<void> {
		await withDashboardDb(
			(db) => {
				db.prepare(
					`INSERT INTO events_raw (event_id, type, schema_version, received_at, data_json)
				 VALUES ('bad', 'session.upserted', ?, 't', 'not json')`,
				).run(STATS_EVENT_SCHEMA_VERSION);
				db.prepare(
					`INSERT INTO events_raw (event_id, type, schema_version, received_at, data_json)
				 VALUES ('future', 'commit.vibes', ?, 't', '{"type":"commit.vibes"}')`,
				).run(STATS_EVENT_SCHEMA_VERSION);
			},
			{ dbPath },
		);
		for (let i = 0; i < 5; i++) await applyStatsEvents([], { producerKind: "cli", dbPath });
	}

	it("reports zero — and stays silent — when there is nothing to revive", async () => {
		await applyStatsEvents([envelope(session())], { producerKind: "cli", dbPath });
		expect(await withDashboardDb((db) => unparkStuckEvents(db), { dbPath })).toBe(0);
	});

	it("returns EVERY stuck row to the queue with its attempt budget reset", async () => {
		await parkTwo();
		// Two, not one: an `unknown-type` whose type this build still cannot project is
		// as stuck as an `error` row — `drainPending` never revives it — so `--fix`
		// must reach it too, matching the count `probeParkedEvents`/`countStuckEvents`
		// reports. An earlier revision un-parked only `error`, leaving this row counted
		// but unreachable.
		expect(await withDashboardDb((db) => unparkStuckEvents(db), { dbPath })).toBe(2);
		const rows = await withDashboardDb(
			(db) =>
				db
					.prepare(
						"SELECT event_id, projection_status, attempts, failed_kind FROM events_raw ORDER BY event_id",
					)
					.all(),
			{ dbPath },
		);
		expect(rows).toEqual([
			{ event_id: "bad", projection_status: "pending", attempts: 0, failed_kind: null },
			{ event_id: "future", projection_status: "pending", attempts: 0, failed_kind: null },
		]);
	});

	it("leaves an auto-revivable unknown-type row for drainPending to own", async () => {
		// The exclusion `REVIVABLE_PREDICATE` encodes: a row parked `unknown-type`
		// whose type this build DOES know heals on the next drain, so touching it here
		// would reset a budget `drainPending` already owns. It is not in the stuck set,
		// so `unparkStuckEvents` must leave it exactly as it found it.
		await withDashboardDb(
			(db) =>
				db
					.prepare(
						`INSERT INTO events_raw (event_id, type, schema_version, received_at, data_json,
						                         projection_status, attempts, failed_kind)
						 VALUES ('revivable', 'session.upserted', ?, 't', '{}', 'failed', 5, 'unknown-type')`,
					)
					.run(STATS_EVENT_SCHEMA_VERSION),
			{ dbPath },
		);
		expect(await withDashboardDb((db) => unparkStuckEvents(db), { dbPath })).toBe(0);
		const row = await withDashboardDb(
			(db) =>
				db
					.prepare(
						"SELECT projection_status, attempts, failed_kind FROM events_raw WHERE event_id = 'revivable'",
					)
					.get(),
			{ dbPath },
		);
		expect(row).toEqual({ projection_status: "failed", attempts: 5, failed_kind: "unknown-type" });
	});

	it("actually recovers the data once the blocker is gone", async () => {
		// The real case this exists for: the event failed against a table a skipped
		// migration never created. With the table present, the same row projects.
		await parkTwo();
		await withDashboardDb(
			(db) =>
				db.prepare("UPDATE events_raw SET data_json = ? WHERE event_id = 'bad'").run(JSON.stringify(session())),
			{ dbPath },
		);
		await withDashboardDb((db) => unparkStuckEvents(db), { dbPath });
		// Only 'bad' projects — 'future' is still an unknown type to this build, so it
		// re-parks. The point is that the fixed row genuinely recovered.
		expect((await applyStatsEvents([], { producerKind: "cli", dbPath })).projected).toBe(1);
	});

	it("re-parks a row that is still defective instead of retrying it forever", async () => {
		// The cost of the exit being manual: reviving a genuinely poison event spends
		// one drain cycle and lands back on 'failed'. That is why nothing calls this
		// automatically. Both stuck rows come back parked (neither is projectable here).
		await parkTwo();
		await withDashboardDb((db) => unparkStuckEvents(db), { dbPath });
		for (let i = 0; i < 5; i++) await applyStatsEvents([], { producerKind: "cli", dbPath });
		expect(await withDashboardDb((db) => countStuckEvents(db), { dbPath })).toBe(2);
	});

	it("un-parks every failed row on a pre-migration schema (no failed_kind column)", () => {
		// The fallback that mirrors `countStuckEvents`: before the `failed_kind`
		// migration there is no column to null out or narrow by, so every `failed` row
		// is stuck and the whole set is un-parked with an UPDATE that never names it.
		let statements = 0;
		const handle = {
			prepare: () => {
				statements += 1;
				if (statements === 1)
					return {
						run: () => {
							throw new Error("no such column: failed_kind");
						},
					};
				return { run: () => ({ changes: 4 }) };
			},
		} as unknown as DashboardDbHandle;
		expect(unparkStuckEvents(handle)).toBe(4);
	});

	it("rethrows a genuine fault rather than un-parking around it", () => {
		const handle = {
			prepare: () => ({
				run: () => {
					throw new Error("database disk image is malformed");
				},
			}),
		} as unknown as DashboardDbHandle;
		expect(() => unparkStuckEvents(handle)).toThrow(/malformed/);
	});
});

describe("applyStatsEvents — rollup cache invalidation on a session day-move", () => {
	it("forgets the SOURCE day's cached rows when a session's updated_at_ms moves to another day", async () => {
		const T1 = 1_700_000_000_000; // 2023-11-14 (UTC)
		const T2 = T1 + 3 * 86_400_000; // three days later — a different local day
		const day1 = new Date(T1).toISOString().slice(0, 10);

		// The session lands on day1 and a rollup is settled for that day.
		await applyStatsEvents([envelope(session({ updatedAtMs: T1 }))], { producerKind: "cli", dbPath });
		await withDashboardDb(
			(db) => {
				const repoId = (
					db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get("repo-1") as { id: number }
				).id;
				const ins = db.prepare(
					`INSERT INTO stats_daily (repo_id, tz, day, kind, series_key, value, cost_usd, built_at_ms, updated_at_ms)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				);
				ins.run(0, "UTC", day1, "built", "", 0, 0, T1, T1); // sentinel: day1 is settled
				ins.run(repoId, "UTC", day1, "model", "claude-opus-5", 150, 0.5, T1, T1); // its data
			},
			{ dbPath },
		);

		// The SAME session, its clock moved to a different day. The staleness scan
		// only notices the destination, so without an explicit forget day1 would stay
		// cached and overstate forever.
		await applyStatsEvents([envelope(session({ updatedAtMs: T2 }))], { producerKind: "cli", dbPath });

		const remaining = await query<{ n: number }>(
			"SELECT COUNT(*) AS n FROM stats_daily WHERE tz = 'UTC' AND day = ?",
			day1,
		);
		expect(remaining[0].n).toBe(0);
	});
});
