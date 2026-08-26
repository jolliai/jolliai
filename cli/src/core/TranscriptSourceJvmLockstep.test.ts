import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TRANSCRIPT_SOURCES } from "../Types.js";

/**
 * Pins the IntelliJ `TranscriptSource` enum to the CLI's `TRANSCRIPT_SOURCES`.
 *
 * `intellij/` is an independent Gradle build that the root `npm run all` does
 * not run, and the CLI↔Kotlin transcript-source lockstep is the kind of thing
 * every way of getting wrong is SILENT on the JVM side: Gson decodes an enum
 * name it does not know to `null`, and a null `source` NPEs the sidebar the
 * moment a row renders (`item.source.name`). The IntelliJ-side round-trip test
 * can only pin the members this build already declares; it cannot see a source
 * the CLI adds later.
 *
 * ## Why the gap list, rather than a flat "they must be equal"
 *
 * The Hermes integration deliberately ships the CLI half first and the IntelliJ
 * enum, config fields and UI wiring in a follow-up PR (see the KNOWN JVM GAP
 * markers in `Types.ts` / `Types.kt`). A flat equality test would reverse that
 * decision by making the CLI-side source addition red until the Kotlin lands
 * with it — the same policy `SourceLabelsLockstep.test.ts` records for the
 * reference-source `SourceId` enum.
 *
 * {@link KNOWN_JVM_TRANSCRIPT_SOURCE_GAPS} keeps the policy and removes the
 * "silent" part: a new source is either mirrored or written down here, in one
 * review-visible line. The list is checked in BOTH directions — every CLI
 * source is mirrored or gap-listed, and every gap entry must still be ABSENT
 * from the Kotlin enum — so an entry that has since been mirrored also fails,
 * forcing the list to shrink in the PR that closes the gap instead of
 * accumulating stale exemptions.
 */

/**
 * CLI transcript sources whose IntelliJ `TranscriptSource` member has not
 * landed yet.
 *
 * EMPTY, and that is the steady state — an entry here is a temporary record of
 * a follow-up PR that is still open, not a place to park a source. Add the id
 * with a one-line reason when the Kotlin genuinely has to ship separately;
 * delete it in the PR that adds the enum member (this test fails on a stale
 * one). Until then, the JVM decode boundary (`ActiveSessionAggregator
 * .filterAndApplyConfig`) drops the null-decoded source, so the staged rollout
 * is crash-free.
 */
const KNOWN_JVM_TRANSCRIPT_SOURCE_GAPS: ReadonlyArray<string> = [
	// `hermes` ships in this integration PR; IntelliJ support (enum member,
	// config fields, UI wiring) follows in a dedicated PR. Remove this entry
	// there — the second assertion below fails as soon as the enum lands.
	"hermes",
];

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const kotlinTypesPath = join(
	repoRoot,
	"intellij",
	"src",
	"main",
	"kotlin",
	"ai",
	"jolli",
	"jollimemory",
	"core",
	"Types.kt",
);
const kotlinTypes = readFileSync(kotlinTypesPath, "utf8");

/**
 * The `TranscriptSource` enum member names, backtick-quoting stripped.
 *
 * Throws on a malformed declaration rather than silently checking nothing: a
 * renamed enum that this parser no longer recognises is a member this test
 * claims to have checked and did not.
 */
function kotlinTranscriptSourceMembers(): ReadonlySet<string> {
	const match = /enum class TranscriptSource \{([\s\S]*?)\n\}/.exec(kotlinTypes);
	if (match === null) {
		throw new Error("Could not locate `enum class TranscriptSource` in intellij Types.kt");
	}
	// Strip `//` comments first — the KNOWN GAP note inside the enum body names
	// `hermes` in prose and must not be parsed as a member.
	const body = match[1].replace(/\/\/.*$/gm, "");
	const members = new Set<string>();
	for (const m of body.matchAll(/`?([a-zA-Z][a-zA-Z0-9-]*)`?/g)) {
		members.add(m[1]);
	}
	if (members.size === 0) {
		throw new Error("Parsed zero members from `enum class TranscriptSource` in intellij Types.kt");
	}
	return members;
}

const kotlinMembers = kotlinTranscriptSourceMembers();

describe("IntelliJ TranscriptSource lockstep", () => {
	it("every CLI transcript source is mirrored in the Kotlin enum or listed as a known gap", () => {
		for (const source of TRANSCRIPT_SOURCES) {
			if (kotlinMembers.has(source)) continue;
			expect(
				KNOWN_JVM_TRANSCRIPT_SOURCE_GAPS,
				`${source} is missing from the IntelliJ TranscriptSource enum and is not listed in KNOWN_JVM_TRANSCRIPT_SOURCE_GAPS`,
			).toContain(source);
		}
	});

	it("a known gap that has since landed in the Kotlin enum fails until removed from the list", () => {
		for (const gap of KNOWN_JVM_TRANSCRIPT_SOURCE_GAPS) {
			expect(
				kotlinMembers.has(gap),
				`${gap} is now in the IntelliJ TranscriptSource enum — remove it from KNOWN_JVM_TRANSCRIPT_SOURCE_GAPS in the PR that lands the member`,
			).toBe(false);
		}
	});

	it("every known gap names a real CLI transcript source", () => {
		for (const gap of KNOWN_JVM_TRANSCRIPT_SOURCE_GAPS) {
			expect(TRANSCRIPT_SOURCES).toContain(gap);
		}
	});
});
