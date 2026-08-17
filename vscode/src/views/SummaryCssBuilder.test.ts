import { describe, expect, it, vi } from "vitest";

// ─── Mock PrCommentService ──────────────────────────────────────────────────
vi.mock("../services/PrCommentService.js", () => ({
	buildPrSectionCss: () => "/* pr-css */",
}));

import { buildCss } from "./SummaryCssBuilder.js";
import { getSourceMeta, NEUTRAL_SOURCE_COLOR, SOURCE_META } from "../../../cli/src/core/references/SourceLabels.js";

describe("buildCss — per-source reference badge hues", () => {
	// .t-ref used to hardcode #5e6ad2 — Linear's SOURCE_META colour — as a KIND
	// level hue, so every reference source rendered as Linear blue-violet with only
	// the letter differing. These lock the per-source hues in and, importantly, the
	// neutral fallback, so this panel now agrees with the sidebar and the Working
	// Memory card instead of being a third independent answer.
	it("emits a hue per SOURCE_META entry", () => {
		const css = buildCss();
		for (const [id, meta] of Object.entries(SOURCE_META)) {
			expect(css).toContain(`.kb-tag.src-${id} { background: ${meta.color}; }`);
		}
	});

	it("keeps Linear's hue byte-identical to the old fixed .t-ref value", () => {
		// Zero visual regression for the one source that was previously correct by
		// accident: the literal being replaced WAS Linear's brand colour.
		expect(SOURCE_META.linear.color).toBe("#5e6ad2");
		expect(buildCss()).toContain(".kb-tag.src-linear { background: #5e6ad2; }");
	});

	it("gives a non-Linear source its own hue, no longer Linear's", () => {
		const css = buildCss();
		expect(SOURCE_META.jollimemory.color).not.toBe(SOURCE_META.linear.color);
		expect(css).toContain(`.kb-tag.src-jollimemory { background: ${SOURCE_META.jollimemory.color}; }`);
	});

	it("leaves .t-ref as the neutral fallback for a source with no generated rule", () => {
		const css = buildCss();
		expect(getSourceMeta("some-phase-2-source").color).toBe(NEUTRAL_SOURCE_COLOR);
		expect(css).toContain(`.kb-tag.t-ref  { background: ${NEUTRAL_SOURCE_COLOR}; }`);
	});

	it("orders the generated rules AFTER .t-ref so they win at equal specificity", () => {
		const css = buildCss();
		expect(css.indexOf(".kb-tag.t-ref")).toBeLessThan(css.indexOf(".kb-tag.src-"));
	});
});

