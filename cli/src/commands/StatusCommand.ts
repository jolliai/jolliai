/**
 * Status command for Jolli CLI.
 *
 * `jolli status` — Show current Jolli Memory installation status,
 * including hooks, sessions, stored memories, and Jolli Site info.
 */

import type { Command } from "commander";
import { loadAuthToken } from "../auth/AuthConfig.js";
import { parseJolliApiKey } from "../core/JolliApiUtils.js";
import { getGlobalConfigDir, loadConfigFromDir } from "../core/SessionTracker.js";
import { getStatus } from "../install/Installer.js";
import { createLogger, setLogDir } from "../Logger.js";
import { resolveProjectDir, VERSION } from "./CliUtils.js";

const log = createLogger("StatusCommand");

/** Registers the `status` command on the given Commander program. */
export function registerStatusCommand(program: Command): void {
	program
		.command("status")
		.description("Show Jolli Memory installation status")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.option("--json", "Output status as JSON (used by the VSCode extension)")
		.action(async (options: { cwd: string; json?: boolean }) => {
			setLogDir(options.cwd);

			log.info("Running 'status' command");
			const status = await getStatus(options.cwd);

			if (options.json) {
				console.log(JSON.stringify(status));
				return;
			}

			// Build hooks description matching VSCode STATUS panel format
			const hookParts: string[] = [];
			if (status.gitHookInstalled) hookParts.push("3 Git");
			if (status.claudeHookInstalled) hookParts.push("2 Claude");
			if (status.geminiHookInstalled) hookParts.push("1 Gemini CLI");
			const hooksDesc = hookParts.length > 0 ? hookParts.join(" + ") : "none installed";

			const hookRuntime = status.hookSource
				? `${status.hookSource}${status.hookVersion && status.hookVersion !== "unknown" ? `@${status.hookVersion}` : ""}`
				: undefined;

			// Load config for Jolli Site display (same layered logic as enable)
			const configDir = getGlobalConfigDir();
			const config = await loadConfigFromDir(configDir);
			const jolliSite = config?.jolliApiKey ? parseJolliApiKey(config.jolliApiKey)?.u : undefined;
			// Use loadAuthToken() so JOLLI_AUTH_TOKEN env var is honored, matching `jolli auth status`.
			const authToken = await loadAuthToken();

			console.log(`\n  Jolli Memory Status (v${VERSION})`);
			console.log("  ──────────────────────────────────────");
			console.log(`  Hooks:            ${hooksDesc}`);
			if (hookRuntime) {
				console.log(`  Hook runtime:     ${hookRuntime}`);
			}
			/* v8 ignore next -- ternary: auth token presence depends on external config/env */
			console.log(`  Jolli Account:    ${authToken ? "Signed in" : "Not signed in"}`);
			console.log(`  Jolli API Key:    ${config?.jolliApiKey ? "Configured" : "Not configured"}`);
			/* v8 ignore next 2 -- ternary: env var presence depends on external environment */
			console.log(
				`  Anthropic Key:    ${config?.apiKey || process.env.ANTHROPIC_API_KEY ? "Configured" : "Not configured"}`,
			);
			console.log(`  Sessions:         ${status.activeSessions}`);
			console.log(`  Stored memories:  ${status.summaryCount}`);
			if (jolliSite) {
				console.log(`  Jolli Site:       ${jolliSite.replace(/^https?:\/\//, "")}`);
			}
			console.log(`  Orphan branch:    ${status.orphanBranch}`);
			console.log("");
		});
}
