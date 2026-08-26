/**
 * MigrationFingerprints — the development-time guard that makes an edit to an
 * already-committed migration fail HERE rather than on someone else's machine.
 *
 * The rule it enforces: **a committed migration is never edited, not even an
 * unreleased one.** Ship a new entry for any delta. That is not a style preference —
 * `SESSION_STATS_SYNC_DDL` was edited in place while unreleased, and databases that
 * had logged the name under the older SQL skipped the newer SQL for ever, ending up
 * without `stats_daily` or `commits.written_at_ms` while their log said the migration
 * had run. The log is keyed by name; it cannot notice that the bytes moved.
 *
 * At runtime nothing compares the bytes any more — that content check (once
 * `findDriftedMigrations`, listed by `jolli doctor --schema-log`) was removed
 * because it could not tell this project's own equivalent rewrite from a foreign
 * build's; see the note at the end of `verifyMigrationLog` in `DashboardDb.ts`. What
 * survives there is a NAME check — a warning when a logged migration is unknown to
 * this build — which cannot be wrong about our own edits but also cannot catch this
 * specific failure (the same name, different bytes, both known to this build). That
 * is right for the user and useless for the author, so the loud stop lives here.
 *
 * ⚠ Fingerprints only reach entries carrying `sql`. A code entry logs `""` and so
 * compares equal to itself for ever — `requires a companion test` below is the whole
 * of their protection, which is why those tests must assert every object the entry
 * creates rather than "it did not throw".
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LEGACY_MIGRATION_NAMES, MIGRATIONS } from "./DashboardDb.js";

const fingerprint = (sql: string): string => createHash("sha256").update(sql).digest("hex").slice(0, 12);

/**
 * Name → content fingerprint, for every entry that carries `sql`, in array order.
 *
 * The NAMES are the load-bearing half: a name is a permanent identifier, since the
 * log is keyed by it — rename one and every database reads it as never applied,
 * re-runs it, and (before the idempotency pass) died on `duplicate column`. So this
 * list may GROW and may never lose or rename an entry. Rails carries the same
 * constraint on its timestamped filenames.
 *
 * ⚠ These fingerprints were recomputed ONCE, by the pass that made every statement
 * re-runnable: `CREATE` gained `IF NOT EXISTS`, the two `context_kinds` seeds gained
 * `OR IGNORE`. That edit was semantically identical on an empty database — which is the
 * only reason it was allowed — and the pass covers every entry that existed before it
 * landed, INCLUDING the two that arrived on `main` mid-flight. That is one pass, not a
 * precedent for a second: an entry committed after it may never be edited. Databases
 * that recorded any of these under the older bytes report them as drifted, correctly.
 * See the AGENTS.md rule.
 */
const EXPECTED: ReadonlyArray<readonly [name: string, fingerprint: string]> = [
	["BASELINE_DDL", "789d9527779e"],
	["RECALL_RECEIPTS_DDL", "891be7ac4377"],
	["SKILL_CONTEXT_KIND_DDL", "a3099c0f4f47"],
	["SCHEMA_MIGRATIONS_DDL", "4f649feb69b3"],
	// Unchanged by the idempotency pass, and the one entry that proves the pass was
	// only about re-runnability: its whole body is `DROP TRIGGER IF EXISTS`, which was
	// already safe to run twice.
	["REPOS_DELETE_ALLOWED_DDL", "52561786c1b7"],
	// Arrived on `main` while the idempotency pass was in flight on this branch, so they
	// belong to the SAME pre-idempotency population as the four above and were finished
	// the same way: `IF NOT EXISTS` added in place. Their add-column siblings
	// (`SKILL_TOKEN_USAGE_DDL`, `SKILL_PLUGIN_DDL`) could not be, so those are code
	// entries and are absent from this list by construction, not by omission.
	["SESSION_ACTIVITY_DDL", "6b9d168501ee"],
	["SKILL_INVOCATIONS_DDL", "70871ae1a43f"],
	// Covering index widening `ix_mt_transcript` with `commit_hash` so
	// `readSessionAggregates` (JourneysQuery.ts) matches (repo_id, transcript_id)
	// without a table fetch — see the entry's own file. Coaching page load was ~2.1 s
	// in this one scan, twice per render; the index makes it ~0.03 s. A pure-SQL
	// `sqlMigration`, so it carries a fingerprint; its two reachability siblings are
	// add-column code entries, absent from this list by construction and guarded by
	// their companion tests instead.
	["2026-08-25-0000-memory-transcripts-covering-index", "0b4cd41295aa"],
	["2026-08-26-0000-memory-lookups", "f6c22b277b2d"],
	// Keyset index `(recorded_at_ms, session_event_id, bucket_ms)` for
	// `session_activity`'s session-sync paging — the composite every sibling synced
	// table already carries, which the frozen `SESSION_ACTIVITY_DDL` shipped without.
	// A pure-SQL `sqlMigration`, so it is fingerprinted here rather than by a companion
	// test. See the entry's own file.
	["2026-08-27-0804-session-activity-keyset-index", "5fa9e542b152"],
];

