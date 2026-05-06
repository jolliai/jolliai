/**
 * Tests for the API stylesheet emitter.
 *
 * Coverage focus:
 *   - The TemplateFile lands at `styles/api.css` (matches the import path
 *     in `app/layout.tsx`).
 *   - Method/status hue tokens are present in both `:root` and `.dark`.
 *   - The accent-hue input flows into the CSS as the post / 3xx hue and
 *     defaults to 220 when omitted.
 *   - Selectors that the React components actually use exist in the output
 *     (so a copy-paste regression is caught here rather than at site-build
 *     time).
 */

import { describe, expect, it } from "vitest";
import { buildApiCss, generateApiCss } from "./ApiCss.js";

describe("generateApiCss", () => {
	it("returns a TemplateFile at styles/api.css", () => {
		const file = generateApiCss();
		expect(file.path).toBe("styles/api.css");
	});

	it("uses 220 as the default accent hue", () => {
		const file = generateApiCss();
		expect(file.content).toContain("hsl(220 84% 50%)");
		expect(file.content).toContain("hsl(220 70% 50%)");
	});

	it("threads a custom accent hue through to the post / 3xx tokens", () => {
		const file = generateApiCss({ accentHue: 320 });
		expect(file.content).toContain("hsl(320 84% 50%)");
		expect(file.content).toContain("hsl(320 70% 50%)");
		expect(file.content).not.toContain("hsl(220 84% 50%)");
	});
});

describe("buildApiCss", () => {
	const css = buildApiCss({ accentHue: 220 });

	it("declares method-bg variables in :root", () => {
		expect(css).toContain(":root {");
		for (const key of [
			"--api-method-get-bg",
			"--api-method-post-bg",
			"--api-method-put-bg",
			"--api-method-patch-bg",
			"--api-method-delete-bg",
		]) {
			expect(css).toContain(key);
		}
	});

	it("declares dark-mode overrides under the .dark selector", () => {
		expect(css).toContain(".dark {");
		// The dark block also redeclares the method-bg vars — count the bg
		// definitions so we know both modes are present.
		const matches = css.match(/--api-method-get-bg:/g) ?? [];
		expect(matches.length).toBeGreaterThanOrEqual(2);
	});

	it("includes selectors the React components reference", () => {
		for (const selector of [
			".api-method",
			".api-method-get",
			".api-endpoint-meta",
			".api-endpoint-grid",
			".api-endpoint-aside",
			".api-param-table",
			".api-param-section",
			".api-schema-block",
			".api-schema-row",
			".api-response-block",
			".api-response-status",
			".api-auth-list",
			".api-tryit",
			".api-tryit-input",
			".api-tryit-send",
			".api-code-switcher",
			".api-code-switcher-toolbar",
		]) {
			expect(css).toContain(selector);
		}
	});

	it("declares status-code colour tokens (2xx / 3xx / 4xx / 5xx)", () => {
		expect(css).toContain("--api-status-2xx");
		expect(css).toContain("--api-status-3xx");
		expect(css).toContain("--api-status-4xx");
		expect(css).toContain("--api-status-5xx");
	});
});
