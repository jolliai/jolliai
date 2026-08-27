/**
 * The runner's contract, exercised against a real database and a fake server.
 *
 * The cases that matter here are the ones where a wrong choice loses data
 * silently: a cursor that never comes down when the backend changes, a throttle
 * mark that only records successes, a gate that reads the wrong switch.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JolliMemoryPushClient, SessionCursorAheadError } from "../core/JolliMemoryPushClient.js";
import {
	MIN_ATTEMPT_INTERVAL_MS,
	readSessionPushChannel,
	type TableCursor,
	writeSessionPushChannel,
} from "../core/SessionPushCursor.js";
import { type DashboardDbHandle, withDashboardDb } from "./DashboardDb.js";
import { BATCH_LIMITS } from "./SessionPushManifest.js";

const NOW = Date.UTC(2026, 7, 12, 12, 0, 0);

/**
 * A cursor at the START of one millisecond — the empty key.
 *
 * The position a bare stamp denotes, so a case that only cares about the
 * millisecond can say so without spelling a key. The fake servers here
 * deliberately ANSWER with bare numbers: the wire tolerates a backend that
 * echoes no tie-breaker, and that path must keep working.
 */
const at = (stamp: number): TableCursor => ({ stamp, key: [] });

const completedReplay = (scope = "https://acme.jolli.ai") => ({
	[scope]: {
		generation: "skills-mcps-fields-v1",
		completed: true,
		completedTables: ["sessions", "session_tool_use", "skill_invocations"],
		cursors: {},
	},
});

const h = vi.hoisted(() => ({
	loadConfig: vi.fn(),
	readRepoRegistryStrict: vi.fn(),
	isRepoDisabled: vi.fn(),
	getDashboardDbPath: vi.fn(),
	canUseDashboardDb: vi.fn(),
	log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Only `createLogger` is replaced: `errMsg` is what turns a thrown value into the
// reason string every branch below reports, so a wholesale mock would assert
// against text the production code never produces.
vi.mock("../Logger.js", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	createLogger: () => h.log,
}));

vi.mock("../core/SessionTracker.js", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	loadConfig: h.loadConfig,
}));

// The two halves of "which repos are switched off". Mocked rather than driven
// through real `profile.json` files because the predicate itself is
// `RepoRegistry`'s to test — here the question is only what the runner does with
// its answer.
vi.mock("./RepoRegistry.js", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	readRepoRegistryStrict: h.readRepoRegistryStrict,
	isRepoDisabled: h.isRepoDisabled,
}));

vi.mock("./DashboardDb.js", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	getDashboardDbPath: h.getDashboardDbPath,
	canUseDashboardDb: h.canUseDashboardDb,
}));

/** A client whose two used methods are stubs. */
function fakeClient(over: Partial<JolliMemoryPushClient> = {}): JolliMemoryPushClient {
	return {
		resolveBaseUrl: async () => "https://acme.jolli.ai",
		pushSessions: async () => ({ accepted: {}, cursor: {} }),
		...over,
	} as unknown as JolliMemoryPushClient;
}

