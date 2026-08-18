/**
 * The guard the whole table-shaped format depends on.
 *
 * Sending tables verbatim means the default for anything new is "it goes up".
 * These tests are what turns that default back into a decision: add a table, or
 * a column to a synced one, and they fail. A failure is a question — is this
 * meant to leave the machine? — not a list to widen on sight.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DashboardDbHandle, withDashboardDb } from "./DashboardDb.js";
import {
	EXCLUDED_COLUMNS,
	NEVER_SYNCED_TABLES,
	REWRITTEN_COLUMNS,
	SYNCED_COLUMNS,
	SYNCED_TABLES,
} from "./SessionPushManifest.js";
import { declaredLocalColumns } from "./SessionPushReader.js";
import { SYNC_STAMP_TABLES, syncStampColumn } from "./SyncColumns.js";

describe("session push manifest", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jolli-manifest-"));
		dbPath = join(dir, "dashboard.db");
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const withDb = <T>(fn: (db: DashboardDbHandle) => T) => withDashboardDb(fn, { dbPath });

	const tableNames = () =>
		withDb((db) =>
			(
				db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
					name: string;
				}>
			).map((r) => r.name),
		);

	const columnsOf = (table: string) =>
		withDb((db) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));

	it("accounts for EVERY table: each one is either synced or explicitly not", async () => {
		// The partition is the mechanism. A new table lands in neither list and
		// fails here, which is the moment to decide — rather than the moment it
		// silently starts uploading, or silently does not.
		const actual = await tableNames();
		const declared = new Set<string>([...SYNCED_TABLES, ...NEVER_SYNCED_TABLES]);
		expect(actual.filter((t) => !declared.has(t))).toEqual([]);
		// And in the other direction, so a dropped table does not leave a name here
		// forever, pretending to protect something that no longer exists.
		const live = new Set(actual);
		expect([...declared].filter((t) => !live.has(t) && t !== "sqlite_sequence")).toEqual([]);
	});

	it("the two lists are disjoint", () => {
		const synced = new Set<string>(SYNCED_TABLES);
		expect(NEVER_SYNCED_TABLES.filter((t) => synced.has(t))).toEqual([]);
	});

	for (const table of SYNCED_TABLES) {
		it(`accounts for every column of ${table}`, async () => {
			const actual = await columnsOf(table);
			// Nothing the schema has may be unaccounted for — that is the added-column
			// alarm, and the reason this is a set comparison rather than a length check.
			expect(actual.filter((c) => !declaredLocalColumns(table).includes(c))).toEqual([]);
			// And every column the manifest SENDS must exist. (The excluded ones are
			// exempt in this direction on purpose: `metadata_json` is gone from the
			// definition but still present on older databases, so it is legitimately
			// absent here while still worth holding back.)
			const sent = declaredLocalColumns(table).filter((c) => !EXCLUDED_COLUMNS[table].includes(c));
			expect(sent.filter((c) => !actual.includes(c))).toEqual([]);
		});
	}

	it("sends the sync stamp of every table, so the server can derive its own cursor", () => {
		for (const table of SYNCED_TABLES) {
			expect(SYNCED_COLUMNS[table]).toContain(syncStampColumn(table));
		}
		// And every stamped table is in the channel: a table that carries a stamp
		// but is not sent is either a missing decision or a stale stamp.
		expect([...SYNC_STAMP_TABLES].sort()).toEqual([...SYNCED_TABLES].sort());
	});

	it("rewrites the machine-local surrogate key and nothing else", async () => {
		// `repos.id` is an autoincrement: the same repo has a different integer on
		// every machine, so sending it would attach rows to whatever repo happened
		// to hold that id on the server.
		for (const table of SYNCED_TABLES) {
			const local = await columnsOf(table);
			for (const [from, to] of Object.entries(REWRITTEN_COLUMNS)) {
				if (!local.includes(from)) continue;
				expect(SYNCED_COLUMNS[table]).toContain(to);
				expect(SYNCED_COLUMNS[table]).not.toContain(from);
			}
		}
	});

	it("never sends a transcript column, under any name", async () => {
		// A blunt second net under the per-table lists: the one thing the product
		// promises never leaves this machine is the conversation text.
		for (const table of SYNCED_TABLES) {
			for (const column of SYNCED_COLUMNS[table]) {
				expect(column).not.toMatch(/transcript|content|body|text/i);
			}
		}
	});
});
