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

	it("references the clineEnabled DOM input", () => {
		expect(script).toContain("getElementById('clineEnabled')");
	});

	it("includes clineEnabled in validation guard", () => {
		expect(script).toMatch(/!clineEnabledInput\.checked/);
	});

	it("ships clineEnabled in save payload", () => {
		expect(script).toContain("clineEnabled: clineEnabledInput.checked");
	});

	it("loads clineEnabled from host message", () => {
		expect(script).toContain(
			"clineEnabledInput.checked = msg.settings.clineEnabled",
		);
	});

	// ── DCO sign-off toggle ──

	it("references the dcoSignoff DOM input", () => {
		expect(script).toContain("getElementById('dcoSignoff')");
	});

	it("ships dcoSignoff in the save payload", () => {
		expect(script).toContain("dcoSignoff: dcoSignoffInput.checked");
	});

	it("loads dcoSignoff from host message and coerces to boolean", () => {
		expect(script).toContain(
			"dcoSignoffInput.checked = !!msg.settings.dcoSignoff",
		);
	});

	it("includes dcoSignoff in dirty tracking", () => {
		expect(script).toContain(
			"dcoSignoffInput.checked !== initialState.dcoSignoff",
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

	it("gates the local-agent card and round-trips the agent tool", () => {
		expect(script).toContain("provider === 'local-agent'");
		expect(script).toContain("localAgentTool: localAgentToolSelect.value");
		expect(script).toContain("localAgentToolSelect.value = msg.settings.localAgentTool");
	});

	// ── Advanced toggle ──

	it("wires the Advanced links to data-advanced-panel siblings", () => {
		expect(script).toContain("advanced-link");
		expect(script).toContain("data-advanced-panel");
		expect(script).toContain("Hide Advanced");
	});

	// ── Migrate-when-dirty confirmation ──
	//
	// The Migrate to Memory Bank command on the host reads localFolder from
	// disk. If the user edited Folder Path but didn't Apply, naively firing the
	// migrate posts to the *old* folder while the form shows the new one. The
	// webview must (a) detect that dirty state, (b) defer to a host-side modal,
	// (c) chain Apply → Migrate when the user confirms, and (d) abort the chain
	// on settingsError. These assertions pin the pieces that, if removed, would
	// silently revert to the old (misleading) behavior.

	it("checks localFolder dirtiness before firing rebuildKnowledgeBase", () => {
		expect(script).toContain("localFolderDirty");
		expect(script).toContain(
			"localFolderInput.value !== initialState.localFolder",
		);
	});

	it("posts confirmDirtyMigrate to the host when Migrate is clicked with dirty Folder Path", () => {
		expect(script).toContain("'confirmDirtyMigrate'");
	});

	it("handles the host's confirmDirtyMigrateResult to chain Apply → Migrate or abort", () => {
		expect(script).toContain("confirmDirtyMigrateResult");
		expect(script).toContain("pendingMigrateAfterApply");
		// Apply path must be reused (not re-implemented) so the payload stays
		// in lockstep with the Apply button click.
		expect(script).toContain("submitApplySettings");
	});

	it("chains into startRebuild on settingsSaved when the migrate-after-apply flag is set", () => {
		expect(script).toMatch(
			/case 'settingsSaved':[\s\S]*pendingMigrateAfterApply[\s\S]*startRebuild\(\)/,
		);
	});

	it("aborts the migrate-after-apply chain on settingsError", () => {
		// Without this, a server-side rejection (e.g. invalid jolli key) would
		// leave the migrate to run anyway against unsaved settings.
		expect(script).toMatch(
			/case 'settingsError':[\s\S]*pendingMigrateAfterApply = false/,
		);
	});
});
