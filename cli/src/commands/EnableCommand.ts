/**
 * Enable / Disable commands for Jolli CLI.
 *
 * - `jolli enable`  — Install AI agent + git hooks, optionally configure API keys.
 * - `jolli disable` — Remove all Jolli Memory hooks.
 */

import { join } from "node:path";
import type { Command } from "commander";
import { getJolliUrl } from "../auth/AuthConfig.js";
import { browserLogin } from "../auth/Login.js";
import { validateJolliApiKey } from "../core/JolliApiUtils.js";
import { getGlobalConfigDir, loadConfigFromDir, saveConfigScoped } from "../core/SessionTracker.js";
import { install, uninstall } from "../install/Installer.js";
import { createLogger, setLogDir } from "../Logger.js";
import type { JolliMemoryConfig } from "../Types.js";
import { isInteractive, promptText, resolveProjectDir } from "./CliUtils.js";

const log = createLogger("EnableCommand");

/**
 * Interactive setup flow after hooks are installed.
 * Offers browser login (recommended), manual API key entry, or skip.
 * Always uses the global config directory.
 */
export async function promptSetup(): Promise<void> {
	const configDir = getGlobalConfigDir();
	const config = await loadConfigFromDir(configDir);

	// If jolliApiKey is already configured, skip the setup menu
	if (config.jolliApiKey) {
		console.log("\n  Jolli API Key:     configured ✓");
		await promptAnthropicKey(configDir, config);
		return;
	}

	console.log("\n  How would you like to use Jolli Memory?\n");
	console.log("    1. Sign up / Sign in to Jolli (recommended)");
	console.log("    2. Enter Jolli API Key manually");
	console.log("    3. Skip for now (configure later)");

	const answer = await promptText("\n  Choice [1]: ");
	const choice = answer.trim() || "1";

	if (choice === "1") {
		await handleBrowserLogin();
	} else if (choice === "2") {
		await handleManualApiKey(configDir);
	} else {
		console.log(`\n  Skipped. You can configure later with 'jolli auth login' or edit:`);
		console.log(`    ${join(configDir, "config.json")}\n`);
		return;
	}

	// After Jolli setup, offer Anthropic key if not configured
	const updatedConfig = await loadConfigFromDir(configDir);
	await promptAnthropicKey(configDir, updatedConfig);
}

/** Opens the browser for OAuth login/signup and saves credentials on callback. */
async function handleBrowserLogin(): Promise<void> {
	try {
		const baseUrl = getJolliUrl();
		await browserLogin(`${baseUrl}/login`);
		console.log("\n  Authenticated successfully ✓");
		const configDir = getGlobalConfigDir();
		const config = await loadConfigFromDir(configDir);
		if (config.jolliApiKey) {
			console.log("  Jolli API Key:     saved ✓");
		}
	} catch (error) {
		console.error("\n  Login failed:", error instanceof Error ? error.message : error);
		console.log("  You can try again with 'jolli auth login'.\n");
	}
}

/** Prompts for a Jolli API key and saves it to config. */
async function handleManualApiKey(configDir: string): Promise<void> {
	console.log("\n  API Key Configuration");
	console.log("  ──────────────────────────────────────");

	const key = await promptText("  Jolli API Key (press Enter to skip): ");
	if (key) {
		try {
			validateJolliApiKey(key);
		} catch (err) {
			console.error(`\n  Error: ${(err as Error).message}\n`);
			process.exitCode = 1;
			return;
		}
		await saveConfigScoped({ jolliApiKey: key } as Partial<JolliMemoryConfig>, configDir);
		console.log("  Jolli API Key:     saved ✓");
		console.log(`\n  Configuration saved to ${join(configDir, "config.json")}`);
	}
}

/** Prompts for an Anthropic API key if not already configured. */
async function promptAnthropicKey(configDir: string, config: JolliMemoryConfig): Promise<void> {
	if (config.apiKey || process.env.ANTHROPIC_API_KEY) {
		console.log("  Anthropic API Key: configured ✓\n");
		return;
	}

	const key = await promptText("  Anthropic API Key (press Enter to skip): ");
	if (key) {
		await saveConfigScoped({ apiKey: key } as Partial<JolliMemoryConfig>, configDir);
		console.log("  Anthropic API Key: saved ✓");
		console.log(`\n  Configuration saved to ${join(configDir, "config.json")}`);
	}

	// Check final state
	const updatedConfig = await loadConfigFromDir(configDir);
	const hasJolliKey = Boolean(updatedConfig.jolliApiKey);
	const hasAnthropicKey = updatedConfig.apiKey || process.env.ANTHROPIC_API_KEY;

	if (!hasJolliKey && !hasAnthropicKey) {
		console.log("\n  Warning: No API keys configured. Jolli Memory summaries will not be generated.");
		console.log("  Run 'jolli auth login' or 'jolli enable' again to configure, or edit config manually:");
		console.log(`    ${join(configDir, "config.json")}\n`);
	} else {
		console.log("");
	}
}

/** Registers the `enable` command on the given Commander program. */
export function registerEnableCommand(program: Command): void {
	program
		.command("enable")
		.description("Install Jolli Memory hooks (AI agent + git hooks)")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.option("-y, --yes", "Skip interactive prompts")
		.action(async (options: { cwd: string; yes?: boolean }) => {
			setLogDir(options.cwd);

			log.info("Running 'enable' command");
			const result = await install(options.cwd, { source: "cli" });

			if (result.success) {
				console.log("\n  Jolli Memory enabled successfully!\n");
				console.log("  Hooks installed:");
				console.log(`    - Git post-commit hook (${result.gitHookPath ?? ".git/hooks/post-commit"})`);
				console.log(`    - Git post-rewrite hook (${result.postRewriteHookPath ?? ".git/hooks/post-rewrite"})`);
				console.log(
					`    - Git prepare-commit-msg hook (${result.prepareMsgHookPath ?? ".git/hooks/prepare-commit-msg"})`,
				);
				console.log(`    - Claude Code hooks (${result.claudeSettingsPath ?? ".claude/settings.local.json"})`);
				if (result.geminiSettingsPath) {
					console.log(`    - Gemini CLI hook (${result.geminiSettingsPath})`);
				}

				for (const warning of result.warnings) {
					console.warn(`  Warning: ${warning}`);
				}

				console.log("\n  IMPORTANT: Restart your AI agent session for the hooks to take effect.");
				console.log("  Run 'jolli doctor' to verify installation.");

				// Step 2: Interactive API key configuration
				if (isInteractive() && !options.yes) {
					await promptSetup();
				} else {
					// Non-interactive: print manual config guide
					const configDir = getGlobalConfigDir();
					console.log("\n  Configure API keys to enable summarization:");
					console.log(`    Edit: ${join(configDir, "config.json")}`);
					console.log('    Set "apiKey" (Anthropic) and/or "jolliApiKey" (Jolli Space)\n');
				}
			} else {
				console.error(`\n  Error: ${result.message}\n`);
				process.exitCode = 1;
				for (const warning of result.warnings) {
					console.warn(`  Warning: ${warning}`);
				}
			}
		});
}

/** Registers the `disable` command on the given Commander program. */
export function registerDisableCommand(program: Command): void {
	program
		.command("disable")
		.description("Remove all Jolli Memory hooks")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (options: { cwd: string }) => {
			setLogDir(options.cwd);

			log.info("Running 'disable' command");
			const result = await uninstall(options.cwd);

			if (result.success) {
				console.log("\n  Jolli Memory disabled. Hooks removed.\n");
			} else {
				console.error(`\n  Error: ${result.message}\n`);
				process.exitCode = 1;
			}
		});
}
