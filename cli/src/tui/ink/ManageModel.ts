/**
 * ManageModel — PURE row builders for the Manage matrix. No Ink, no I/O.
 * Separates "what the rows are" (testable) from "how they render / react to
 * keys" (the Ink component).
 */
import type { ToggleableHost } from "../../install/HostToggle.js";
import type { PluginDiagnostic } from "../../PluginLoader.js";
import type { StatusInfo } from "../../Types.js";

export interface SourceRow {
	readonly host: ToggleableHost;
	readonly label: string;
	readonly on: boolean;
	/** What toggling this source controls (session tracking/discovery), shown per
	 *  row so the effect is legible. MCP is NOT toggled here — it stays managed by
	 *  `install()` — so these read the same as the VSCode "AI Agents" tab. */
	readonly detail: string;
}

/** Per-source detail — the session tracking/discovery the flag governs. Wording
 *  mirrors the VSCode extension's "AI Agents" tab (see SettingsHtmlBuilder). */
const SOURCE_DETAIL: Record<ToggleableHost, string> = {
	claude: "Session tracking via Stop hook",
	cursor: "Session discovery via Cursor's local SQLite store",
	gemini: "Session tracking via AfterAgent hook",
	codex: "Session discovery via filesystem scan",
	copilot: "Session discovery for GitHub Copilot CLI and VS Code Copilot Chat",
	opencode: "Session discovery via ~/.local/share/opencode/opencode.db",
};

export interface PluginRow {
	readonly name: string;
	readonly state: PluginDiagnostic["state"];
	readonly installHint: string;
}

/** Detected and not explicitly disabled. */
function on(detected: boolean | undefined, enabled: boolean | undefined): boolean {
	return detected === true && enabled !== false;
}

/** The 6 toggleable AI sources, in display order, with current on/off state.
 *  Order and labels mirror the VSCode extension's "AI Agents" tab so the two
 *  surfaces read the same (see vscode SettingsHtmlBuilder). */
export function buildSourceRows(status: StatusInfo): SourceRow[] {
	const row = (host: ToggleableHost, label: string, isOn: boolean): SourceRow => ({
		host,
		label,
		on: isOn,
		detail: SOURCE_DETAIL[host],
	});
	return [
		row("claude", "Claude Code", on(status.claudeDetected, status.claudeEnabled)),
		row("codex", "Codex CLI", on(status.codexDetected, status.codexEnabled)),
		row("gemini", "Gemini CLI", on(status.geminiDetected, status.geminiEnabled)),
		row("opencode", "OpenCode", on(status.openCodeDetected, status.openCodeEnabled)),
		row("cursor", "Cursor", on(status.cursorDetected, status.cursorEnabled)),
		// Copilot's row covers CLI + Chat — detected when EITHER is present (mirrors
		// StatusCommand + HomeSnapshot), so the row can't read "off" while the Home
		// host count treats a chat-only install as detected.
		row("copilot", "Copilot", on(status.copilotDetected || status.copilotChatDetected, status.copilotEnabled)),
	];
}

export function buildPluginRows(plugins: PluginDiagnostic[]): PluginRow[] {
	return plugins.map((p) => ({ name: p.packageName, state: p.state, installHint: p.installHint }));
}
