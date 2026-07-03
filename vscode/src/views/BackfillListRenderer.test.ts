import { describe, expect, it } from "vitest";
import { backfillListRendererSource, formatBackfillMeta, formatBackfillResult } from "./BackfillListRenderer";

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

describe("backfillListRendererSource", () => {
	it("emits JS defining both label helpers, mirroring the TS wording", () => {
		const src = backfillListRendererSource();
		expect(src).toContain("function formatBackfillMeta(");
		expect(src).toContain("function formatBackfillResult(");
		// The emitted JS must produce the same strings as the TS functions —
		// eval the snippet in an isolated scope and compare a few cases.
		const factory = new Function(`${src}\nreturn { formatBackfillMeta, formatBackfillResult };`);
		const js = factory() as {
			formatBackfillMeta: (s: number, t: number) => string;
			formatBackfillResult: (s: number, t: number) => string;
		};
		expect(js.formatBackfillMeta(2, 5)).toBe(formatBackfillMeta(2, 5));
		expect(js.formatBackfillMeta(1, 1)).toBe(formatBackfillMeta(1, 1));
		expect(js.formatBackfillMeta(0, 0)).toBe(formatBackfillMeta(0, 0));
		expect(js.formatBackfillResult(3, 4)).toBe(formatBackfillResult(3, 4));
		expect(js.formatBackfillResult(0, 2)).toBe(formatBackfillResult(0, 2));
	});
});
