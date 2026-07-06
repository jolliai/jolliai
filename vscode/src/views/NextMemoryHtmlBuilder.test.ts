import { describe, expect, it } from "vitest";
import { buildNextMemoryHtml } from "./NextMemoryHtmlBuilder.js";

describe("buildNextMemoryHtml", () => {
	it("includes a nonce-based CSP with no unsafe-inline", () => {
		const html = buildNextMemoryHtml("abc123", "vscode-webview://x", "https://x/codicon.css");
		expect(html).toContain("Content-Security-Policy");
		expect(html).toContain("nonce-abc123");
		expect(html).not.toContain("unsafe-inline");
	});

	it("mounts the CSS and script with the same nonce", () => {
		const html = buildNextMemoryHtml("abc123", "vscode-webview://x", "https://x/codicon.css");
		expect(html).toContain('<style nonce="abc123">');
		expect(html).toContain('<script nonce="abc123">');
	});

	it("links the codicon stylesheet", () => {
		const html = buildNextMemoryHtml("abc123", "vscode-webview://x", "https://x/codicon.css");
		expect(html).toContain("https://x/codicon.css");
	});

	it("provides mount points for the panels the script builder renders into", () => {
		const html = buildNextMemoryHtml("abc123", "vscode-webview://x", "https://x/codicon.css");
		for (const id of [
			"root",
			"meta-strip",
			"title-panel",
			"token-meter",
			"conversations-panel",
			"context-panel",
			"files-panel",
			"footer",
		]) {
			expect(html).toContain(`id="${id}"`);
		}
	});
});
