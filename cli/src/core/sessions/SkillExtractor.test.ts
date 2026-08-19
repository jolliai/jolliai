import { beforeEach, describe, expect, it, vi } from "vitest";

// The capability table is the seam: `supports` asks it rather than restating a list
// of agents, so driving it here is what pins that delegation.
vi.mock("../skills/SkillTranscriptScanner.js", () => ({ getSkillScanner: vi.fn() }));

import type { SkillInvocation, SkillUse, TranscriptSource } from "../../Types.js";
import { USAGE_SPLIT_LINE_1 } from "../skills/__fixtures__/claudeTranscript.js";
import { getSkillScanner } from "../skills/SkillTranscriptScanner.js";
import type { SessionSignalInput } from "./SessionSignalExtractor.js";
import { skillExtractor } from "./SkillExtractor.js";

function use(skill: string, invocations: ReadonlyArray<SkillInvocation>): SkillUse {
	return { source: "claude", skill, entryPaths: [], invocations };
}

/** A scanner stub that returns `uses` for any lines it is handed. */
function scannerFor(uses: ReadonlyArray<SkillUse>) {
	return { source: "claude" as const, scan: vi.fn(() => ({ uses, lastLine: 0 })) };
}

function input(
	lines: () => Promise<ReadonlyArray<string> | undefined>,
	source: TranscriptSource = "claude",
): SessionSignalInput {
	return {
		source,
		sessionId: "s1",
		transcriptPath: "/tmp/s1.jsonl",
		content: {
			read: async () => ({
				entries: [],
				newCursor: { transcriptPath: "/tmp/s1.jsonl", lineNumber: 0, updatedAt: "2026-08-01T00:00:00.000Z" },
				totalLinesRead: 0,
			}),
			lines,
		},
	};
}

beforeEach(() => {
	vi.mocked(getSkillScanner).mockReset();
});

describe("skillExtractor.supports", () => {
	it("says yes for a source the scanner table has", () => {
		vi.mocked(getSkillScanner).mockReturnValue(scannerFor([]));
		expect(skillExtractor.supports("claude")).toBe(true);
	});

	it("says no for a source the table has no scanner for", () => {
		// Asking the table rather than restating it is what makes a new scanner reach
		// the back-fill for free.
		vi.mocked(getSkillScanner).mockReturnValue(undefined);
		expect(skillExtractor.supports("opencode")).toBe(false);
	});
});

