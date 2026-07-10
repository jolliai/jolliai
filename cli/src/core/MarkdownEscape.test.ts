import { describe, expect, it } from "vitest";
import { escHtml, escMdLinkText, escMdStrikeText, escMdUrl } from "./MarkdownEscape.js";

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

describe("escMdStrikeText", () => {
	it("escapes tildes on top of the link-text set so `~~` can't close a strikethrough span", () => {
		expect(escMdStrikeText("weird ~~title~~ [x]\ny")).toBe("weird \\~\\~title\\~\\~ \\[x\\] y");
	});
	it("escapes pre-existing backslashes in the same pass, so `\\~` input can't forge an escape", () => {
		// Input `\~`: the backslash becomes `\\` and the tilde `\~` — the tilde's
		// escaping backslash is always the one WE added, never attacker-supplied.
		expect(escMdStrikeText("a\\~b")).toBe("a\\\\\\~b");
	});
});

describe("escMdUrl", () => {
	it("percent-encodes parens, whitespace, angle brackets, quote", () => {
		expect(escMdUrl(`http://h/a (b)<c>"d`)).toBe(`http://h/a%20%28b%29%3Cc%3E%22d`);
	});
});
