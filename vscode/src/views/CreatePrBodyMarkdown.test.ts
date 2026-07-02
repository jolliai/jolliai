import { describe, expect, it } from "vitest";
import { renderPrBodyMarkdown } from "./CreatePrBodyMarkdown";

describe("renderPrBodyMarkdown", () => {
	it("returns empty string for empty or whitespace-only input", () => {
		expect(renderPrBodyMarkdown("")).toBe("");
		expect(renderPrBodyMarkdown("   \n  \n")).toBe("");
	});

	it("renders ATX headings with a +1 level offset and the md-heading class", () => {
		expect(renderPrBodyMarkdown("## Quick recap")).toBe('<h3 class="md-heading">Quick recap</h3>');
		expect(renderPrBodyMarkdown("# Top")).toBe('<h2 class="md-heading">Top</h2>');
	});

	it("caps heading level at 6", () => {
		expect(renderPrBodyMarkdown("###### Deep")).toContain("<h6");
	});

	it("passes whole-line structural HTML through verbatim so folding renders natively", () => {
		const html = renderPrBodyMarkdown(
			["<details>", "<summary><strong>01 · Title</strong></summary>", "<br>", "<blockquote>", "</blockquote>", "</details>"].join(
				"\n",
			),
		);
		expect(html).toContain("<details>");
		expect(html).toContain("<summary><strong>01 · Title</strong></summary>");
		expect(html).toContain("<br>");
		expect(html).toContain("<blockquote>");
		expect(html).toContain("</blockquote>");
		expect(html).toContain("</details>");
	});

	it("renders a fenced code block, escaping its contents", () => {
		const html = renderPrBodyMarkdown("```ts\nconst x = 1 < 2;\n```");
		expect(html).toBe('<pre class="md-code-block"><code>const x = 1 &lt; 2;</code></pre>');
	});

	it("flushes an unterminated fenced code block", () => {
		const html = renderPrBodyMarkdown("```\nline1\nline2");
		expect(html).toBe('<pre class="md-code-block"><code>line1\nline2</code></pre>');
	});

	it("renders a horizontal rule", () => {
		expect(renderPrBodyMarkdown("---")).toBe('<hr class="md-hr" />');
	});

	it("merges consecutive markdown blockquote lines into one block", () => {
		const html = renderPrBodyMarkdown("> Note: line one\n> line two");
		expect(html).toBe('<blockquote class="md-quote">Note: line one<br />line two</blockquote>');
	});

	it("renders an unordered list and closes it when a non-item line follows", () => {
		const html = renderPrBodyMarkdown("- one\n- two\ntail");
		expect(html).toBe(
			'<ul class="md-list"><li>one</li><li>two</li></ul><div class="md-line">tail</div>',
		);
	});

	it("emits a gap for blank lines and a md-line for paragraphs", () => {
		expect(renderPrBodyMarkdown("hello\n\nworld")).toBe(
			'<div class="md-line">hello</div><div class="md-blank"></div><div class="md-line">world</div>',
		);
	});

	it("applies inline bold, italic, code and http links", () => {
		expect(renderPrBodyMarkdown("**bold**")).toContain("<strong>bold</strong>");
		expect(renderPrBodyMarkdown("*em*")).toContain("<em>em</em>");
		expect(renderPrBodyMarkdown("`code`")).toContain('<code class="md-inline-code">code</code>');
		expect(renderPrBodyMarkdown("[docs](https://x.jolli.ai/p)")).toContain(
			'<a class="md-link" href="https://x.jolli.ai/p">docs</a>',
		);
	});

	it("does not treat underscores in identifiers or paths as italic", () => {
		const html = renderPrBodyMarkdown("Touch `file_name_v2.ts` and a_b_c");
		expect(html).not.toContain("<em>");
	});

	it("escapes stray HTML in prose so it cannot inject markup", () => {
		const html = renderPrBodyMarkdown("Danger <img src=x onerror=1> here");
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img");
	});

	it("normalizes CRLF line endings", () => {
		expect(renderPrBodyMarkdown("a\r\nb")).toBe('<div class="md-line">a</div><div class="md-line">b</div>');
	});

	it("does not re-apply bold/italic markup found inside an inline code span", () => {
		const html = renderPrBodyMarkdown("Use `**not bold**` here");
		expect(html).toContain('<code class="md-inline-code">**not bold**</code>');
		expect(html).not.toContain("<strong>");
	});

	it("does not re-apply bold/italic markup found inside a link's text or URL", () => {
		const html = renderPrBodyMarkdown("[**bold** text](https://x.jolli.ai/a*b)");
		expect(html).toBe('<div class="md-line"><a class="md-link" href="https://x.jolli.ai/a*b">**bold** text</a></div>');
	});

	it("renders ordered lists as <ol> and switches list type at a marker-style boundary", () => {
		const html = renderPrBodyMarkdown("**Steps:**\n1. Open the app\n2. Click the button");
		expect(html).toBe(
			'<div class="md-line"><strong>Steps:</strong></div><ol class="md-list"><li>Open the app</li><li>Click the button</li></ol>',
		);
	});

	it("closes an ordered list and opens an unordered one when the marker style switches", () => {
		const html = renderPrBodyMarkdown("1. first\n- second");
		expect(html).toBe('<ol class="md-list"><li>first</li></ol><ul class="md-list"><li>second</li></ul>');
	});

	it("does not double-escape text already neutralized by cli's escapeGithubWrapperTags", () => {
		// escapeGithubWrapperTags turns a literal "<details>" typed in body prose into
		// this entity form so GitHub's renderer shows it inertly (see
		// cli/src/core/SummaryPrMarkdownBuilder.ts). This renderer must undo that
		// encoding before its own escHtml pass, or the leftover "&" gets escaped a
		// second time and the browser shows the literal text "&lt;details&gt;".
		const html = renderPrBodyMarkdown("Wrap the section in a &lt;details&gt; tag");
		expect(html).toBe('<div class="md-line">Wrap the section in a &lt;details&gt; tag</div>');
		expect(html).not.toContain("&amp;lt;");
	});

	it("falls back to escaped plain text for a <summary> line that isn't the exact wrapInGithubDetails shape", () => {
		// SUMMARY_LINE is anchored to <summary><strong>…</strong></summary> specifically
		// so that untrusted content smuggled into the line (rather than pre-escaped by
		// the caller) fails the pattern and gets HTML-escaped instead of passed through.
		const html = renderPrBodyMarkdown("<summary><img src=x onerror=alert(1)></summary>");
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;summary&gt;&lt;img");
	});
});
