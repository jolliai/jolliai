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

	describe("onboarding panel skeleton", () => {
		it("includes the onboarding panel, hidden by default", () => {
			const html = buildSidebarHtml(
				"test-nonce",
				"vscode-resource:",
				"https://example/codicon.css",
				SIDEBAR_EMPTY_STRINGS,
			);
			expect(html).toContain('id="onboarding-panel"');
			expect(html).toMatch(/<div class="onboarding-panel hidden"/);
			expect(html).toContain("Get started with Jolli Memory");
			expect(html).toContain("Sign in to Jolli");
			expect(html).toContain("Use your Anthropic API key");
			expect(html).toContain("RECOMMENDED");
			expect(html).toContain('id="onboarding-signin-btn"');
			expect(html).toContain('id="onboarding-apikey-btn"');
		});

		it("renders Anthropic API key as the recommended option above Sign in to Jolli", () => {
			const html = buildSidebarHtml(
				"test-nonce",
				"vscode-resource:",
				"https://example/codicon.css",
				SIDEBAR_EMPTY_STRINGS,
			);
			const apikeyIdx = html.indexOf("Use your Anthropic API key");
			const signinIdx = html.indexOf("Sign in to Jolli");
			expect(apikeyIdx).toBeGreaterThan(-1);
			expect(signinIdx).toBeGreaterThan(-1);
			expect(apikeyIdx).toBeLessThan(signinIdx);
			// The RECOMMENDED badge must live in the same DOM region as the
			// Anthropic card — i.e. between the panel header and the Sign in card.
			const badgeIdx = html.indexOf("RECOMMENDED");
			expect(badgeIdx).toBeGreaterThan(-1);
			expect(badgeIdx).toBeLessThan(signinIdx);
		});

		it("uses primary button class on Configure API Key and secondary on Sign In", () => {
			const html = buildSidebarHtml(
				"test-nonce",
				"vscode-resource:",
				"https://example/codicon.css",
				SIDEBAR_EMPTY_STRINGS,
			);
			expect(html).toMatch(
				/id="onboarding-apikey-btn"[^>]*class="ob-btn ob-btn--primary"/,
			);
			expect(html).toMatch(
				/id="onboarding-signin-btn"[^>]*class="ob-btn ob-btn--secondary"/,
			);
		});
	});

	describe("loading panel skeleton", () => {
		it("includes the loading panel visible by default with spinner + label", () => {
			const html = buildSidebarHtml(
				"test-nonce",
				"vscode-resource:",
				"https://example/codicon.css",
				SIDEBAR_EMPTY_STRINGS,
			);
			// Loading panel is the first-paint placeholder. It must NOT be
			// hidden by default — the script tears it down once init lands.
			expect(html).toContain('id="loading-panel"');
			expect(html).toMatch(/<div class="loading-panel"/);
			expect(html).not.toMatch(/<div class="loading-panel hidden"/);
			expect(html).toContain("codicon-loading codicon-modifier-spin");
			expect(html).toContain("Loading…");
		});

		it("hides tab-bar and all tab-content panels by default so they don't peek through during loading", () => {
			const html = buildSidebarHtml(
				"test-nonce",
				"vscode-resource:",
				"https://example/codicon.css",
				SIDEBAR_EMPTY_STRINGS,
			);
			// Without these defaults, reload would briefly show the tab bar
			// before the script wires up applyConfigured/applyEnabled.
			expect(html).toMatch(/<div class="tab-bar hidden"/);
			expect(html).toMatch(
				/<div class="tab-content hidden" id="tab-content-branch"/,
			);
			expect(html).toMatch(
				/<div class="tab-content hidden" id="tab-content-kb"/,
			);
			expect(html).toMatch(
				/<div class="tab-content hidden" id="tab-content-status"/,
			);
		});
	});

	describe("disabled panel skeleton", () => {
		it("includes the disabled panel, hidden by default, with a header and Enable button", () => {
			const html = buildSidebarHtml(
				"test-nonce",
				"vscode-resource:",
				"https://example/codicon.css",
				SIDEBAR_EMPTY_STRINGS,
			);
			expect(html).toContain('id="disabled-panel"');
			expect(html).toMatch(/<div class="disabled-panel hidden"/);
			expect(html).toContain('id="disabled-enable-btn"');
			expect(html).toMatch(
				/id="disabled-enable-btn"[^>]*class="ob-btn ob-btn--primary"/,
			);
			expect(html).toMatch(
				/<button[^>]*id="disabled-enable-btn"[^>]*>Enable Jolli Memory<\/button>/,
			);
		});

		it("reuses the onboarding header copy (Get started + subtitle) and omits the option cards", () => {
			const html = buildSidebarHtml(
				"test-nonce",
				"vscode-resource:",
				"https://example/codicon.css",
				SIDEBAR_EMPTY_STRINGS,
			);
			// Slice from disabled-panel open to the next sibling (tab-bar);
			// disabled-panel sits between onboarding-panel and tab-bar in the
			// skeleton, so this window contains exactly the panel's body.
			const start = html.indexOf('<div class="disabled-panel');
			const end = html.indexOf('<div class="tab-bar', start);
			expect(start).toBeGreaterThan(-1);
			expect(end).toBeGreaterThan(start);
			const panel = html.slice(start, end);
			expect(panel).toContain("Get started with Jolli Memory");
			expect(panel).toContain(
				"Jolli Memory automatically captures your work context",
			);
			// Onboarding-only artefacts must NOT bleed into the disabled panel.
			expect(panel).not.toContain("RECOMMENDED");
			expect(panel).not.toContain("Use your Anthropic API key");
			expect(panel).not.toContain("Sign in to Jolli");
			expect(panel).not.toMatch(/class="ob-card/);
			expect(panel).not.toMatch(/class="ob-or"/);
		});
	});
});
