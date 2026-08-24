/**
 * SchemaSnapshot — the checked-in description of what `MIGRATIONS` actually BUILDS.
 *
 * Every other guard on the migration list looks at the mechanism rather than the
 * result, and between them they leave one hole:
 *
 *  - `MigrationFingerprints.test.ts` pins the BYTES of each committed entry, so a
 *    shipped entry cannot be edited. It says nothing about what those bytes produce.
 *  - `DashboardDb.test.ts`'s "every migration is re-runnable" pins IDEMPOTENCE — the
 *    schema after a second run equals the schema after the first. It compares a
 *    database to itself, so an entry that creates the wrong thing passes as long as
 *    it creates the wrong thing consistently.
 *  - The companion tests pin what one `sql`-less entry creates, one object at a time.
 *
 * So nothing described the FINAL schema. A new entry that quietly drops a column
 * from a table it rebuilds, or an edit to one of the live DDL constants the code
 * entries are assembled from (`STATS_DAILY_TABLE_DDL`, `SYNC_STAMP_ZERO_BACKFILL_DDL`
 * — those are NOT fingerprinted, because their entries carry no `sql`), changes the
 * shape of every fresh install with nothing to notice. This file is that notice: the
 * snapshot is regenerated deliberately and the DIFF is the review artifact.
 *
 * It is also the answer to a plainer question this schema had no answer to. The DDL
 * constants in `SotSchema.ts` are frozen at the shape they shipped with — a column
 * added later exists only inside a migration entry, and `BASELINE_DDL` can never
 * gain it — so "what does this database look like right now?" could only be answered
 * by replaying thirteen entries in your head. Now it is a file you can read.
 *
 * ⚠ This is a snapshot, not an assertion of correctness. A regenerated snapshot is
 * only as good as the reading of its diff; that is precisely why regeneration is an
 * explicit env var rather than vitest's `-u`, which is one keystroke away from
 * rubber-stamping a schema change nobody looked at.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type DashboardDbHandle, MIGRATIONS, migrateDashboardDb } from "./DashboardDb.js";

const SNAPSHOT_PATH = join(import.meta.dirname, "schema.snapshot.txt");

/** Set to `1` to rewrite the snapshot. Deliberately not vitest's `-u`. */
const UPDATE_ENV = "JOLLI_UPDATE_SCHEMA_SNAPSHOT";

const REGEN_COMMAND = `${UPDATE_ENV}=1 npx vitest run src/dashboard/SchemaSnapshot.test.ts`;

/**
 * Raw IN-MEMORY handle: no pragmas, no migration pass — this file drives both by hand.
 *
 * `:memory:` rather than a temp file, and that is a safety property rather than a speed
 * one: nothing here needs to reopen a database, so there is no reason to have a path at
 * all — and with no path there is nothing that could ever resolve to the user's real
 * `~/.jolli/jollimemory/jollimemory.db`. The only file this test touches is the
 * snapshot, and only under {@link UPDATE_ENV}.
 */
async function rawDb(): Promise<DashboardDbHandle> {
	const { DatabaseSync } = await import("node:sqlite");
	return new DatabaseSync(":memory:") as unknown as DashboardDbHandle;
}

/**
 * Strips full-line `--` comments and collapses whitespace.
 *
 * Only FULL-LINE comments, and that limit is deliberate rather than lazy: a trailing
 * `-- …` could in principle sit inside a quoted string, where cutting at the `--`
 * would corrupt the statement. A line whose first non-blank characters are `--`
 * cannot be anything but a comment. Measured on the current schema this reaches all
 * but a handful of comment characters — the DDL carries 349 full-line comments and
 * effectively no trailing ones — so the cheap rule buys the whole benefit: the
 * snapshot stays about SHAPE, and rewrapping a comment in a live DDL constant does
 * not show up as a schema change.
 */
