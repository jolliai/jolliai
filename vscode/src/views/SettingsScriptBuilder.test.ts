import { describe, expect, it } from "vitest";
import { ALLOWED_JOLLI_HOSTS } from "../../../cli/src/core/JolliApiUtils.js";
import { buildSettingsScript } from "./SettingsScriptBuilder.js";

describe("SettingsScriptBuilder", () => {
	const script = buildSettingsScript();

	it("returns a non-empty string", () => {
		expect(script).toBeTruthy();
		expect(typeof script).toBe("string");
		expect(script.length).toBeGreaterThan(0);
	});

	it("acquires the VS Code API", () => {
		expect(script).toContain("acquireVsCodeApi()");
	});

	it("contains loadSettings message handler", () => {
		expect(script).toContain("loadSettings");
	});

	it("contains applySettings message handler", () => {
		expect(script).toContain("applySettings");
	});

	it("contains settingsLoaded handler", () => {
		expect(script).toContain("settingsLoaded");
	});

	it("contains settingsSaved handler", () => {
		expect(script).toContain("settingsSaved");
	});

	it("does not contain scope switching logic", () => {
		expect(script).not.toContain("scopeSelect");
		expect(script).not.toContain("currentScope");
		expect(script).not.toContain("initialScope");
	});

	it("contains validation logic for API key prefixes", () => {
		expect(script).toContain("sk-ant-");
		expect(script).toContain("sk-jol-");
	});

	it("inlines the CLI's ALLOWED_JOLLI_HOSTS verbatim, not a copy", () => {
		// The webview's origin validator runs in a browser context and can't
		// import the Node module, so SettingsScriptBuilder embeds the array as
		// JSON at extension build time. Pinning the exact embedded form keeps
		// this from drifting back into a copy-pasted literal — adding a host
		// to JolliApiUtils now flows here automatically, and the IntelliJ
		// Kotlin port stays the only remaining lockstep sibling to update.
		expect(script).toContain(
			`var ALLOWED_JOLLI_HOSTS = ${JSON.stringify(ALLOWED_JOLLI_HOSTS)};`,
		);
		// Sanity: the current host set is still represented in the embedded JSON.
		for (const host of ALLOWED_JOLLI_HOSTS) {
			expect(script).toContain(`"${host}"`);
		}
	});

	it("contains dirty tracking logic", () => {
		expect(script).toContain("isDirty");
	});

	it("contains masking detection logic", () => {
		expect(script).toContain("maskedApiKey");
		expect(script).toContain("maskedJolliApiKey");
	});

	it("validates at least one integration must be enabled", () => {
		expect(script).toContain("integrations-error");
		expect(script).toContain("At least one integration must be enabled");
		expect(script).toContain("openCodeEnabled");
		expect(script).toContain("cursorEnabled");
	});

	it("references the copilotEnabled DOM input", () => {
		expect(script).toContain("getElementById('copilotEnabled')");
	});

	it("includes copilotEnabled in validation guard", () => {
		expect(script).toMatch(/!copilotEnabledInput\.checked/);
	});

	it("ships copilotEnabled in save payload", () => {
		expect(script).toContain("copilotEnabled: copilotEnabledInput.checked");
	});

	it("loads copilotEnabled from host message", () => {
		expect(script).toContain(
			"copilotEnabledInput.checked = msg.settings.copilotEnabled",
		);
	});

	// ── Tab switching ──

	it("wires .tab-button clicks to .tab-active toggle and panel show/hide", () => {
		expect(script).toContain(".tab-button");
		expect(script).toContain("tab-active");
		expect(script).toContain("data-tab");
		expect(script).toContain("data-panel");
		// Show/hide should go through the shared .hidden class — see CLAUDE.md
		// memory: "vscode webview 用 .hidden class 切显隐".
		expect(script).toContain("classList.toggle('hidden'");
	});

	// ── Provider card switching ──

	it("ships syncProviderCard logic gated by aiProvider, signedIn, hasJolliKey", () => {
		expect(script).toContain("syncProviderCard");
		expect(script).toContain("aiProviderSelect");
		expect(script).toContain("'jolli-ok'");
		expect(script).toContain("'jolli-nokey'");
		expect(script).toContain("'jolli-signin'");
		expect(script).toContain("'anthropic'");
	});

	it("ships syncSyncCard for the Sync tab", () => {
		expect(script).toContain("syncSyncCard");
		expect(script).toContain("'signed-in'");
		expect(script).toContain("'signed-out'");
	});

	// ── Sign-in / Sign-out ──

	it("posts signIn / signOut messages on the auth buttons", () => {
		expect(script).toContain("'signIn'");
		expect(script).toContain("'signOut'");
		expect(script).toContain("summarySignInBtn");
		expect(script).toContain("syncSignInBtn");
		expect(script).toContain("syncSignOutBtn");
	});

	it("handles authStateChanged messages from the host", () => {
		expect(script).toContain("authStateChanged");
	});

	it("syncs aiProviderSelect when authStateChanged carries an aiProvider", () => {
		// Without this sync, a sign-in flips aiProvider on disk but the open
		// form keeps stale dropdown state — and the next Apply silently
		// overwrites disk with whatever the user last had selected. The
		// closure must (a) accept the value, (b) re-baseline initialState so
		// it doesn't show as a phantom user edit, and (c) recompute dirty so
		// the Apply button reflects the merged state.
		expect(script).toContain("aiProviderSelect.value = msg.aiProvider");
		expect(script).toContain("initialState.aiProvider = msg.aiProvider");
	});

	// ── aiProvider in payload ──

	it("ships aiProvider in the save payload", () => {
		expect(script).toContain("aiProvider: aiProviderSelect.value");
	});

	it("loads aiProvider from settings (with anthropic fallback)", () => {
		expect(script).toContain("msg.settings.aiProvider");
	});

	// ── Advanced toggle ──

	it("wires the Advanced links to data-advanced-panel siblings", () => {
		expect(script).toContain("advanced-link");
		expect(script).toContain("data-advanced-panel");
		expect(script).toContain("Hide Advanced");
	});
});