/** `YYYY-MM-DD-HHMM-<subject>`, UTC. Uniqueness and a readable chronology. */
const TIMESTAMPED_NAME = /^\d{4}-\d{2}-\d{2}-\d{4}-[a-z0-9-]+$/;

describe("migration names", () => {
	it("keeps the legacy entries first, in their original order", () => {
		// Their names are frozen and their positions are the execution order every
		// existing database already took. A new entry goes after them, never among
		// them.
		expect(MIGRATIONS.slice(0, LEGACY_MIGRATION_NAMES.length).map((m) => m.name)).toEqual(LEGACY_MIGRATION_NAMES);
	});

	it("timestamps every entry appended after the legacy ones", () => {
		// The legacy names predate this convention and cannot be renamed, so the format
		// is required only from the first appended entry onward.
		for (const m of MIGRATIONS.slice(LEGACY_MIGRATION_NAMES.length)) {
			expect(m.name, `${m.name} must be YYYY-MM-DD-HHMM-<subject>`).toMatch(TIMESTAMPED_NAME);
		}
	});

	it("has no duplicate names", () => {
		// A duplicate would make the log ambiguous about which entry it recorded, and
		// the second one would be skipped for ever as "already applied".
		const names = MIGRATIONS.map((m) => m.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("appends in ascending timestamp order", () => {
		// Array order is the execution order and timestamps do NOT sort it — this keeps
		// the two from telling different stories. A back-dated entry appended at the end
		// would execute last while reading as if it came first.
		const stamps = MIGRATIONS.slice(LEGACY_MIGRATION_NAMES.length).map((m) => m.name.slice(0, 15));
		expect(stamps).toEqual([...stamps].sort());
	});
});

describe("migration fingerprints", () => {
	it("has one expectation per sql-carrying entry, in array order", () => {
		const withSql = MIGRATIONS.filter((m) => m.sql !== undefined).map((m) => m.name);
		expect(withSql).toEqual(EXPECTED.map(([name]) => name));
	});

	for (const [name, want] of EXPECTED) {
		it(`${name} still carries the SQL it was committed with`, () => {
			// If this fails: you edited a migration that databases have already applied.
			// Append a new entry instead — with its OWN body, never a second name pointing
			// at this entry's function.
			const entry = MIGRATIONS.find((m) => m.name === name);
			expect(fingerprint(entry?.sql ?? "")).toBe(want);
		});
	}

	it("interpolates nothing at runtime, which is what makes a byte compare exact", () => {
		// The drift check compares stored text to these constants verbatim and has no
		// checksum column to fall back on. A template hole would make the same
		// migration hash differently per process and turn the check into noise.
		for (const m of MIGRATIONS) expect(m.sql ?? "").not.toMatch(/\$\{/);
	});
});

describe("code migrations", () => {
	/**
	 * The only guard a `sql`-less entry has.
	 *
	 * Fingerprints cannot see them: the log stores `sql ?? ""`, so a code entry
	 * compares equal to itself no matter what its `run` does. Requiring the name to
	 * appear in SOME `migrations/*.test.ts` file is what stops one being added — or
	 * later quietly rewritten — with nothing asserting what it produces.
	 *
	 * Every entry now lives in its own file under `migrations/`, named by its real
	 * introduction date rather than by its `name` (see `migrations/index.ts`'s
	 * docblock), so the companion test cannot be found by building a path from
	 * `name` — it is found the same way a human would, by searching every test file
	 * in that directory. It must live under `migrations/`, never in
	 * `DashboardDb.test.ts`, which covers the engine (`migrateDashboardDb`,
	 * `verifyMigrationLog`, …) rather than any one entry's content.
	 */
	it("requires a companion test for every entry without sql", () => {
		const migrationsDir = join(import.meta.dirname, "migrations");
		const testFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".test.ts"));
		expect(testFiles.length).toBeGreaterThan(0);
		const combined = testFiles.map((f) => readFileSync(join(migrationsDir, f), "utf8")).join("\n");
		const codeEntries = MIGRATIONS.filter((m) => m.sql === undefined).map((m) => m.name);
		expect(codeEntries.length).toBeGreaterThan(0);
		for (const name of codeEntries) {
			expect(combined, `${name} has no companion test under migrations/*.test.ts`).toContain(name);
		}
	});

	/**
	 * No two entries may run the same body.
	 *
	 * A migration is one delta; two names pointing at one function are the same script
	 * twice, and the array then executes it twice on every fresh database. That is what
	 * a `2026-08-19-0000-session-stats-heal` entry did — it shared
	 * `applySessionStatsSchema` with `SESSION_STATS_SYNC_DDL` — and it was removed. This
	 * is what stops the shape coming back.
	 *
	 * `run` is compared by IDENTITY, which catches the case that actually occurs (two
	 * entries handed the same function). Two separately-written bodies that happen to
	 * be equivalent are not caught, and are not the problem: they are two scripts.
	 */
	it("gives every entry its own body", () => {
		const seen = new Map<unknown, string>();
		for (const m of MIGRATIONS) {
			const first = seen.get(m.run);
			expect(first, `${m.name} runs the same function as ${first} — one body, two names`).toBeUndefined();
			seen.set(m.run, m.name);
		}
	});
});
