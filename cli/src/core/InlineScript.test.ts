import { describe, expect, it } from "vitest";
import { escapeForInlineScript } from "./InlineScript.js";

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

/** What the browser would see for `<script>window.X = <json>;</script>`. */
const inlined = (json: string) => `<script>window.X = ${escapeForInlineScript(json)};</script>`;

describe("escapeForInlineScript", () => {
	it("escapes </script so the element cannot be closed from inside the data", () => {
		const out = escapeForInlineScript(JSON.stringify({ title: "</script><img onerror=x>" }));
		expect(out).not.toContain("</script");
		expect(out).toContain("\\u003c/script");
	});

	// The regression this module exists for: the previous sequence-based escape
	// neutralized `</script` only, so `<!--` still moved the tokenizer into
	// script-data-escaped state and swallowed every later inlined script.
	it("escapes <!-- so a comment opener cannot enter script-data-escaped state", () => {
		const out = inlined(JSON.stringify({ title: "<!--<script>" }));
		expect(out).not.toContain("<!--");
		// Exactly one `<script` and one `</script` remain: the wrapper's own.
		expect(out.match(/<script/g)).toHaveLength(1);
		expect(out.match(/<\/script/g)).toHaveLength(1);
	});

	it("leaves no raw < for any breakout sequence, whatever its case", () => {
		for (const payload of ["</SCRIPT >", "<!--", "<script", "<!-- --><script>alert(1)</script>"]) {
			expect(escapeForInlineScript(JSON.stringify({ t: payload }))).not.toContain("<");
		}
	});

	it("escapes the raw U+2028/U+2029 line terminators JSON leaves unescaped", () => {
		const out = escapeForInlineScript(`{"x":"${LS}${PS}"}`);
		expect(out).not.toContain(LS);
		expect(out).not.toContain(PS);
		expect(out).toContain("\\u2028");
		expect(out).toContain("\\u2029");
	});

	it("round-trips through JSON.parse unchanged — the escape is transparent to the parser", () => {
		const value = { title: "<!--<script>a</script>", nested: [`${LS}x`, "a < b", "&amp;"] };
		expect(JSON.parse(escapeForInlineScript(JSON.stringify(value)))).toEqual(value);
	});

	it("leaves > and & alone — neither can leave script-data state", () => {
		const out = escapeForInlineScript(JSON.stringify({ t: "a > b & c" }));
		expect(out).toContain(">");
		expect(out).toContain("&");
	});

	it("is a no-op for JSON with nothing to escape", () => {
		const json = JSON.stringify({ a: 1, b: "plain text" });
		expect(escapeForInlineScript(json)).toBe(json);
	});
});