describe("skillExtractor.extract", () => {
	it("reports nothing when the source has no scanner", async () => {
		// The defensive half of `supports`: reached only if a caller extracts without
		// asking first.
		vi.mocked(getSkillScanner).mockReturnValue(undefined);
		expect(await skillExtractor.extract(input(async () => ["{}"]))).toEqual({});
	});

	it("reports nothing — NOT an empty list — for a source with no line-oriented transcript", async () => {
		// `{}` leaves the tool extractor's answer untouched; `{ tools: [] }` would be a
		// claim about a store this never opened.
		vi.mocked(getSkillScanner).mockReturnValue(scannerFor([use("code-review", [])]));
		const signals = await skillExtractor.extract(input(async () => undefined));
		expect(signals).toEqual({});
		expect(signals.tools).toBeUndefined();
	});

	it("reports nothing when the scan found no skills", async () => {
		vi.mocked(getSkillScanner).mockReturnValue(scannerFor([]));
		expect(await skillExtractor.extract(input(async () => ["{}"]))).toEqual({});
	});

	it("scans from line 0 — a whole-conversation read, not an incremental one", async () => {
		// The back-fill has no cursor here and must not touch the live discovery marks:
		// those are monotonic, so advancing one would strand the lines in between for
		// the StopHook that was going to read them.
		const scanner = scannerFor([]);
		vi.mocked(getSkillScanner).mockReturnValue(scanner);

		await skillExtractor.extract(input(async () => ["a", "b"]));

		expect(scanner.scan).toHaveBeenCalledWith(["a", "b"], 0);
	});

	it("turns one skill into a bucket named after the skill", async () => {
		// The skill's own name, matching what the `Skill` tool path reports, so the two
		// halves of one skill's usage fold together instead of appearing as two rows.
		vi.mocked(getSkillScanner).mockReturnValue(
			scannerFor([use("code-review", [{ at: "2026-08-01T10:00:00.000Z", ok: true }])]),
		);

		const signals = await skillExtractor.extract(input(async () => ["{}"]));

		expect(signals.tools).toEqual([
			{
				name: "code-review",
				kind: "skill",
				calls: 1,
				lastCallAtMs: Date.parse("2026-08-01T10:00:00.000Z"),
				// Forwarded, not reduced to the count: the dashboard writes one row per entry.
				invocations: [{ at: "2026-08-01T10:00:00.000Z", ok: true }],
			},
		]);
	});

	it("carries the attributed token spend onto the bucket", async () => {
		// The very figures `SkillAttribution.test.ts` pins for this fixture, reached
		// through the extractor — which is the point: the dashboard's per-skill numbers
		// and the ones the IDE panel reads out of `plans.json` are one measurement run
		// twice, not two implementations that agree until they don't.
		vi.mocked(getSkillScanner).mockReturnValue(
			scannerFor([use("superpowers:brainstorming", [{ at: "2026-07-12T11:08:35.523Z", ok: true }])]),
		);

		const signals = await skillExtractor.extract(input(async () => [USAGE_SPLIT_LINE_1]));

		expect(signals.tools?.[0]?.usage).toEqual({ input: 1, cached: 4162, output: 797, confidence: "attributed" });
	});

	it("leaves usage ABSENT — never zeroed — when nothing could be attributed", async () => {
		// Codex, Kimi and Cursor attribute nothing at all, and on a real machine they
		// are the majority of skill calls. A zeroed bucket would price their skills at
		// free rather than reporting them unmeasured, which is the distinction the whole
		// column exists to keep.
		vi.mocked(getSkillScanner).mockReturnValue(
			scannerFor([use("code-review", [{ at: "2026-08-01T10:00:00.000Z", ok: true }])]),
		);

		const signals = await skillExtractor.extract(input(async () => ["{}"]));

		expect(signals.tools?.[0]).not.toHaveProperty("usage");
	});

	it("counts calls as the number of invocations", async () => {
		vi.mocked(getSkillScanner).mockReturnValue(
			scannerFor([
				use("code-review", [
					{ at: "2026-08-01T10:00:00.000Z", ok: true },
					{ at: "2026-08-01T09:00:00.000Z", ok: true },
				]),
			]),
		);

		const signals = await skillExtractor.extract(input(async () => ["{}"]));

		expect(signals.tools?.[0].calls).toBe(2);
	});

	it("takes the MAXIMUM instant, not the first entry", async () => {
		// Claude, Kimi and OpenCode all sort newest-first, so for them the two are the
		// same number — this stops the value depending on an ordering convention that
		// lives in three separate scanners and is enforced nowhere.
		vi.mocked(getSkillScanner).mockReturnValue(
			scannerFor([
				use("code-review", [
					{ at: "2026-08-01T09:00:00.000Z", ok: true },
					{ at: "2026-08-01T11:00:00.000Z", ok: true },
				]),
			]),
		);

		const signals = await skillExtractor.extract(input(async () => ["{}"]));

		expect(signals.tools?.[0].lastCallAtMs).toBe(Date.parse("2026-08-01T11:00:00.000Z"));
	});

	it("omits the instant when every invocation is undateable, rather than writing 0", async () => {
		// A zero is a real instant in 1970 and would sort as the oldest call ever made;
		// absence is what readers fall back on.
		vi.mocked(getSkillScanner).mockReturnValue(scannerFor([use("code-review", [{ at: "not a date", ok: true }])]));

		const signals = await skillExtractor.extract(input(async () => ["{}"]));

		expect(signals.tools?.[0]).not.toHaveProperty("lastCallAtMs");
	});

	it("keeps a dateable instant beside an undateable one", async () => {
		vi.mocked(getSkillScanner).mockReturnValue(
			scannerFor([
				use("code-review", [
					{ at: "nope", ok: true },
					{ at: "2026-08-01T08:00:00.000Z", ok: true },
				]),
			]),
		);

		const signals = await skillExtractor.extract(input(async () => ["{}"]));

		expect(signals.tools?.[0].lastCallAtMs).toBe(Date.parse("2026-08-01T08:00:00.000Z"));
	});

	it("omits the instant for a skill with no invocations at all", async () => {
		vi.mocked(getSkillScanner).mockReturnValue(scannerFor([use("code-review", [])]));

		const signals = await skillExtractor.extract(input(async () => ["{}"]));

		expect(signals.tools).toEqual([{ name: "code-review", kind: "skill", calls: 0 }]);
	});

	it("reports one bucket per skill", async () => {
		vi.mocked(getSkillScanner).mockReturnValue(
			scannerFor([use("code-review", [{ at: "2026-08-01T10:00:00.000Z", ok: true }]), use("brainstorming", [])]),
		);

		const signals = await skillExtractor.extract(input(async () => ["{}"]));

		expect(signals.tools?.map((t) => t.name)).toEqual(["code-review", "brainstorming"]);
	});

	it("rethrows a scanner failure with the session named", async () => {
		const scanner = {
			source: "claude" as const,
			scan: vi.fn(() => {
				throw new Error("bad line");
			}),
		};
		vi.mocked(getSkillScanner).mockReturnValue(scanner);

		await expect(skillExtractor.extract(input(async () => ["{}"], "kimi"))).rejects.toThrow(
			/skill extraction failed for kimi\/s1: bad line/,
		);
	});
});
