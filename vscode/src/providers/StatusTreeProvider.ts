/**
 * StatusTreeProvider
 *
 * TreeDataProvider for the "STATUS" panel.
 * Displays one of three states:
 *
 *   A. Disabled    — returns [] so the viewsWelcome placeholder shows the Enable button.
 *   B. Full Status — enabled; shows live status + optional API Key warning.
 *   C. Migrating   — v1→v3 migration in progress; shows a single "Migrating…" spinner item.
 *
 * The FileSystemWatcher in Extension.ts triggers refresh() when sessions.json
 * changes, so the active session count stays up-to-date.
 */

import * as vscode from "vscode";
import {
	getGlobalConfigDir,
	loadConfigFromDir,
} from "../../../cli/src/core/SessionTracker.js";
import type { JolliMemoryConfig, StatusInfo } from "../../../cli/src/Types.js";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import type { AuthService } from "../services/AuthService.js";
import { parseJolliApiKey } from "../services/JolliPushService.js";
import type { HistoryTreeProvider } from "./HistoryTreeProvider.js";

// ─── StatusItem tree node ─────────────────────────────────────────────────────

class StatusItem extends vscode.TreeItem {
	constructor(
		label: string,
		description: string,
		icon: vscode.ThemeIcon,
		tooltip?: string,
	) {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.description = description;
		this.iconPath = icon;
		this.contextValue = "statusItem";
		if (tooltip) {
			this.tooltip = tooltip;
		}
	}
}

// ─── Colored icons ────────────────────────────────────────────────────────────

/** Green — used for all "good" / informational items */
const GREEN = new vscode.ThemeColor("charts.green");
/** Red — not installed */
const RED = new vscode.ThemeColor("charts.red");
/** Yellow — disabled / warning */
const YELLOW = new vscode.ThemeColor("charts.yellow");

const ICON_OK = new vscode.ThemeIcon("check", GREEN);
const ICON_NO = new vscode.ThemeIcon("x", RED);
const ICON_WARN = new vscode.ThemeIcon("warning", YELLOW);
const ICON_PULSE = new vscode.ThemeIcon("pulse", GREEN);
const ICON_GLOBE = new vscode.ThemeIcon("globe", GREEN);
const ICON_LOADING = new vscode.ThemeIcon("loading~spin");

// ─── StatusTreeProvider ───────────────────────────────────────────────────────

export class StatusTreeProvider implements vscode.TreeDataProvider<StatusItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<
		StatusItem | undefined | null | undefined
	>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private status: StatusInfo | null = null;
	/** Loaded from config.json for API Key presence check; null when disabled. */
	private config: JolliMemoryConfig | null = null;

	/** True while v1→v3 migration is in progress (State C). */
	private migrating = false;
	/** True while the post-commit Worker holds the lock (AI summary in progress). */
	private workerBusy = false;
	/** True when a newer JolliMemory version manages hooks than this extension. */
	private extensionOutdated = false;

	constructor(
		private readonly bridge: JolliMemoryBridge,
		private readonly authService?: AuthService,
	) {}

	/** @deprecated No longer needed — kept as a no-op for call-site compatibility. */
	setHistoryProvider(_provider: HistoryTreeProvider): void {
		// Previously used for branch summary count in "Stored Memories" row (removed).
	}

	/** Triggers a refresh of the status panel by re-fetching from the bridge. */
	async refresh(): Promise<void> {
		this.status = await this.bridge.getStatus();

		// Load config when enabled (needed for API Key warning and integration rows).
		if (this.status.enabled) {
			this.config = await loadConfigFromDir(getGlobalConfigDir());
			// Keep the jollimemory.signedIn context key in sync with the config state.
			this.authService?.refreshContextKey(this.config);
		} else {
			this.config = null;
		}

		this._onDidChangeTreeData.fire();
	}

	/** Toggles the migrating state (State C). While true, getChildren() shows a spinner. */
	setMigrating(migrating: boolean): void {
		this.migrating = migrating;
		this._onDidChangeTreeData.fire();
	}

	/** Toggles the worker busy state. While true, an "AI summary in progress…" row is appended. */
	setWorkerBusy(busy: boolean): void {
		this.workerBusy = busy;
		this._onDidChangeTreeData.fire();
	}

	/** Marks this extension as outdated — a newer version manages hooks. */
	setExtensionOutdated(outdated: boolean): void {
		this.extensionOutdated = outdated;
		this._onDidChangeTreeData.fire();
	}

	/** Updates the cached status directly (e.g. after enable/disable). */
	setStatus(status: StatusInfo): void {
		this.status = status;
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: StatusItem): vscode.TreeItem {
		return element;
	}

	getChildren(): Array<StatusItem> {
		// State C: v1→v3 migration in progress — show spinner.
		if (this.migrating) {
			return [new StatusItem("Migrating memories...", "", ICON_LOADING)];
		}
		if (!this.status) {
			return [new StatusItem("Loading...", "", ICON_LOADING)];
		}
		// State A: disabled — return [] so the "disabled" viewsWelcome shows.
		if (!this.status.enabled) {
			return [];
		}
		// State B: full status with optional API Key warning.
		const items = buildFullStatusItems(
			this.status,
			this.config,
			this.extensionOutdated,
		);
		// Append worker busy indicator when the post-commit AI Worker is running
		if (this.workerBusy) {
			items.push(new StatusItem("AI summary in progress…", "", ICON_LOADING));
		}
		return items;
	}
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Builds the full status tree items when enabled.
 * Conditionally appends an API Key warning when no key is configured.
 */
