import { describe, expect, it } from "vitest";
import { buildNextMemoryCss } from "./NextMemoryCssBuilder.js";

describe("buildNextMemoryCss", () => {
	it("defines the panel/row/badge classes used by NextMemoryScriptBuilder", () => {
		const css = buildNextMemoryCss();
		for (const cls of [
			".panel",
			".panel-header",
			".row",
			".r-main",
			".r-title",
			".r-meta",
			".conv-source-icon",
			".kb-tag",
			".excluded",
			".row-excl",
			".row-act-btn",
			".env-label",
			".tmeter",
			".tmeter-bar",
			".meta-strip",
			".local-chip",
		]) {
			expect(css).toContain(cls);
		}
	});

	it("left-aligns the section count next to the title, matching the sidebar Working Memory", () => {
		const css = buildNextMemoryCss();
		// The title must NOT flex:1 — flexing it shoves the count to the far right.
		// Left-alignment relies on the title keeping its natural width so the count
		// sits immediately after it (the panel-header's own gap provides spacing).
		expect(css).not.toMatch(/\.panel-title\s*\{[^}]*flex:\s*1/);
		// The count reads as sidebar-style metadata: muted + tabular figures.
		expect(css).toMatch(/\.sec-count\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
	});

	it("marks excluded rows with a strikethrough, matching the sidebar's model", () => {
		const css = buildNextMemoryCss();
		expect(css).toMatch(/\.row\.excluded[^{]*\{[^}]*text-decoration:\s*line-through/);
	});

	it("hides the row-actions overlay until hover, matching the sidebar's hover-reveal pattern", () => {
		const css = buildNextMemoryCss();
		// Actions live in an absolutely-positioned .row-actions overlay (like the
		// sidebar's .inline-actions) so they never reflow the row content; hidden
		// via visibility, revealed on row hover.
		expect(css).toMatch(/\.row-actions\s*\{[^}]*position:\s*absolute/);
		expect(css).toMatch(/\.row-actions\s*\{[^}]*visibility:\s*hidden/);
		expect(css).toMatch(/\.row:hover\s+\.row-actions\s*\{[^}]*visibility:\s*visible/);
	});

	it("hides the conversation row's 'N msgs' count on hover so the ✕ overlay covers it", () => {
		const css = buildNextMemoryCss();
		// The count (.r-meta.hide-on-hover) sits exactly where the ✕ exclude
		// toggle overlay lands; hide it on hover (via visibility, not display, so
		// the row never reflows) rather than let it peek out beside the overlay.
		expect(css).toMatch(/\.row:hover\s+\.hide-on-hover\s*\{[^}]*visibility:\s*hidden/);
	});

	it("styles the Context + with a neutral icon color, not the accent link-blue", () => {
		const css = buildNextMemoryCss();
		// The add button must not read as an accent color — it uses the same
		// icon-foreground the sidebar's .iconbtn add button does.
		expect(css).toMatch(/\.panel-add\s*\{[^}]*color:\s*var\(--vscode-icon-foreground/);
		expect(css).not.toMatch(/\.panel-add\s*\{[^}]*--vscode-textLink-foreground/);
	});

	it("tints conversation / context / file rows per source, kind, and git-status (not all-gray)", () => {
		const css = buildNextMemoryCss();
		// Conversation rows use the brand SVG icon (colors baked into the glyph).
		expect(css).toContain(".conv-source-svg");
		// Context kind badges, mirroring the sidebar's .mem-ctx-badge--* palette.
		expect(css).toContain(".mem-ctx-badge--plan");
		expect(css).toContain(".mem-ctx-badge--note");
		// Git-status letters, tinted by VS Code's git-decoration theme colors.
		expect(css).toContain(".gs-M");
		expect(css).toContain("gitDecoration-modifiedResourceForeground");
	});

	it("tints the filename for every git-status the .gs-* set covers (name + trailing letter agree)", () => {
		const css = buildNextMemoryCss();
		// renderFileRow builds `fname-<code>` for any gs letter, so the .fname-*
		// set must cover the same letters as .gs-* — otherwise a conflicted (C) or
		// ignored (I) file's name renders in the default color while its trailing
		// letter is tinted.
		for (const code of ["M", "A", "D", "U", "R", "C", "I"]) {
			expect(css).toContain(`.fname-${code}`);
			expect(css).toContain(`.gs-${code}`);
		}
	});

	it("defines the design tokens + meta-strip pill/chip and footer copy (not heavy badge-bg)", () => {
		const css = buildNextMemoryCss();
		// Shared pill/status tokens (light + dark) so the strip isn't solid gray.
		expect(css).toContain("--pill-bg");
		expect(css).toContain("--ship-warn");
		expect(css).toMatch(/\.meta-branch[^}]*var\(--pill-bg\)/);
		expect(css).toMatch(/\.local-chip[^}]*var\(--ship-warn\)/);
		expect(css).toContain(".cc-body");
		expect(css).toContain(".cc-note");
	});

	it("defines bucketed segment width classes for the CSP-safe token bar", () => {
		const css = buildNextMemoryCss();
		// Mirrors the sidebar's token-seg--wN pattern; the script emits seg--wNN
		// (floored to 10%) so widths never need an inline style.
		expect(css).toContain(".seg--w0 { width: 0%; }");
		expect(css).toContain(".seg--w40 { width: 40%; }");
		expect(css).toContain(".seg--w100 { width: 100%; }");
	});

	it("styles the anchored add-context dropdown (matching the sidebar menu)", () => {
		const css = buildNextMemoryCss();
		expect(css).toContain(".context-menu");
		expect(css).toContain(".context-menu .menu-item");
	});

	it("contains no backtick (builder template-literal trap)", () => {
		expect(buildNextMemoryCss().includes("`")).toBe(false);
	});
});
