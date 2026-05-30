/**
 * Tests for `Sanitize.ts` — the consolidated URL allow-list and HTML escape
 * helpers shared across every layout, footer renderer, and `_meta.js` writer.
 *
 * `sanitizeUrl` and `escapeHtml` are also exercised indirectly through
 * Footer.test.ts and MetaGenerator.test.ts, but pinning the helpers
 * directly here means a future tightening (or accidental loosening) of the
 * allow-list shows up as a localised test failure rather than a cascade of
 * far-away assertions.
 */

import { describe, expect, it } from "vitest";
import { escapeHtml, sanitizeUrl } from "./Sanitize.js";

// ─── sanitizeUrl: safe schemes pass through ──────────────────────────────────

describe("sanitizeUrl — safe schemes", () => {
	it("preserves http URLs verbatim", () => {
		expect(sanitizeUrl("http://example.com/path")).toBe("http://example.com/path");
	});

	it("preserves https URLs verbatim", () => {
		expect(sanitizeUrl("https://example.com/path?q=1#frag")).toBe("https://example.com/path?q=1#frag");
	});

	it("preserves mailto: URLs verbatim", () => {
		expect(sanitizeUrl("mailto:hi@example.com")).toBe("mailto:hi@example.com");
	});

	it("preserves tel: URLs verbatim", () => {
		expect(sanitizeUrl("tel:+15551234567")).toBe("tel:+15551234567");
	});

	it("preserves fragment-only URLs verbatim", () => {
		expect(sanitizeUrl("#section")).toBe("#section");
	});

	it("preserves query-only URLs verbatim", () => {
		expect(sanitizeUrl("?q=1&x=y")).toBe("?q=1&x=y");
	});

	it("preserves root-relative paths verbatim", () => {
		expect(sanitizeUrl("/assets/logo.svg")).toBe("/assets/logo.svg");
	});

	it("preserves dot-relative paths verbatim (./)", () => {
		expect(sanitizeUrl("./sibling.md")).toBe("./sibling.md");
	});

	it("preserves dot-relative paths verbatim (../)", () => {
		expect(sanitizeUrl("../parent/page.md")).toBe("../parent/page.md");
	});

	it("treats schemes case-insensitively", () => {
		expect(sanitizeUrl("HTTPS://example.com")).toBe("HTTPS://example.com");
		expect(sanitizeUrl("MAILTO:hi@x.com")).toBe("MAILTO:hi@x.com");
	});
});

// ─── sanitizeUrl: dangerous schemes clamped ──────────────────────────────────

describe("sanitizeUrl — dangerous schemes", () => {
	it("clamps javascript: URLs to '#'", () => {
		expect(sanitizeUrl("javascript:alert(1)")).toBe("#");
	});

	it("clamps data: URLs to '#'", () => {
		expect(sanitizeUrl("data:text/html,<script>alert(1)</script>")).toBe("#");
	});

	it("clamps vbscript: URLs to '#'", () => {
		expect(sanitizeUrl("vbscript:msgbox(1)")).toBe("#");
	});

	it("clamps file: URLs to '#'", () => {
		expect(sanitizeUrl("file:///etc/passwd")).toBe("#");
	});

	it("clamps unrecognised schemes to '#' (e.g. typoed 'htps://')", () => {
		expect(sanitizeUrl("htps://example.com")).toBe("#");
	});

	it("blocks dangerous schemes prefixed with whitespace (trim before scheme check)", () => {
		expect(sanitizeUrl("  javascript:alert(1)")).toBe("#");
		expect(sanitizeUrl("\tjavascript:alert(1)")).toBe("#");
	});
});

// ─── sanitizeUrl: scheme-relative rejection ──────────────────────────────────

