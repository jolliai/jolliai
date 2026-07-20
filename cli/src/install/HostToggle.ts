/**
 * HostToggle — per-host enable/disable orchestration for the control-center TUI.
 *
 * Mirrors the VS Code Settings panel exactly (`SettingsWebviewPanel.syncHooks` +
 * `saveConfigScoped`): a host toggle syncs ONLY that host's HOOK and persists the
 * `<host>Enabled` config flag. It deliberately does NOT add or remove MCP or
 * skills — those stay owned by `Installer.install()`, which is detection-driven
 * and never tears down artifacts on a flag flip. Managing MCP here (as an earlier
 * version did) contradicted that: `install()` re-registers repo MCP on the next
 * run regardless of the flag, so a per-toggle `.mcp.json` removal was silently
 * undone — and the Cursor toggle (whose only artifact was MCP) became a no-op
 * that fought the installer. Keeping this to hooks-only matches the extension and
 * makes each `<host>Enabled` flag mean what its label says: session discovery.
 *
 * Two axes, kept separate:
 *  - the host's HOOK (Claude / Gemini only — the sole per-host on-disk artifact
 *    a toggle owns), applied per host below; and
 *  - the `<host>Enabled` config flag (session discovery).
 *
 * Ordering: the hook is synced FIRST, then the flag is written — so if the hook
 * step throws, the flag stays at its pre-toggle value (the UI keeps reading the
 * host as unchanged) instead of persisting a flipped flag over an unchanged hook.
 *
 * Hooks live INSIDE each worktree, so a toggle fans out across every worktree —
 * matching `install()`'s per-worktree loop and the extension's `syncHooks` loop.
 */

import { listWorktrees } from "../core/GitOps.js";
import { saveConfig } from "../core/SessionTracker.js";
import type { JolliMemoryConfig } from "../Types.js";
import {
	installClaudeHook,
	installGeminiHook,
	removeClaudeHook,
	removeGeminiHook,
	syncGlobalInstructions,
} from "./Installer.js";

export type ToggleableHost = "claude" | "codex" | "gemini" | "cursor" | "copilot" | "opencode";

const FLAG_KEY: Record<ToggleableHost, keyof JolliMemoryConfig> = {
	claude: "claudeEnabled",
	codex: "codexEnabled",
	gemini: "geminiEnabled",
	cursor: "cursorEnabled",
	copilot: "copilotEnabled",
	opencode: "openCodeEnabled",
};

/** Enable a source: install its hook (all worktrees), then set the flag. */
export async function enableHost(cwd: string, host: ToggleableHost): Promise<void> {
	await applyHostHookAllWorktrees(cwd, host, true);
	await saveConfig({ [FLAG_KEY[host]]: true });
	// The machine-global instruction files (~/.claude/CLAUDE.md etc.) advertise
	// Jolli per host, derived from the *Enabled flags — resync so a just-toggled
	// host isn't left stale until some unrelated later action rewrites them.
	await syncGlobalInstructions();
}

/** Disable a source: remove its hook (all worktrees), then clear the flag. */
export async function disableHost(cwd: string, host: ToggleableHost): Promise<void> {
	await applyHostHookAllWorktrees(cwd, host, false);
	await saveConfig({ [FLAG_KEY[host]]: false });
	await syncGlobalInstructions(); // keep the global instruction files in step (see enableHost)
}

/** Sync the host's hook in every worktree of `cwd`'s repo (no-op for hookless hosts). */
async function applyHostHookAllWorktrees(cwd: string, host: ToggleableHost, on: boolean): Promise<void> {
	for (const wt of await listWorktrees(cwd)) {
		await applyHostHook(wt, host, on);
	}
}

async function applyHostHook(cwd: string, host: ToggleableHost, on: boolean): Promise<void> {
	switch (host) {
		case "claude":
			if (on) await installClaudeHook(cwd);
			else await removeClaudeHook(cwd);
			return;
		case "gemini":
			if (on) await installGeminiHook(cwd);
			else await removeGeminiHook(cwd);
			return;
		default:
			// codex / cursor / copilot / opencode own no hook — the persisted flag
			// alone governs session discovery, and MCP is detection-driven by
			// `install()` (never toggled here), mirroring the VS Code Settings panel.
			return;
	}
}
