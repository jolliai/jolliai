import { describe, expect, it } from "vitest";
import { escHtml, escMdLinkText, escMdUrl } from "./MarkdownEscape.js";

describe("escHtml", () => {
	it('escapes &, <, >, "', () => {
		expect(escHtml(`a & b < c > d "e"`)).toBe(`a &amp; b &lt; c &gt; d &quot;e&quot;`);
	});
});

describe("escMdLinkText", () => {
	it("backslash-escapes brackets and folds newlines", () => {
		expect(escMdLinkText("x](y)\nz")).toBe("x\\](y) z");
	});
});

describe("escMdUrl", () => {
	it("percent-encodes parens, whitespace, angle brackets, quote", () => {
		expect(escMdUrl(`http://h/a (b)<c>"d`)).toBe(`http://h/a%20%28b%29%3Cc%3E%22d`);
	});
});
