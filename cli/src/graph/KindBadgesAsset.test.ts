import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The viz assets under assets/js/ are plain JavaScript, bundled verbatim into the
// webview / standalone export — tsc never type-checks them, so a `u.kind` ->
// `u.kinds` slip would render `undefined` at runtime with no compile-time signal.
// This smoke test evaluates the real data.js IIFE (its `window.WikiRender.kindBadges`
// is the shared chip renderer used by views.js and panel.js) and asserts its output.
// data.js only *defines* load() (which uses fetch) — it never calls it at eval time —
// so a bare stub window is enough.
function loadKindBadges(): (kinds: unknown) => string {
	const src = readFileSync(new URL("./assets/js/data.js", import.meta.url), "utf8");
	const win: { WikiRender?: { kindBadges: (kinds: unknown) => string } } = {};
	new Function("window", src)(win);
	if (!win.WikiRender) throw new Error("data.js did not expose window.WikiRender");
	return win.WikiRender.kindBadges;
}

describe("kindBadges (assets/js/data.js runtime smoke)", () => {
	const kindBadges = loadKindBadges();

	it("renders a single primary chip", () => {
		const html = kindBadges(["decision"]);
		expect(html).toBe('<span class="u-kind decision">decision</span>');
		expect(html).not.toContain("undefined");
	});

	it("renders the primary chip plus smaller secondary badges", () => {
		const html = kindBadges(["fix", "gotcha", "constraint"]);
		expect(html).toContain('<span class="u-kind fix">fix</span>');
		expect(html).toContain('<span class="u-kind u-kind--sec gotcha">gotcha</span>');
		expect(html).toContain('<span class="u-kind u-kind--sec constraint">constraint</span>');
		expect(html).not.toContain("undefined");
	});

	it("renders a clean out-of-vocabulary kind without crashing or leaking 'undefined'", () => {
		// A value outside the 7-word vocabulary (e.g. from a tampered graph.json) still
		// renders a chip -- unstyled, since no CSS rule matches -- but must not crash
		// or emit the literal "undefined".
		const html = kindBadges(["banana", "gotcha"]);
		expect(html).toContain('<span class="u-kind banana">banana</span>');
		expect(html).toContain('<span class="u-kind u-kind--sec gotcha">gotcha</span>');
		expect(html).not.toContain("undefined");
	});

	it("returns an empty string (never the literal 'undefined') for empty or missing kinds", () => {
		expect(kindBadges([])).toBe("");
		expect(kindBadges(undefined)).toBe("");
		expect(kindBadges(null)).toBe("");
	});

	it("escapes HTML metacharacters defensively", () => {
		const html = kindBadges(["<x>"]);
		expect(html).not.toContain("<x>");
		expect(html).toContain("&lt;x&gt;");
	});
});
