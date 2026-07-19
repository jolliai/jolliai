import { describe, expect, it } from "vitest";
import { buildConversationDetailsHtml } from "./ConversationDetailsHtmlBuilder.js";

// The detail panel webview pulls in a codicon stylesheet from the extension's
// bundled asset URI, so the builder requires `cspSource` (allowlisted in CSP)
// and `codiconCssUri` (the asWebviewUri-resolved href). Tests pass fixed dummy
// values; the assertions below pin those literals.
const TEST_CSP_SOURCE = "vscode-webview://test";
const TEST_CODICON_URI = "https://example/codicon.css";

function build(source: string, title = "Some session"): string {
	return buildConversationDetailsHtml({
		nonce: "abc123",
		sessionId: "sess-1",
		source,
		transcriptPath: "/tmp/t.jsonl",
		title,
		readOnly: false,
		cspSource: TEST_CSP_SOURCE,
		codiconCssUri: TEST_CODICON_URI,
	});
}

describe("buildConversationDetailsHtml", () => {
	describe("source badge", () => {
		// The detail panel runs in its own webview with no shared CSS, so the
		// brand-color cascade is duplicated locally from SidebarCssBuilder. These
		// tests pin the badge HTML + CSS so the panel title-bar stays in step
		// with the CONVERSATIONS row that opened it.
		it("attaches a transcript-source-<source> class to the badge", () => {
			for (const source of [
				"claude",
				"cursor",
				"codex",
				"gemini",
				"opencode",
				"copilot",
				"copilot-chat",
			]) {
				const html = build(source);
				expect(html).toContain(
					`<span class="badge transcript-source-${source}" id="badge">`,
				);
			}
		});

		it("renders the providerLabel string, not the raw enum value", () => {
			const cases: Array<[string, string]> = [
				["claude", "Claude"],
				["cursor", "Cursor"],
				["codex", "Codex"],
				["gemini", "Gemini"],
				["opencode", "OpenCode"],
				["copilot", "Copilot"],
				["copilot-chat", "Copilot Chat"],
			];
			for (const [source, label] of cases) {
				const html = build(source);
				const open = `<span class="badge transcript-source-${source}" id="badge">`;
				const start = html.indexOf(open);
				expect(start).toBeGreaterThanOrEqual(0);
				const after = html.slice(start + open.length);
				expect(after.startsWith(`${label}</span>`)).toBe(true);
			}
		});

		it("falls back to the raw source string for unknown sources", () => {
			const html = build("future-agent");
			expect(html).toContain(
				'<span class="badge transcript-source-future-agent" id="badge">future-agent</span>',
			);
		});

		it("declares brand-color rules for every TranscriptSource", () => {
			// Each rule must include the .badge prefix so its specificity
			// (0,2,0) beats the neutral .badge fallback (0,1,0). Bare
			// '.transcript-source-X' would be silently overridden.
			const html = build("claude");
			for (const source of [
				"claude",
				"cursor",
				"codex",
				"gemini",
				"opencode",
				"copilot",
				"copilot-chat",
				"devin",
			]) {
				const re = new RegExp(
					"\\.badge\\.transcript-source-" +
						source +
						"\\b[^{]*\\{[^}]*color:\\s*#[0-9a-f]{3,6}[^}]*border-color:",
					"i",
				);
				expect(html).toMatch(re);
			}
		});
	});

	describe("readOnly footer toggle", () => {
		it("adds the hidden class to the footer when readOnly is true", () => {
			const html = buildConversationDetailsHtml({
				nonce: "n",
				sessionId: "s",
				source: "claude",
				transcriptPath: "/t",
				title: "x",
				readOnly: true,
				cspSource: TEST_CSP_SOURCE,
				codiconCssUri: TEST_CODICON_URI,
			});
			expect(html).toContain('class="footer hidden"');
		});

		it("omits the hidden class on the footer when readOnly is false", () => {
			const html = buildConversationDetailsHtml({
				nonce: "n",
				sessionId: "s",
				source: "claude",
				transcriptPath: "/t",
				title: "x",
				readOnly: false,
				cspSource: TEST_CSP_SOURCE,
				codiconCssUri: TEST_CODICON_URI,
			});
			expect(html).toContain('class="footer"');
			expect(html).not.toContain('class="footer hidden"');
		});
	});

	describe("edited notice", () => {
		it("renders a hidden edited notice banner shell for script-controlled toggling", () => {
			const html = build("claude");
			expect(html).toContain('id="editedNotice"');
			expect(html).toContain('class="edited-notice hidden"');
			expect(html).toContain("Conversation content has been modified.");
		});

		it("uses a codicon-edit glyph (no text pill) so the marker matches the sidebar row", () => {
			const html = build("claude");
			// The pencil glyph carries the "modified" semantic; the adjacent
			// .edited-text span carries the full sentence, so the icon is
			// aria-hidden to avoid double-announcing for screen readers.
			expect(html).toContain(
				'<i class="codicon codicon-edit edited-icon" aria-hidden="true"></i>',
			);
			// And the legacy text pill must not survive — it was the exact thing
			// that visually competed with the AI agent badge in the sidebar
			// row, so we don't want it leaking back in here either.
			expect(html).not.toContain("edited-pill");
			expect(html).not.toContain(">Edited<");
		});

		it("links the codicon stylesheet into <head> so the glyph renders", () => {
			const html = build("claude");
			expect(html).toContain(
				`<link rel="stylesheet" href="${TEST_CODICON_URI}" />`,
			);
		});
	});

	describe("HTML escaping", () => {
		// TranscriptSource is a controlled enum, but the builder still routes
		// both title and source through escapeHtml as defense-in-depth. These
		// assertions stay focused on the badge's title-bar HTML; the wider
		// CSP / nonce / inline-script defenses are out of scope here.
		it("escapes special characters in the title", () => {
			const html = buildConversationDetailsHtml({
				nonce: "n",
				sessionId: "s",
				source: "claude",
				transcriptPath: "/t",
				title: 'Tom & "Jerry" <hi>',
				readOnly: false,
				cspSource: TEST_CSP_SOURCE,
				codiconCssUri: TEST_CODICON_URI,
			});
			expect(html).toContain("Tom &amp; &quot;Jerry&quot; &lt;hi&gt;");
		});

		it("escapes special characters in the source class + label", () => {
			const html = buildConversationDetailsHtml({
				nonce: "n",
				sessionId: "s",
				source: "weird<&>source",
				transcriptPath: "/t",
				title: "x",
				readOnly: false,
				cspSource: TEST_CSP_SOURCE,
				codiconCssUri: TEST_CODICON_URI,
			});
			expect(html).toContain(
				'<span class="badge transcript-source-weird&lt;&amp;&gt;source" id="badge">weird&lt;&amp;&gt;source</span>',
			);
		});
	});

	describe("CSP nonce", () => {
		it("interpolates the caller-provided nonce into CSP and script tag", () => {
			const html = buildConversationDetailsHtml({
				nonce: "NONCE-XYZ",
				sessionId: "s",
				source: "claude",
				transcriptPath: "/t",
				title: "x",
				readOnly: false,
				cspSource: TEST_CSP_SOURCE,
				codiconCssUri: TEST_CODICON_URI,
			});
			expect(html).toContain("script-src 'nonce-NONCE-XYZ'");
			expect(html).toContain('<script nonce="NONCE-XYZ">');
		});

		it("locks style-src to cspSource + nonce (no 'unsafe-inline')", () => {
			// CLAUDE.md webview CSP rule: no inline style="" — relying on
			// nonce-only inline style means a future inline-style regression
			// fails closed instead of silently rendering in this panel while
			// being blocked elsewhere. cspSource is added solely so the
			// bundled codicon stylesheet (linked via <link rel="stylesheet">)
			// loads; arbitrary inline style="..." still cannot match it.
			const html = buildConversationDetailsHtml({
				nonce: "NONCE-XYZ",
				sessionId: "s",
				source: "claude",
				transcriptPath: "/t",
				title: "x",
				readOnly: false,
				cspSource: TEST_CSP_SOURCE,
				codiconCssUri: TEST_CODICON_URI,
			});
			expect(html).toContain(
				`style-src ${TEST_CSP_SOURCE} 'nonce-NONCE-XYZ'`,
			);
			expect(html).toContain(`font-src ${TEST_CSP_SOURCE}`);
			expect(html).not.toContain("'unsafe-inline'");
		});

		it("attaches the nonce to the embedded <style> block so the CSP doesn't strip it", () => {
			const html = buildConversationDetailsHtml({
				nonce: "NONCE-XYZ",
				sessionId: "s",
				source: "claude",
				transcriptPath: "/t",
				title: "x",
				readOnly: false,
				cspSource: TEST_CSP_SOURCE,
				codiconCssUri: TEST_CODICON_URI,
			});
			expect(html).toContain('<style nonce="NONCE-XYZ">');
		});
	});

	describe("script injection defense", () => {
		// JSON.stringify does NOT escape '/' or '<', so a transcriptPath
		// containing the literal "</script>" would close the surrounding
		// <script> tag and inject the trailing JSON as HTML. The builder
		// pre-escapes '<' to its JSON unicode form, which JSON.parse decodes
		// transparently inside the webview.
		it("escapes a transcriptPath that contains </script> so it cannot terminate the inline block", () => {
			const malicious =
				"/tmp/</script><img src=x onerror=alert(1)>/transcript.jsonl";
			const html = buildConversationDetailsHtml({
				nonce: "n",
				sessionId: "s",
				source: "claude",
				transcriptPath: malicious,
				title: "x",
				readOnly: false,
				cspSource: TEST_CSP_SOURCE,
				codiconCssUri: TEST_CODICON_URI,
			});
			// Between the opening `<script nonce="n">` and the matching
			// `</script>` there must be no extra `</script>` token.
			const openIdx = html.indexOf('<script nonce="n">');
			expect(openIdx).toBeGreaterThanOrEqual(0);
			const closeIdx = html.indexOf("</script>", openIdx);
			expect(closeIdx).toBeGreaterThan(openIdx);
			const inside = html.slice(openIdx, closeIdx);
			expect(inside).not.toContain("</script>");
			// Defense renders the literal `<` (only — `>` alone cannot close
			// a script tag) as the JSON unicode escape so JSON.parse
			// round-trips to the original string in the webview.
			expect(inside).toContain("\\u003c/script>");
			// And the original raw closing tag must NOT survive verbatim.
			expect(inside).not.toContain("</script>");
		});
	});
});
