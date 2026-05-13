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

	it("renders the header bar with breadcrumb (repo + branch) and 3 right-side icon buttons", () => {
		const html = buildSidebarHtml(
			"n",
			"vscode-resource:",
			"https://example/codicon.css",
			SIDEBAR_EMPTY_STRINGS,
		);
		// Breadcrumb segments: repo on the left, branch on the right, with a
		// chevron-down per segment that the script hides when there is no
		// real choice (initially hidden via .hidden in the static skeleton so
		// the breadcrumb doesn't dangle a no-op affordance before the host
		// pushes the repo/branch enumeration).
		expect(html).toContain('id="breadcrumb"');
		expect(html).toContain('id="breadcrumb-repo-btn"');
		expect(html).toContain('id="breadcrumb-branch-btn"');
		expect(html).toContain('id="breadcrumb-repo-label"');
		expect(html).toContain('id="breadcrumb-branch-label"');
		expect(html).toMatch(
			/<i[^>]*class="codicon codicon-chevron-down breadcrumb-seg-chevron hidden"/,
		);
		// 3 icon buttons on the right side. Memory Bank and Status carry
		// data-tab for the switchTab dispatch; Settings carries
		// data-action="open-settings" so the existing event handler routes it
		// to the openSettings command without going through tab dispatch.
		expect(html).toContain('id="kb-icon-btn"');
		expect(html).toContain('data-tab="kb"');
		expect(html).toContain('id="settings-icon-btn"');
		expect(html).toContain('data-action="open-settings"');
		expect(html).toContain('id="status-icon-btn"');
		expect(html).toContain('data-tab="status"');
		expect(html).toContain("codicon-circle-filled");
		// The branch label is now part of the breadcrumb, not a tab button.
		// data-tab="branch" no longer appears anywhere because Branch is the
		// implicit default view that surfaces whenever no overlay is active.
		expect(html).not.toContain('data-tab="branch"');
		// Native title="Status" was removed in favor of attachTextTip (which
		// renders a dynamic OK/Warnings/Errors tooltip from JS). Keeping both
		// would cause the native title to flash before the project tip shows.
		expect(html).not.toContain('id="status-icon-btn" title=');
		// Dropdown menu container — empty by default, populated on demand by
		// the script when a breadcrumb segment is clicked.
		expect(html).toContain('id="breadcrumb-menu"');
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

		it("includes the apikey-panel, hidden by default, with input + Save (initially disabled) + Back + inline error", () => {
			const html = buildSidebarHtml(
				"test-nonce",
				"vscode-resource:",
				"https://example/codicon.css",
				SIDEBAR_EMPTY_STRINGS,
			);
			expect(html).toContain('id="apikey-panel"');
			expect(html).toMatch(/<div class="apikey-panel hidden"/);
			// Password input keeps the typed key off-screen and disables
			// browser autofill (Anthropic keys aren't a username/password
			// pair so autofill suggestions would be wrong noise).
			expect(html).toMatch(
				/<input type="password"[^>]*id="apikey-input"[^>]*autocomplete="off"/,
			);
			// Save starts disabled — empty input is not a valid key. The
			// script flips it on input. Without the disabled attribute the
			// user could click Save with an empty field and we'd round-trip
			// to the host just to surface "API key cannot be empty."
			expect(html).toMatch(
				/<button[^>]*id="apikey-save-btn"[^>]*\sdisabled[^>]*>Save<\/button>/,
			);
			expect(html).toMatch(
				/<button[^>]*id="apikey-back-btn"[^>]*>Back<\/button>/,
			);
			// Inline error span is hidden until populated by an
			// apikey:saveError message from the host.
			expect(html).toMatch(/<p class="apikey-error hidden"/);
			expect(html).toContain('id="apikey-error"');
		});

		it("places the apikey-panel between onboarding-panel and disabled-panel so configured===false views are siblings", () => {
			const html = buildSidebarHtml(
				"test-nonce",
				"vscode-resource:",
				"https://example/codicon.css",
				SIDEBAR_EMPTY_STRINGS,
			);
			// The three configured===false views must be DOM siblings in this
			// order so the script's exclusive toggle (only one of the three
			// visible at a time) maps cleanly to top-down scan order. Out of
			// order they'd still render correctly, but we'd lose the
			// "first-of-three is the default" intuition.
			const ob = html.indexOf('<div class="onboarding-panel');
			const ak = html.indexOf('<div class="apikey-panel');
			const di = html.indexOf('<div class="disabled-panel');
			expect(ob).toBeGreaterThan(-1);
			expect(ak).toBeGreaterThan(ob);
			expect(di).toBeGreaterThan(ak);
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
