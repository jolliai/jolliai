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

	it("renders the header bar with the breadcrumb (repo + branch) and no in-webview icon strip", () => {
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
		// The Settings (gear) and Status (pulse) actions moved to the native
		// "JOLLI MEMORY" title bar (view/title contributions), so the webview no
		// longer renders an in-header icon strip at all.
		expect(html).not.toContain('id="kb-icon-btn"');
		expect(html).not.toContain('id="settings-icon-btn"');
		expect(html).not.toContain('data-action="open-settings"');
		expect(html).not.toContain('id="status-icon-btn"');
		expect(html).not.toContain('class="tab-bar-right"');
		// Dropdown menu container — empty by default, populated on demand by
		// the script when a breadcrumb segment is clicked.
		expect(html).toContain('id="breadcrumb-menu"');
	});

	it("renders the two-view switch with Current Branch / Memory Bank", () => {
		const html = buildSidebarHtml(
			"n",
			"vscode-resource:",
			"https://example/codicon.css",
			SIDEBAR_EMPTY_STRINGS,
		);
		// The view-switch is hidden by default (like tab-bar) so it doesn't
		// peek through during the loading-panel phase.
		expect(html).toMatch(/<div class="view-switch hidden" id="view-switch"/);
		expect(html).toContain('class="view-tab active" type="button" data-tab="branch"');
		expect(html).toContain('data-tab="kb"');
		expect(html).not.toContain('data-tab="knowledge"');
		expect(html).toContain("Current Branch");
		expect(html).toContain("Memory Bank");
		// The view-switch sits ABOVE the breadcrumb header now (it used to be
		// below it). The repo/branch dropdowns live under the three-view tabs.
		const switchIdx = html.indexOf('id="view-switch"');
		const tabBarIdx = html.indexOf('id="tab-bar"');
		expect(switchIdx).toBeGreaterThan(-1);
		expect(tabBarIdx).toBeGreaterThan(switchIdx);
	});

	it("renders a repo filter selector for the Memory Bank header", () => {
		const html = buildSidebarHtml("n", "vscode-resource:", "https://example/codicon.css", SIDEBAR_EMPTY_STRINGS);
		expect(html).toContain('id="repo-filter"');
		expect(html).toContain("Showing");
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
		expect(html).not.toContain('id="tab-content-knowledge"');
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

		it("renders Anthropic API key above Sign in to Jolli, with the RECOMMENDED badge preceding both", () => {
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
			// In the static skeleton the RECOMMENDED badge lives inside the
			// (hidden-by-default) local-agent card, which sits above the API-key
			// card — SidebarScriptBuilder moves it back onto the API-key card at
			// runtime only when state.localAgents is empty. Either way it must
			// precede the Sign in to Jolli card.
			const badgeIdx = html.indexOf("RECOMMENDED");
			expect(badgeIdx).toBeGreaterThan(-1);
			expect(badgeIdx).toBeLessThan(signinIdx);
			// The API-key card itself no longer carries the recommended styling
			// statically — that is applied dynamically only in the no-agents case.
			const apikeyCardTag = html.match(/<section[^>]*id="onboarding-apikey-card"[^>]*>/)?.[0] ?? "";
			expect(apikeyCardTag).not.toBe("");
			expect(apikeyCardTag).not.toContain("ob-card--recommended");
		});

		it("uses secondary button class on both Configure API Key and Sign In", () => {
			const html = buildSidebarHtml(
				"test-nonce",
				"vscode-resource:",
				"https://example/codicon.css",
				SIDEBAR_EMPTY_STRINGS,
			);
			expect(html).toMatch(
				/id="onboarding-apikey-btn"[^>]*class="ob-btn ob-btn--secondary"/,
			);
			expect(html).toMatch(
				/id="onboarding-signin-btn"[^>]*class="ob-btn ob-btn--secondary"/,
			);
		});
	});

	describe("onboarding local-agent card", () => {
		it("renders the block hidden by default", () => {
			const html = buildSidebarHtml(
				"test-nonce",
				"vscode-resource:",
				"https://example/codicon.css",
				SIDEBAR_EMPTY_STRINGS,
			);
			expect(html).toContain('id="onboarding-localagent-block"');
			expect(html).toMatch(/<div class="ob-localagent hidden" id="onboarding-localagent-block">/);
		});

		it("uses the exact approved copy", () => {
			const html = buildSidebarHtml(
				"test-nonce",
				"vscode-resource:",
				"https://example/codicon.css",
				SIDEBAR_EMPTY_STRINGS,
			);
			expect(html).toContain("Use your local agent tool");
			expect(html).toContain(
				"Use your local agent tool for AI summarization. Memories are stored locally only.",
			);
			expect(html).toContain("Use Local Agent Tool");
			expect(html).toContain("Make sure you're signed in to the tool.");
		});

		it("carries no inline style or inline handler (CSP)", () => {
			const html = buildSidebarHtml(
				"test-nonce",
				"vscode-resource:",
				"https://example/codicon.css",
				SIDEBAR_EMPTY_STRINGS,
			);
			expect(html).not.toMatch(/<[^>]*\sstyle="/);
			expect(html).not.toMatch(/\son(click|change)=/);
		});

		it("produces the DOM ids and CSS classes the script builder consumes", () => {
			const html = buildSidebarHtml(
				"test-nonce",
				"vscode-resource:",
				"https://example/codicon.css",
				SIDEBAR_EMPTY_STRINGS,
			);
			expect(html).toContain('id="onboarding-localagent-select"');
			expect(html).toContain('id="onboarding-localagent-btn"');
			expect(html).toContain('id="onboarding-localagent-error"');
			expect(html).toContain('class="ob-select"');
			expect(html).toContain('class="ob-hint"');
			// The error paragraph starts hidden — Task 9 owns showing it.
			expect(html).toMatch(/class="ob-error hidden" id="onboarding-localagent-error"/);
			// The <option> list is NOT interpolated into the HTML string — the
			// skeleton's own docstring states it carries no user-supplied data.
			// SidebarScriptBuilder populates it via the DOM API on init.
			const selectTag = html.match(/<select[^>]*id="onboarding-localagent-select"[^>]*>[\s\S]*?<\/select>/)?.[0] ?? "";
			expect(selectTag).not.toBe("");
			expect(selectTag).not.toContain("<option");
		});

		it("positions the block immediately after the onboarding divider, above the API-key card", () => {
			const html = buildSidebarHtml(
				"test-nonce",
				"vscode-resource:",
				"https://example/codicon.css",
				SIDEBAR_EMPTY_STRINGS,
			);
			const dividerIdx = html.indexOf('<hr class="ob-divider" />');
			const blockIdx = html.indexOf('id="onboarding-localagent-block"');
			const apikeyCardIdx = html.indexOf('id="onboarding-apikey-card"');
			expect(dividerIdx).toBeGreaterThan(-1);
			expect(blockIdx).toBeGreaterThan(dividerIdx);
			expect(apikeyCardIdx).toBeGreaterThan(blockIdx);
		});

		it("nests the hint, label and dropdown inside the recommended card", () => {
			const html = buildSidebarHtml(
				"test-nonce",
				"vscode-resource:",
				"https://example/codicon.css",
				SIDEBAR_EMPTY_STRINGS,
			);
			// The card is the only .ob-card--recommended section and holds no
			// nested <section>, so a non-greedy match is its full inner HTML.
			const card =
				html.match(/<section class="ob-card ob-card--recommended">[\s\S]*?<\/section>/)?.[0] ?? "";
			expect(card).not.toBe("");
			expect(card).toContain("Make sure you're signed in to the tool.");
			expect(card).toContain('for="onboarding-localagent-select"');
			expect(card).toContain('id="onboarding-localagent-select"');
			// The action button and error line stay outside the card.
			expect(card).not.toContain('id="onboarding-localagent-btn"');
			expect(card).not.toContain('id="onboarding-localagent-error"');
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
			expect(html).toMatch(/<div class="view-switch hidden" id="view-switch"/);
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
			// Slice from disabled-panel open to the next sibling (view-switch);
			// disabled-panel sits between onboarding-panel and view-switch in the
			// skeleton, so this window contains exactly the panel's body.
			const start = html.indexOf('<div class="disabled-panel');
			const end = html.indexOf('<div class="view-switch', start);
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
