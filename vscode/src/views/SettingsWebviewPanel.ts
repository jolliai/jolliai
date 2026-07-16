/**
 * SettingsWebviewPanel
 *
 * Opens a webview in the active editor column showing the Jolli Memory settings form.
 * Singleton pattern — only one settings panel can be open at a time.
 *
 * Handles:
 * - Loading config from the global config directory
 * - API key masking (first 12 + **** + last 4)
 * - Saving config changes via saveConfigScoped
 * - Sign-in / sign-out via the shared AuthService
 * - Pushing auth-state-change messages so the webview re-renders provider/sync
 *   cards without a full settings reload (mirrors IntelliJ's auth listener)
 */

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
	getProjectRootDir,
	listWorktrees,
} from "../../../cli/src/core/GitOps.js";
import {
	parseJolliApiKey,
	validateJolliApiKey,
} from "../../../cli/src/core/JolliApiUtils.js";
import { track } from "../../../cli/src/core/Telemetry.js";
import {
	getGlobalConfigDir,
	loadConfigFromDir,
	saveConfigScoped,
} from "../../../cli/src/core/SessionTracker.js";
import {
	installClaudeHook,
	installGeminiHook,
	removeClaudeHook,
	removeGeminiHook,
	syncGlobalInstructions,
} from "../../../cli/src/install/Installer.js";
import type { JolliMemoryConfig } from "../../../cli/src/Types.js";
import type { AuthService } from "../services/AuthService.js";
import { log } from "../util/Logger.js";
import { buildSettingsHtml } from "./SettingsHtmlBuilder.js";

/** Payload exchanged between webview and extension host. */
interface SettingsPayload {
	readonly apiKey: string;
	readonly model: string;
	readonly maxTokens: number | null;
	readonly aiProvider: "anthropic" | "jolli" | "local-agent";
	readonly localAgentTool?: "claude-code";
	readonly jolliApiKey: string;
	readonly claudeEnabled: boolean;
	readonly codexEnabled: boolean;
	readonly geminiEnabled: boolean;
	readonly openCodeEnabled: boolean;
	readonly cursorEnabled: boolean;
	readonly copilotEnabled: boolean;
	/** Tri-state config switch (undecided | "enabled" | "disabled") flattened to a checkbox; see handleApplySettings for the enable/disable/preserve-undecided persistence rules. */
	readonly globalInstructions: boolean;
	readonly localFolder: string;
	readonly excludePatterns: string;
	/** Comma-separated folder names (exact or `*` glob) skipped by `jolli compile`. */
	readonly compileExcludeFolders: string;
	readonly dcoSignoff: boolean;
	readonly autoSyncEnabled?: boolean;
	readonly syncTranscripts?: boolean;
	/** Null → "leave blank, use default"; number → clamped seconds (5400..86400). */
	readonly syncPollIntervalSec?: number | null;
}

interface HookSyncFailure {
	readonly integration: "Claude" | "Gemini";
	readonly worktree: string;
	readonly cause: unknown;
}

/** Messages sent from the webview to the extension host. */
type SettingsMessage =
	| { command: "loadSettings" }
	| { command: "browseLocalFolder" }
	| { command: "rebuildKnowledgeBase" }
	| { command: "generateMissingSummaries" }
	| { command: "confirmDirtyMigrate" }
	| { command: "signIn" }
	| { command: "signOut" }
	| { command: "syncNow" }
	| {
			command: "applySettings";
			settings: SettingsPayload;
			maskedApiKey: string;
			maskedJolliApiKey: string;
	  };

/**
 * Masks an API key for display.
 * Keys with a recognized prefix (sk-ant-, sk-jol-) are always masked regardless of length.
 * Other keys are masked when longer than 16 chars: first 12 + **** + last 4.
 * Returns empty string for undefined/empty keys.
 */
function maskApiKey(key: string | undefined): string {
	if (!key || key.length === 0) {
		return "";
	}
	const hasKnownPrefix = key.startsWith("sk-ant-") || key.startsWith("sk-jol-");
	if (!hasKnownPrefix && key.length <= 16) {
		return key;
	}
	const prefixLen = Math.min(12, key.length - 4);
	return `${key.substring(0, prefixLen)}****${key.substring(key.length - 4)}`;
}

