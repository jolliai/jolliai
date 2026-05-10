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
	readonly aiProvider: "anthropic" | "jolli";
	readonly jolliApiKey: string;
	readonly claudeEnabled: boolean;
	readonly codexEnabled: boolean;
	readonly geminiEnabled: boolean;
	readonly openCodeEnabled: boolean;
	readonly cursorEnabled: boolean;
	readonly copilotEnabled: boolean;
	readonly localFolder: string;
	readonly excludePatterns: string;
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
	| { command: "signIn" }
	| { command: "signOut" }
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
 * Mirrors the Kotlin port in `intellij/.../SettingsDialog.kt::refreshJolliFields`.
 */
function buildJolliSiteLabel(jolliApiKey: string | undefined): string {
	if (!jolliApiKey) return "Using Jolli to generate summaries";
	const meta = parseJolliApiKey(jolliApiKey);
	const siteDisplay = meta?.u.replace(/^https?:\/\//, "") ?? "";
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
			case "rebuildKnowledgeBase":
				this.handleRebuildKnowledgeBase().catch((err: unknown) => {
					log.error("SettingsPanel", `Rebuild failed: ${err}`);
					this.panel.webview.postMessage({
						command: "rebuildKnowledgeBaseDone",
						success: false,
						message: err instanceof Error ? err.message : String(err),
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
	private resolveProvider(config: JolliMemoryConfig): "anthropic" | "jolli" {
		if (config.aiProvider === "anthropic" || config.aiProvider === "jolli") {
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
			jolliApiKey: maskedJolliApiKey,
			claudeEnabled: config.claudeEnabled !== false,
			codexEnabled: config.codexEnabled !== false,
			geminiEnabled: config.geminiEnabled !== false,
			openCodeEnabled: config.openCodeEnabled !== false,
			cursorEnabled: config.cursorEnabled !== false,
			copilotEnabled: config.copilotEnabled !== false,
			localFolder: config.localFolder ?? "",
			excludePatterns: config.excludePatterns
				? config.excludePatterns.join(", ")
				: "",
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
			jolliSiteLabel: buildJolliSiteLabel(config.jolliApiKey),
		});

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
			jolliSiteLabel: buildJolliSiteLabel(config.jolliApiKey),
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

		const update: Partial<JolliMemoryConfig> = {
			apiKey: resolvedApiKey.length > 0 ? resolvedApiKey : undefined,
			model: settings.model === "sonnet" ? undefined : settings.model,
			maxTokens: settings.maxTokens ?? undefined,
			aiProvider: settings.aiProvider,
			jolliApiKey:
				resolvedJolliApiKey.length > 0 ? resolvedJolliApiKey : undefined,
			claudeEnabled: settings.claudeEnabled,
			codexEnabled: settings.codexEnabled,
			geminiEnabled: settings.geminiEnabled,
			openCodeEnabled: settings.openCodeEnabled,
			cursorEnabled: settings.cursorEnabled,
			copilotEnabled: settings.copilotEnabled,
			localFolder:
				settings.localFolder && settings.localFolder.length > 0
					? settings.localFolder
					: undefined,
			excludePatterns: excludePatterns.length > 0 ? excludePatterns : undefined,
		};

		const repoRoot = await getProjectRootDir(this.workspaceRoot);
		await this.syncHooks(repoRoot, settings);

		const configDir = this.resolveConfigDir();
		await saveConfigScoped(update, configDir);

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
