/**
 * Tests for the Forge stylesheet builder.
 *
 * Forge CSS is mostly a vendored static block (~1300 lines) that we cover
 * with sanity checks rather than line-by-line — the value-add of these
 * tests is the dynamic override generator: hue interpolation, optional
 * font-family declaration, and the cascade order (base + overrides).
 */

import { describe, expect, it } from "vitest";
import { buildForgeCss, buildForgeOverrides } from "./Css.js";

describe("buildForgeOverrides", () => {
	it("interpolates the accent hue into hsl() declarations", () => {
		const result = buildForgeOverrides({ accentHue: 145 });
		expect(result).toContain("--nextra-primary-hue:        145");
		expect(result).toContain("hsl(145 84% 61%)");
	});

	it("emits dark-mode accent variants derived from the same hue", () => {
		const result = buildForgeOverrides({ accentHue: 200 });
		expect(result).toContain(".dark");
		expect(result).toContain("hsl(200 84% 68%)"); // dark accent
		expect(result).toContain("hsl(200 84% 11%)"); // dark accent-soft
	});

	it("emits a --forge-font-family declaration when fontFamily is set", () => {
		const result = buildForgeOverrides({ accentHue: 228, fontFamily: "'IBM Plex Sans', sans-serif" });
		expect(result).toContain("--forge-font-family: 'IBM Plex Sans', sans-serif");
	});

	it("omits --forge-font-family when fontFamily is undefined", () => {
		const result = buildForgeOverrides({ accentHue: 228 });
		expect(result).not.toContain("--forge-font-family:");
	});
});

describe("buildForgeCss", () => {
	it("includes the base Forge stylesheet sections", () => {
		const result = buildForgeCss({ accentHue: 228 });
		expect(result).toContain("Forge Theme");
		expect(result).toContain(".forge-sidebar-logo");
		expect(result).toContain(".forge-sidebar-search");
		expect(result).toContain(".nextra-navbar");
		expect(result).toContain(".nextra-toc");
	});

	it("appends the override block after the base CSS so cascade gives overrides precedence", () => {
		const result = buildForgeCss({ accentHue: 145 });
		const baseMarkerIdx = result.indexOf(".forge-footer-social");
		const overrideMarkerIdx = result.indexOf("Forge theme overrides (generated)");
		expect(baseMarkerIdx).toBeGreaterThan(-1);
		expect(overrideMarkerIdx).toBeGreaterThan(baseMarkerIdx);
	});

	it("does NOT include the auth banner block (CLI-strip)", () => {
		const result = buildForgeCss({ accentHue: 228 });
		expect(result).not.toContain(".jolli-auth-banner");
	});
});