/**
 * Builds the human-friendly site label shown on the AI Summary > Jolli card.
 * Mirrors the Kotlin port in `intellij/.../SettingsDialog.kt::refreshJolliFields`
 * (the IntelliJ side persists no `jolliUrl` of its own — config-intellij.json
 * has no such field — so the Kotlin port can ignore the fallback argument).
 *
 * Falls back to `jolliUrl` when `jolliApiKey` is absent OR present but
 * undecodable. This matches `cli/src/commands/StatusCommand.ts` so the
 * Settings panel and `jolli status` agree on the displayed site after a
 * cross-tenant clear has emptied the key but the persisted sign-in origin
 * is still known, and also for legacy / hand-typed keys whose
 * `parseJolliApiKey` returns null.
 */
function buildJolliSiteLabel(jolliApiKey: string | undefined, jolliUrl: string | undefined): string {
	const siteOrigin = parseJolliApiKey(jolliApiKey ?? "")?.u ?? jolliUrl;
	const siteDisplay = siteOrigin?.replace(/^https?:\/\//, "") ?? "";
	return siteDisplay
		? `Signed in to ${siteDisplay} — using Jolli to generate summaries`
		: "Using Jolli to generate summaries";
}

/** Callback type for post-save refresh. */
type OnSavedCallback = () => void;

export class SettingsWebviewPanel {
	private static currentPanel: SettingsWebviewPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly workspaceRoot: string;
	private readonly authService: AuthService | undefined;
	private onSavedCallback: OnSavedCallback | undefined;
	/** Full (unmasked) API keys from the last config load — used to detect unchanged masked values. */
	private fullApiKey = "";
	private fullJolliApiKey = "";

	private constructor(
		extensionUri: vscode.Uri,
		workspaceRoot: string,
		onSaved: OnSavedCallback | undefined,
		authService: AuthService | undefined,
	) {
		this.onSavedCallback = onSaved;
		this.workspaceRoot = workspaceRoot;
		this.authService = authService;
		this.panel = vscode.window.createWebviewPanel(
			"jollimemory.settings",
			"Jolli Memory Settings",
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				localResourceRoots: [extensionUri],
				retainContextWhenHidden: true,
			},
		);

		const nonce = randomBytes(16).toString("hex");
		this.panel.webview.html = buildSettingsHtml(nonce);

		this.panel.onDidDispose(() => {
			SettingsWebviewPanel.currentPanel = undefined;
		});

		this.panel.webview.onDidReceiveMessage((message: SettingsMessage) => {
			this.handleMessage(message);
		});
	}

	/** Opens the Settings panel (creates or reveals existing). */
	static show(
		extensionUri: vscode.Uri,
		workspaceRoot: string,
		onSaved?: OnSavedCallback,
		authService?: AuthService,
	): void {
		track("settings_opened", { tab: "general" });
		if (SettingsWebviewPanel.currentPanel) {
			if (onSaved) {
				SettingsWebviewPanel.currentPanel.onSavedCallback = onSaved;
			}
			SettingsWebviewPanel.currentPanel.panel.reveal(vscode.ViewColumn.Active);
			return;
		}
		SettingsWebviewPanel.currentPanel = new SettingsWebviewPanel(
			extensionUri,
			workspaceRoot,
			onSaved,
			authService,
		);
	}

	/** Disposes the current panel (used in tests for singleton reset). */
	static dispose(): void {
		if (SettingsWebviewPanel.currentPanel) {
			SettingsWebviewPanel.currentPanel.panel.dispose();
			SettingsWebviewPanel.currentPanel = undefined;
		}
	}

	/**
	 * Pushes the current auth state to the open panel (if any). Called from
	 * Extension.ts after the OAuth callback completes (sign-in) or the sign-out
	 * command runs, so the panel can re-render its provider/sync cards without
	 * a full settings reload. Reads config fresh to pick up the API key the
	 * server just issued.
	 */
	static async notifyAuthChanged(): Promise<void> {
		const panel = SettingsWebviewPanel.currentPanel;
		if (!panel) return;
		await panel.postAuthState();
	}

	private handleMessage(message: SettingsMessage): void {
		switch (message.command) {
			case "loadSettings":
				this.handleLoadSettings().catch((err: unknown) => {
					log.error("SettingsPanel", `Load failed: ${err}`);
					this.postError("Failed to load settings");
				});
				break;
			case "browseLocalFolder":
				this.handleBrowseLocalFolder().catch((err: unknown) => {
					log.error("SettingsPanel", `Browse failed: ${err}`);
				});
				break;
			case "applySettings":
				this.handleApplySettings(
					message.settings,
					message.maskedApiKey,
					message.maskedJolliApiKey,
				).catch((err: unknown) => {
					log.error("SettingsPanel", `Save failed: ${err}`);
					this.postError("Failed to save settings");
				});
				break;
			case "syncNow":
				// Delegates to the orchestrator if one is wired; otherwise the
				// command shows a "not enabled" toast.
				log.info(
					"SettingsPanel",
					"syncNow received from webview → executing jollimemory.syncNow",
				);
				void vscode.commands.executeCommand("jollimemory.syncNow").then(
					() =>
						log.info("SettingsPanel", "jollimemory.syncNow command resolved"),
					(err: unknown) =>
						log.error("SettingsPanel", `jollimemory.syncNow rejected: ${err}`),
				);
				break;
			case "rebuildKnowledgeBase":
				this.handleRebuildKnowledgeBase().catch((err: unknown) => {
					log.error("SettingsPanel", `Rebuild failed: ${err}`);
					if (SettingsWebviewPanel.currentPanel !== this) return;
					this.panel.webview.postMessage({
						command: "rebuildKnowledgeBaseDone",
						success: false,
						message: err instanceof Error ? err.message : String(err),
					});
				});
				break;
			case "generateMissingSummaries":
				this.handleGenerateMissingSummaries().catch((err: unknown) => {
					log.error("SettingsPanel", `Generate missing summaries failed: ${err}`);
					if (SettingsWebviewPanel.currentPanel !== this) return;
					this.panel.webview.postMessage({
						command: "generateMissingSummariesDone",
						success: false,
						message: err instanceof Error ? err.message : String(err),
					});
				});
				break;
			case "confirmDirtyMigrate":
				this.handleConfirmDirtyMigrate().catch((err: unknown) => {
					log.error("SettingsPanel", `Confirm dirty migrate failed: ${err}`);
					// Treat any failure as a cancel so the webview doesn't stay
					// stuck waiting for a response.
					this.panel.webview.postMessage({
						command: "confirmDirtyMigrateResult",
						proceed: false,
					});
				});
				break;
			case "signIn":
				// Delegate to the same command Extension.ts registers so the OAuth
				// flow is identical to the sidebar's Sign In path.
				vscode.commands
					.executeCommand("jollimemory.signIn")
					.then(undefined, (err: unknown) => {
						log.error("SettingsPanel", `signIn command failed: ${err}`);
						this.postError(
							`Sign in failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					});
				break;
			case "signOut":
				vscode.commands
					.executeCommand("jollimemory.signOut")
					.then(undefined, (err: unknown) => {
						log.error("SettingsPanel", `signOut command failed: ${err}`);
						this.postError(
							`Sign out failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					});
				break;
		}
	}

	/**
	 * Shows a native modal warning when the user clicks Migrate to Memory Bank
	 * while Folder Path has been edited but not yet applied. Posts the user's
	 * choice back so the webview can either chain Apply → Migrate or abort.
	 *
	 * The migrate command reads `localFolder` from disk; running it against an
	 * unapplied Folder Path edit would migrate into the *previous* folder,
	 * which is the opposite of what the visible form state suggests. Force a
	 * choice instead of silently using the stale value.
	 */
	private async handleConfirmDirtyMigrate(): Promise<void> {
		const choice = await vscode.window.showWarningMessage(
			"Folder Path has unsaved changes",
			{
				modal: true,
				detail:
					"Migrate to Memory Bank reads the saved Folder Path from disk. Apply your changes first so the migration uses the path shown in the form.",
			},
			"Apply Changes & Migrate",
		);
		this.panel.webview.postMessage({
			command: "confirmDirtyMigrateResult",
			proceed: choice === "Apply Changes & Migrate",
		});
	}

	/**
	 * Forwards the Settings → Migrate to Memory Bank button click to the
	 * `jollimemory.rebuildKnowledgeBase` command.
	 */
	private async handleRebuildKnowledgeBase(): Promise<void> {
		const result = (await vscode.commands.executeCommand(
			"jollimemory.rebuildKnowledgeBase",
		)) as { ok: boolean; message: string } | undefined;
		this.panel.webview.postMessage({
			command: "rebuildKnowledgeBaseDone",
			success: result?.ok ?? false,
			message: result?.message ?? "",
		});
	}

	/**
	 * Forwards the Settings → Generate Missing Summaries button click to the
	 * `jollimemory.generateMissingSummaries` command (back-fills historical
	 * commits via the isolated CLI engine) and posts the result back.
	 */
	private async handleGenerateMissingSummaries(): Promise<void> {
		const result = (await vscode.commands.executeCommand("jollimemory.generateMissingSummaries")) as
			| { ok: boolean; generated: number; total: number; skipped: number; message: string }
			| undefined;
		// The command can run for minutes; the user may have closed the panel
		// meanwhile. Bail out instead of posting to a disposed webview / doing
		// the (git + index) count work for a panel nobody is looking at.
		if (SettingsWebviewPanel.currentPanel !== this) return;
		this.panel.webview.postMessage({
			command: "generateMissingSummariesDone",
			success: result?.ok ?? false,
			message: result?.message ?? "",
		});
		// Counts changed — refresh just the missing-summary number (async).
		void this.refreshMissingSummaryCount();
	}

	/**
	 * Computes the "N commits lack a summary" count off the settings-load critical
	 * path and posts it to the webview. Best-effort: any failure leaves the count
	 * blank. Uses a dynamic import so the Node-only BackfillEngine dependency chain
	 * (QueueWorker, node:child_process) is not statically bundled into the panel.
	 */
	private async refreshMissingSummaryCount(): Promise<void> {
		try {
			const { countMissingSummaries } = await import("../../../cli/src/backfill/BackfillEngine.js");
			const { extractRepoName } = await import("../../../cli/src/core/KBPathResolver.js");
			const { missing } = await countMissingSummaries(this.workspaceRoot);
			if (SettingsWebviewPanel.currentPanel !== this) return; // panel closed meanwhile
			this.panel.webview.postMessage({
				command: "missingSummaryCountLoaded",
				missingSummaryCount: missing,
				repoName: extractRepoName(this.workspaceRoot),
			});
		} catch (err) {
			log.warn("SettingsPanel", `Missing-summary count failed: ${err}`);
			if (SettingsWebviewPanel.currentPanel !== this) return;
			// Count failed — release the button from its initial disabled state so the
			// user isn't stuck (back-fill is idempotent for commits that already have one).
			this.panel.webview.postMessage({ command: "missingSummaryCountLoaded" });
		}
	}

	/** Opens a folder picker and posts the selected path back to the webview. */
	private async handleBrowseLocalFolder(): Promise<void> {
		const picked = await vscode.window.showOpenDialog({
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
			openLabel: "Select folder for Push to Local",
		});
		if (picked && picked.length > 0) {
			this.panel.webview.postMessage({
				command: "setLocalFolder",
				path: picked[0].fsPath,
			});
		}
	}

	/** Returns the global config directory. */
	private resolveConfigDir(): string {
		return getGlobalConfigDir();
	}

	/**
	 * Resolves the AI provider for the loaded config: explicit value when
	 * present, else "jolli" if signed in (matches IntelliJ's default-derivation
	 * in `populateFields`), else "anthropic".
	 */
	private resolveProvider(config: JolliMemoryConfig): "anthropic" | "jolli" | "local-agent" {
		if (config.aiProvider === "anthropic" || config.aiProvider === "jolli" || config.aiProvider === "local-agent") {
			return config.aiProvider;
		}
		const signedIn = this.authService?.isSignedIn(config) ?? false;
		return signedIn ? "jolli" : "anthropic";
	}

	/** Loads config from the global directory and sends it to the webview. */
	private async handleLoadSettings(): Promise<void> {
		const configDir = this.resolveConfigDir();
		const config = await loadConfigFromDir(configDir);

		this.fullApiKey = config.apiKey ?? "";
		this.fullJolliApiKey = config.jolliApiKey ?? "";

		const maskedApiKey = maskApiKey(config.apiKey);
		const maskedJolliApiKey = maskApiKey(config.jolliApiKey);

		const payload: SettingsPayload = {
			apiKey: maskedApiKey,
			model: config.model ?? "sonnet",
			maxTokens: config.maxTokens ?? null,
			aiProvider: this.resolveProvider(config),
			localAgentTool: config.localAgentTool ?? "claude-code",
			jolliApiKey: maskedJolliApiKey,
			claudeEnabled: config.claudeEnabled !== false,
			codexEnabled: config.codexEnabled !== false,
			geminiEnabled: config.geminiEnabled !== false,
			openCodeEnabled: config.openCodeEnabled !== false,
			cursorEnabled: config.cursorEnabled !== false,
			copilotEnabled: config.copilotEnabled !== false,
			globalInstructions: config.globalInstructions === "enabled",
			localFolder: config.localFolder ?? "",
			excludePatterns: config.excludePatterns
				? config.excludePatterns.join(", ")
				: "",
			compileExcludeFolders: config.compileExcludeFolders
				? config.compileExcludeFolders.join(", ")
				: "",
			dcoSignoff: config.dcoSignoff === true,
			autoSyncEnabled: Boolean(config.autoSyncEnabled),
			syncTranscripts: Boolean(config.syncTranscripts),
			syncPollIntervalSec:
				typeof config.syncPollIntervalSec === "number"
					? config.syncPollIntervalSec
					: null,
		};

		const signedIn = this.authService?.isSignedIn(config) ?? false;
		const hasJolliKey = this.fullJolliApiKey.length > 0;

		this.panel.webview.postMessage({
			command: "settingsLoaded",
			settings: payload,
			maskedApiKey,
			maskedJolliApiKey,
			signedIn,
			hasJolliKey,
			jolliSiteLabel: buildJolliSiteLabel(config.jolliApiKey, config.jolliUrl),
		});

		// The missing-summary count runs `git rev-list` over all of HEAD plus an
		// index read — too slow to block the form render on. Compute it off the
		// critical path and push a separate update when ready (the count span
		// shows "Checking…" until then).
		void this.refreshMissingSummaryCount();

		if (this.fullJolliApiKey.length > 0) {
			try {
				validateJolliApiKey(this.fullJolliApiKey);
			} catch (err) {
				const message =
					err instanceof Error ? err.message : "Invalid Jolli API Key on file";
				log.warn("SettingsPanel", `Saved Jolli API key is invalid: ${message}`);
				this.postError(
					`${message} (the key currently on disk is invalid — paste a new one and click Apply)`,
				);
			}
		}
	}

	/**
	 * Reads fresh config and pushes auth-state-only update to the webview.
	 *
	 * Includes the resolved `aiProvider` so a sign-in/sign-out that flipped
	 * `aiProvider` on disk is reflected in the open form. Without this, the
	 * webview's `aiProviderSelect.value` would stay stale, and the next Apply
	 * would silently overwrite disk's freshly-set value with the user's
	 * pre-sign-in dropdown selection.
	 */
	private async postAuthState(): Promise<void> {
		const configDir = this.resolveConfigDir();
		const config = await loadConfigFromDir(configDir);
		this.fullJolliApiKey = config.jolliApiKey ?? "";
		const signedIn = this.authService?.isSignedIn(config) ?? false;
		const hasJolliKey = this.fullJolliApiKey.length > 0;
		this.panel.webview.postMessage({
			command: "authStateChanged",
			signedIn,
			hasJolliKey,
			aiProvider: this.resolveProvider(config),
			localAgentTool: config.localAgentTool ?? "claude-code",
			jolliSiteLabel: buildJolliSiteLabel(config.jolliApiKey, config.jolliUrl),
		});
	}

	/** Saves settings, resolving masked API keys back to full values. */
	private async handleApplySettings(
		settings: SettingsPayload,
		sentMaskedApiKey: string,
		sentMaskedJolliApiKey: string,
	): Promise<void> {
		const resolvedApiKey =
			settings.apiKey === sentMaskedApiKey ? this.fullApiKey : settings.apiKey;
		const resolvedJolliApiKey =
			settings.jolliApiKey === sentMaskedJolliApiKey
				? this.fullJolliApiKey
				: settings.jolliApiKey;

		if (resolvedJolliApiKey.length > 0) {
			try {
				validateJolliApiKey(resolvedJolliApiKey);
			} catch (err) {
				const message =
					err instanceof Error ? err.message : "Invalid Jolli API Key";
				log.error("SettingsPanel", `Save rejected: ${message}`);
				this.postError(message);
				return;
			}
		}

		const excludePatterns = settings.excludePatterns
			.split(",")
			.map((p) => p.trim())
			.filter((p) => p.length > 0);

		// `?? ""` tolerates a payload that omits this field — the live webview
		// always sends it, but a direct postMessage (tests, or a stale cached
		// bundle from before this field existed) shouldn't crash the save.
		const compileExcludeFolders = (settings.compileExcludeFolders ?? "")
			.split(",")
			.map((p) => p.trim())
			.filter((p) => p.length > 0);

		const configDir = this.resolveConfigDir();
		// Read the persisted config before building the update so the
		// globalInstructions tri-state mapping below (enable / disable /
		// preserve-undecided) can compare the incoming checkbox against what's
		// actually on disk, not just the payload the webview happens to send.
		const currentConfig = await loadConfigFromDir(configDir);

		// The checkbox is binary; the config field is tri-state
		// (undefined | "enabled" | "disabled"). Turning the checkbox off from an
		// undecided state must NOT clobber it with an explicit "disabled" — that
		// would make syncGlobalInstructions actively try to REMOVE a block that was
		// never written for a user who simply never touched this toggle. Only an
		// explicit enabled -> off transition writes "disabled"; otherwise the field
		// is omitted from the update entirely (never written as `undefined`, which
		// would delete an existing value via saveConfigScoped's merge).
		const giUpdate: { globalInstructions?: "enabled" | "disabled" } = settings.globalInstructions
			? { globalInstructions: "enabled" }
			: currentConfig.globalInstructions === "enabled"
				? { globalInstructions: "disabled" }
				: {};

		const update: Partial<JolliMemoryConfig> = {
			apiKey: resolvedApiKey.length > 0 ? resolvedApiKey : undefined,
			model: settings.model === "sonnet" ? undefined : settings.model,
			maxTokens: settings.maxTokens ?? undefined,
			aiProvider: settings.aiProvider,
			localAgentTool: settings.localAgentTool ?? "claude-code",
			jolliApiKey:
				resolvedJolliApiKey.length > 0 ? resolvedJolliApiKey : undefined,
			claudeEnabled: settings.claudeEnabled,
			codexEnabled: settings.codexEnabled,
			geminiEnabled: settings.geminiEnabled,
			openCodeEnabled: settings.openCodeEnabled,
			cursorEnabled: settings.cursorEnabled,
			copilotEnabled: settings.copilotEnabled,
			...giUpdate,
			localFolder:
				settings.localFolder && settings.localFolder.length > 0
					? settings.localFolder
					: undefined,
			excludePatterns: excludePatterns.length > 0 ? excludePatterns : undefined,
			compileExcludeFolders:
				compileExcludeFolders.length > 0 ? compileExcludeFolders : undefined,
			dcoSignoff: settings.dcoSignoff ? true : undefined,
			autoSyncEnabled: settings.autoSyncEnabled === true ? true : undefined,
			syncTranscripts: settings.syncTranscripts === true ? true : undefined,
			// `null` from the webview → user cleared the field → reset to default
			// (write `undefined` so config falls back to the engine's 90-min default).
			// Number → clamp to [5400, 86400] before persisting; the webview already
			// pre-clamps but we re-clamp defensively against direct postMessage.
			syncPollIntervalSec:
				typeof settings.syncPollIntervalSec === "number"
					? Math.min(
							86400,
							Math.max(5400, Math.floor(settings.syncPollIntervalSec)),
						)
					: undefined,
		};

		const repoRoot = await getProjectRootDir(this.workspaceRoot);
		await this.syncHooks(repoRoot, settings);

		await saveConfigScoped(update, configDir);

		// JOLLI-1904 (funnel): record an explicit AI-provider change, not every
		// settings save. Mirrors IntelliJ ai_provider_selected { provider };
		// surface=vscode is auto-injected.
		if (settings.aiProvider !== this.resolveProvider(currentConfig)) {
			track("ai_provider_selected", { provider: settings.aiProvider });
		}

		// Act on a global-instructions transition in EITHER direction: the
		// undecided/disabled -> enabled transition writes the block; the
		// enabled -> off transition removes it (the checkbox's "off" must
		// actually undo the write, not just flip the persisted flag). Config
		// was persisted just above, so syncGlobalInstructions reads the fresh
		// value and does the right thing. Calling the block-specific sync
		// (rather than re-running the full installer) keeps host-gating in one
		// place without redoing hook/MCP work the settings save already did.
		const giEnabling = settings.globalInstructions && currentConfig.globalInstructions !== "enabled";
		const giDisabling = !settings.globalInstructions && currentConfig.globalInstructions === "enabled";
		if (giEnabling || giDisabling) {
			await syncGlobalInstructions();
		}

		this.fullApiKey = resolvedApiKey;
		this.fullJolliApiKey = resolvedJolliApiKey;

		log.info("SettingsPanel", "Settings saved");

		this.panel.webview.postMessage({ command: "settingsSaved" });
		this.onSavedCallback?.();
	}

	/**
	 * Installs or removes CLI hooks based on the enabled state of each integration.
	 * Syncs across ALL worktrees so every worktree stays consistent with the
	 * user's settings — mirrors the behaviour of Installer.install/uninstall.
	 */
	private async syncHooks(
		repoRoot: string,
		settings: SettingsPayload,
	): Promise<void> {
		let worktrees: ReadonlyArray<string>;
		try {
			worktrees = await listWorktrees(repoRoot);
		} catch {
			worktrees = [repoRoot];
		}
		const failures: Array<HookSyncFailure> = [];

		for (const wt of worktrees) {
			try {
				if (settings.claudeEnabled) {
					await installClaudeHook(wt);
				} else {
					await removeClaudeHook(wt);
				}
			} catch (err: unknown) {
				log.error("SettingsPanel", `Failed to sync Claude hook for ${wt}`, err);
				failures.push({ integration: "Claude", worktree: wt, cause: err });
			}

			try {
				if (settings.geminiEnabled) {
					await installGeminiHook(wt);
				} else {
					await removeGeminiHook(wt);
				}
			} catch (err: unknown) {
				log.error("SettingsPanel", `Failed to sync Gemini hook for ${wt}`, err);
				failures.push({ integration: "Gemini", worktree: wt, cause: err });
			}
		}

		if (failures.length > 0) {
			const summary = failures
				.map(
					(failure) =>
						`${failure.integration} (${failure.worktree}): ${String(failure.cause)}`,
				)
				.join("; ");
			throw new Error(
				`Hook sync failed for ${failures.length} worktree operation(s): ${summary}`,
			);
		}
	}

	private postError(message: string): void {
		this.panel.webview.postMessage({ command: "settingsError", message });
	}
}
