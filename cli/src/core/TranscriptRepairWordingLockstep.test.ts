import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The three-state memory-detail empty-conversations sentence (spec §9) is
 * rendered INDEPENDENTLY on three surfaces — the dashboard, the VS Code webview,
 * and the IntelliJ panel — because each host draws that panel itself. The strings
 * must stay identical, or the same memory reads differently depending on where
 * the user opens it, and the "repairable" wording that spec §9 exists to get
 * right (a failed capture must not read as "not yet") drifts on whichever surface
 * lags. Nothing else holds them together: the surfaces share no code here (one is
 * Kotlin), so a prose comment "keep these in sync" cannot fail. This test is that
 * forcing function — changing the wording means updating this pinned triple AND
 * all three surfaces in the same change.
 *
 * Same shape as NodeFloorLockstep.test.ts / SourceLabelsLockstep.test.ts.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

// The canonical strings, keyed by state. This test is their fourth copy on
// purpose: it is the pinned source of truth the three renderers are checked against.
const WORDING = {
	repairable: "Conversation capture is missing but repair may still be possible",
	repaired: "Conversation capture was repaired from local transcript history",
	empty: "No conversations were captured for this memory",
} as const;

const SURFACES = [
	"cli/src/dashboard/assets/js/memories.js",
	"vscode/src/views/SummaryScriptBuilder.ts",
	"intellij/src/main/kotlin/ai/jolli/jollimemory/core/TranscriptRepairState.kt",
] as const;

// The state each guarded sentence must be wired to. `empty` is deliberately
// absent: on all three surfaces it is the DEFAULT arm (a bare `return` / `var
// text = …` / `else ->`), reached when neither guard matched, so there is no
// keyword to anchor it to — the guarded pair being correct is what leaves it
// correct by construction.
const GUARDED = { repairable: "repairable", repaired: "repaired" } as const;

describe("transcript-repair empty-conversations wording is in lockstep across surfaces", () => {
	// A self-check on the pinned triple itself: two states rendering the SAME
	// sentence would make the per-surface mapping assertions below vacuously pass
	// (the wrong-state guard would still sit next to a matching string).
	it("pins three DISTINCT sentences", () => {
		expect(new Set(Object.values(WORDING)).size).toBe(Object.values(WORDING).length);
	});

	for (const surface of SURFACES) {
		it(`${surface} carries all three canonical strings verbatim`, () => {
			const source = read(surface);
			for (const [state, text] of Object.entries(WORDING)) {
				expect(
					source,
					`${surface} is missing the "${state}" wording — it drifted from the pinned triple`,
				).toContain(text);
			}
		});

		// The contains-check above proves the strings are PRESENT; it cannot catch a
		// mapping that points the `repairable` guard at the `repaired` sentence (or
		// vice-versa) — both strings are present either way. This anchors each
		// guarded sentence to its state token: the token must appear on the
		// sentence's own line or the two lines above it (same-line on memories.js /
		// Kotlin, one line up in the VS Code builder's `if (…) { text = … }`). Same
		// bidirectional spirit as SourceLabelsLockstep.
		it(`${surface} wires each guarded sentence to its own state`, () => {
			const lines = read(surface).split("\n");
			for (const [state, keyword] of Object.entries(GUARDED)) {
				const idx = lines.findIndex((l) => l.includes(WORDING[state as keyof typeof WORDING]));
				expect(idx, `${surface} is missing the "${state}" sentence`).toBeGreaterThanOrEqual(0);
				const near = lines
					.slice(Math.max(0, idx - 2), idx + 1)
					.join("\n")
					.toLowerCase();
				expect(
					near,
					`${surface} renders the "${state}" sentence without a nearby "${keyword}" guard — the state→sentence mapping drifted`,
				).toContain(keyword);
			}
			// The `empty` sentence must be the unguarded default, not a misrouted
			// guarded arm: its own line carries neither guarded state token.
			const emptyLine = lines.find((l) => l.includes(WORDING.empty)) ?? "";
			for (const keyword of Object.values(GUARDED)) {
				expect(
					emptyLine.toLowerCase(),
					`${surface} guards the empty-state sentence with "${keyword}" — it should be the default arm`,
				).not.toContain(keyword);
			}
		});
	}
});
