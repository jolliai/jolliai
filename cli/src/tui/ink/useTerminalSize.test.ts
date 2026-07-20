import { describe, expect, it } from "vitest";
import { fillRows, fitRows } from "./useTerminalSize.js";

describe("fitRows", () => {
	it("returns the default unchanged when the terminal height is unknown", () => {
		// The test renderer (and some pipes) report undefined rows — behaviour must
		// be identical to the old fixed constant.
		expect(fitRows(undefined, 9, 16)).toBe(16);
	});

	it("keeps the default on a roomy terminal (never grows past it)", () => {
		expect(fitRows(40, 9, 16)).toBe(16); // 40 - 9 = 31, clamped down to the 16 default
	});

	it("shrinks to fit a short terminal", () => {
		expect(fitRows(20, 9, 16)).toBe(11); // 20 - 9 = 11 < 16
	});

	it("never drops below the floor", () => {
		expect(fitRows(5, 9, 16)).toBe(3); // 5 - 9 = -4 → floored at 3
		expect(fitRows(6, 9, 16, 2)).toBe(2); // custom floor
	});
});

describe("fillRows", () => {
	it("returns the fallback unchanged when the terminal height is unknown", () => {
		expect(fillRows(undefined, 9, 16)).toBe(16);
	});

	it("GROWS past the fallback to fill a tall terminal (unlike fitRows)", () => {
		expect(fillRows(40, 9, 16)).toBe(31); // 40 - 9 = 31, NOT capped at 16
	});

	it("shrinks to fit a short terminal", () => {
		expect(fillRows(20, 9, 16)).toBe(11); // 20 - 9 = 11
	});

	it("never drops below the floor", () => {
		expect(fillRows(5, 9, 16)).toBe(3); // 5 - 9 = -4 → floored at 3
		expect(fillRows(6, 9, 16, 2)).toBe(2); // custom floor
	});
});
