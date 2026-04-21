/**
 * Auth Command Module
 *
 * Registers jolli auth login/logout/status subcommands.
 */
import type { Command } from "commander";
import { clearAuthCredentials, getJolliUrl, loadAuthToken } from "../auth/AuthConfig.js";
import { browserLogin } from "../auth/Login.js";
import { loadConfig } from "../core/SessionTracker.js";

export function registerAuthCommands(program: Command): void {
	const auth = program.command("auth").description("Authentication commands");

	auth.command("login")
		.description("Log in to Jolli via browser")
		.action(async () => {
			try {
				const baseUrl = getJolliUrl();
				await browserLogin(`${baseUrl}/login`);
				const config = await loadConfig();
				console.log("\n  Signed in successfully!");
				console.log("  Auth token:        saved ✓");
				if (config.jolliApiKey) {
					console.log("  Jolli API Key:     saved ✓");
				}
				console.log("");
			} catch (error) {
				console.error("\n  Login failed:", error instanceof Error ? error.message : error);
				console.log("  You can try again with 'jolli auth login'.\n");
				process.exitCode = 1;
			}
		});

	auth.command("logout")
		.description("Clear stored auth credentials")
		.action(async () => {
			await clearAuthCredentials();
			const config = await loadConfig();
			const hasAnthropicKey = Boolean(config.apiKey || process.env.ANTHROPIC_API_KEY);

			console.log("\n  Logged out.");
			console.log("  Auth token and Jolli API Key have been removed from local config.");
			if (hasAnthropicKey) {
				console.log("\n  Your Anthropic API Key is still saved and will continue to work:");
				console.log("    - Anthropic API Key  (remove with `jolli configure --remove apiKey`)");
			}
			console.log("");
		});

	auth.command("status")
		.description("Show current authentication state")
		.action(async () => {
			const token = await loadAuthToken();
			const config = await loadConfig();

			console.log("\n  Jolli Auth Status");
			console.log("  ──────────────────────────────────────");

			/* v8 ignore next -- ternary: auth token presence depends on external config */
			console.log(`  Jolli Account:  ${token ? "Signed in" : "Not signed in"}`);

			const hasJolliKey = Boolean(config.jolliApiKey);

			console.log(`  Jolli API Key:  ${hasJolliKey ? "Configured" : "Not configured"}`);

			if (!token && !hasJolliKey) {
				console.log("\n  No credentials configured. Run `jolli auth login` to get started.");
			}

			console.log("");
		});
}
