import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	saveConfig: vi.fn(),
	listWorktrees: vi.fn(),
	installClaudeHook: vi.fn(),
	removeClaudeHook: vi.fn(),
	installGeminiHook: vi.fn(),
	removeGeminiHook: vi.fn(),
	syncGlobalInstructions: vi.fn(),
}));

vi.mock("../core/GitOps.js", () => ({ listWorktrees: m.listWorktrees }));
vi.mock("../core/SessionTracker.js", () => ({ saveConfig: m.saveConfig }));
vi.mock("./Installer.js", () => ({
	installClaudeHook: m.installClaudeHook,
	removeClaudeHook: m.removeClaudeHook,
	installGeminiHook: m.installGeminiHook,
	removeGeminiHook: m.removeGeminiHook,
	syncGlobalInstructions: m.syncGlobalInstructions,
}));

import { disableHost, enableHost } from "./HostToggle.js";

beforeEach(() => {
	vi.clearAllMocks();
	// Default: a single worktree at the passed cwd (multi-worktree tested below).
	m.listWorktrees.mockResolvedValue(["/wt"]);
});

// A host toggle mirrors the VS Code Settings panel (SettingsWebviewPanel.syncHooks
// + saveConfigScoped): it syncs ONLY the host's hook and persists the flag. MCP
// and skills are never touched here — they stay owned by Installer.install().
describe("enableHost", () => {
	it("claude: flag + claude hook only (no MCP/skill work here)", async () => {
		await enableHost("/wt", "claude");
		expect(m.saveConfig).toHaveBeenCalledWith({ claudeEnabled: true });
		expect(m.installClaudeHook).toHaveBeenCalledWith("/wt");
		expect(m.installGeminiHook).not.toHaveBeenCalled();
	});

	it("gemini: flag + gemini hook only", async () => {
		await enableHost("/wt", "gemini");
		expect(m.saveConfig).toHaveBeenCalledWith({ geminiEnabled: true });
		expect(m.installGeminiHook).toHaveBeenCalledWith("/wt");
		expect(m.installClaudeHook).not.toHaveBeenCalled();
	});

	it("cursor: pure config flag, no hook (MCP is detection-driven, never toggled)", async () => {
		await enableHost("/wt", "cursor");
		expect(m.saveConfig).toHaveBeenCalledWith({ cursorEnabled: true });
		expect(m.installClaudeHook).not.toHaveBeenCalled();
		expect(m.installGeminiHook).not.toHaveBeenCalled();
	});

	it("codex: pure config flag, no hook", async () => {
		await enableHost("/wt", "codex");
		expect(m.saveConfig).toHaveBeenCalledWith({ codexEnabled: true });
		expect(m.installClaudeHook).not.toHaveBeenCalled();
		expect(m.installGeminiHook).not.toHaveBeenCalled();
	});

	it("opencode: maps to openCodeEnabled, pure flag", async () => {
		await enableHost("/wt", "opencode");
		expect(m.saveConfig).toHaveBeenCalledWith({ openCodeEnabled: true });
	});
});

describe("disableHost", () => {
	it("claude: flag false + claude hook removal only", async () => {
		await disableHost("/wt", "claude");
		expect(m.saveConfig).toHaveBeenCalledWith({ claudeEnabled: false });
		expect(m.removeClaudeHook).toHaveBeenCalledWith("/wt");
		expect(m.removeGeminiHook).not.toHaveBeenCalled();
	});

	it("gemini: flag false + gemini hook removal only", async () => {
		await disableHost("/wt", "gemini");
		expect(m.saveConfig).toHaveBeenCalledWith({ geminiEnabled: false });
		expect(m.removeGeminiHook).toHaveBeenCalledWith("/wt");
		expect(m.removeClaudeHook).not.toHaveBeenCalled();
	});

	it("cursor: pure config flag off, no hook and NO MCP teardown (nothing to silently restore)", async () => {
		await disableHost("/wt", "cursor");
		expect(m.saveConfig).toHaveBeenCalledWith({ cursorEnabled: false });
		expect(m.removeClaudeHook).not.toHaveBeenCalled();
		expect(m.removeGeminiHook).not.toHaveBeenCalled();
	});

	it("copilot: pure config flag off, no hook", async () => {
		await disableHost("/wt", "copilot");
		expect(m.saveConfig).toHaveBeenCalledWith({ copilotEnabled: false });
		expect(m.removeClaudeHook).not.toHaveBeenCalled();
	});
});

// Failure semantics: the hook is synced FIRST, then the flag is written. If the
// hook step throws, the flag is NOT written — so the toggle fails closed (the UI
// keeps reading the host as unchanged) rather than persisting a flipped flag over
// an unchanged hook.
describe("failure semantics (hook first; flag not written on failure)", () => {
	it("enableHost: a failing hook install rejects and the flag is never saved", async () => {
		m.installClaudeHook.mockRejectedValueOnce(new Error("hook write failed"));
		await expect(enableHost("/wt", "claude")).rejects.toThrow("hook write failed");
		expect(m.saveConfig).not.toHaveBeenCalled();
	});

	it("disableHost: a failing hook removal rejects and the flag is never cleared", async () => {
		m.removeClaudeHook.mockRejectedValueOnce(new Error("hook remove failed"));
		await expect(disableHost("/wt", "claude")).rejects.toThrow("hook remove failed");
		expect(m.saveConfig).not.toHaveBeenCalled();
	});
});

// Hooks live inside each worktree, so a toggle must touch every worktree (matching
// install()'s per-worktree loop and the extension's syncHooks loop) — not just the
// one the TUI was opened from. Otherwise siblings keep stale hook state.
describe("worktree fan-out", () => {
	it("enableHost: installs the hook in every worktree, flag written once", async () => {
		m.listWorktrees.mockResolvedValue(["/wt", "/wt2", "/wt3"]);
		await enableHost("/wt", "claude");
		for (const wt of ["/wt", "/wt2", "/wt3"]) {
			expect(m.installClaudeHook).toHaveBeenCalledWith(wt);
		}
		expect(m.installClaudeHook).toHaveBeenCalledTimes(3);
		expect(m.saveConfig).toHaveBeenCalledTimes(1);
		expect(m.saveConfig).toHaveBeenCalledWith({ claudeEnabled: true });
	});

	it("disableHost: removes the hook in every worktree", async () => {
		m.listWorktrees.mockResolvedValue(["/wt", "/wt2"]);
		await disableHost("/wt", "gemini");
		expect(m.removeGeminiHook).toHaveBeenCalledWith("/wt");
		expect(m.removeGeminiHook).toHaveBeenCalledWith("/wt2");
		expect(m.saveConfig).toHaveBeenCalledWith({ geminiEnabled: false });
	});
});

describe("global instruction resync", () => {
	// The machine-global instruction files are derived from the *Enabled flags, so
	// a toggle must resync them or they advertise a host the user just turned off.
	it("enableHost resyncs global instructions after flipping the flag", async () => {
		await enableHost("/wt", "gemini");
		expect(m.syncGlobalInstructions).toHaveBeenCalledTimes(1);
	});
	it("disableHost resyncs global instructions after flipping the flag", async () => {
		await disableHost("/wt", "claude");
		expect(m.syncGlobalInstructions).toHaveBeenCalledTimes(1);
	});
});