function normalizeSql(sql: string): string {
	return sql
		.split("\n")
		.filter((line) => !/^\s*--/.test(line))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

interface SchemaObject {
	readonly type: string;
	readonly name: string;
	readonly tbl_name: string;
	readonly sql: string;
}

/**
 * Every object this build's migrations create, in a stable order.
 *
 * `sqlite_%` names are SQLite's own — `sqlite_sequence` (which `schema_migrations`'s
 * `AUTOINCREMENT` brings into being) and the `sqlite_autoindex_*` entries a PRIMARY
 * KEY creates. They are consequences of the schema rather than part of it, and
 * `SessionPushManifest.test.ts` exempts the same name for the same reason.
 */
function schemaObjects(db: DashboardDbHandle): ReadonlyArray<SchemaObject> {
	return db
		.prepare(
			`SELECT type, name, tbl_name, COALESCE(sql, '') AS sql FROM sqlite_master
			  WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
		)
		.all() as ReadonlyArray<SchemaObject>;
}

/** One stanza per object: a header a human can scan, then the normalized SQL. */
function dumpObjects(db: DashboardDbHandle): string {
	const lines: string[] = [];
	for (const obj of schemaObjects(db)) {
		const on = obj.tbl_name !== obj.name ? ` ON ${obj.tbl_name}` : "";
		lines.push(`${obj.type.toUpperCase()} ${obj.name}${on}`);
		lines.push(`    ${normalizeSql(obj.sql)}`);
	}
	return lines.join("\n");
}

/**
 * Every table that has rows — which on a FRESH database is exactly the seed data the
 * migrations insert, with no hand-maintained list of "the lookup tables" to go stale.
 *
 * Seeds are worth pinning: they are `INSERT OR IGNORE` rows that a CHECK constraint
 * elsewhere then depends on (`context.kind` references `context_kinds`), so a seed
 * lost from an entry is a write that starts failing rather than a cosmetic change.
 */
function dumpSeedRows(db: DashboardDbHandle): string {
	const lines: string[] = [];
	for (const obj of schemaObjects(db)) {
		if (obj.type !== "table") continue;
		const columns = (
			db.prepare("SELECT name FROM pragma_table_info(?)").all(obj.name) as ReadonlyArray<{ name: string }>
		).map((row) => row.name);
		// Order by every column, so the dump cannot depend on physical row order.
		const order = columns.map((_, index) => index + 1).join(", ");
		const rows = db.prepare(`SELECT * FROM "${obj.name}" ORDER BY ${order}`).all();
		if (rows.length === 0) continue;
		lines.push(`${obj.name} (${rows.length} row${rows.length === 1 ? "" : "s"})`);
		for (const row of rows) lines.push(`    ${JSON.stringify(row)}`);
	}
	return lines.join("\n");
}

/** The file's contents: a self-describing header, the objects, then the seed rows. */
function buildSnapshot(db: DashboardDbHandle): string {
	return [
		"# GENERATED FILE — do not edit by hand.",
		"#",
		"# What `MIGRATIONS` in DashboardDb.ts builds on a fresh database: every schema",
		"# object with its SQL normalized (full-line `--` comments stripped, whitespace",
		"# collapsed), then every table that has rows — on a fresh database, exactly the",
		"# seed data the migrations insert.",
		"#",
		"# This is the only place the CURRENT shape of the database is written down: the",
		"# DDL constants are frozen at the shape they shipped with, so a column added by a",
		"# later entry appears in no CREATE statement anywhere in the source.",
		"#",
		"# Regenerate deliberately, and read the diff — it is the review artifact:",
		`#   ${REGEN_COMMAND}`,
		"",
		"# ── objects ─────────────────────────────────────────────────────────────────",
		dumpObjects(db),
		"",
		"# ── seed rows ───────────────────────────────────────────────────────────────",
		dumpSeedRows(db),
		"",
	].join("\n");
}

describe("dashboard schema snapshot", () => {
	it("matches the checked-in snapshot", async () => {
		const db = await rawDb();
		try {
			// The entries, not `migrateDashboardDb`: this pass wants the schema alone,
			// and the runner would also write log rows whose timestamps and client
			// version are not reproducible. The next test is what ties the two together.
			for (const migration of MIGRATIONS) migration.run(db);
			const actual = buildSnapshot(db);
			if (process.env[UPDATE_ENV] === "1") {
				writeFileSync(SNAPSHOT_PATH, actual);
				return;
			}
			expect(
				actual,
				`The schema built by MIGRATIONS no longer matches schema.snapshot.txt.\n` +
					`If the change is intended, regenerate it and review the diff:\n  ${REGEN_COMMAND}`,
			).toBe(readFileSync(SNAPSHOT_PATH, "utf8"));
		} finally {
			db.close();
		}
	});

	it("is what the real migration runner produces, not just what replaying the entries produces", async () => {
		// The snapshot above is built by calling each entry directly, which is the only
		// way to get a reproducible dump — so on its own it would say nothing about the
		// path every real install actually takes. `migrateDashboardDb` re-reads the log
		// inside a write lock, skips entries, holds rows for the entry that creates the
		// log table and toggles `foreign_keys`; this asserts none of that changes the
		// resulting schema. Objects only, since the runner's own log rows are not
		// reproducible and are the one difference that is expected.
		const replayed = await rawDb();
		const migrated = await rawDb();
		try {
			for (const migration of MIGRATIONS) migration.run(replayed);
			migrateDashboardDb(migrated);
			expect(dumpObjects(migrated)).toBe(dumpObjects(replayed));
		} finally {
			replayed.close();
			migrated.close();
		}
	});
});
