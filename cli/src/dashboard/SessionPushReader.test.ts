import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TableCursor } from "../core/SessionPushCursor.js";
import { type DashboardDbHandle, withDashboardDb } from "./DashboardDb.js";
import {
	batchTables,
	FIRST_RUN_WINDOW_MS,
	isBatchEmpty,
	readDbInstanceId,
	readSessionBatch,
	readTableSlice,
} from "./SessionPushReader.js";

const NOW = Date.UTC(2026, 7, 12, 12, 0, 0);

/**
 * A cursor at the START of one millisecond — the empty key.
 *
 * The position a bare stamp denotes, so a case that only cares about the
 * millisecond can say so without spelling a key.
 */
const at = (stamp: number): TableCursor => ({ stamp, key: [] });

describe("session push reader", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jolli-sessionpush-"));
		dbPath = join(dir, "dashboard.db");
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const withDb = <T>(fn: (db: DashboardDbHandle) => T) => withDashboardDb(fn, { dbPath });

	/** Seeds one repo plus one session, with control over both clocks. */
	let seq = 0;
	async function seed(opts: {
		identity?: string;
		eventId?: string;
		updatedAtMs?: number;
		writtenAtMs?: number;
	}): Promise<void> {
		const identity = opts.identity ?? "https://github.com/acme/widgets";
		const sessionId = `s${++seq}`;
		const eventId = opts.eventId ?? `session:${identity}:claude:${sessionId}`;
		await withDb((db) => {
			db.prepare(
				`INSERT OR IGNORE INTO repos (repo_identity, repo_name, worktree_root, enabled_at)
				 VALUES (?, 'widgets', '/w', 1)`,
			).run(identity);
			const repo = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(identity) as { id: number };
			db.prepare(
				`INSERT INTO sessions (event_id, repo_id, source, session_id, title, updated_at_ms, written_at_ms,
				                       input_tokens, output_tokens, cached_tokens, est_cost_usd)
				 VALUES (?, ?, 'claude', ?, 'Refactor the push executor', ?, ?, 100, 10, 5, 0.5)`,
			).run(eventId, repo.id, sessionId, opts.updatedAtMs ?? NOW, opts.writtenAtMs ?? NOW);
		});
	}

	it("puts the repo's identity on the row, so one batch can carry many repos", async () => {
		await seed({});
		await seed({ identity: "https://github.com/acme/other", eventId: "session:other:claude:s2" });

		const batch = await withDb((db) => readSessionBatch(db, { cursors: {}, nowMs: NOW }));
		const identities = batch.sessions.rows.map((r) => r.repo_identity);

		expect(new Set(identities)).toEqual(
			new Set(["https://github.com/acme/widgets", "https://github.com/acme/other"]),
		);
		// The envelope has no repo field at all — this column is the only thing
		// that says where a row belongs.
		expect(batch.sessions.rows[0]).not.toHaveProperty("repo_id");
	});

	it("passes values through untouched", async () => {
		await seed({});

		const batch = await withDb((db) => readSessionBatch(db, { cursors: {}, nowMs: NOW }));
		const row = batch.sessions.rows[0];

		// Integers stay integers, a REAL stays a REAL, and text stays text. The point
		// is that "did this sync correctly" stays a field-by-field comparison rather
		// than a question about two representations.
		expect(row.updated_at_ms).toBe(NOW);
		expect(row.input_tokens).toBe(100);
		expect(row.est_cost_usd).toBe(0.5);
		expect(row.title).toBe("Refactor the push executor");
	});

	it("selects on the SYNC stamp, not the business clock", async () => {
		// The failure this prevents: `projectCommitSummary` enriches a session's
		// token split without touching `updated_at_ms` (which means "last active"),
		// so a sync keyed on that column would never see the better data it just
		// wrote.
		await seed({ updatedAtMs: 1_000, writtenAtMs: NOW });

		const stale = await withDb((db) =>
			readTableSlice(db, "sessions", { cursors: { sessions: at(2_000) }, nowMs: NOW }),
		);
		expect(stale.rows).toHaveLength(1);
		expect(stale.next?.stamp).toBe(NOW);
	});

	it("selects with >= so a shared millisecond is never skipped", async () => {
		// `>` would step over every row after the first in a millisecond, and
		// nothing ever revisits them. Re-sending costs nothing: the server upserts.
		await seed({ eventId: "a", writtenAtMs: 5_000 });
		await seed({ eventId: "b", writtenAtMs: 5_000 });

		const slice = await withDb((db) =>
			readTableSlice(db, "sessions", { cursors: { sessions: at(5_000) }, nowMs: NOW }),
		);
		expect(slice.rows).toHaveLength(2);
	});

	it("advances past a millisecond holding more rows than one batch", async () => {
		// The deadlock this keyset cursor exists to remove, caught in production: a
		// stamp is not a unique position, so `stamp >= cursor ORDER BY stamp LIMIT n`
		// returns the SAME first n rows on every pass once more than n rows share a
		// millisecond. The highest stamp seen then equals the cursor it started
		// from, the cursor stands still, and that table stops syncing for ever —
		// measured on a real machine as 9,657 rows stranded behind one millisecond
		// holding 840 of them, unmoved for five days.
		//
		// `sessions` takes 200 per batch; 201 rows on one millisecond is the
		// smallest case that overflows it.
		const SHARED = 7_000;
		for (let i = 0; i < 201; i++) await seed({ eventId: `e${String(i).padStart(3, "0")}`, writtenAtMs: SHARED });

		let cursor: TableCursor = at(SHARED);
		const seen = new Set<string>();
		for (let pass = 1; pass <= 3; pass++) {
			const slice = await withDb((db) =>
				readTableSlice(db, "sessions", { cursors: { sessions: cursor }, nowMs: NOW }),
			);
			for (const row of slice.rows) seen.add(String(row.event_id));
			expect(slice.next).toBeDefined();
			cursor = slice.next as TableCursor;
		}
		// Every row is delivered, inside the same millisecond, in three passes of a
		// 200-row batch. Against the stamp-only cursor this saw the first 200 rows
		// three times and `seen.size` stayed at 200.
		expect(seen.size).toBe(201);
	});

	it("applies the first-run window to the BUSINESS clock, never to the stamp", async () => {
		// A backfill rewrites every old row's stamp to "just now". Windowing on the
		// stamp would then admit sessions from years ago as though they were recent
		// — the window would filter nothing at all.
		await seed({ eventId: "old", updatedAtMs: NOW - FIRST_RUN_WINDOW_MS - 1, writtenAtMs: NOW });
		await seed({ eventId: "recent", updatedAtMs: NOW - 1_000, writtenAtMs: NOW });

		const first = await withDb((db) => readTableSlice(db, "sessions", { cursors: {}, nowMs: NOW }));
		expect(first.rows.map((r) => r.event_id)).toEqual(["recent"]);
		expect(first.skipped).toBe(1);

		// And with a cursor, the window is gone: this is a first-run trade, not a
		// standing filter.
		const later = await withDb((db) =>
			readTableSlice(db, "sessions", { cursors: { sessions: at(0) }, nowMs: NOW }),
		);
		expect(later.rows).toHaveLength(2);
	});

	it("windows a table with no clock of its own through its parent session", async () => {
		// `session_model_usage` has no instant of its own, and it used to get no
		// window at all — so a first run shipped the WHOLE table, including children
		// of the very sessions the window had just withheld. The server then held
		// usage it could only file under a session it was never sent.
		await seed({ eventId: "old", updatedAtMs: NOW - FIRST_RUN_WINDOW_MS - 1, writtenAtMs: NOW });
		await seed({ eventId: "recent", updatedAtMs: NOW - 1_000, writtenAtMs: NOW });
		await withDb((db) => {
			for (const eventId of ["old", "recent"]) {
				db.prepare(
					`INSERT INTO session_model_usage (session_event_id, model, input_tokens, output_tokens,
					                                  cached_tokens, updated_at_ms)
					 VALUES (?, 'sonnet', 1, 2, 3, ?)`,
				).run(eventId, NOW);
			}
		});

		const slice = await withDb((db) => readTableSlice(db, "session_model_usage", { cursors: {}, nowMs: NOW }));

		expect(slice.rows.map((r) => r.session_event_id)).toEqual(["recent"]);
		// Counted through the same predicate, so what the window admitted and what
		// it reports as the cost of the trade cannot drift apart.
		expect(slice.skipped).toBe(1);
	});

	it("does not advance the cursor past rows the window declined to send", async () => {
		// The window is inside the SELECT, so a row it excludes never reaches the
		// stamp scan — the cursor cannot step over a row that was never sent.
		await seed({ eventId: "old", updatedAtMs: NOW - FIRST_RUN_WINDOW_MS - 1, writtenAtMs: 9_000 });
		await seed({ eventId: "recent", updatedAtMs: NOW - 1_000, writtenAtMs: 4_000 });

		const slice = await withDb((db) => readTableSlice(db, "sessions", { cursors: {}, nowMs: NOW }));
		expect(slice.next?.stamp).toBe(4_000);
	});

	it("still advances when a whole batch would fall outside the first-run window", async () => {
		// The regression this pins: filtering AFTER `LIMIT` left a table whose oldest
		// `LIMIT` rows are all outside the window with nothing kept, so no stamp, so
		// no cursor — and the next run read and dropped exactly the same rows, for
		// ever. The migration backfills `written_at_ms` from `updated_at_ms`, so
		// stamp order tracks business order and that is the ORDINARY starting state
		// of any machine with a batch of history older than 90 days. A limit of 1
		// stands in for the real 200.
		// Both strictly BELOW the floor: the window is `>=`, so `NOW -
		// FIRST_RUN_WINDOW_MS` itself is still inside it.
		const old = NOW - FIRST_RUN_WINDOW_MS - 2;
		await seed({ eventId: "old-1", updatedAtMs: old, writtenAtMs: old });
		await seed({ eventId: "old-2", updatedAtMs: old + 1, writtenAtMs: old + 1 });
		await seed({ eventId: "recent", updatedAtMs: NOW - 1_000, writtenAtMs: NOW - 1_000 });

		const slice = await withDb((db) => readTableSlice(db, "sessions", { cursors: {}, nowMs: NOW }));
		// The in-window row is reached rather than being crowded out by two older
		// ones, and its stamp is what the cursor moves to.
		expect(slice.rows.map((r) => r.event_id)).toEqual(["recent"]);
		expect(slice.next?.stamp).toBe(NOW - 1_000);
		// Counted across the whole table, not just this batch — it is the backlog
		// the window declines, and it is reported once rather than understated.
		expect(slice.skipped).toBe(2);
	});

	it("omits empty tables from the wire payload", async () => {
		await seed({});
		const batch = await withDb((db) => readSessionBatch(db, { cursors: {}, nowMs: NOW }));
		expect(Object.keys(batchTables(batch))).toEqual(["sessions"]);
		expect(isBatchEmpty(batch)).toBe(false);
	});

	it("reports an empty batch when nothing is new", async () => {
		await seed({ writtenAtMs: 1_000 });
		const batch = await withDb((db) => readSessionBatch(db, { cursors: { sessions: at(2_000) }, nowMs: NOW }));
		expect(isBatchEmpty(batch)).toBe(true);
	});

	it("counts the whole backlog the first-run window declines, across the batch", async () => {
		// The window is a trade, not an optimisation, so what it cost has to be
		// visible somewhere rather than inferred from a batch that looks empty for
		// no stated reason. It is the table's whole backlog, counted once on the run
		// that declines it — a per-batch figure could only ever see as far as one
		// `LIMIT` reached.
		await seed({ eventId: "old-1", updatedAtMs: NOW - FIRST_RUN_WINDOW_MS - 1, writtenAtMs: NOW });
		await seed({ eventId: "old-2", updatedAtMs: NOW - FIRST_RUN_WINDOW_MS - 2, writtenAtMs: NOW });

		const batch = await withDb((db) => readSessionBatch(db, { cursors: {}, nowMs: NOW }));
		expect(isBatchEmpty(batch)).toBe(true);
		expect(batch.sessions.skipped).toBe(2);
	});

	it("withholds every table's rows for a disabled repo, and keeps the other repo's", async () => {
		// The promise the Settings page makes. `sessions` carries the repo itself;
		// the three child tables can only reach it through their parent session, so
		// each shape has to be exercised — a filter that covered `sessions` alone
		// would still ship the usage rows the charts are built from.
		await seed({ identity: "https://github.com/acme/off", eventId: "off" });
		await seed({ identity: "https://github.com/acme/on", eventId: "on" });
		await withDb((db) => {
			for (const eventId of ["off", "on"]) {
				db.prepare(
					`INSERT INTO session_model_usage (session_event_id, model, input_tokens, output_tokens,
					                                  cached_tokens, updated_at_ms)
					 VALUES (?, 'sonnet', 1, 2, 3, ?)`,
				).run(eventId, NOW);
				db.prepare(
					`INSERT INTO session_tool_use (session_event_id, tool_name, kind, calls, last_call_at_ms,
					                               updated_at_ms)
					 VALUES (?, 'Edit', 'builtin', 1, ?, ?)`,
				).run(eventId, NOW, NOW);
				db.prepare(
					`INSERT INTO session_usage_events (session_event_id, dedup_key, responded_at_ms, model,
					                                   input_tokens, output_tokens, cached_tokens, updated_at_ms)
					 VALUES (?, ?, ?, 'sonnet', 1, 2, 3, ?)`,
				).run(eventId, `${eventId}:1`, NOW, NOW);
			}
		});

		const batch = await withDb((db) =>
			readSessionBatch(db, {
				cursors: {},
				nowMs: NOW,
				excludedIdentities: new Set(["https://github.com/acme/off"]),
			}),
		);

		expect(batch.sessions.rows.map((r) => r.repo_identity)).toEqual(["https://github.com/acme/on"]);
		for (const table of ["session_model_usage", "session_tool_use", "session_usage_events"] as const) {
			expect(batch[table].rows.map((r) => r.session_event_id)).toEqual(["on"]);
		}
	});

	it("pages OVER a withheld row rather than stopping on it", async () => {
		// The deliberate cost of filtering inside the SELECT: the cursor advances
		// past a withheld row, so re-enabling the repo does not send its backlog —
		// which is what the Settings copy says. Holding the cursor back instead
		// would let one disabled repo's single row block every other repo's
		// statistics for ever.
		await seed({ identity: "https://github.com/acme/off", eventId: "off", writtenAtMs: 1_000 });
		await seed({ identity: "https://github.com/acme/on", eventId: "on", writtenAtMs: 2_000 });

		const slice = await withDb((db) =>
			readTableSlice(db, "sessions", {
				cursors: {},
				nowMs: NOW,
				excludedIdentities: new Set(["https://github.com/acme/off"]),
			}),
		);

		expect(slice.rows.map((r) => r.event_id)).toEqual(["on"]);
		expect(slice.next?.stamp).toBe(2_000);
	});

	it("is byte-identical to the unfiltered read when nothing is excluded", async () => {
		// The normal case on every machine: no disabled repo, so no predicate and no
		// parameters. An empty set must not become an `IN ()`.
		await seed({});
		const plain = await withDb((db) => readSessionBatch(db, { cursors: {}, nowMs: NOW }));
		const empty = await withDb((db) =>
			readSessionBatch(db, { cursors: {}, nowMs: NOW, excludedIdentities: new Set() }),
		);
		expect(empty).toEqual(plain);
	});

	it("never sends an absolute path for a repo with no remote", async () => {
		// `local:<hash>` is what the schema stores on purpose — the alternative puts
		// a home directory into every table. `getCanonicalRepoUrl`'s `file:///…`
		// fallback still exists elsewhere and must not reach this wire.
		await seed({ identity: "local:9f2a1c", eventId: "session:local:claude:s9" });

		const batch = await withDb((db) => readSessionBatch(db, { cursors: {}, nowMs: NOW }));
		const wire = JSON.stringify(batchTables(batch));

		expect(wire).toContain("local:9f2a1c");
		expect(wire).not.toContain("file://");
		expect(wire).not.toContain(dir);
	});

	it("reads the database identity without minting one", async () => {
		// This whole path is read-only. `ensureInstanceId` creates the id when it is
		// missing, which is right for a writer and wrong here — the sync must never
		// be the first thing that writes to the database.
		expect(await withDb(readDbInstanceId)).toBeUndefined();

		const { ensureInstanceId } = await import("./Backup.js");
		const minted = await withDb(ensureInstanceId);
		expect(await withDb(readDbInstanceId)).toBe(minted);
	});
});
