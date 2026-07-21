import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { cursorWindow, ScrollView, scrollWindow, wrapLines } from "./Scrollable.js";

describe("wrapLines", () => {
	it("returns lines unchanged when each fits the width", () => {
		expect(wrapLines(["abc", "de"], 10)).toEqual(["abc", "de"]);
	});

	it("word-wraps at the last space within the width", () => {
		expect(wrapLines(["the quick brown fox"], 10)).toEqual(["the quick", "brown fox"]);
	});

	it("hard-splits a single token longer than the width", () => {
		expect(wrapLines(["abcdefghij"], 4)).toEqual(["abcd", "efgh", "ij"]);
	});

	it("preserves empty lines and returns lines unchanged for width <= 0", () => {
		expect(wrapLines(["", "x"], 5)).toEqual(["", "x"]);
		expect(wrapLines(["a very long line"], 0)).toEqual(["a very long line"]);
	});
});

describe("scrollWindow", () => {
	it("shows everything (no hidden) when content fits", () => {
		expect(scrollWindow(3, 10, 0)).toEqual({ start: 0, above: 0, below: 0 });
	});
	it("clamps the offset and reports above/below", () => {
		expect(scrollWindow(100, 16, 0)).toEqual({ start: 0, above: 0, below: 84 });
		expect(scrollWindow(100, 16, 10)).toEqual({ start: 10, above: 10, below: 74 });
		// Offset past the end is clamped so the last page is fully shown.
		expect(scrollWindow(100, 16, 999)).toEqual({ start: 84, above: 84, below: 0 });
	});
});

describe("cursorWindow", () => {
	it("no window when the list fits", () => {
		expect(cursorWindow(5, 8, 4)).toEqual({ start: 0, above: 0, below: 0 });
	});
	it("centers the cursor and keeps it visible", () => {
		// cursor 50, height 10 → start = 50 - 5 = 45
		expect(cursorWindow(100, 10, 50)).toMatchObject({ start: 45 });
		// near the top → start clamped to 0 (cursor still visible)
		expect(cursorWindow(100, 10, 2)).toMatchObject({ start: 0, above: 0 });
		// near the end → start clamped so the window ends at total
		expect(cursorWindow(100, 10, 99)).toMatchObject({ start: 90, below: 0 });
	});
});

describe("ScrollView", () => {
	it("renders a window with ▲/▼ more indicators", () => {
		const lines = Array.from({ length: 30 }, (_, i) => `line-${i}`);
		const { lastFrame } = render(<ScrollView lines={lines} height={5} offset={10} />);
		const out = lastFrame() ?? "";
		expect(out).toContain("▲ 10 more");
		expect(out).toContain("line-10");
		expect(out).toContain("line-14");
		expect(out).not.toContain("line-15");
		expect(out).toContain("▼ 15 more");
	});
	it("no indicators when everything fits", () => {
		const { lastFrame } = render(<ScrollView lines={["a", "b"]} height={5} offset={0} />);
		const out = lastFrame() ?? "";
		expect(out).not.toContain("more");
		expect(out).toContain("a");
		expect(out).toContain("b");
	});
	it("windows wide content horizontally and pans with colOffset", () => {
		const line = "0123456789ABCDEFGHIJ"; // 20 cols
		const { lastFrame } = render(<ScrollView lines={[line]} height={3} offset={0} width={10} colOffset={0} />);
		const out = lastFrame() ?? "";
		expect(out).toContain("0123456789"); // first 10 cols
		expect(out).not.toContain("ABCDEFGHIJ"); // right half clipped
		expect(out).toContain("cols 1–10");
		expect(out).toContain("▶"); // more to the right, nothing hidden left
		expect(out).not.toContain("◀");
	});
	it("shows a left affordance once panned right, and clamps at the end", () => {
		const line = "0123456789ABCDEFGHIJ"; // 20 cols
		const { lastFrame } = render(<ScrollView lines={[line]} height={3} offset={0} width={10} colOffset={999} />);
		const out = lastFrame() ?? "";
		expect(out).toContain("ABCDEFGHIJ"); // clamped to the last 10 cols
		expect(out).toContain("cols 11–20");
		expect(out).toContain("◀");
		expect(out).not.toContain("▶");
	});
});