describe("SummaryCssBuilder", () => {
	const css = buildCss();

	it("returns a non-empty string", () => {
		expect(css).toBeTruthy();
		expect(typeof css).toBe("string");
		expect(css.length).toBeGreaterThan(0);
	});

	it("contains light theme variables", () => {
		expect(css).toContain("body.vscode-light");
	});

	it("contains dark theme variables", () => {
		expect(css).toContain("body.vscode-dark");
	});

	it("contains high contrast theme variables", () => {
		expect(css).toContain("vscode-high-contrast");
	});

	it("contains expected CSS class names", () => {
		expect(css).toContain(".toggle");
		expect(css).toContain(".callout");
		expect(css).toContain(".page");
		expect(css).toContain(".mem-details");
		expect(css).toContain(".md-row");
		expect(css).toContain(".hash");
		expect(css).toContain(".pill");
		expect(css).toContain(".separator");
	});

	it("lets the [hidden] attribute actually hide a filtered collaborator row (display:flex must not override it)", () => {
		const css = buildCss();
		expect(css).toContain(".share-collab-row[hidden]");
	});

	it("Export button gets a plain .meta-export rule with no split-toggle !important overrides", () => {
		// Regression: .meta-export previously stacked with the two-button
		// split-toggle skeleton (border-radius/padding/font-size all
		// !important), which silently crushed the single Export button.
		// That skeleton (.split-btn-group / .split-toggle) must be gone.
		expect(css).not.toContain(".split-btn-group");
		expect(css).not.toContain(".split-toggle");
		expect(css).toContain(".export-menu-group");
		expect(css).toContain(".meta-strip .action-btn.meta-export");
	});

	it("styles the meta-strip Share/Export as the mockup's borderless secondary buttons with icon gap", () => {
		// Mockup `.btn.secondary`: inline-flex + gap for the leading icon,
		// borderless, semibold, 6px radius — not the bordered text-only look.
		const rule = css.slice(css.indexOf(".meta-strip .action-btn.meta-share"));
		expect(rule).toMatch(/display:\s*inline-flex/);
		expect(rule).toMatch(/gap:\s*6px/);
		expect(rule).toMatch(/border:\s*none/);
		expect(rule).toMatch(/font-weight:\s*600/);
		// Share's inline SVG and Export's codicons are sized to the compact button.
		expect(css).toContain(".meta-strip .action-btn .sico");
		expect(css).toContain(".meta-strip .action-btn .codicon");
	});

	it("pins the Context row's badge + actions to the top so a 3-line row (title/filename/AI-relevance) doesn't sink them to the middle", () => {
		// #contextPanel .row is align-items:center; a kept row stacks title +
		// filename + relevance line inside .r-main, so without this the leading
		// P/N badge and the trailing edit/remove actions float to the row's
		// vertical middle. align-self:flex-start keeps them against the title's
		// first line (matching the NextMemory review panel).
		expect(css).toMatch(
			/#contextPanel \.row > \.kb-tag,\s*#contextPanel \.row > \.r-actions\s*{\s*align-self:\s*flex-start/,
		);
	});

	it("indents the AI-relevance line so it spans the card as a full-width sibling of .row (not boxed in the narrow r-main column)", () => {
		// The relevance line moved out of .r-main to a sibling of .row, so a long
		// reason no longer shares the narrow title column with the always-visible
		// date + actions. padding-left keeps it aligned under the title, past the
		// badge column (.row padding 6 + badge 16 + gap 6 = 28px).
		expect(css).toMatch(/\.ctx-rel\s*{[^}]*padding:\s*3px 6px 0 28px/);
	});

	it("hover-highlights the whole context item (row + relevance line), not just the inner row", () => {
		// The relevance line is a sibling of .row, so a .row:hover would leave it
		// un-tinted. Hover lives on .plan-item so the tint spans the full item.
		expect(css).toMatch(/#contextPanel \.plan-item:hover\s*{[^}]*background:\s*var\(--surface-hover\)/);
		// The old inner-row hover must be gone for the context panel (a stray
		// #contextPanel .row:hover would double-tint / bound the highlight early).
		expect(css).not.toContain("#contextPanel .row:hover");
	});

	it("contains the PR section CSS from buildPrSectionCss()", () => {
		expect(css).toContain("/* pr-css */");
	});

	// ─── Token meter (.tmeter) ─────────────────────────────────────────────
	describe("token meter", () => {
		it("contains the .tmeter shell, na state, head, and bar classes", () => {
			expect(css).toContain(".tmeter {");
			expect(css).toContain(".tmeter.na");
			expect(css).toContain(".tmeter-head");
			expect(css).toContain(".tmeter-bar");
		});

		it("contains the three segment classes and legend/dot classes", () => {
			expect(css).toContain(".seg-in");
			expect(css).toContain(".seg-out");
			expect(css).toContain(".seg-cache");
			expect(css).toContain(".tmeter-legend");
			expect(css).toContain(".lg-dot");
		});

		it("contains the help popover classes, hidden until pinned", () => {
			expect(css).toContain(".tok-help-wrap");
			expect(css).toContain(".tok-help");
			expect(css).toContain(".tok-pop");
			expect(css).toMatch(/\.tok-help-wrap\.pinned\s+\.tok-pop\s*\{[^}]*display:\s*block/);
		});

		it("segments have no inline width — widths must be set via data-pct in script", () => {
			expect(css).not.toMatch(/\.seg-in\s*\{[^}]*width:\s*\d/);
		});
	});

	it("contains callout variable definitions", () => {
		expect(css).toContain("--callout-trigger-bg");
		expect(css).toContain("--callout-response-bg");
		expect(css).toContain("--callout-decisions-bg");
		expect(css).toContain("--callout-todo-bg");
		expect(css).toContain("--callout-detail-bg");
		expect(css).toContain("--callout-detail-label");
	});

	// ─── Floating overlays must be opaque ─────────────────────────────────
	// The local surface tokens here (--surface-hover, --callout-*-bg, …) are
	// 3–10% alpha. Correct for an element STACKED on a known background — a
	// callout inside a panel composites against the panel. Wrong for an element
	// FLOATING over arbitrary content (position: fixed/absolute): the page shows
	// straight through and the overlay's text collides with whatever is scrolled
	// underneath. Sweep every declaration block rather than the ones we thought
	// of, so the next floating element that grabs a translucent token fails here
	// instead of in a screenshot. Mirrors SummaryCssBuilderTest.kt.
	describe("floating overlays", () => {
		/**
		 * Partial alpha only — `0 < a < 1`. Fully `transparent` is deliberately NOT
		 * flagged: that's a click-catcher scrim (`.share-overlay` is `inset: 0;
		 * background: transparent`), which paints nothing and carries no text, so
		 * being see-through is the entire point. The bug this guards is the opposite
		 * intent — "I wanted a visible surface" plus a token that is almost invisible.
		 */
		function isTranslucent(value: string): boolean {
			const alpha = /(?:rgba|hsla)\([^)]*,\s*([0-9.]+)\s*\)/.exec(value.trim())?.[1];
			return alpha !== undefined && Number(alpha) > 0 && Number(alpha) < 1;
		}

		/**
		 * Innermost declaration blocks only — a body containing `{` is a container
		 * (`@media`, `body.vscode-dark`), so its inner rules get matched on their own
		 * and the wrapper is skipped.
		 */
		function floatingBlocksWithTranslucentBackground(input: string): string[] {
			// Strip comments so a preceding /* … */ can't end up in the reported selector.
			const sheet = input.replace(/\/\*[\s\S]*?\*\//g, "");
			// Every `--token: value;` in the sheet, for one level of var() resolution.
			const tokens = new Map<string, string>();
			for (const m of sheet.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
				tokens.set(m[1], m[2].trim());
			}
			const offenders: string[] = [];
			for (const m of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
				const selector = m[1].trim();
				const body = m[2];
				if (!/position\s*:\s*(fixed|absolute)/.test(body)) continue;
				const background = /\bbackground(?:-color)?\s*:\s*([^;]+)/.exec(body)?.[1];
				if (background === undefined) continue;
				// Only backgrounds that reach for a var(--…) surface token are the bug this
				// guards. A deliberate inline literal — e.g. a modal backdrop's rgba(0,0,0,0.5)
				// dimming scrim — is excluded for the same reason a fully `transparent`
				// click-catcher is: being see-through is the entire point.
				const ref = /var\(\s*(--[a-z0-9-]+)/.exec(background)?.[1]?.slice(2);
				if (ref === undefined) continue;
				const resolved = tokens.get(ref);
				if (resolved !== undefined && isTranslucent(resolved)) offenders.push(selector);
			}
			return offenders;
		}

		it("no position:fixed/absolute rule paints a translucent background", () => {
			expect(floatingBlocksWithTranslucentBackground(css)).toEqual([]);
		});

		it("the sweep flags a floating element that reaches for a translucent token", () => {
			// Guards the guard — a vacuous sweep would let the original bug back in.
			const regressed = `
				:root { --panel-inner: rgba(255, 255, 255, 0.045); }
				.copy-toast { position: fixed; bottom: 16px; background: var(--panel-inner); }
			`;
			expect(floatingBlocksWithTranslucentBackground(regressed)).toContain(".copy-toast");
		});

		it("the copy toast paints the opaque notifications surface", () => {
			expect(css).toContain("--vscode-notifications-background");
		});

		it("gives the reference-id chip a visible focus ring", () => {
			expect(css).toContain(".page-title-ref:focus-visible");
		});
	});

	// ─── Foreign-repo read-only mode ──────────────────────────────────────
	// SummaryHtmlBuilder marks .page with `foreign-readonly` when the loaded
	// summary belongs to a non-current repo. The CSS below hides every
	// destructive control. PR section is NOT hidden — checkPrStatus is
	// reachable in foreign mode via gh `--repo <remoteUrl>` so the panel
	// still surfaces the foreign repo's PR (read-only).
	describe("foreign-readonly mode", () => {
		it("hides every non-whitelisted button under .page.foreign-readonly", () => {
			expect(css).toMatch(
				/\.page\.foreign-readonly\s+button:not\(\[data-foreign-safe\]\)\s*\{[^}]*display:\s*none/,
			);
		});
	});
});
