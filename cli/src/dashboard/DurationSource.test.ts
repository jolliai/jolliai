/**
 * `sessions.duration_ms` is a raw first-to-last-message span. Measured on the
 * live database it overstates activity by 7.6-26x, so a journey's duration
 * comes from `session_activity` buckets instead (`journeyActivityMinutes`).
 *
 * Source-shape rather than behavioural: a unit test cannot see a call site
 * added without going through the helper, and the value is a plausible-looking
 * integer that no seeded fixture would catch at the wrong scale.
 *
 * Comments are stripped first. `JourneysQuery.ts` names the column twice, in
 * prose, to say why it is not the source — the explanation is the point, and a
 * scan that forbade it would trade a real guard for a spelling rule.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toForwardSlash } from "../core/PathUtils.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Files that may name `duration_ms`, each for a reason that is not "a journey's
 * duration". Bidirectional: an entry that no longer matches fails the test, so
 * the list can only shrink.
 *
 * Keys are forward-slash relative paths from this file's directory (via {@link
 * toForwardSlash}) so a nested match — `migrations/` holds one file per
 * dashboard migration — compares the same on Windows as everywhere else this
 * suite runs.
 */
const ALLOWED = new Map<string, string>([
	[
		"migrations/2026-08-12-0000-baseline.ts",
		"declares the column — the sessions table DDL that used to be SotSchema.ts's ACTIVITY_DDL",
	],
	[
		"migrations/2026-08-12-0005-schema-migrations.ts",
		"the unrelated schema_migrations.duration_ms — used to be SotSchema.ts's SCHEMA_MIGRATIONS_DDL",
	],
	["DashboardDb.ts", "schema_migrations bookkeeping — how long a migration took"],
	["StatsWriter.ts", "writes the column"],
	["DbBackfill.ts", "writes and backfills the column"],
	["SessionPushManifest.ts", "names it in SYNCED_COLUMNS.sessions — a sync coverage list, not a duration source"],
	// Known separate surface: the Stats page's "legendary session" figure is
	// derived from the same raw span and is very likely inflated the same way.
	// Out of scope here, tracked as an open question in the spec.
	["DashboardQuery.ts", "Stats page's legendarySessionMinutes — pre-existing reader"],
]);

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(full);
		if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
		return [full];
	});
}

/** Block and line comments removed, so prose about the column does not count as a use. */
function stripComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
}

describe("duration has one definition", () => {
	it("no dashboard source outside the allowlist uses sessions.duration_ms", () => {
		const offenders = sourceFiles(HERE)
			.filter((file) => /\bduration_ms\b/u.test(stripComments(readFileSync(file, "utf8"))))
			.map((file) => toForwardSlash(file.slice(HERE.length + 1)))
			.filter((name) => !ALLOWED.has(name));

		expect(offenders).toEqual([]);
	});

	it("every allowlist entry still uses it, so the list can only shrink", () => {
		const using = new Set(
			sourceFiles(HERE)
				.filter((file) => /\bduration_ms\b/u.test(stripComments(readFileSync(file, "utf8"))))
				.map((file) => toForwardSlash(file.slice(HERE.length + 1))),
		);
		const stale = [...ALLOWED.keys()].filter((name) => !using.has(name));

		expect(stale).toEqual([]);
	});
});
