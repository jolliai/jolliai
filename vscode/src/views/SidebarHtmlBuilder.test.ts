import { describe, expect, it, vi } from "vitest";

vi.mock("./SidebarCssBuilder.js", () => ({
	buildSidebarCss: () => "/* sidebar-css */",
}));
vi.mock("./SidebarScriptBuilder.js", () => ({
	buildSidebarScript: () => "/* sidebar-script */",
}));

import { SIDEBAR_EMPTY_STRINGS } from "./SidebarEmptyMessages.js";
import { buildSidebarHtml } from "./SidebarHtmlBuilder.js";

describe("SidebarHtmlBuilder", () => {
	it("returns a complete HTML document", () => {
		const html = buildSidebarHtml(
			"test-nonce",
			"vscode-resource:",
			"https://example/codicon.css",
			SIDEBAR_EMPTY_STRINGS,
		);
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("</html>");
	});

	it("injects the provided nonce in CSP, style, and script tags", () => {
		const html = buildSidebarHtml(
			"test-nonce-123",
			"vscode-resource:",
			"https://example/codicon.css",
			SIDEBAR_EMPTY_STRINGS,
		);
		const occurrences = html.split("test-nonce-123").length - 1;
		expect(occurrences).toBeGreaterThanOrEqual(3);
	});

	it("renders 2 labeled tab buttons + status icon button + settings icon button", () => {
		const html = buildSidebarHtml(
			"n",
			"vscode-resource:",
			"https://example/codicon.css",
			SIDEBAR_EMPTY_STRINGS,
		);
		// Two labeled tabs
		expect(html).toContain('data-tab="kb"');
		expect(html).toContain('data-tab="branch"');
		// Status icon button (not a labeled tab — lives in tab-bar-right)
		expect(html).toContain('id="status-icon-btn"');
		expect(html).toContain("codicon-circle-filled");
		// Settings was moved into the Status tab toolbar (rendered by JS), so it
		// must NOT live in the static HTML skeleton anymore.
		expect(html).not.toContain('data-action="open-settings"');
		// Status icon still carries data-tab="status" for switchTab compatibility
		expect(html).toContain('data-tab="status"');
		// Native title="Status" was removed in favor of attachTextTip (which
		// renders a dynamic OK/Warnings/Errors tooltip from JS). Keeping both
		// would cause the native title to flash before the project tip shows.
		expect(html).not.toContain('id="status-icon-btn" title=');
	});

	it("includes 3 tab content panels with stable ids", () => {
		const html = buildSidebarHtml(
			"n",
			"vscode-resource:",
			"https://example/codicon.css",
			SIDEBAR_EMPTY_STRINGS,
		);
		expect(html).toContain('id="tab-content-kb"');
		expect(html).toContain('id="tab-content-branch"');
		expect(html).toContain('id="tab-content-status"');
	});

	it("includes a hidden disabled banner mount", () => {
		const html = buildSidebarHtml(
			"n",
			"vscode-resource:",
			"https://example/codicon.css",
			SIDEBAR_EMPTY_STRINGS,
		);
		expect(html).toContain('id="disabled-banner"');
	});

	it("includes a link tag for the codicon CSS URI", () => {
		const html = buildSidebarHtml(
			"n",
			"vscode-resource:",
			"https://example/codicon.css",
			SIDEBAR_EMPTY_STRINGS,
		);
		expect(html).toContain(
			'<link rel="stylesheet" href="https://example/codicon.css"',
		);
	});

	it("includes style-src cspSource in the CSP meta tag", () => {
		const html = buildSidebarHtml(
			"n",
			"vscode-resource:",
			"https://example/codicon.css",
			SIDEBAR_EMPTY_STRINGS,
		);
		expect(html).toContain("style-src vscode-resource:");
		expect(html).toContain("font-src vscode-resource:");
	});

	it("injects empty-strings JSON block", () => {
		const html = buildSidebarHtml(
			"test-nonce",
			"vscode-resource:",
			"https://example/codicon.css",
			SIDEBAR_EMPTY_STRINGS,
		);
		expect(html).toContain('id="empty-strings"');
		expect(html).toContain('"kbMemoriesEmpty":"No memories yet."');
		expect(html).toContain('type="application/json"');
	});
});
