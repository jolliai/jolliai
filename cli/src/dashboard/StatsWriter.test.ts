import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardDbHandle } from "./DashboardDb.js";
import { withDashboardDb } from "./DashboardDb.js";
import type {
	CommitCreatedEvent,
	SessionUpsertedEvent,
	StatsEventEnvelope,
	WorktreeStatusEvent,
} from "./DashboardModel.js";
import { STATS_EVENT_SCHEMA_VERSION } from "./DashboardModel.js";
import { applyStatsEvents, drainPending, observeWorktree, pruneProjectedEvents } from "./StatsWriter.js";

vi.mock("../core/GitOps.js", () => ({
	execGit: vi.fn(),
}));

import { execGit } from "../core/GitOps.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-statsw-"));
	dbPath = join(dir, "dashboard.db");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const envelope = (event: SessionUpsertedEvent | CommitCreatedEvent | WorktreeStatusEvent): StatsEventEnvelope => ({
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
		// `Backfill.applyBatches` refuses to advance the summaries cursor while
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
		// `Backfill` asks "may I advance repo-1's summaries cursor?". Counting
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
		// table. `pending` gates `Backfill`'s summaries cursor, and a future-schema
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
