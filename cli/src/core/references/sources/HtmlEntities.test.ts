import { describe, expect, it } from "vitest";
import { decodeHtmlEntities } from "./HtmlEntities.js";

describe("decodeHtmlEntities", () => {
	it("decodes the five known named entities", () => {
		expect(decodeHtmlEntities("&amp; &lt; &gt; &quot; &apos;")).toBe("& < > \" '");
	});

	it("decodes decimal numeric entities", () => {
		// &#960; → π (U+03C0)
		expect(decodeHtmlEntities("Hello &#960; world")).toBe("Hello π world");
	});

	it("decodes hex numeric entities (lowercase x)", () => {
		// &#x2026; → … (HORIZONTAL ELLIPSIS).
		// HTML spec allows uppercase `&#X…;` too, but real GitHub MCP output and
		// the regex used here are both lowercase-only — keeping the surface
		// narrow avoids tolerating malformed entities.
		expect(decodeHtmlEntities("ellipsis: &#x2026;")).toBe("ellipsis: …");
	});

	it("passes through unknown named entities unchanged (defensive — no silent corruption)", () => {
		expect(decodeHtmlEntities("&foo; &nbsp; &copy;")).toBe("&foo; &nbsp; &copy;");
	});

	it("passes through out-of-range hex code points unchanged (no throw)", () => {
		// &#x110000; is one past the Unicode max (U+10FFFF). String.fromCodePoint would
		// throw RangeError; the decoder's range guard returns the original string instead.
		expect(decodeHtmlEntities("oob: &#x110000;")).toBe("oob: &#x110000;");
	});

	it("passes through out-of-range decimal code points unchanged (no throw)", () => {
		// 1114112 = 0x110000 — same out-of-range guard, decimal path.
		expect(decodeHtmlEntities("oob: &#1114112;")).toBe("oob: &#1114112;");
	});

	it("leaves bare strings without entities alone", () => {
		expect(decodeHtmlEntities("plain text with no entities")).toBe("plain text with no entities");
	});

	it("handles consecutive entities and entity-rich strings", () => {
		expect(decodeHtmlEntities("&amp;&amp;&amp;")).toBe("&&&");
		expect(decodeHtmlEntities("&lt;tag attr=&quot;v&quot;&gt;")).toBe('<tag attr="v">');
	});

	it("decodes ASCII control range (e.g. newline) via decimal", () => {
		// &#10; → newline; in-range, normal path.
		expect(decodeHtmlEntities("a&#10;b")).toBe("a\nb");
	});

	it("decodes ASCII control range via hex", () => {
		// &#x0A; → newline
		expect(decodeHtmlEntities("a&#x0A;b")).toBe("a\nb");
	});

	it("passes through lone UTF-16 surrogate code points unchanged (hex)", () => {
		// U+D800 is a high surrogate. String.fromCodePoint does NOT throw on it —
		// it would emit a lone surrogate and silently corrupt the text — so the
		// guard must leave the entity verbatim.
		expect(decodeHtmlEntities("x&#xD800;y")).toBe("x&#xD800;y");
		expect(decodeHtmlEntities("x&#xDFFF;y")).toBe("x&#xDFFF;y");
	});

	it("passes through a lone surrogate code point unchanged (decimal)", () => {
		// 55296 = 0xD800
		expect(decodeHtmlEntities("x&#55296;y")).toBe("x&#55296;y");
	});

	it("still decodes the code points just outside the surrogate block", () => {
		// U+D7FF (just below) and U+E000 (just above) are valid scalar values.
		expect(decodeHtmlEntities("&#xD7FF;")).toBe(String.fromCodePoint(0xd7ff));
		expect(decodeHtmlEntities("&#xE000;")).toBe(String.fromCodePoint(0xe000));
	});
});
