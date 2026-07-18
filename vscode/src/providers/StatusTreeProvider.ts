/**
 * StatusTreeProvider
 *
 * Data source for the Status tab in the sidebar webview. Thin subscriber over
 * StatusStore. Renders three visual states:
 *   A. Disabled    — returns [] (sidebar webview shows the disabled-panel with
 *                    the Enable Jolli Memory button)
 *   B. Migrating   — single "Migrating…" spinner item
 *   C. Full status — live rows + optional warnings + worker-busy indicator
 */

import * as vscode from "vscode";
import { describeSchemaV5Status } from "../../../cli/src/commands/StatusCommand.js";
import { resolveLlmCredentialSource } from "../../../cli/src/core/LlmClient.js";
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
		hookParts.push(`${s.prePushHookInstalled ? 5 : 4} Git`);
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

	const gitHookCount = s.gitHookInstalled ? (s.prePushHookInstalled ? 5 : 4) : 0;
	const gitHookList = `post-commit, post-rewrite, prepare-commit-msg, post-merge${s.prePushHookInstalled ? ", pre-push" : ""}`;
	const hooksTooltipLines = [
		`Git hooks: ${gitHookCount > 0 ? `${gitHookCount} installed` : "not installed"} (${gitHookList})`,
		`Claude Code hooks: ${s.claudeHookInstalled ? "2 installed" : "not installed"} (Stop, SessionStart)`,
		`Gemini CLI hook: ${s.geminiHookInstalled ? "installed" : "not installed"} (AfterAgent)`,
	];
	if (hookRuntime) {
		hooksTooltipLines.push(`Hook runtime: ${hookRuntime}`);
	}
	hooksTooltipLines.push(`Data migration: ${describeSchemaV5Status(s.schemaV5)}`);
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

	// AI Summary Provider — single row that shows what the dispatcher will
	// actually pick on next commit. Uses the same `resolveLlmCredentialSource`
	// the LLM dispatcher uses, so this row's claim and the actual call route
	// can never drift apart. Click opens Settings so the user can change it.
	pushProviderItem(items, config);

	// Anthropic API Key warning — suppressed when:
	//   - the user has explicitly chosen `aiProvider: "jolli"` (nagging would
	//     contradict the choice they just made on the AI Summary tab), or
	//   - `ANTHROPIC_API_KEY` is in the environment, in which case the AI
	//     Summary Provider row above already reports "Anthropic (env) ✓" via
	//     `resolveLlmCredentialSource`. Without this env check, the env-only
	//     setup contradicts itself in the same tree (provider row green,
	//     warning row yellow).
	// Legacy configs without `aiProvider` set still see the warning when
	// neither config.apiKey nor the env var is present.
	if (
		!config?.apiKey &&
		!process.env.ANTHROPIC_API_KEY &&
		config?.aiProvider !== "jolli"
	) {
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

		// Show the resolved site. `buildJolliSiteItem` falls back to the
		// persisted `jolliUrl` when no decodable key is on file, so the panel
		// keeps showing the tenant in the "signed in but key not yet issued /
		// stale key cleared" state — matching the Settings panel and `jolli
		// status`, which both gained the same fallback.
		const siteItem = buildJolliSiteItem(config);
		if (siteItem) items.push(siteItem);

		if (!config.jolliApiKey) {
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
		const siteItem = buildJolliSiteItem(config);
		if (siteItem) items.push(siteItem);
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

	// Integration status rows (Claude, Codex, Gemini, OpenCode, Cursor, Copilot, Cline)
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
	// Cursor: Composer sessions via global SQLite (no agent hook — scan errors surface like OpenCode).
	if (s.cursorScanError) {
		items.push(
			new StatusItem(
				"Cursor Integration",
				`unavailable — ${s.cursorScanError.kind}`,
				ICON_WARN,
				`Cursor database scan failed (${s.cursorScanError.kind}): ${s.cursorScanError.message}`,
			),
		);
	} else {
		pushIntegrationItem(
			items,
			s.cursorDetected,
			s.cursorEnabled !== false,
			undefined,
			"Cursor Integration",
			"Cursor Composer store found — session discovery is enabled",
			"Cursor detected but session discovery is disabled in config",
			undefined,
			counts.cursor,
		);
	}

	// Copilot integration: shared `copilotEnabled` toggle for terminal CLI and VS Code Chat.
	// Each form has its own scan-error channel; each surfaces as a separate warn row.
	if (s.copilotScanError) {
		items.push(
			new StatusItem(
				"Copilot Integration",
				`unavailable — ${s.copilotScanError.kind}`,
				ICON_WARN,
				`Copilot CLI database scan failed (${s.copilotScanError.kind}): ${s.copilotScanError.message}`,
			),
		);
	}
	if (s.copilotChatScanError) {
		items.push(
			new StatusItem(
				"Copilot Chat",
				`unavailable — ${s.copilotChatScanError.kind}`,
				ICON_WARN,
				`Copilot Chat scan failed (${s.copilotChatScanError.kind}): ${s.copilotChatScanError.message}`,
			),
		);
	}
	const cliMark = s.copilotDetected ? "✓" : "✗";
	const chatMark = s.copilotChatDetected ? "✓" : "✗";
	const anyCopilotDetected =
		(s.copilotDetected ?? false) || (s.copilotChatDetected ?? false);
	const copilotSessions = (counts.copilot ?? 0) + (counts["copilot-chat"] ?? 0);
	pushIntegrationItem(
		items,
		anyCopilotDetected,
		s.copilotEnabled !== false,
		undefined,
		"Copilot Integration",
		`GitHub Copilot detected (CLI: ${cliMark}, Chat: ${chatMark}) — session discovery is enabled`,
		`GitHub Copilot detected (CLI: ${cliMark}, Chat: ${chatMark}) but session discovery is disabled in config`,
		undefined,
		copilotSessions,
	);

	// Cline integration: shared `clineEnabled` toggle for the terminal CLI and the
	// VS Code extension. Like Cursor/OpenCode, a scan error replaces the main row
	// with a dedicated warn row (single scan channel, unlike Copilot's two).
	if (s.clineScanError) {
		items.push(
			new StatusItem(
				"Cline Integration",
				`unavailable — ${s.clineScanError.kind}`,
				ICON_WARN,
				`Cline scan failed (${s.clineScanError.kind}): ${s.clineScanError.message}`,
			),
		);
	} else {
		const clineCliMark = s.clineCliDetected ? "✓" : "✗";
		const clineVscodeMark = s.clineVscodeDetected ? "✓" : "✗";
		const clineSessions = (counts.cline ?? 0) + (counts["cline-cli"] ?? 0);
		pushIntegrationItem(
			items,
			s.clineDetected ?? false,
			s.clineEnabled !== false,
			undefined,
			"Cline Integration",
			`Cline detected (CLI: ${clineCliMark}, VS Code: ${clineVscodeMark}) — session discovery is enabled`,
			`Cline detected (CLI: ${clineCliMark}, VS Code: ${clineVscodeMark}) but session discovery is disabled in config`,
			undefined,
			clineSessions,
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

/**
 * Builds the "Jolli Site" tree row, or `undefined` when no site is resolvable.
 *
 * The site origin is the minted key's embedded `meta.u` when a decodable key is
 * on file, otherwise the persisted sign-in origin `config.jolliUrl`. This
 * mirrors `buildJolliSiteLabel` in `SettingsWebviewPanel.ts` and the
 * `config.jolliUrl` fallback in `cli/src/commands/StatusCommand.ts`, so all
 * three surfaces agree on the displayed site — including the "signed in but no
 * Jolli API Key (yet) on file" state where the key-only derivation would show
 * nothing. The tooltip records which source was used so the row is auditable.
 */
function buildJolliSiteItem(config: JolliMemoryConfig): StatusItem | undefined {
	const meta = config.jolliApiKey ? parseJolliApiKey(config.jolliApiKey) : null;
	const origin = meta?.u ?? config.jolliUrl;
	if (!origin) return undefined;
	const tooltip = meta?.u
		? `Resolved from Jolli API Key (tenant: ${meta.t})`
		: "Persisted sign-in origin (no decodable Jolli API Key on file)";
	return new StatusItem("Jolli Site", origin.replace(/^https?:\/\//, ""), ICON_GLOBE, tooltip);
}

/**
 * Pushes the "AI Summary Provider" row. Uses `resolveLlmCredentialSource` so
 * the displayed provider matches what the dispatcher will actually pick on the
 * next commit — they can't drift, since both consult the same function.
 *
 * Click opens Settings so the user can flip the choice. The row stays visible
 * even when no provider resolves (warning state) so the user sees the absence
 * as a discoverable problem, not a missing UI element.
 */
function pushProviderItem(
	items: Array<StatusItem>,
	config: JolliMemoryConfig | null,
): void {
	const source = resolveLlmCredentialSource(config ?? {});
	let description: string;
	let icon: vscode.ThemeIcon;
	let tooltip: string;
	switch (source) {
		case "anthropic-config":
			description = "Anthropic";
			icon = ICON_OK;
			tooltip =
				"AI summaries are generated via the Anthropic API key from your config.";
			break;
		case "anthropic-env":
			description = "Anthropic (env)";
			icon = ICON_OK;
			tooltip =
				"AI summaries are generated via the ANTHROPIC_API_KEY environment variable.";
			break;
		case "jolli-proxy":
			description = "Jolli";
			icon = ICON_OK;
			tooltip = "AI summaries are routed through the Jolli backend proxy.";
			break;
		case "local-agent":
			description = "Local agent";
			icon = ICON_OK;
			tooltip =
				"AI summaries are generated by a local agent CLI using its own login (no Anthropic/Jolli key needed).";
			break;
		default: {
			// Resolves to null — either no credentials at all, or an explicit
			// aiProvider whose required credential is missing (e.g. user picked
			// Jolli but no jolliApiKey is on file). Different sub-messages so
			// the user can tell which gap they're looking at.
			description = "not configured — click to set";
			icon = ICON_WARN;
			if (config?.aiProvider === "jolli") {
				tooltip =
					"Provider is set to Jolli but no Jolli API key is on file. Sign in again or set a key in Settings.";
			} else if (config?.aiProvider === "anthropic") {
				tooltip =
					"Provider is set to Anthropic but no API key is configured. Open Settings to add one.";
			} else {
				tooltip =
					"No AI provider is configured. Pick one (Anthropic or Jolli) in Settings.";
			}
			break;
		}
	}
	const item = new StatusItem(
		"AI Summary Provider",
		description,
		icon,
		tooltip,
	);
	item.command = {
		command: "jollimemory.openSettings",
		title: "Open Settings",
	};
	items.push(item);
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