describe("session sync runner", () => {
	let dir: string;
	let dbPath: string;
	let configDir: string;

	beforeEach(async () => {
		vi.clearAllMocks();
		// The runner states each stable skip reason once per PROCESS, and a vitest
		// file is one process for every case in it — so without this, a reason
		// reported by an earlier case would be missing from a later one's log.
		const { resetSessionSyncReportMemo } = await import("./SessionSyncRunner.js");
		resetSessionSyncReportMemo();
		dir = mkdtempSync(join(tmpdir(), "jolli-syncrun-"));
		dbPath = join(dir, "dashboard.db");
		configDir = join(dir, "cfg");
		h.loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x" });
		h.readRepoRegistryStrict.mockResolvedValue({ version: 1, repos: [] });
		h.isRepoDisabled.mockReturnValue(false);
		h.getDashboardDbPath.mockReturnValue(dbPath);
		h.canUseDashboardDb.mockReturnValue(true);
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const run = async (over: Record<string, unknown> = {}) => {
		const { runSessionSync } = await import("./SessionSyncRunner.js");
		return runSessionSync({ nowMs: NOW, configDir, force: true, client: fakeClient(), ...over });
	};

	async function seedSession(writtenAtMs = NOW): Promise<void> {
		await withDashboardDb(
			(db: DashboardDbHandle) => {
				db.prepare(
					`INSERT OR IGNORE INTO repos (repo_identity, repo_name, worktree_root, enabled_at)
				 VALUES ('https://github.com/acme/widgets', 'widgets', '/w', 1)`,
				).run();
				db.prepare(
					`INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms, written_at_ms)
				 VALUES ('e1', 1, 'claude', 's1', ?, ?)`,
				).run(NOW, writtenAtMs);
			},
			{ dbPath },
		);
	}

	/** `count` sessions with strictly increasing sync stamps. */
	async function seedMany(count: number): Promise<void> {
		await withDashboardDb(
			(db: DashboardDbHandle) => {
				db.prepare(
					`INSERT OR IGNORE INTO repos (repo_identity, repo_name, worktree_root, enabled_at)
					 VALUES ('https://github.com/acme/widgets', 'widgets', '/w', 1)`,
				).run();
				for (let i = 0; i < count; i++) {
					db.prepare(
						`INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms, written_at_ms)
						 VALUES (?, 1, 'claude', ?, ?, ?)`,
					).run(`e${i}`, `s${i}`, NOW, 1_000 + i);
				}
			},
			{ dbPath },
		);
	}

	/** One `memory_lookups` row, so a batch carries the newest synced table. */
	async function seedLookup(updatedAtMs = NOW): Promise<void> {
		await withDashboardDb(
			(db: DashboardDbHandle) => {
				db.prepare(
					`INSERT OR IGNORE INTO repos (repo_identity, repo_name, worktree_root, enabled_at)
					 VALUES ('https://github.com/acme/widgets', 'widgets', '/w', 1)`,
				).run();
				db.prepare(
					`INSERT INTO memory_lookups
					   (receipt_id, repo_id, kind, surface, session_id, at_ms, query, query_key,
					    result_count, hit, updated_at_ms)
					 VALUES ('lookup:r:search:mcp:1:45fd5fcd2b6bb6fd', 1, 'search', 'mcp', 's1', ?,
					         'rate limiter', 'rate limiter', 3, 1, ?)`,
				).run(NOW, updatedAtMs);
			},
			{ dbPath },
		);
	}

	/** `count` lookups with strictly increasing sync stamps — enough to truncate a batch. */
	async function seedLookups(count: number): Promise<void> {
		await withDashboardDb(
			(db: DashboardDbHandle) => {
				db.prepare(
					`INSERT OR IGNORE INTO repos (repo_identity, repo_name, worktree_root, enabled_at)
					 VALUES ('https://github.com/acme/widgets', 'widgets', '/w', 1)`,
				).run();
				for (let i = 0; i < count; i++) {
					db.prepare(
						`INSERT INTO memory_lookups
						   (receipt_id, repo_id, kind, surface, session_id, at_ms, query, query_key,
						    result_count, hit, updated_at_ms)
						 VALUES (?, 1, 'search', 'mcp', 's1', ?, 'rate limiter', 'rate limiter', 3, 1, ?)`,
					).run(`lookup:r:search:mcp:${i}:45fd5fcd2b6bb6fd`, NOW, 1_000 + i);
				}
			},
			{ dbPath },
		);
	}

	/** Puts `identities` in the registry, so `isRepoDisabled` gets asked about them. */
	function registered(...identities: string[]): void {
		h.readRepoRegistryStrict.mockResolvedValue({
			version: 1,
			repos: identities.map((repoIdentity, i) => ({
				repoIdentity,
				repoName: `r${i}`,
				worktreeRoot: `/w${i}`,
				enabledAt: "2026-08-12T00:00:00.000Z",
			})),
		});
	}

	/** A second repo with one session, so a filter can be seen to keep one and drop one. */
	async function seedSecondRepo(): Promise<void> {
		await withDashboardDb(
			(db: DashboardDbHandle) => {
				db.prepare(
					`INSERT OR IGNORE INTO repos (repo_identity, repo_name, worktree_root, enabled_at)
					 VALUES ('https://github.com/acme/gadgets', 'gadgets', '/g', 1)`,
				).run();
				db.prepare(
					`INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms, written_at_ms)
					 VALUES ('e2', 2, 'claude', 's2', ?, ?)`,
				).run(NOW, NOW);
			},
			{ dbPath },
		);
	}

	describe("gates", () => {
		it("sends nothing when syncSessions is off", async () => {
			h.loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x", syncSessions: false });
			await seedSession();
			const push = vi.fn();
			expect(await run({ client: fakeClient({ pushSessions: push } as never) })).toMatchObject({
				status: "skipped",
			});
			expect(push).not.toHaveBeenCalled();
		});

		it("sends nothing when not signed in", async () => {
			h.loadConfig.mockResolvedValue({});
			expect(await run()).toMatchObject({ status: "skipped", reason: "not signed in" });
		});

		it("withholds a disabled repository's rows whatever triggered the run", async () => {
			// `jolli disable` is a ROW FILTER here, not a gate: this run has no cwd at
			// all (the daemon's shape), and the rows must still stay put. The gate this
			// replaced could only answer for the repo that triggered the run, so a
			// commit in any OTHER repo shipped this one's backlog.
			await seedSession();
			registered("https://github.com/acme/widgets");
			h.isRepoDisabled.mockReturnValue(true);
			const push = vi.fn();
			await run({ client: fakeClient({ pushSessions: push } as never) });
			expect(push).not.toHaveBeenCalled();
		});

		it("still sends every OTHER repo's rows", async () => {
			// The failure the old gate had in the other direction: one switched-off
			// repo stopped the whole machine's statistics.
			await seedSession();
			await seedSecondRepo();
			registered("https://github.com/acme/widgets", "https://github.com/acme/gadgets");
			h.isRepoDisabled.mockImplementation(
				(repo: { repoIdentity: string }) => repo.repoIdentity === "https://github.com/acme/widgets",
			);
			// Typed parameter so the captured call keeps its shape — `vi.fn(async () =>
			// …)` infers an empty tuple for `calls`.
			const push = vi.fn(
				async (_payload: { tables: { sessions?: Array<{ repo_identity: string; repo_name: string }> } }) => ({
					accepted: {},
					cursor: {},
				}),
			);
			await run({ client: fakeClient({ pushSessions: push } as never) });
			const sent = push.mock.calls[0]?.[0];
			expect(sent?.tables.sessions?.map((r) => r.repo_identity)).toEqual(["https://github.com/acme/gadgets"]);
			expect(sent?.tables.sessions?.map((r) => r.repo_name)).toEqual(["gadgets"]);
		});

		it("sends nothing when the registry cannot be read", async () => {
			// Fail CLOSED, the one read in this module that does. Degrading to
			// "nothing is disabled" would upload statistics from a repo whose owner
			// switched the product off, and no later run can take that back.
			await seedSession();
			h.readRepoRegistryStrict.mockRejectedValue(new Error("EACCES"));
			const push = vi.fn();
			expect(await run({ client: fakeClient({ pushSessions: push } as never) })).toMatchObject({
				status: "skipped",
			});
			expect(push).not.toHaveBeenCalled();
		});

		it("skips whole on a runtime that cannot open the database", async () => {
			// A Node without flag-free `node:sqlite`, or a machine that never enabled
			// the dashboard. The rows stay put and the next capable runtime sends
			// them, so this is a skip rather than a failure — and it says so, because
			// otherwise it is indistinguishable from a machine with nothing new.
			h.canUseDashboardDb.mockReturnValue(false);
			await seedSession();
			const push = vi.fn();
			expect(await run({ client: fakeClient({ pushSessions: push } as never) })).toMatchObject({
				status: "skipped",
				reason: "runtime cannot open the database",
			});
			expect(push).not.toHaveBeenCalled();
		});

		it("sends for a repo with push turned off, and for one with no binding", async () => {
			// The decision this channel is built on: statistics do not follow the
			// memory push's rules. `syncOnPush: false` is that rule, and it must not
			// reach here — otherwise the switch in Settings would be lying.
			h.loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x", syncOnPush: false });
			await seedSession();
			const push = vi.fn(async () => ({ accepted: {}, cursor: {} }));
			await run({ client: fakeClient({ pushSessions: push } as never) });
			expect(push).toHaveBeenCalledTimes(1);
		});
	});

	describe("cursors", () => {
		it("keeps protocol 3 and preserves keyset positions", async () => {
			await seedSession();
			const push = vi.fn(async () => ({
				accepted: { sessions: 1 },
				cursor: { sessions: { stamp: 4_242, key: ["e1"] } },
			}));

			await run({ client: fakeClient({ pushSessions: push } as never) });

			expect(push).toHaveBeenCalledWith(expect.objectContaining({ version: 3 }));
			expect(readSessionPushChannel(configDir).byOrigin["https://acme.jolli.ai"]).toEqual({
				sessions: { stamp: 4_242, key: ["e1"] },
			});
		});

		it("adopts the server's cursor after a successful batch", async () => {
			await seedSession();
			await run({
				client: fakeClient({
					pushSessions: async () => ({ accepted: {}, cursor: { sessions: 4_242 } }),
				} as never),
			});
			const state = readSessionPushChannel(configDir);
			// Stored as a keyset even though the server answered with a bare number:
			// an empty key IS "the start of that millisecond", so nothing downstream
			// has to know which shape the answer arrived in.
			expect(state.byOrigin["https://acme.jolli.ai"]).toEqual({ sessions: at(4_242) });
		});

		it("replays affected tables from zero without changing unrelated normal cursors", async () => {
			await seedSession(1_000);
			writeSessionPushChannel(
				{
					version: 1,
					payloadVersion: 3,
					clientId: "c1",
					silencedByScope: {},
					byOrigin: {
						"https://acme.jolli.ai": {
							sessions: at(999_999),
							memory_lookups: at(700),
						},
					},
				},
				configDir,
			);
			const seen: Array<Record<string, TableCursor>> = [];
			await run({
				client: fakeClient({
					pushSessions: async (payload: { cursor: Record<string, TableCursor> }) => {
						seen.push(payload.cursor);
						// Deliberately higher than this local page. Replay pagination must
						// ignore it or the remaining historical range would be skipped.
						return { accepted: { sessions: 1 }, cursor: { sessions: at(999_999) } };
					},
				} as never),
			});

			expect(seen[0]).toEqual({
				sessions: at(0),
				session_tool_use: at(0),
				skill_invocations: at(0),
			});
			const stored = readSessionPushChannel(configDir);
			expect(stored.replayByScope?.["https://acme.jolli.ai"]?.completed).toBe(true);
			expect(stored.byOrigin["https://acme.jolli.ai"]?.sessions).toEqual({ stamp: 1_000, key: ["e1"] });
			expect(stored.byOrigin["https://acme.jolli.ai"]?.memory_lookups).toEqual(at(700));
		});

		it("replays more than one page from zero and advances only to each accepted page maximum", async () => {
			await seedMany(250);
			writeSessionPushChannel(
				{
					version: 1,
					payloadVersion: 3,
					clientId: "c1",
					silencedByScope: {},
					byOrigin: {
						"https://acme.jolli.ai": {
							sessions: at(999_999),
							session_tool_use: at(999_999),
						},
					},
				},
				configDir,
			);

			const seen: Array<{
				readonly cursor: Record<string, TableCursor>;
				readonly eventIds: ReadonlyArray<string>;
			}> = [];
			const push = vi.fn(
				async (payload: {
					readonly version: number;
					readonly cursor: Record<string, TableCursor>;
					readonly tables: { readonly sessions?: ReadonlyArray<Record<string, unknown>> };
				}) => {
					const rows = payload.tables.sessions ?? [];
					const last = rows.at(-1);
					expect(payload.version).toBe(3);
					expect(last).toBeDefined();
					seen.push({
						cursor: payload.cursor,
						eventIds: rows.map((row) => String(row.event_id)),
					});
					return {
						accepted: { sessions: rows.length },
						// The pre-existing high server cursor must not control local replay paging.
						cursor: { sessions: { stamp: 999_999, key: ["server-high"] } },
					};
				},
			);

			const outcome = await run({ client: fakeClient({ pushSessions: push } as never) });

			expect(outcome).toMatchObject({ status: "done", batches: 2 });
			expect(seen.map(({ cursor }) => cursor)).toEqual([
				{
					sessions: at(0),
					session_tool_use: at(0),
					skill_invocations: at(0),
				},
				{
					sessions: { stamp: 1_199, key: ["e199"] },
					session_tool_use: at(0),
					skill_invocations: at(0),
				},
			]);
			expect(seen.map(({ eventIds }) => eventIds.length)).toEqual([200, 51]);
			expect(new Set(seen.flatMap(({ eventIds }) => eventIds)).size).toBe(250);
			expect(readSessionPushChannel(configDir).byOrigin["https://acme.jolli.ai"]?.sessions).toEqual({
				stamp: 1_249,
				key: ["e249"],
			});
			expect(readSessionPushChannel(configDir).replayByScope?.["https://acme.jolli.ai"]?.completed).toBe(true);
		});

		it("persists replay progress at the run ceiling and resumes instead of starting over", async () => {
			await seedMany(2_100);
			writeSessionPushChannel(
				{
					version: 1,
					clientId: "c1",
					silencedByScope: {},
					byOrigin: { "https://acme.jolli.ai": { sessions: at(999_999) } },
				},
				configDir,
			);
			const seen: Array<Record<string, TableCursor>> = [];
			const push = vi.fn(
				async (payload: {
					readonly cursor: Record<string, TableCursor>;
					readonly tables: { readonly sessions?: ReadonlyArray<Record<string, unknown>> };
				}) => {
					seen.push(payload.cursor);
					return {
						accepted: { sessions: payload.tables.sessions?.length ?? 0 },
						cursor: { sessions: { stamp: 999_999_999, key: ["server-high"] } },
					};
				},
			);

			const first = await run({ client: fakeClient({ pushSessions: push } as never) });
			expect(first).toMatchObject({ status: "done", batches: 10 });
			const pending = readSessionPushChannel(configDir);
			expect(pending.replayByScope?.["https://acme.jolli.ai"]).toMatchObject({
				completed: false,
				cursors: { sessions: { stamp: 2_990, key: ["e1990"] } },
			});
			// Normal progress stays untouched until replay completion is committed.
			expect(pending.byOrigin["https://acme.jolli.ai"]?.sessions).toEqual(at(999_999));

			const secondStart = seen.length;
			const second = await run({ client: fakeClient({ pushSessions: push } as never) });
			expect(second).toMatchObject({ status: "done", batches: 1 });
			expect(seen[secondStart]?.sessions).toEqual({ stamp: 2_990, key: ["e1990"] });
			const completed = readSessionPushChannel(configDir);
			expect(completed.replayByScope?.["https://acme.jolli.ai"]?.completed).toBe(true);
			expect(completed.byOrigin["https://acme.jolli.ai"]?.sessions).toEqual({
				stamp: 3_099,
				key: ["e2099"],
			});
		});

		it("walks the cursor DOWN on 409 and re-sends that range", async () => {
			// The whole reason the mechanism exists: pushing to one backend, then
			// pointing the install at a fresh one. The local cursor still claims the
			// range was delivered, and only lowering it sends that range anywhere.
			await seedSession(1_000);
			writeSessionPushChannel(
				{
					version: 1,
					payloadVersion: 4,
					replayByScope: completedReplay(),
					clientId: "c1",
					silencedByScope: {},
					byOrigin: { "https://acme.jolli.ai": { sessions: at(999_999) } },
				},
				configDir,
			);
			const seen: Array<Record<string, TableCursor>> = [];
			const push = vi.fn(async (payload: { cursor: Record<string, TableCursor> }) => {
				seen.push(payload.cursor);
				if (seen.length === 1) throw new SessionCursorAheadError({ sessions: 500 });
				return { accepted: { sessions: 1 }, cursor: { sessions: 1_000 } };
			});

			const outcome = await run({ client: fakeClient({ pushSessions: push } as never) });

			expect(outcome.status).toBe("done");
			expect(seen[0]).toEqual({ sessions: at(999_999) });
			// The server's number, adopted and re-sent in this protocol's shape.
			expect(seen[1]).toEqual({ sessions: at(500) });
			expect(readSessionPushChannel(configDir).byOrigin["https://acme.jolli.ai"]).toEqual({
				sessions: at(1_000),
			});
		});

		it("treats a null server cursor as lower than anything, not as no opinion", async () => {
			// A brand-new or wiped backend has no record. Reading that as "no
			// opinion" and continuing from our own high-water mark is exactly how the
			// range before it never reaches that backend at all.
			await seedSession(1_000);
			writeSessionPushChannel(
				{
					version: 1,
					payloadVersion: 4,
					replayByScope: completedReplay(),
					clientId: "c1",
					silencedByScope: {},
					byOrigin: { "https://acme.jolli.ai": { sessions: at(999_999) } },
				},
				configDir,
			);
			let calls = 0;
			const push = vi.fn(async () => {
				calls++;
				if (calls === 1) throw new SessionCursorAheadError({ sessions: null });
				return { accepted: {}, cursor: { sessions: 1_000 } };
			});

			await run({ client: fakeClient({ pushSessions: push } as never) });

			// The cursor was cleared, so the second attempt is a first run again.
			expect(calls).toBe(2);
		});

		it("carries memory lookups in the same batch as the sessions", async () => {
			// The regression that matters for this table: the server's `tables` is a
			// closed schema, so a client sending a table the backend has not listed
			// gets a 2xx with the rows STRIPPED — and advances its cursor over rows
			// nobody stored. `recall_receipts`, the table this one replaces, did
			// exactly that for its whole life. Asserting the rows leave here is the
			// client half of that contract; the server half is its own route test.
			await seedSession();
			await withDashboardDb(
				(db: DashboardDbHandle) => {
					db.prepare(
						`INSERT INTO memory_lookups
						   (receipt_id, repo_id, kind, surface, session_id, at_ms, query, query_key,
						    result_count, hit, updated_at_ms)
						 VALUES ('lookup:r:search:mcp:1:45fd5fcd2b6bb6fd', 1, 'search', 'mcp', 's1', ?,
						         'Rate  Limiter', 'rate limiter', 3, 1, ?)`,
					).run(NOW, NOW);
				},
				{ dbPath },
			);
			const push = vi.fn(async () => ({ accepted: {}, cursor: {} }));

			await run({ client: fakeClient({ pushSessions: push } as never) });

			const [payload] = push.mock.calls[0] as unknown as [
				{ tables: Record<string, Array<Record<string, unknown>>> },
			];
			expect(payload.tables.memory_lookups).toHaveLength(1);
			expect(payload.tables.memory_lookups[0]).toMatchObject({
				query: "Rate  Limiter",
				query_key: "rate limiter",
				repo_identity: "https://github.com/acme/widgets",
			});
			// The branch a recall asked for is withheld, and no row carries the
			// machine-local repo id.
			expect(payload.tables.memory_lookups[0]).not.toHaveProperty("target");
			expect(payload.tables.memory_lookups[0]).not.toHaveProperty("repo_id");
		});

		it("holds the cursor of a table the server acknowledged in no way at all", async () => {
			// The silent half of the closed-schema hazard the case above describes. A
			// backend that has not learned `memory_lookups` STRIPS it and answers 2xx
			// with a cursor for everything it does know — so the rows reached nobody
			// and the batch's own high-water mark would step over them for ever.
			// Holding that one cursor is what makes the range survive until the
			// backend ships, with nothing to replay by hand.
			await seedSession(1_000);
			await seedLookup(2_000);
			const push = vi.fn(async () => ({ accepted: { sessions: 1 }, cursor: { sessions: 1_000 } }));

			await run({ client: fakeClient({ pushSessions: push } as never) });

			const cursors = readSessionPushChannel(configDir).byOrigin["https://acme.jolli.ai"];
			expect(cursors?.sessions).toEqual(at(1_000));
			expect(cursors?.memory_lookups).toBeUndefined();
			expect(h.log.warn).toHaveBeenCalledWith(
				expect.stringContaining("acknowledged neither a row count nor a cursor"),
				"https://acme.jolli.ai",
				"memory_lookups",
				// The rows the warning is about — the count the run then withholds from
				// its "sent" total, so the two cannot disagree about what was stripped.
				1,
			);
		});

		it("holds the one absent table when the reply names every OTHER table it knows", async () => {
			// ⚠ The reply below is the SHAPE A REAL BACKEND SENDS, captured from a live
			// one rather than composed here. Probed with a batch carrying a table the
			// server does not know:
			//
			//   {"accepted":{},"cursor":{"sessions":null,"session_activity":null,
			//    "session_model_usage":null,"session_tool_use":null,
			//    "session_usage_events":null,"memory_lookups":null}}
			//
			// Two things it settles, and neither is visible in a two-key mock. The
			// server fills a key for EVERY table it knows, `null` included — so an
			// ABSENT key really is "I do not know this table" and not "I have no
			// opinion". And the unknown table appeared in neither field, which is the
			// pair `unacknowledgedTables` reads.
			//
			// So this case is that reply with `memory_lookups` REMOVED: exactly what a
			// backend deployed before that table would answer. The other cases in this
			// block use a shorter reply on purpose — the wire tolerates it — but none
			// of them proves the client survives the real one.
			await seedSession(1_000);
			await seedLookup(2_000);
			const push = vi.fn(async () => ({
				accepted: { sessions: 1 },
				cursor: {
					sessions: at(1_000),
					session_activity: null,
					session_model_usage: null,
					session_tool_use: null,
					session_usage_events: null,
				},
			}));

			const outcome = await run({ client: fakeClient({ pushSessions: push } as never) });

			const cursors = readSessionPushChannel(configDir).byOrigin["https://acme.jolli.ai"];
			// The named tables are adopted — `null` means "this backend holds nothing",
			// which CLEARS rather than holds, and is what re-sends the window to a
			// fresh backend.
			expect(cursors?.sessions).toEqual(at(1_000));
			expect(cursors?.session_tool_use).toBeUndefined();
			// The absent one is HELD, which looks identical on disk and is not: its
			// rows were never stored, so the next run offers them from here again.
			expect(cursors?.memory_lookups).toBeUndefined();
			expect(outcome).toMatchObject({ held: { rows: 1, tables: ["memory_lookups"] } });
		});

		it("reaches the held-table path through the real client when an older backend strips a table", async () => {
			// This uses JolliMemoryPushClient rather than `fakeClient`: the regression was
			// precisely that the real client threw before this runner could inspect the
			// partial response, while every held-table test stopped at a fake boundary.
			await seedSession(1_000);
			await seedLookup(2_000);
			const fetchImpl = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							accepted: { sessions: 1 },
							cursor: {
								sessions: { stamp: 1_000, key: ["e1"] },
								session_activity: null,
								session_model_usage: null,
								session_tool_use: null,
								session_usage_events: null,
							},
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			);
			const client = new JolliMemoryPushClient({
				fetchImpl,
				baseUrlOverride: "https://acme.jolli.ai",
				apiKeyProvider: async () => "sk-jol-test",
			});

			const outcome = await run({ client });

			expect(fetchImpl).toHaveBeenCalledTimes(1);
			expect(readSessionPushChannel(configDir).byOrigin["https://acme.jolli.ai"]?.sessions).toEqual({
				stamp: 1_000,
				key: ["e1"],
			});
			expect(outcome).toMatchObject({
				status: "done",
				rows: 1,
				held: { rows: 1, tables: ["memory_lookups"] },
			});
		});

		it("counts a held table's rows out of the uploaded total, and reports them separately", async () => {
			// `rows` is what `jolli doctor` prints as "Uploaded N row(s)". A stripped
			// table stored nothing, so counting it there is the one place this failure
			// reads back as a success — and with only held rows to send, `rows` at 0
			// would have printed "up to date" for a machine that uploaded nothing. The
			// two numbers are kept apart rather than summed for exactly that reason.
			await seedSession(1_000);
			await seedLookup(2_000);
			const push = vi.fn(async () => ({ accepted: { sessions: 1 }, cursor: { sessions: 1_000 } }));

			const outcome = await run({ client: fakeClient({ pushSessions: push } as never) });

			expect(outcome).toMatchObject({
				status: "done",
				batches: 1,
				rows: 1,
				// The names travel with the count: this line is only ever reached when
				// backend-first deployment was broken, so it has to say for WHICH table.
				held: { rows: 1, tables: ["memory_lookups"] },
			});
		});

		it("keeps sending a held table, so it lands the day the backend learns it", async () => {
			// Held means "do not advance", never "stop offering". The rows go up on
			// every run; the first server that knows the name stores them.
			await seedLookup(2_000);
			const push = vi.fn(async () => ({ accepted: {}, cursor: { sessions: null } }));

			await run({ client: fakeClient({ pushSessions: push } as never) });
			await run({ client: fakeClient({ pushSessions: push } as never), force: true });

			expect(push).toHaveBeenCalledTimes(2);
			for (const call of push.mock.calls) {
				const [payload] = call as unknown as [{ tables: Record<string, unknown[]> }];
				expect(payload.tables.memory_lookups).toHaveLength(1);
			}
		});

		it("withholds a held table for the rest of the run rather than re-offering the same page", async () => {
			// The server cannot learn a table between two requests seconds apart, so a
			// re-offer can only be stripped again — while costing a full page in every
			// later request of the run (`BATCH_LIMITS` carries what one page weighs).
			// The rows are already safe: the same answer held their cursor, so the next
			// RUN offers them from exactly where they are. Counting them once instead
			// of once per attempt is the other half of it.
			await seedMany(250);
			await seedLookup(2_000);
			// `accepted` names sessions and nothing names `memory_lookups`, which is the
			// closed-schema shape: a 2xx that stripped one table. An empty cursor sends
			// sessions to the batch's own high-water mark, so the loop still advances.
			const push = vi.fn(async () => ({ accepted: { sessions: 200 }, cursor: {} }));

			const outcome = await run({ client: fakeClient({ pushSessions: push } as never) });

			expect(push).toHaveBeenCalledTimes(2);
			const sent = push.mock.calls as unknown as Array<[{ tables: Record<string, unknown[]> }]>;
			expect(sent[0][0].tables.memory_lookups).toHaveLength(1);
			expect(sent[1][0].tables).not.toHaveProperty("memory_lookups");
			// 200 + 51 sessions; the one held lookup is in neither total more than once.
			expect(outcome).toMatchObject({
				status: "done",
				batches: 2,
				rows: 251,
				held: { rows: 1, tables: ["memory_lookups"] },
			});
		});

		it("stops the run when a truncated batch moved no cursor, instead of re-sending one page", async () => {
			// A held table with a backlog above its batch limit reports "truncated" for
			// ever, so the loop's own end condition can never fire — it would spend the
			// whole per-run ceiling re-sending the identical page. The cursor is already
			// exactly where the next trigger should resume, so stopping costs nothing.
			writeSessionPushChannel(
				{
					version: 1,
					payloadVersion: 4,
					replayByScope: completedReplay(),
					clientId: "c1",
					silencedByScope: {},
					byOrigin: { "https://acme.jolli.ai": { memory_lookups: at(1) } },
				},
				configDir,
			);
			await seedLookups(BATCH_LIMITS.memory_lookups + 1);
			const push = vi.fn(async () => ({ accepted: { sessions: 0 }, cursor: { sessions: null } }));

			await run({ client: fakeClient({ pushSessions: push } as never) });

			expect(push).toHaveBeenCalledTimes(1);
			expect(readSessionPushChannel(configDir).byOrigin["https://acme.jolli.ai"]).toEqual({
				memory_lookups: at(1),
			});
		});

		it("advances a table the server DID acknowledge, even with no cursor of its own", async () => {
			// An `accepted` count is an acknowledgement on its own: the wire tolerates
			// a backend with no per-table cursor opinion, and treating that as "table
			// unknown" would freeze a channel that is working.
			await seedSession(1_000);
			const push = vi.fn(async () => ({ accepted: { sessions: 1 }, cursor: {} }));

			await run({ client: fakeClient({ pushSessions: push } as never) });

			// The batch's own high-water mark, keyset and all — the fallback the
			// acknowledgement re-enables, not a bare stamp.
			expect(readSessionPushChannel(configDir).byOrigin["https://acme.jolli.ai"]?.sessions).toEqual({
				stamp: 1_000,
				key: ["e1"],
			});
		});

		it("keeps each backend's progress separate", async () => {
			await seedSession();
			writeSessionPushChannel(
				{
					version: 1,
					payloadVersion: 4,
					replayByScope: completedReplay(),
					clientId: "c1",
					silencedByScope: {},
					byOrigin: { "https://dev.jolli.ai": { sessions: at(7) } },
				},
				configDir,
			);
			await run({
				client: fakeClient({ pushSessions: async () => ({ accepted: {}, cursor: { sessions: 99 } }) } as never),
			});
			const state = readSessionPushChannel(configDir);
			expect(state.byOrigin["https://dev.jolli.ai"]).toEqual({ sessions: at(7) });
			expect(state.byOrigin["https://acme.jolli.ai"]).toEqual({ sessions: at(99) });
		});

		it("gives up after two consecutive rejections instead of spinning", async () => {
			await seedSession(1_000);
			const push = vi.fn(async () => {
				throw new SessionCursorAheadError({ sessions: 1 });
			});
			const outcome = await run({ client: fakeClient({ pushSessions: push } as never) });
			expect(outcome.status).toBe("failed");
			expect(push.mock.calls.length).toBeLessThanOrEqual(3);
		});

		it("resets progress when the local database was rebuilt", async () => {
			// A rebuilt database re-derives rows whose stamps can be BELOW the stored
			// cursor — rows no cursor would ever select again, with nothing to report
			// it.
			const { ensureInstanceId } = await import("./Backup.js");
			await withDashboardDb(ensureInstanceId, { dbPath });
			await seedSession(1_000);
			writeSessionPushChannel(
				{
					version: 1,
					payloadVersion: 4,
					replayByScope: completedReplay(),
					clientId: "c1",
					silencedByScope: {},
					dbInstanceId: "a-different-database",
					byOrigin: { "https://acme.jolli.ai": { sessions: at(999_999) } },
				},
				configDir,
			);
			const push = vi.fn(async () => ({ accepted: {}, cursor: {} }));

			await run({ client: fakeClient({ pushSessions: push } as never) });

			expect(push).toHaveBeenCalledTimes(1);
			expect((push.mock.calls[0] as unknown as [{ cursor: unknown }])[0].cursor).toEqual({});
		});

		it("makes no request at all on a first run with nothing to send", async () => {
			// The empty-batch reconciliation buys one request per throttle window so
			// a client whose cursor sits above every local row still hears from the
			// server. It must NOT fire on a machine that has never synced: there is
			// no cursor to reconcile, so the request could only be empty in both
			// directions.
			await withDashboardDb(() => undefined, { dbPath });
			const push = vi.fn(async () => ({ accepted: {}, cursor: {} }));
			const outcome = await run({ client: fakeClient({ pushSessions: push } as never) });
			expect(push).not.toHaveBeenCalled();
			expect(outcome).toEqual({ status: "done", batches: 0, rows: 0, held: { rows: 0, tables: [] } });
		});

		it("binds to the database's identity on first sight, and keeps the cursor it already had", async () => {
			// Recording the id is not the same event as noticing a rebuild: the first
			// run has nothing to compare against, so it must adopt the id and leave
			// the progress alone. Clearing here would re-send the whole first-run
			// window to a backend that already has it, every time a machine upgraded
			// into this build.
			await seedSession(1_000);
			await withDashboardDb(
				(db: DashboardDbHandle) =>
					db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('instance-id', 'db-1')").run(),
				{ dbPath },
			);
			writeSessionPushChannel(
				{
					version: 1,
					payloadVersion: 4,
					replayByScope: completedReplay(),
					clientId: "c1",
					silencedByScope: {},
					byOrigin: { "https://acme.jolli.ai": { sessions: at(999_999) } },
				},
				configDir,
			);

			await run();
			const first = readSessionPushChannel(configDir);
			expect(first.dbInstanceId).toBe("db-1");
			expect(first.byOrigin["https://acme.jolli.ai"]).toEqual({ sessions: at(999_999) });

			// And the same database on the next run is not a rebuild either.
			await run();
			const second = readSessionPushChannel(configDir);
			expect(second.dbInstanceId).toBe("db-1");
			expect(second.byOrigin["https://acme.jolli.ai"]).toEqual({ sessions: at(999_999) });
		});
	});

	describe("what it reports", () => {
		/** True when some call's format string carries `text`. */
		const said = (calls: Array<unknown[]>, text: string): boolean => calls.some((c) => String(c[0]).includes(text));

		it("says why it is not uploading for each gate, instead of returning silently", async () => {
			// The failure this exists for: a switched-off toggle, an invalid key and a
			// silenced backend were all indistinguishable from a healthy machine with
			// nothing new to send — in the log, in the channel file, everywhere.
			h.loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x", syncSessions: false });
			await run();
			expect(said(h.log.info.mock.calls, "syncSessions is off")).toBe(true);
		});

		it("says so when there is no API key", async () => {
			h.loadConfig.mockResolvedValue({});
			await run();
			expect(said(h.log.info.mock.calls, "no API key configured")).toBe(true);
		});

		it("says so when a repository is being withheld", async () => {
			registered("https://github.com/acme/widgets");
			h.isRepoDisabled.mockReturnValue(true);
			await run();
			// `said` matches the FORMAT string, so the count is asserted separately.
			expect(said(h.log.info.mock.calls, "withholding %d disabled repository")).toBe(true);
			expect(h.log.info.mock.calls.some((c) => String(c[0]).includes("withholding") && c[1] === 1)).toBe(true);
		});

		it("states a stable reason ONCE per process, not once per trigger", async () => {
			// Every trigger on the machine asks again, and the answer holds for hours.
			// One line is the signal; forty-eight is a reason to stop reading the file.
			h.loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x", syncSessions: false });
			await run();
			await run();
			await run();
			expect(h.log.info.mock.calls.filter((c) => String(c[0]).includes("syncSessions is off"))).toHaveLength(1);
		});

		it("states a reason again once the memo has overflowed, instead of growing forever", async () => {
			// Every other memo key is a constant; the catch-all keys on the message,
			// which is arbitrary text. In the global daemon that set lives as long as
			// the machine is up, so it is capped — and overflowing degrades it to
			// "state this reason again", never to a leak and never to a lost line.
			const saidBoomZero = () => h.log.info.mock.calls.filter((c) => c[1] === "boom 0").length;
			h.loadConfig.mockRejectedValue(new Error("boom 0"));
			await run();
			await run();
			expect(saidBoomZero()).toBe(1);

			// Enough distinct reasons to fill the cap, at which point the memo starts over.
			for (let i = 1; i <= 64; i++) {
				h.loadConfig.mockRejectedValue(new Error(`boom ${i}`));
				await run();
			}
			h.loadConfig.mockRejectedValue(new Error("boom 0"));
			await run();
			expect(saidBoomZero()).toBe(2);
		});

		it("warns, with the scope, when a backend refuses the channel", async () => {
			const { PermissionDeniedError } = await import("../core/JolliMemoryPushClient.js");
			await seedSession();
			await run({
				client: fakeClient({
					pushSessions: async () => {
						throw new PermissionDeniedError("scope not enabled");
					},
				} as never),
			});
			expect(said(h.log.warn.mock.calls, "refused this channel")).toBe(true);
			// `flat()` + `toContain` rather than `some((c) => c.includes(scope))`, and the
			// reason is CodeQL rather than taste: that spelling reads to
			// `js/incomplete-url-substring-sanitization` as a URL literal inside a
			// containment check, even though the receiver is the ARGS ARRAY — where
			// `includes` is exact equality, not a substring test. The scope travels as its
			// own `%s` argument (see the `log.warn` call), so both forms assert the same
			// exact match; this one just cannot be misread as a host check.
			//
			// ⚠ Do NOT "fix" it by parsing and comparing `new URL(entry).host`: that
			// accepts `http://` and `https://acme.jolli.ai/tenant` too, and the scoped-URL
			// case below exists precisely because those are DIFFERENT scopes.
			expect(h.log.warn.mock.calls.flat()).toContain("https://acme.jolli.ai");
		});

		it("warns on a 401 rather than leaving an invalid key to retry forever in silence", async () => {
			// Not silenced — a key is re-issued by the user — so this one repeats every
			// half hour with nothing to show for it unless it says something.
			const { NotAuthenticatedError } = await import("../core/JolliMemoryPushClient.js");
			await seedSession();
			await run({
				client: fakeClient({
					pushSessions: async () => {
						throw new NotAuthenticatedError("bad key");
					},
				} as never),
			});
			expect(said(h.log.warn.mock.calls, "rejected our credentials")).toBe(true);
		});

		it("records the bypass when a forced run overrides a silence", async () => {
			const { PermissionDeniedError } = await import("../core/JolliMemoryPushClient.js");
			await seedSession();
			await run({
				client: fakeClient({
					pushSessions: async () => {
						throw new PermissionDeniedError("scope not enabled");
					},
				} as never),
			});
			h.log.info.mockClear();
			await run({ client: fakeClient({ pushSessions: async () => ({ accepted: {}, cursor: {} }) } as never) });
			expect(said(h.log.info.mock.calls, "retrying anyway (forced)")).toBe(true);
		});
	});

	describe("throttle and failure marks", () => {
		it("records the attempt even when the request fails", async () => {
			// ⚠ The opposite of the cursors, which only move on success. This is a
			// throttle: recording only successes makes every trigger retry a request
			// that is going to fail the same way.
			await seedSession();
			const outcome = await run({
				client: fakeClient({
					pushSessions: async () => {
						throw new Error("network down");
					},
				} as never),
			});
			expect(outcome.status).toBe("failed");
			expect(readSessionPushChannel(configDir).lastAttemptAtMs).toBe(NOW);
		});

		it("silences the refusing SCOPE for a day after a 403, not the machine", async () => {
			const { PermissionDeniedError } = await import("../core/JolliMemoryPushClient.js");
			await seedSession();
			await run({
				client: fakeClient({
					pushSessions: async () => {
						throw new PermissionDeniedError("scope not enabled");
					},
				} as never),
			});
			const state = readSessionPushChannel(configDir);
			expect(state.silencedByScope["https://acme.jolli.ai"]).toBeGreaterThan(NOW);

			// And an ordinary (unforced) run does not even reach the client.
			const push = vi.fn();
			const { runSessionSync } = await import("./SessionSyncRunner.js");
			const outcome = await runSessionSync({
				nowMs: NOW + MIN_ATTEMPT_INTERVAL_MS,
				configDir,
				client: fakeClient({ pushSessions: push } as never),
			});
			expect(outcome).toEqual({ status: "skipped", reason: "silenced" });
			expect(push).not.toHaveBeenCalled();
		});

		it("silences a 404 whose body carries the server's own message", async () => {
			// The end of the bug the CLASSES were introduced for. The runner used to
			// decide this by matching `/HTTP 404/` against the error message, while the
			// client raises `errorMessage(json)` whenever the body has one — so a
			// gateway answering `{"error":"Not Found"}` produced `Not Found`, matched
			// nothing, and the channel retried a missing endpoint every 30 minutes
			// indefinitely. Nothing about the message is asserted here on purpose: the
			// point of the fix is that the message stopped being the contract.
			const { SessionEndpointMissingError } = await import("../core/JolliMemoryPushClient.js");
			await seedSession();
			await run({
				client: fakeClient({
					pushSessions: async () => {
						throw new SessionEndpointMissingError("Not Found");
					},
				} as never),
			});
			expect(readSessionPushChannel(configDir).silencedByScope["https://acme.jolli.ai"]).toBeGreaterThan(NOW);
		});

		it("silences a 412 whose body carries prose instead of a status", async () => {
			// Same fix, on the branch whose whole purpose is to be findable: a 412 is
			// the response most likely to carry the server's own explanation, so the
			// old `/HTTP 412/` match was the least likely of the two to ever fire.
			const { SessionPreconditionFailedError } = await import("../core/JolliMemoryPushClient.js");
			await seedSession();
			await run({
				client: fakeClient({
					pushSessions: async () => {
						throw new SessionPreconditionFailedError("this deployment requires a binding");
					},
				} as never),
			});
			expect(readSessionPushChannel(configDir).silencedByScope["https://acme.jolli.ai"]).toBeGreaterThan(NOW);
		});

		it("leaves a DIFFERENT backend running while one is silenced", async () => {
			// The bug this replaced: one machine-wide mark, so a 403 from a
			// misconfigured deployment stopped a healthy one too — and re-pointing the
			// key at the healthy one changed nothing for 24h.
			const { PermissionDeniedError } = await import("../core/JolliMemoryPushClient.js");
			await seedSession();
			await run({
				client: fakeClient({
					resolveBaseUrl: async () => "https://refuses.jolli.ai",
					pushSessions: async () => {
						throw new PermissionDeniedError("scope not enabled");
					},
				} as never),
			});

			const push = vi.fn(async () => ({ accepted: {}, cursor: {} }));
			const { runSessionSync } = await import("./SessionSyncRunner.js");
			const outcome = await runSessionSync({
				nowMs: NOW + MIN_ATTEMPT_INTERVAL_MS,
				configDir,
				client: fakeClient({ pushSessions: push } as never),
			});

			expect(outcome.status).toBe("done");
			expect(push).toHaveBeenCalled();
		});

		it("lets an explicit forced run through a silence", async () => {
			// A user who has just fixed the server must not be told to wait a day; the
			// throttle-only bypass left editing the state file as the only way out.
			const { PermissionDeniedError } = await import("../core/JolliMemoryPushClient.js");
			await seedSession();
			await run({
				client: fakeClient({
					pushSessions: async () => {
						throw new PermissionDeniedError("scope not enabled");
					},
				} as never),
			});

			const push = vi.fn(async () => ({ accepted: {}, cursor: {} }));
			const outcome = await run({ client: fakeClient({ pushSessions: push } as never) });

			expect(outcome.status).toBe("done");
			expect(push).toHaveBeenCalled();
		});

		it("keeps two tenants on one origin apart", async () => {
			// `x-tenant-slug` comes off the same path segment this key does, so a
			// cursor cannot be filed against a tenant the rows did not go to.
			await seedSession();
			await run({
				client: fakeClient({
					resolveBaseUrl: async () => "https://one.jolli.ai/alpha",
					pushSessions: async () => ({ accepted: {}, cursor: { sessions: 11 } }),
				} as never),
			});
			await run({
				client: fakeClient({
					resolveBaseUrl: async () => "https://one.jolli.ai/beta",
					pushSessions: async () => ({ accepted: {}, cursor: { sessions: 22 } }),
				} as never),
			});

			const state = readSessionPushChannel(configDir);
			expect(state.byOrigin["https://one.jolli.ai/alpha"]).toEqual({ sessions: at(11) });
			expect(state.byOrigin["https://one.jolli.ai/beta"]).toEqual({ sessions: at(22) });
		});

		it("uses legacy bare-origin progress as proof that the scoped destination needs replay", async () => {
			await seedSession(1_000);
			writeSessionPushChannel(
				{
					version: 1,
					payloadVersion: 4,
					clientId: "c1",
					silencedByScope: {},
					byOrigin: { "https://acme.jolli.ai": { sessions: at(777) } },
				},
				configDir,
			);
			const seen: Array<Record<string, TableCursor>> = [];
			await run({
				client: fakeClient({
					resolveBaseUrl: async () => "https://acme.jolli.ai/tenant",
					pushSessions: async (p: { cursor: Record<string, TableCursor> }) => {
						seen.push(p.cursor);
						return { accepted: {}, cursor: {} };
					},
				} as never),
			});
			// The old origin cursor proves this is an upgrade, so the dedicated replay
			// starts all affected tables at zero and writes completion on the scope.
			expect(seen[0]).toEqual({ sessions: at(0), session_tool_use: at(0), skill_invocations: at(0) });
			expect(readSessionPushChannel(configDir).byOrigin["https://acme.jolli.ai/tenant"]).toBeDefined();
			expect(readSessionPushChannel(configDir).replayByScope?.["https://acme.jolli.ai/tenant"]?.completed).toBe(
				true,
			);
		});

		it("does not run again inside the throttle window", async () => {
			await seedSession();
			await run();
			const push = vi.fn();
			const { runSessionSync } = await import("./SessionSyncRunner.js");
			const outcome = await runSessionSync({
				nowMs: NOW + 1_000,
				configDir,
				client: fakeClient({ pushSessions: push } as never),
			});
			expect(outcome).toMatchObject({ status: "skipped", reason: "throttled" });
			expect(push).not.toHaveBeenCalled();
		});

		it("keeps a stable clientId across runs", async () => {
			await seedSession();
			await run();
			const first = readSessionPushChannel(configDir).clientId;
			await run();
			expect(readSessionPushChannel(configDir).clientId).toBe(first);
			expect(first).not.toBe("");
		});
	});

	it("batches through the backlog and stops when the remainder is short", async () => {
		await seedMany(250);
		const push = vi.fn(async () => ({ accepted: {}, cursor: {} }));

		const outcome = await run({ client: fakeClient({ pushSessions: push } as never) });

		// 200 + 50, then done: selection is `>=`, so a loop that waited for an empty
		// batch would re-send the boundary row until the per-run ceiling.
		expect(outcome).toMatchObject({ status: "done", batches: 2 });
		const sent = push.mock.calls as unknown as Array<[{ tables: { sessions: unknown[] } }]>;
		expect(sent[0][0].tables.sessions).toHaveLength(200);
		expect(sent[1][0].tables.sessions).toHaveLength(51);
	});

	it("stops at the per-run ceiling instead of draining a whole backlog at once", async () => {
		// A first run on a long-used machine can be thousands of rows, and a
		// background run is not the place to make dozens of serial requests. Stopping
		// early is not a failure — the cursor is what makes the rest someone else's
		// turn.
		const { MAX_BATCHES_PER_RUN } = await import("./SessionSyncRunner.js");
		await seedMany(2_100);
		const push = vi.fn(async () => ({ accepted: {}, cursor: {} }));

		const outcome = await run({ client: fakeClient({ pushSessions: push } as never) });

		expect(outcome).toMatchObject({ status: "done", batches: MAX_BATCHES_PER_RUN });
	});
});
