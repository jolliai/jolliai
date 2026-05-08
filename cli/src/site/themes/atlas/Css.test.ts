/**
 * Tests for the Atlas stylesheet builder. Confidence-checks the static
 * vendor + targeted assertions on the dynamic override generator.
 */

import { describe, expect, it } from "vitest";
import { buildAtlasCss, buildAtlasOverrides } from "./Css.js";

describe("buildAtlasOverrides", () => {
	it("interpolates the accent hue into hsl() declarations", () => {
		const result = buildAtlasOverrides({ accentHue: 145 });
		expect(result).toContain("--nextra-primary-hue:        145");
		expect(result).toContain("hsl(145 70% 56%)");
	});

	it("uses Atlas's saturation (70%) and lightness (56%) — distinct from Forge's 84%/61%", () => {
		const result = buildAtlasOverrides({ accentHue: 200 });
		expect(result).toContain("70% 56%");
		expect(result).not.toContain("84% 61%");
	});

	it("emits dark-mode accent variants tuned for Atlas's default dark palette", () => {
		const result = buildAtlasOverrides({ accentHue: 200 });
		expect(result).toContain(".dark");
		expect(result).toContain("hsl(200 70% 64%)"); // dark accent
		expect(result).toContain("hsl(200 70% 12%)"); // dark accent-soft
	});

	it("emits a --atlas-font-family declaration when fontFamily is set", () => {
		const result = buildAtlasOverrides({ accentHue: 200, fontFamily: "'Source Serif 4', serif" });
		expect(result).toContain("--atlas-font-family: 'Source Serif 4', serif");
	});

	it("omits --atlas-font-family when fontFamily is undefined", () => {
		const result = buildAtlasOverrides({ accentHue: 200 });
		expect(result).not.toContain("--atlas-font-family:");
	});
});

describe("buildAtlasCss", () => {
	it("includes the base Atlas stylesheet sections", () => {
		const result = buildAtlasCss({ accentHue: 200 });
		expect(result).toContain("Atlas");
		expect(result).toContain(".atlas-navbar-logo");
		expect(result).toContain("nextra-sidebar");
		expect(result).toContain("nextra-toc");
	});

	it("appends the override block after the base CSS so cascade gives overrides precedence", () => {
		const result = buildAtlasCss({ accentHue: 145 });
		const baseMarkerIdx = result.indexOf(".atlas-footer-social");
		const overrideMarkerIdx = result.indexOf("Atlas theme overrides (generated)");
		expect(baseMarkerIdx).toBeGreaterThan(-1);
		expect(overrideMarkerIdx).toBeGreaterThan(baseMarkerIdx);
	});

	it("does NOT include the auth banner block (CLI-strip)", () => {
		const result = buildAtlasCss({ accentHue: 200 });
		expect(result).not.toContain(".jolli-auth-banner");
	});
});