function buildFullStatusItems(
	s: StatusInfo,
	config: JolliMemoryConfig | null,
	extensionOutdated: boolean,
): Array<StatusItem> {
	// Hooks: build a descriptive breakdown of what's installed
	const hookParts: Array<string> = [];
	if (s.gitHookInstalled) {
		hookParts.push("3 Git");
	}
	if (s.claudeHookInstalled) {
		hookParts.push("2 Claude");
	}
	if (s.geminiHookInstalled) {
		hookParts.push("1 Gemini CLI");
	}
	const allHooksInstalled = s.gitHookInstalled;
	const hooksDescription =
		hookParts.length > 0 ? hookParts.join(" + ") : "none installed";
	// Format hook runtime display (e.g. "cli@1.0.0" or "vscode-extension@1.0.0")
	const hookRuntime = s.hookSource
		? `${s.hookSource}${s.hookVersion && s.hookVersion !== "unknown" ? `@${s.hookVersion}` : ""}`
		: undefined;

	const hooksTooltipLines = [
		`Git hooks: ${s.gitHookInstalled ? "3 installed" : "not installed"} (post-commit, post-rewrite, prepare-commit-msg)`,
		`Claude Code hooks: ${s.claudeHookInstalled ? "2 installed" : "not installed"} (Stop, SessionStart)`,
		`Gemini CLI hook: ${s.geminiHookInstalled ? "installed" : "not installed"} (AfterAgent)`,
	];
	if (hookRuntime) {
		hooksTooltipLines.push(`Hook runtime: ${hookRuntime}`);
	}
	const hooksTooltip = hooksTooltipLines.join("\n");

	const sessionsTooltip = `${s.activeSessions} active session${s.activeSessions !== 1 ? "s" : ""} across all integrations`;

	const items: Array<StatusItem> = [
		new StatusItem(
			"Hooks",
			hooksDescription,
			allHooksInstalled ? ICON_OK : ICON_NO,
			hooksTooltip,
		),
		new StatusItem(
			"Sessions",
			String(s.activeSessions),
			ICON_PULSE,
			sessionsTooltip,
		),
	];

	// Show a clickable warning when no Anthropic API key is configured.
	// Clicking the item opens the unified Settings webview.
	if (!config?.apiKey) {
		const apiKeyItem = new StatusItem(
			"Anthropic API Key",
			"not configured — click to set",
			ICON_WARN,
			"Required for AI-powered commit summarization",
		);
		apiKeyItem.command = {
			command: "jollimemory.openSettings",
			title: "Open Settings",
		};
		items.push(apiKeyItem);
	}

	// Jolli Account: auth-aware display based on OAuth sign-in state
	if (config?.authToken) {
		// Signed in via OAuth — show connected status
		const accountItem = new StatusItem(
			"Jolli Account",
			"connected",
			ICON_OK,
			"Signed in to Jolli. Use the sign-out icon in the title bar to disconnect.",
		);
		items.push(accountItem);

		if (config.jolliApiKey) {
			// Full auth state — surface the Jolli Site URL from the key metadata.
			const meta = parseJolliApiKey(config.jolliApiKey);
			if (meta?.u) {
				const siteTooltip = `Resolved from Jolli API Key (tenant: ${meta.t})`;
				items.push(
					new StatusItem(
						"Jolli Site",
						meta.u.replace(/^https?:\/\//, ""),
						ICON_GLOBE,
						siteTooltip,
					),
				);
			}
		} else {
			// Partial auth state — sign-in succeeded but /api/auth/cli-token
			// didn't return a jolli_api_key (e.g. key generation failed on the
			// server). Without a key, pushes to the Jolli Space silently fail,
			// so raise a clickable warning that routes the user to Settings.
			const keyWarn = new StatusItem(
				"Jolli API Key",
				"not issued — pushes disabled",
				ICON_WARN,
				"Signed in, but no Jolli API Key was issued. Pushes to your Jolli Space are disabled. Sign out and sign in again, or set a key manually in Settings.",
			);
			keyWarn.command = {
				command: "jollimemory.openSettings",
				title: "Open Settings",
			};
			items.push(keyWarn);
		}
	} else if (config?.jolliApiKey) {
		// Manual API key configured (no OAuth) — show site URL as before
		const meta = parseJolliApiKey(config.jolliApiKey);
		if (meta?.u) {
			const siteTooltip = `Resolved from Jolli API Key (tenant: ${meta.t})`;
			items.push(
				new StatusItem(
					"Jolli Site",
					meta.u.replace(/^https?:\/\//, ""),
					ICON_GLOBE,
					siteTooltip,
				),
			);
		}
	} else {
		// Neither OAuth nor manual key — show sign-in prompt
		const accountItem = new StatusItem(
			"Jolli Account",
			"not connected — click to sign in",
			ICON_WARN,
			"Sign in to push memories to your Jolli Space",
		);
		accountItem.command = { command: "jollimemory.signIn", title: "Sign In" };
		items.push(accountItem);
	}

	// Integration status rows (Claude, Codex, Gemini)
	pushIntegrationItem(
		items,
		s.claudeDetected,
		config?.claudeEnabled !== false,
		s.claudeHookInstalled,
		"Claude Integration",
		"Claude Code hooks installed (Stop, SessionStart) — session tracking is enabled",
		"Claude Code detected but session tracking is disabled in config",
		"Claude Code detected but hooks are not installed",
	);
	pushIntegrationItem(
		items,
		s.codexDetected,
		s.codexEnabled !== false,
		undefined,
		"Codex Integration",
		"Codex CLI sessions directory found — session discovery is enabled",
		"Codex CLI detected but session discovery is disabled in config",
		undefined,
	);
	pushIntegrationItem(
		items,
		s.geminiDetected,
		s.geminiEnabled !== false,
		s.geminiHookInstalled,
		"Gemini Integration",
		"Gemini CLI AfterAgent hook installed — session tracking is enabled",
		"Gemini CLI detected but session tracking is disabled in config",
		"Gemini CLI detected but AfterAgent hook is not installed",
	);

	// Show a persistent warning when a newer version manages hooks — last item for visibility.
	if (extensionOutdated) {
		items.push(
			new StatusItem(
				"Update Available",
				"a newer version is available",
				ICON_WARN,
				"A newer version of Jolli Memory is managing hooks. Please update the extension.",
			),
		);
	}

	return items;
}

/** Appends an integration status row if the integration is detected. */
function pushIntegrationItem(
	items: Array<StatusItem>,
	detected: boolean | undefined,
	enabled: boolean,
	hookInstalled: boolean | undefined,
	label: string,
	enabledTooltip: string,
	disabledTooltip: string,
	hookMissingTooltip: string | undefined,
): void {
	if (!detected) {
		return;
	}
	// Four states: disabled in config, enabled without a hook, enabled but hook missing, fully enabled with hook
	if (!enabled) {
		items.push(
			new StatusItem(
				label,
				"detected but disabled",
				ICON_WARN,
				disabledTooltip,
			),
		);
	} else if (hookInstalled === undefined && hookMissingTooltip === undefined) {
		items.push(
			new StatusItem(label, "detected & enabled", ICON_OK, enabledTooltip),
		);
	} else if (hookInstalled === false && hookMissingTooltip) {
		items.push(
			new StatusItem(
				label,
				"hook not installed",
				ICON_WARN,
				hookMissingTooltip,
			),
		);
	} else {
		items.push(
			new StatusItem(label, "hook installed", ICON_OK, enabledTooltip),
		);
	}
}
