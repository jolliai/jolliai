import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getParserForSource, PARSER_BACKED_SOURCES } from "./TranscriptParser.js";

// ESM, not CJS — `cli` is pure ESM and `__dirname` is undefined here. See
// ClientHeader.test.ts for the same pattern.
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "transcripts");

/**
 * Sources with NO real conversation capture available on any machine that has
 * built this fixture set so far — JOLLI-2240's root cause was a hand-authored
 * fixture that looked plausible and quietly diverged from what the real agent
 * actually writes, so a fabricated kimi fixture would defeat the whole point
 * of this guard. The one real `~/.kimi-code/.../agents/main/wire.jsonl`
 * available belongs to a session whose login never completed (membership
 * verification failed before any model was configured), so it recorded only
 * `metadata`/`config.update`/tool-discovery bookkeeping — zero `turn.prompt`
 * or `content.part` events, i.e. zero conversation turns to capture from.
 *
 * This is a BIDIRECTIONAL gap list, the same idiom as `KNOWN_JVM_SOURCE_GAPS`:
 * it must shrink the moment a real kimi capture becomes available (Assertion
 * B below fails the instant a `kimi-wire.jsonl` fixture is dropped in without
 * also removing "kimi" from this set), and it must grow if a future
 * parser-backed source is added without a real fixture — Assertion A forces
 * that decision rather than letting a new source silently sit ungrounded.
 */
const PARSER_FIXTURE_GAPS: ReadonlySet<string> = new Set(["kimi"]);

/** Sources actually covered by a real captured fixture in this directory. */
const FIXTURE: Partial<Record<(typeof PARSER_BACKED_SOURCES)[number], string>> = {
	claude: "claude.jsonl",
	codex: "codex-response-item.jsonl",
};

describe("parser-backed sources extract conversation from a REAL captured fixture", () => {
	it("PARSER_FIXTURE_GAPS and FIXTURE partition PARSER_BACKED_SOURCES exactly", () => {
		for (const source of PARSER_BACKED_SOURCES) {
			const isGap = PARSER_FIXTURE_GAPS.has(source);
			const isCovered = source in FIXTURE;
			// Exactly one of the two must hold — never both (a covered source has no
			// business being excused as a gap) and never neither (a source this test
			// doesn't know how to check is a silent hole in the guard, not a pass).
			expect(isGap !== isCovered).toBe(true);
		}
	});

	for (const source of PARSER_BACKED_SOURCES) {
		const fixtureName = FIXTURE[source];
		if (fixtureName === undefined) continue;

		it(`${source}: parses ≥1 conversation entry from its own real capture`, () => {
			const path = join(FIXTURES_DIR, fixtureName);
			const lines = readFileSync(path, "utf8")
				.split("\n")
				.filter((l) => l.trim().length > 0);
			const parser = getParserForSource(source);
			const entries = lines.map((l, i) => parser.parseLine(l, i)).filter((e) => e !== null);
			// A parser that extracts nothing from its own source's real transcript has
			// silently gone dark — this is the JOLLI-2240 failure mode made loud in CI.
			expect(entries.length).toBeGreaterThan(0);
		});
	}

	for (const source of PARSER_FIXTURE_GAPS) {
		it(`${source}: has NO fixture yet (known gap — remove from PARSER_FIXTURE_GAPS once a real capture lands)`, () => {
			// Guards the other direction: a real fixture dropped in without also
			// updating PARSER_FIXTURE_GAPS/FIXTURE would silently keep skipping it.
			expect(existsSync(join(FIXTURES_DIR, `${source}-wire.jsonl`))).toBe(false);
		});
	}
});
