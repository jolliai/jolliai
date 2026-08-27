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
	PROJECTED_COLUMNS,
	SYNCED_COLUMNS,
	SYNCED_TABLES,
	type SyncedTable,
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
			const declared = declaredLocalColumns(table);
			// A local schema is a set of columns. Two wire projections may share one
			// source, but that source must appear exactly once in this local declaration.
			expect(new Set(declared).size).toBe(declared.length);
			// Nothing the schema has may be unaccounted for — that is the added-column
			// alarm, and the reason this is a set comparison rather than a length check.
			expect(actual.filter((c) => !declared.includes(c))).toEqual([]);
			// And every column the manifest SENDS must exist. (The excluded ones are
			// exempt in this direction on purpose: `metadata_json` is gone from the
			// definition but still present on older databases, so it is legitimately
			// absent here while still worth holding back.)
			const sent = declared.filter((c) => !EXCLUDED_COLUMNS[table].includes(c));
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

	it("projects every table's declared local columns without leaking the originals", async () => {
		// `repos.id` is an autoincrement: the same repo has a different integer on
		// every machine, so sending it would attach rows to whatever repo happened
		// to hold that id on the server.
		for (const table of SYNCED_TABLES) {
			const local = await columnsOf(table);
			for (const [to, from] of Object.entries(PROJECTED_COLUMNS[table])) {
				if (!local.includes(from)) continue;
				expect(SYNCED_COLUMNS[table]).toContain(to);
				expect(SYNCED_COLUMNS[table]).not.toContain(from);
			}
		}
	});

	it("never sends a transcript column, under any name", async () => {
		// A blunt second net under the per-table lists: the one thing the product
		// promises never leaves this machine is the conversation text. ⚠ NOTHING
		// exempts a match here — that is what separates tier 1 from tier 2 below.
		for (const table of SYNCED_TABLES) {
			for (const column of SYNCED_COLUMNS[table]) {
				expect(column).not.toMatch(TRANSCRIPT_NET);
			}
		}
	});

	// The second tier. `query` walked straight through the net above — the word is
	// not in it — so adding `memory_lookups` was not a matter of widening tier 1 but
	// of giving the guard a way to catch the NEXT such column. Matching this net is
	// not a failure; it is a requirement to have written down why.
	it("has a recorded reason for every free-text column it sends", async () => {
		for (const table of SYNCED_TABLES) {
			for (const column of SYNCED_COLUMNS[table]) {
				if (!FREE_TEXT_NET.test(column)) continue;
				const reason = FREE_TEXT_EXEMPTIONS[table]?.[column];
				expect(reason, `${table}.${column} needs a FREE_TEXT_EXEMPTIONS entry`).toBeDefined();
				// A stub cannot pass. The entry exists to make somebody state the case,
				// not to be a checkbox — an allowlist of one-word reasons is a rubber
				// stamp, which is the failure mode this whole tier has to avoid.
				expect((reason ?? "").length, `${table}.${column}`).toBeGreaterThanOrEqual(40);
			}
		}
	});

	it("carries no exemption that has stopped meaning anything", async () => {
		// The reverse direction, so the list cannot quietly become a pile of
		// pre-approvals for columns nobody is sending any more — or, worse, for ones
		// nobody has added yet.
		for (const [table, exemptions] of Object.entries(FREE_TEXT_EXEMPTIONS)) {
			expect(SYNCED_TABLES as ReadonlyArray<string>, `${table} is exempted but is not synced`).toContain(table);
			for (const column of Object.keys(exemptions)) {
				expect(SYNCED_COLUMNS[table as SyncedTable], `${table}.${column}`).toContain(column);
				expect(FREE_TEXT_NET.test(column), `${table}.${column} is exempted but the net never matched it`).toBe(
					true,
				);
				// ⚠ The tiers cannot be crossed. Tier 1 is the promise; an exemption
				// naming one of its columns would turn that promise into a preference.
				expect(TRANSCRIPT_NET.test(column), `${table}.${column} is a tier-1 column`).toBe(false);
			}
		}
		// The sensitive local source stays visible to the coverage guard, while the
		// wire uses a content-neutral name and carries only its INTEGER count.
		expect(PROJECTED_COLUMNS.skill_invocations.injected_chars).toBe("body_chars");
		expect(SYNCED_COLUMNS.skill_invocations).toContain("injected_chars");
		expect(SYNCED_COLUMNS.skill_invocations).not.toContain("body_chars");
		expect(SYNCED_COLUMNS.skill_invocations).not.toContain("args");
		expect(EXCLUDED_COLUMNS.skill_invocations).toContain("args");
	});
});

/** Tier 1: the conversation text, under any name. No exemption reaches it. */
const TRANSCRIPT_NET = /transcript|content|body|text/i;

/**
 * Tier 2: names that plausibly hold prose a human or a model wrote.
 *
 * ⚠ Deliberately short. Every token here that never names a real column costs a
 * meaningless exemption entry on the next column that trips it, and a list of
 * meaningless entries is exactly the rubber stamp the 40-character reason above
 * exists to prevent. Add a token when a real column makes the case, not on
 * speculation. `message_count` already sits here as a false positive, which is
 * the net working rather than a leak — but it is also the reason not to grow the
 * list on a hunch.
 */
const FREE_TEXT_NET = /query|prompt|message|title|term|snippet|excerpt|description|instruction/i;

/**
 * Every tier-2 column the channel sends, and why it is sent anyway.
 *
 * ⚠ Lives in the TEST, not in the manifest: nothing reads it at runtime, and an
 * allowlist belongs to the guard that consults it rather than to the thing being
 * guarded. `JolliMemorySessionColumns.test.ts` in the server repository carries
 * the mirror image, so a column added on either side has to be justified twice.
 */
const FREE_TEXT_EXEMPTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	sessions: {
		title: "The session's own title. Several agent hosts derive it from the user's FIRST MESSAGE, so it is conversation-adjacent text; the Settings copy discloses it in those words.",
		message_count:
			"An integer count of messages, never their content. It matches only because 'message' is in the net, which is the net doing its job rather than a leak.",
	},
	memory_lookups: {
		query: "The reader's own search string, verbatim. The Memory Top Search Terms card IS this text — the clustering picks each row's label out of it — so withholding it would withhold the feature, not trim it.",
		query_key:
			"The same string, lower-cased with whitespace collapsed. It is the bucket the card groups on, so it has to travel with the query it keys or the card lists terms whose tally cannot be found.",
	},
};
