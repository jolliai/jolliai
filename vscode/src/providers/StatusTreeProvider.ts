/**
 * StatusTreeProvider
 *
 * TreeDataProvider for the "STATUS" panel. Thin subscriber over StatusStore.
 * Renders three visual states:
 *   A. Disabled    — returns [] (viewsWelcome shows Enable button)
 *   B. Migrating   — single "Migrating…" spinner item
 *   C. Full status — live rows + optional warnings + worker-busy indicator
 */

import * as vscode from "vscode";
import type { JolliMemoryConfig, StatusInfo } from "../../../cli/src/Types.js";
import { parseJolliApiKey } from "../services/JolliPushService.js";
import type { StatusStore } from "../stores/StatusStore.js";
import type { SerializedTreeItem } from "../views/SidebarMessages.js";
import { treeItemToSerialized } from "../views/SidebarSerialize.js";

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

const GREEN = new vscode.ThemeColor("charts.green");
const RED = new vscode.ThemeColor("charts.red");
const YELLOW = new vscode.ThemeColor("charts.yellow");

const ICON_OK = new vscode.ThemeIcon("check", GREEN);
const ICON_NO = new vscode.ThemeIcon("x", RED);
const ICON_WARN = new vscode.ThemeIcon("warning", YELLOW);
const ICON_PULSE = new vscode.ThemeIcon("pulse", GREEN);
const ICON_GLOBE = new vscode.ThemeIcon("globe", GREEN);
const ICON_LOADING = new vscode.ThemeIcon("loading~spin");

// ─── StatusTreeProvider ───────────────────────────────────────────────────────

export class StatusTreeProvider
	implements vscode.TreeDataProvider<StatusItem>, vscode.Disposable
{
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<
		StatusItem | undefined | null | undefined
	>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly unsubscribe: () => void;

	constructor(private readonly store: StatusStore) {
		this.unsubscribe = store.onChange(() => {
			this._onDidChangeTreeData.fire(undefined);
		});
	}

	getTreeItem(element: StatusItem): vscode.TreeItem {
		return element;
	}

	getChildren(): Array<StatusItem> {
		const snap = this.store.getSnapshot();
		if (snap.migrating) {
			return [new StatusItem("Migrating memories...", "", ICON_LOADING)];
		}
		if (!snap.status) {
			return [new StatusItem("Loading...", "", ICON_LOADING)];
		}
		if (!snap.status.enabled) {
			return [];
		}
		const items = buildFullStatusItems(
			snap.status,
			snap.config,
			snap.extensionOutdated,
		);
		if (snap.workerBusy) {
			items.push(new StatusItem("AI summary in progress…", "", ICON_LOADING));
		}
		return items;
	}

	serialize(): ReadonlyArray<SerializedTreeItem> {
		const items = this.getChildren();
		return items.map((it) => treeItemToSerialized(it));
	}

	getWorkerBusy(): boolean {
		return this.store.getSnapshot().workerBusy;
	}

	dispose(): void {
		this.unsubscribe();
		this._onDidChangeTreeData.dispose();
	}
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function buildFullStatusItems(
	s: StatusInfo,
	config: JolliMemoryConfig | null,
	extensionOutdated: boolean,
): Array<StatusItem> {
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

	if (config?.authToken) {
		const accountItem = new StatusItem(
			"Jolli Account",
			"connected",
			ICON_OK,
			"Signed in to Jolli. Use the sign-out icon in the title bar to disconnect.",
		);
		items.push(accountItem);

		if (config.jolliApiKey) {
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
		const accountItem = new StatusItem(
			"Jolli Account",
			"not connected — click to sign in",
			ICON_WARN,
			"Sign in to push memories to your Jolli Space",
		);
		accountItem.command = { command: "jollimemory.signIn", title: "Sign In" };
		items.push(accountItem);
	}

	// Integration status rows (Claude, Codex, Gemini, OpenCode)
	const counts = s.sessionsBySource ?? {};
	pushIntegrationItem(
		items,
		s.claudeDetected,
		config?.claudeEnabled !== false,
		s.claudeHookInstalled,
		"Claude Integration",
		"Claude Code hooks installed (Stop, SessionStart) — session tracking is enabled",
		"Claude Code detected but session tracking is disabled in config",
		"Claude Code detected but hooks are not installed",
		counts.claude,
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
		counts.codex,
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
		counts.gemini,
	);
	// OpenCode has a scan-time error channel that the other integrations don't:
	// the DB can exist but be corrupt / locked / schema-drifted. Surface that as
	// a dedicated warning row BEFORE the regular "detected & enabled" row so
	// the failure state doesn't silently look like "0 sessions".
	if (s.openCodeScanError) {
		items.push(
			new StatusItem(
				"OpenCode Integration",
				`unavailable — ${s.openCodeScanError.kind}`,
				ICON_WARN,
				`OpenCode database scan failed (${s.openCodeScanError.kind}): ${s.openCodeScanError.message}`,
			),
		);
	} else {
		pushIntegrationItem(
			items,
			s.openCodeDetected,
			s.openCodeEnabled !== false,
			undefined,
			"OpenCode Integration",
			"OpenCode sessions database found — session discovery is enabled",
			"OpenCode detected but session discovery is disabled in config",
			undefined,
			counts.opencode,
		);
	}

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

function pushIntegrationItem(
	items: Array<StatusItem>,
	detected: boolean | undefined,
	enabled: boolean,
	hookInstalled: boolean | undefined,
	label: string,
	enabledTooltip: string,
	disabledTooltip: string,
	hookMissingTooltip: string | undefined,
	sessionCount?: number,
): void {
	if (!detected) {
		return;
	}

	// Build session count suffix for enabled states
	const countSuffix =
		sessionCount && sessionCount > 0
			? ` (${sessionCount} session${sessionCount !== 1 ? "s" : ""})`
			: "";
	const tooltipSuffix =
		sessionCount && sessionCount > 0
			? ` (${sessionCount} active session${sessionCount !== 1 ? "s" : ""})`
			: "";

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
			new StatusItem(
				label,
				`detected & enabled${countSuffix}`,
				ICON_OK,
				`${enabledTooltip}${tooltipSuffix}`,
			),
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
			new StatusItem(
				label,
				`hook installed${countSuffix}`,
				ICON_OK,
				`${enabledTooltip}${tooltipSuffix}`,
			),
		);
	}
}
