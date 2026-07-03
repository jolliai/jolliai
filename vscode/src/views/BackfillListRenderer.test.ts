import { describe, expect, it } from "vitest";
import {
	backfillListRendererSource,
	formatBackfillMeta,
	formatBackfillResult,
	formatColdStartNote,
} from "./BackfillListRenderer";

describe("formatBackfillMeta", () => {
	it("shows sessions + turns with correct pluralization", () => {
		expect(formatBackfillMeta(2, 5)).toBe("2 sessions · 5 turns");
	});
	it("uses singular for a count of 1", () => {
		expect(formatBackfillMeta(1, 1)).toBe("1 session · 1 turn");
	});
	it("shows 'Code change only' when there are no attributed sessions", () => {
		expect(formatBackfillMeta(0, 0)).toBe("Code change only");
	});
});

describe("formatBackfillResult", () => {
	it("shows sessions + topics when a conversation was attributed", () => {
		expect(formatBackfillResult(3, 4)).toBe("3 sessions · 4 topics");
	});
	it("uses singular for a count of 1", () => {
		expect(formatBackfillResult(1, 1)).toBe("1 session · 1 topic");
	});
	it("shows topics only when diff-only (no sessions)", () => {
		expect(formatBackfillResult(0, 2)).toBe("2 topics");
	});
});

describe("formatColdStartNote", () => {
	it("empty variant → the zero-memories copy (no count)", () => {
		expect(formatColdStartNote("empty", 0)).toContain("this repo has no memories yet");
	});
	it("gaps below the cap states the scope: 'from the last month (up to CAP)'", () => {
		const note = formatColdStartNote("gaps", 3, 10);
		expect(note).toContain("3 recent commits from the last month (up to 10)");
	});
	it("gaps with N=1 (below cap) → singular 'commit' (no verb-agreement error)", () => {
		const note = formatColdStartNote("gaps", 1, 10);
		expect(note).toContain("1 recent commit from the last month");
		expect(note).not.toContain("1 recent commits"); // singular noun, not plural
		// Regression: an earlier draft hardcoded "have" → "1 commit … have" (wrong).
		expect(note).not.toContain(" have ");
	});
	it("gaps at the cap (N=cap=10) → 'The 10 most recent' + points to Settings", () => {
		const note = formatColdStartNote("gaps", 10, 10);
		// Answers "I have many locally, why only 10?" — states the cap + full-scope route.
		expect(note).toContain("The 10 most recent commits from the last month");
		expect(note).toContain("manage all in Settings");
	});
});

describe("backfillListRendererSource", () => {
	it("emits JS defining the label + note helpers, mirroring the TS wording", () => {
		const src = backfillListRendererSource();
		expect(src).toContain("function formatBackfillMeta(");
		expect(src).toContain("function formatBackfillResult(");
		expect(src).toContain("function formatColdStartNote(");
		// The emitted JS must produce the same strings as the TS functions —
		// eval the snippet in an isolated scope and compare a few cases.
		const factory = new Function(
			`${src}\nreturn { formatBackfillMeta, formatBackfillResult, formatColdStartNote };`,
		);
		const js = factory() as {
			formatBackfillMeta: (s: number, t: number) => string;
			formatBackfillResult: (s: number, t: number) => string;
			formatColdStartNote: (v: "empty" | "gaps", n: number, cap: number) => string;
		};
		expect(js.formatBackfillMeta(2, 5)).toBe(formatBackfillMeta(2, 5));
		expect(js.formatBackfillMeta(1, 1)).toBe(formatBackfillMeta(1, 1));
		expect(js.formatBackfillMeta(0, 0)).toBe(formatBackfillMeta(0, 0));
		expect(js.formatBackfillResult(3, 4)).toBe(formatBackfillResult(3, 4));
		expect(js.formatBackfillResult(0, 2)).toBe(formatBackfillResult(0, 2));
		expect(js.formatColdStartNote("empty", 0, 10)).toBe(formatColdStartNote("empty", 0, 10));
		expect(js.formatColdStartNote("gaps", 1, 10)).toBe(formatColdStartNote("gaps", 1, 10)); // below cap
		expect(js.formatColdStartNote("gaps", 4, 10)).toBe(formatColdStartNote("gaps", 4, 10));
		expect(js.formatColdStartNote("gaps", 10, 10)).toBe(formatColdStartNote("gaps", 10, 10)); // capped
	});
});
