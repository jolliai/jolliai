import { describe, expect, it } from "vitest";
import { escapeForAttr, escapeForText } from "./PromptXmlEscape.js";

describe("escapeForAttr", () => {
	it("escapes ampersand to &amp;", () => {
		expect(escapeForAttr("a & b")).toBe("a &amp; b");
	});

	it("escapes less-than to &lt;", () => {
		expect(escapeForAttr("a < b")).toBe("a &lt; b");
	});

	it("escapes greater-than to &gt;", () => {
		expect(escapeForAttr("a > b")).toBe("a &gt; b");
	});

	it("escapes double-quote to &quot;", () => {
		expect(escapeForAttr('a "x" b')).toBe("a &quot;x&quot; b");
	});

	it("escapes single-quote to &apos;", () => {
		expect(escapeForAttr("it's")).toBe("it&apos;s");
	});

	it("escapes all five characters together", () => {
		expect(escapeForAttr(`a & b < c > d "e" 'f'`)).toBe("a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;");
	});

	it("returns the input unchanged when no special characters present", () => {
		expect(escapeForAttr("plain text 123")).toBe("plain text 123");
	});

	it("handles empty string", () => {
		expect(escapeForAttr("")).toBe("");
	});

	it("does not transform = character (sentinel imitation defense is via prompt warning, not escape)", () => {
		// Documents the §8.3 design: escape only defends against XML structural breakage.
		// SUMMARIZE sentinel strings like ===SUMMARY=== / ---TICKETID--- pass through verbatim.
		expect(escapeForAttr("===SUMMARY===")).toBe("===SUMMARY===");
		expect(escapeForAttr("---TICKETID---")).toBe("---TICKETID---");
	});

	it("escapes ampersand before applying other entity escapes (no double-encoding)", () => {
		// Edge case: input "&lt;" must become "&amp;lt;" (not "&amp;amp;lt;").
		expect(escapeForAttr("&lt;")).toBe("&amp;lt;");
	});
});

describe("escapeForText", () => {
	it("escapes ampersand to &amp;", () => {
		expect(escapeForText("a & b")).toBe("a &amp; b");
	});

	it("escapes less-than to &lt;", () => {
		expect(escapeForText("a < b")).toBe("a &lt; b");
	});

	it("escapes greater-than to &gt;", () => {
		expect(escapeForText("a > b")).toBe("a &gt; b");
	});

	it("preserves double-quote (not needed in element text)", () => {
		expect(escapeForText('a "x" b')).toBe('a "x" b');
	});

	it("preserves single-quote (not needed in element text)", () => {
		expect(escapeForText("it's")).toBe("it's");
	});

	it("escapes only structural characters", () => {
		expect(escapeForText(`a & b < c > d "e" 'f'`)).toBe(`a &amp; b &lt; c &gt; d "e" 'f'`);
	});

	it("returns the input unchanged when no special characters present", () => {
		expect(escapeForText("plain text 123\nwith newlines")).toBe("plain text 123\nwith newlines");
	});

	it("handles empty string", () => {
		expect(escapeForText("")).toBe("");
	});

	it("does not transform = character — SUMMARIZE sentinels pass through verbatim", () => {
		expect(escapeForText("===SUMMARY===")).toBe("===SUMMARY===");
		expect(escapeForText("---TICKETID---")).toBe("---TICKETID---");
		expect(escapeForText("---FIELDNAME---")).toBe("---FIELDNAME---");
	});

	it("escapes literal </description> so embedded text cannot close its containing element prematurely", () => {
		expect(escapeForText("payload contains </description> here")).toBe(
			"payload contains &lt;/description&gt; here",
		);
	});

	it("escapes ampersand first to avoid double-encoding", () => {
		expect(escapeForText("&lt;")).toBe("&amp;lt;");
	});
});
