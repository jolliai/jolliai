/**
 * MigrationFingerprints — the development-time guard that makes an edit to
 * already-shipped DDL fail HERE rather than on a user's machine.
 *
 * A writable open compares each logged migration's stored DDL against the constant
 * this build carries and REPORTS any divergence (`findDriftedMigrations`, listed by
 * `jolli doctor --schema-log`) — it does NOT refuse the database. The refuse-on-drift
 * behaviour was removed with the version gate: ~64% of the baseline entry is SQL
 * comments, so re-wrapping one must not lock every existing user out. Entry 0 is the
 * sharpest case — ~37 KB of baseline every database on earth has applied — where an
 * edit is now "reported as drift", never "old databases refuse".
 *
 * Reporting is right for the USER, but a silent DDL edit is still a bug the AUTHOR
 * should never ship — and that loud stop belongs in CI, not in an install. So the
 * content of each entry is
 * pinned here: change a DDL constant without updating its fingerprint and this
 * test fails, in the same shape and for the same reason as
 * `SkillInstaller.test.ts`'s body fingerprints.
 *
 * When an edit is genuinely intended, the honest move is almost always to APPEND
 * a new entry instead. Updating a fingerprint below is for a case where nothing
 * has the old bytes yet.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DASHBOARD_SCHEMA_VERSION, MIGRATIONS } from "./DashboardDb.js";

const fingerprint = (ddl: string): string => createHash("sha256").update(ddl).digest("hex").slice(0, 12);

/**
 * Name → content fingerprint, in slot order.
 *
 * The NAMES are the load-bearing half: a name is a permanent identifier, since
 * the log is keyed by it — rename one and every database reads it as never
 * applied, re-runs it, and dies on `duplicate column`. So this list may GROW and
 * may never lose or rename an entry. (Rails carries the same constraint on its
 * timestamped filenames.)
 */
const EXPECTED: ReadonlyArray<readonly [name: string, fingerprint: string]> = [
	["BASELINE_DDL", "88fc66f6dfcd"],
	["RECALL_RECEIPTS_DDL", "3319838df5a4"],
	["SKILL_CONTEXT_KIND_DDL", "fcded137e861"],
	["EVENT_FAILED_KIND_DDL", "a7cdc1abee65"],
	["TOOL_CALL_TIME_DDL", "6393ea338cd8"],
	["SCHEMA_MIGRATIONS_DDL", "151c9e7a7af7"],
];

describe("migration fingerprints", () => {
	it("has one expectation per entry, in slot order", () => {
		// Slot order matters even though identity does not depend on it: order is
		// still the execution order, and it is protected socially — APPEND only,
		// never insert into the middle, or an entry runs against a database that has
		// already applied its successors.
		expect(MIGRATIONS.map((m) => m.name)).toEqual(EXPECTED.map(([name]) => name));
		expect(MIGRATIONS).toHaveLength(EXPECTED.length);
	});

	for (const [index, [name, want]] of EXPECTED.entries()) {
		it(`${name} (slot ${index}) still carries the DDL it shipped with`, () => {
			// If this fails: you edited DDL that databases in the wild have already
			// applied, and every one of them will now refuse to open. Append a new
			// entry instead — or, if truly nothing has these bytes yet, update the
			// fingerprint deliberately in the same change.
			expect(fingerprint(MIGRATIONS[index].ddl)).toBe(want);
		});
	}

	it("keeps the version equal to the entry count", () => {
		expect(DASHBOARD_SCHEMA_VERSION).toBe(MIGRATIONS.length);
	});

	it("interpolates nothing at runtime, which is what makes a byte compare exact", () => {
		// The drift check compares stored text to these constants verbatim and has no
		// checksum column to fall back on. A template hole would make the same
		// migration hash differently per process and turn the check into noise.
		for (const m of MIGRATIONS) expect(m.ddl).not.toMatch(/\$\{/);
	});
});
