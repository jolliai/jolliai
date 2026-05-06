/**
 * Tests for the OpenAPI emitter escape helpers.
 */

import { describe, expect, it } from "vitest";
import { escapeHtml, escapeInlineCode, escapeJsString, escapeMdxText, escapeYaml } from "./Escape.js";

describe("escapeYaml", () => {
	it("returns the string unchanged when no special characters are present", () => {
		expect(escapeYaml("hello world")).toBe("hello world");
	});

	it("quotes strings starting with a digit so they don't parse as numbers", () => {
		expect(escapeYaml("1.0")).toBe('"1.0"');
		expect(escapeYaml("3.1.0")).toBe('"3.1.0"');
	});

	it("quotes YAML special values (true, false, null, yes, no, on, off, ~)", () => {
		expect(escapeYaml("true")).toBe('"true"');
		expect(escapeYaml("False")).toBe('"False"');
		expect(escapeYaml("null")).toBe('"null"');
		expect(escapeYaml("~")).toBe('"~"');
	});

	it("quotes strings containing YAML metacharacters", () => {
		expect(escapeYaml("colon: here")).toBe('"colon: here"');
		expect(escapeYaml("hash # here")).toBe('"hash # here"');
		expect(escapeYaml("[array]")).toBe('"[array]"');
		expect(escapeYaml("{flow}")).toBe('"{flow}"');
		expect(escapeYaml("pipe|here")).toBe('"pipe|here"');
		expect(escapeYaml('quote"here')).toBe('"quote\\"here"');
		expect(escapeYaml("apos'here")).toBe('"apos\'here"');
	});

	it("escapes embedded double-quotes inside the quoted output", () => {
		expect(escapeYaml('say "hi"')).toBe('"say \\"hi\\""');
	});
});

describe("escapeMdxText", () => {
	it("backslash-escapes curly braces", () => {
		expect(escapeMdxText("/users/{id}")).toBe("/users/\\{id\\}");
	});

	it("backslash-escapes < but leaves > alone", () => {
		expect(escapeMdxText("value < 10")).toBe("value \\< 10");
		expect(escapeMdxText("value > 10")).toBe("value > 10");
	});

	it("leaves plain text untouched", () => {
		expect(escapeMdxText("hello world")).toBe("hello world");
	});

	it("escapes a string mixing curly braces and angle brackets", () => {
		expect(escapeMdxText("{x} <= 10")).toBe("\\{x\\} \\<= 10");
	});
});

describe("escapeInlineCode", () => {
	it("backslash-escapes backticks", () => {
		expect(escapeInlineCode("use `npm`")).toBe("use \\`npm\\`");
	});

	it("leaves backtick-free strings untouched", () => {
		expect(escapeInlineCode("v1.0.0")).toBe("v1.0.0");
	});
});

describe("escapeJsString", () => {
	it("escapes backslash, single quote, CR, and LF", () => {
		expect(escapeJsString("a\\b")).toBe("a\\\\b");
		expect(escapeJsString("it's")).toBe("it\\'s");
		expect(escapeJsString("line1\nline2")).toBe("line1\\nline2");
		expect(escapeJsString("crlf\r\nx")).toBe("crlf\\r\\nx");
	});

	it("leaves double-quotes and other characters untouched (single-quoted contexts)", () => {
		expect(escapeJsString('say "hi"')).toBe('say "hi"');
	});

	it("escapes backslashes before single quotes are reduced (no double-escape)", () => {
		// "\'": a literal backslash followed by a single quote should become
		// "\\'" (backslash twice + escaped single quote). The order matters —
		// running the quote replace first would corrupt the prior backslash.
		expect(escapeJsString("\\'")).toBe("\\\\\\'");
	});
});

describe("escapeHtml", () => {
	it("escapes &, <, >, \", '", () => {
		expect(escapeHtml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#039;&lt;/a&gt;");
	});

	it("escapes curly braces using numeric character references", () => {
		expect(escapeHtml("Acme {Beta}")).toBe("Acme &#123;Beta&#125;");
	});

	it("returns the empty string for empty input", () => {
		expect(escapeHtml("")).toBe("");
	});

	it("escapes ampersands first so subsequent escapes do not double-encode", () => {
		// "&lt;" must round-trip to "&amp;lt;" — if we escaped < first, then &,
		// we'd produce "&amp;amp;lt;" (broken).
		expect(escapeHtml("&lt;")).toBe("&amp;lt;");
	});
});