describe("sanitizeUrl — scheme-relative URLs", () => {
	// Browsers parse `//evil.com/x` as same-protocol cross-origin. A malicious
	// site.json with `header.items: [{ url: "//evil.com" }]` could otherwise
	// redirect users; `<img src="//evil.com">` could leak referrer context.
	// Single-leading-slash (root-relative) is allowed; double-slash is not.

	it("clamps a bare scheme-relative URL to '#'", () => {
		expect(sanitizeUrl("//evil.com/x")).toBe("#");
	});

	it("clamps a scheme-relative URL with a path/query to '#'", () => {
		expect(sanitizeUrl("//evil.com/track?u=1#x")).toBe("#");
	});

	it("clamps a triple-slash variant (still scheme-relative-shaped) to '#'", () => {
		expect(sanitizeUrl("///evil.com")).toBe("#");
	});

	it("clamps the backslash variant `/\\evil.com` to '#'", () => {
		// Browsers normalise the leading backslash to a forward slash and resolve
		// the URL as `//evil.com` — the exact scheme-relative cross-origin
		// vector this allow-list documents protecting against. Without the
		// `[/\\]` lookahead, `\/(?!\/)` was satisfied (because the next char is
		// `\`, not `/`) and the value passed through unchanged.
		expect(sanitizeUrl("/\\evil.com")).toBe("#");
		expect(sanitizeUrl("/\\evil.com/track?u=1")).toBe("#");
	});

	it("clamps the mixed slash/backslash variants `/\\\\foo` and `\\\\foo` to '#'", () => {
		// Defence-in-depth: any combination of leading slashes/backslashes that
		// browsers parse as scheme-relative must clamp. We can't trust a
		// single-character lookahead to catch every variant, but we pin the
		// common ones here so regressions are caught immediately.
		expect(sanitizeUrl("/\\\\evil.com")).toBe("#");
		expect(sanitizeUrl("\\\\evil.com")).toBe("#");
	});

	it("does NOT block legitimate single-slash root-relative paths", () => {
		// Pin the negative — `/foo/bar` must still pass through; the rejection
		// only fires on `//` (or its backslash homoglyph variants above).
		expect(sanitizeUrl("/foo/bar")).toBe("/foo/bar");
		expect(sanitizeUrl("/")).toBe("/");
	});
});

// ─── sanitizeUrl: empty / whitespace ─────────────────────────────────────────

describe("sanitizeUrl — empty / whitespace inputs", () => {
	it("returns an empty string unchanged when given an empty string", () => {
		expect(sanitizeUrl("")).toBe("");
	});

	it("returns an empty string when given whitespace only (after trim)", () => {
		expect(sanitizeUrl("   ")).toBe("");
		expect(sanitizeUrl("\t\n")).toBe("");
	});

	it("trims leading / trailing whitespace from valid URLs", () => {
		expect(sanitizeUrl("  https://example.com  ")).toBe("https://example.com");
	});
});

// ─── escapeHtml ──────────────────────────────────────────────────────────────

describe("escapeHtml", () => {
	it("escapes ampersand FIRST so subsequent entities are not double-escaped", () => {
		// If `&` were escaped after `<`, the entity `&lt;` would become `&amp;lt;`.
		expect(escapeHtml("a & b")).toBe("a &amp; b");
		expect(escapeHtml("<a&b>")).toBe("&lt;a&amp;b&gt;");
	});

	it("escapes angle brackets so `<script>` cannot inject a tag", () => {
		expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
	});

	it('escapes double quotes so attribute values cannot break out of `"…"`', () => {
		expect(escapeHtml('a"b')).toBe("a&quot;b");
	});

	it("escapes single quotes (defensive — single-quoted attribute boundaries)", () => {
		expect(escapeHtml("a'b")).toBe("a&#39;b");
	});

	it("escapes curly braces so spliced text cannot open a JSX expression", () => {
		// JSX text mode treats `{` as an expression delimiter; numeric character
		// references render as the literal char in the browser but stay inert
		// during the customer's MDX/TSX compile.
		expect(escapeHtml("a {x} b")).toBe("a &#123;x&#125; b");
	});

	it("returns the input unchanged when no special chars are present", () => {
		expect(escapeHtml("plain text 123")).toBe("plain text 123");
	});

	it("handles every special character at once", () => {
		expect(escapeHtml(`<a href="x" class='y'>{z}&w</a>`)).toBe(
			"&lt;a href=&quot;x&quot; class=&#39;y&#39;&gt;&#123;z&#125;&amp;w&lt;/a&gt;",
		);
	});
});
