import { describe, expect, it } from "vitest";
import { hexToHsl, resolveAccent } from "./ColorUtils.js";

describe("hexToHsl", () => {
	it("converts 6-digit hex to HSL", () => {
		// Pure red → h=0, s=100, l=50
		const result = hexToHsl("#FF0000");
		expect(result).toEqual({ h: 0, s: 100, l: 50 });
	});

	it("converts 3-digit shorthand hex", () => {
		const result = hexToHsl("#F00");
		expect(result).toEqual({ h: 0, s: 100, l: 50 });
	});

	it("converts hex without hash prefix", () => {
		const result = hexToHsl("00FF00");
		expect(result).toEqual({ h: 120, s: 100, l: 50 });
	});

	it("converts blue hex", () => {
		const result = hexToHsl("#0000FF");
		expect(result).toEqual({ h: 240, s: 100, l: 50 });
	});

	it("converts achromatic (grey) to zero saturation", () => {
		const result = hexToHsl("#808080");
		expect(result?.s).toBe(0);
		expect(result?.h).toBe(0);
	});

	it("converts white", () => {
		const result = hexToHsl("#FFFFFF");
		expect(result).toEqual({ h: 0, s: 0, l: 100 });
	});

	it("converts black", () => {
		const result = hexToHsl("#000000");
		expect(result).toEqual({ h: 0, s: 0, l: 0 });
	});

	it("converts indigo (Forge default hue ~228)", () => {
		// #4F46E5 → roughly h=243, s=75, l=58 (actual values)
		const result = hexToHsl("#4F46E5");
		expect(result).toBeDefined();
		expect(result?.h).toBeGreaterThan(200);
		expect(result?.s).toBeGreaterThan(50);
	});

	it("returns undefined for invalid hex", () => {
		expect(hexToHsl("not-a-color")).toBeUndefined();
	});

	it("returns undefined for too-short hex", () => {
		expect(hexToHsl("#AB")).toBeUndefined();
	});

	it("returns undefined for empty string", () => {
		expect(hexToHsl("")).toBeUndefined();
	});
});

describe("resolveAccent", () => {
	it("uses colors.primary hex when set", () => {
		const result = resolveAccent({ colors: { primary: "#FF0000" } }, 228, 84, 61);
		expect(result.hue).toBe(0);
		expect(result.saturation).toBe(100);
		expect(result.lightness).toBe(50);
	});

	it("passes through light and dark variants from colors", () => {
		const result = resolveAccent(
			{ colors: { primary: "#FF0000", light: "#FF8080", dark: "#800000" } },
			228,
			84,
			61,
		);
		expect(result.light).toBeDefined();
		expect(result.dark).toBeDefined();
		expect(result.light?.l).toBeGreaterThan(result.lightness);
		expect(result.dark?.l).toBeLessThan(result.lightness);
	});

	it("falls back to primaryHue when colors is not set", () => {
		const result = resolveAccent({ primaryHue: 300 }, 228, 84, 61);
		expect(result.hue).toBe(300);
		expect(result.saturation).toBe(84);
		expect(result.lightness).toBe(61);
	});

	it("falls back to default hue when both colors and primaryHue are unset", () => {
		const result = resolveAccent({}, 228, 84, 61);
		expect(result.hue).toBe(228);
		expect(result.saturation).toBe(84);
		expect(result.lightness).toBe(61);
	});

	it("falls back to default when theme is undefined", () => {
		const result = resolveAccent(undefined, 200, 70, 56);
		expect(result.hue).toBe(200);
		expect(result.saturation).toBe(70);
		expect(result.lightness).toBe(56);
	});

	it("ignores invalid hex in colors.primary and falls through to primaryHue", () => {
		const result = resolveAccent({ colors: { primary: "not-a-color" }, primaryHue: 150 }, 228, 84, 61);
		expect(result.hue).toBe(150);
	});

	it("colors.primary takes precedence over primaryHue", () => {
		const result = resolveAccent({ colors: { primary: "#00FF00" }, primaryHue: 300 }, 228, 84, 61);
		expect(result.hue).toBe(120); // green hue
	});
});
