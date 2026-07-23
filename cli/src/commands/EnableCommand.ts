/**
 * Enable / Disable commands for Jolli CLI.
 *
 * - `jolli enable`  — Install AI agent + git hooks, optionally configure API keys.
 * - `jolli disable` — Remove all Jolli Memory hooks.
 */

import { join } from "node:path";
import { type Command, Option } from "commander";
import { getJolliUrl, loadAuthToken } from "../auth/AuthConfig.js";
import { browserLogin } from "../auth/Login.js";
import { isLocalAgentChild } from "../core/AgentReentry.js";
import { resolveLlmCredentialSource } from "../core/LlmClient.js";
import { isClaudeCodeUsable } from "../core/localagent/ClaudeExecutableResolver.js";
import { getGlobalConfigDir, loadConfig, loadConfigFromDir, saveConfigScoped } from "../core/SessionTracker.js";
import { track } from "../core/Telemetry.js";
import { markSkipExitFlush } from "../core/TelemetryCommandHook.js";
import { triggerPendingPushRetry } from "../hooks/PushCompensation.js";
import { isValidSourceTag } from "../install/DistPathResolver.js";
import { install, uninstall } from "../install/Installer.js";
import { createLogger, setLogDir } from "../Logger.js";
import type { InstallResult, JolliMemoryConfig } from "../Types.js";
import { isInteractive, promptText, resolveProjectDir } from "./CliUtils.js";
import { offerOptionalJolliLogin } from "./OptionalLogin.js";

const log = createLogger("EnableCommand");

/**
 * Interactive provider-setup flow after hooks are installed. When a fresh config
 * meets a working local Claude Code CLI it auto-selects the local agent and
 * returns; otherwise it offers browser sign-in (recommended), an Anthropic key,
 * or skip. Always uses the global config directory. Shared by `jolli enable` and
 * the bare-`jolli` guided front door.
 */
export async function promptSetup(): Promise<void> {
	const configDir = getGlobalConfigDir();
	const config = await loadConfigFromDir(configDir);

	// Already signed in / holding a Jolli key → skip the provider menu.
	if (config.jolliApiKey) {
		console.log("\n  Jolli API Key:     configured ✓");
		await promptAnthropicKey(configDir, config);
		return;
	}

	// Zero-friction default: when nothing is configured yet AND a working local
	// Claude Code CLI is present, generate summaries through the user's own
	// subscription (no API key, no sign-in) and skip the menu entirely. Probe
	// ONLY on a truly fresh config so an existing Anthropic key or a deliberate
	// provider choice is never second-guessed (and so an already-configured
	// re-run never pays for the subprocess probe).
	const fresh = !config.apiKey && !process.env.ANTHROPIC_API_KEY && config.aiProvider === undefined;
	let noLocalAgent = false;
	if (fresh) {
		if (isClaudeCodeUsable({ overridePath: config.localAgentPath })) {
			await handleLocalAgent(configDir);
			return;
		}
		noLocalAgent = true;
	}

	// No local agent: the only ways to generate are the Jolli proxy (sign in) or
	// a direct Anthropic key. "Skip" defers setup — hooks still install, nothing
	// generates until configured. (Manual Jolli-key entry was retired; set one
	// with `jolli configure` if needed.)
	console.log(
		noLocalAgent
			? "\n  No local agent CLI found. How would you like to generate summaries?\n"
			: "\n  How would you like to generate summaries?\n",
	);
	console.log("    1. Sign up / Sign in to Jolli (browser login)   [recommended]");
	console.log("    2. Enter Anthropic API key (sk-ant-...)");
	console.log("    3. Skip for now (configure later)");

	const answer = await promptText("\n  Choice [1]: ");
	const choice = answer.trim() || "1";

	// Each choice is terminal — no fall-through to the Anthropic-key prompt (that
	// stays only on the "already have a Jolli key" path above).
	if (choice === "2") {
		await handleAnthropicKey(configDir);
	} else if (choice === "3") {
		console.log("\n  Skipped. Configure later with 'jolli auth login' or 'jolli configure'.");
		console.log(`    ${join(configDir, "config.json")}\n`);
	} else {
		await handleBrowserLogin();
	}
}

/** Opens the browser for OAuth login/signup and saves credentials on callback. */
async function handleBrowserLogin(): Promise<void> {
	try {
		await browserLogin(getJolliUrl());
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

/** Prompts for an Anthropic API key and pins the provider to Anthropic. */
async function handleAnthropicKey(configDir: string): Promise<void> {
	const key = await promptText("\n  Anthropic API Key (press Enter to skip): ");
	if (key) {
		await saveConfigScoped({ apiKey: key, aiProvider: "anthropic" } as Partial<JolliMemoryConfig>, configDir);
		console.log("  Anthropic API Key: saved ✓");
		console.log(`\n  Configuration saved to ${join(configDir, "config.json")}`);
	}
}

/**
 * Auto-selects the Local Agent provider after a working Claude Code CLI is
 * detected: summaries are generated by driving the local `claude` (v1) through
 * the user's own subscription, so no jollimemory-held API key is stored. Reached
 * only when {@link isClaudeCodeUsable} already returned true on a fresh config,
 * so the message states the detection plainly and points at how to change it.
 */
async function handleLocalAgent(configDir: string): Promise<void> {
	await saveConfigScoped(
		{ aiProvider: "local-agent", localAgentTool: "claude-code" } as Partial<JolliMemoryConfig>,
		configDir,
	);
	console.log("\n  ✓ Detected Claude Code — using your subscription to generate summaries (claude -p), no API key.");
	console.log("  Summaries run through your local `claude` login.");
	console.log("  Change this anytime: 'jolli auth login', or 'jolli configure --set aiProvider=jolli'.");
	console.log(`\n  Configuration saved to ${join(configDir, "config.json")}\n`);
}

/**
 * Offers an Anthropic API key on the "already have a Jolli key" path (its only
 * caller — a jolliApiKey is always present here, so summaries can already be
 * generated; this just lets the user add a direct key on top).
 */
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
		.option(
			"--integrations-only",
			"Repair MCP, skills, and dispatch scripts without changing repo hooks (advanced)",
		)
		.option(
			"--repo-hooks-only",
			"Install only the shared runtime, source-neutral Git hooks, Claude agent hooks, and project /jolli menu",
		)
		.option("--source-tag <tag>", "Override the dist-paths source tag (e.g. 'intellij')")
		.addOption(new Option("--automatic").hideHelp())
		.action(
			async (options: {
				cwd: string;
				yes?: boolean;
				integrationsOnly?: boolean;
				repoHooksOnly?: boolean;
				sourceTag?: string;
				automatic?: boolean;
			}) => {
				setLogDir(options.cwd);

				// A jollimemory-spawned local agent (see AgentReentry) triggers the
				// `jolli` Claude plugin's SessionStart hook, which runs this command
				// against the agent's throwaway temp cwd. Installing hooks / claiming a
				// Memory Bank repo there is pure self-recursion — bail before any work.
				if (isLocalAgentChild()) {
					log.info("'enable' skipped — running inside a jollimemory-spawned local agent");
					return;
				}

				if (options.integrationsOnly && options.repoHooksOnly) {
					console.error("\n  Error: --integrations-only and --repo-hooks-only are mutually exclusive.\n");
					process.exitCode = 1;
					return;
				}

				if (options.repoHooksOnly) {
					markSkipExitFlush();
				}

				if (options.sourceTag !== undefined && !isValidSourceTag(options.sourceTag)) {
					// The tag becomes a dist-paths filename and may be passed to the
					// resolver as an env value — reject unsafe path/shell tokens.
					console.error(
						"\n  Error: --source-tag must be lowercase alphanumerics and hyphens only (e.g. 'intellij').\n",
					);
					process.exitCode = 1;
					return;
				}

				log.info("Running 'enable' command");
				const result = await install(options.cwd, {
					source: "cli",
					integrationsOnly: options.integrationsOnly,
					repoHooksOnly: options.repoHooksOnly,
					sourceTag: options.sourceTag,
					respectManualDisable: options.automatic,
					clearManualDisableOnSuccess: !options.integrationsOnly && !options.automatic,
					automatic: options.automatic,
				});

				if (options.repoHooksOnly) {
					if (result.success) {
						log.info("repo-hooks-only reconciliation complete");
					} else {
						console.error(`Jolli repo-hooks reconciliation failed: ${result.message}`);
						process.exitCode = 1;
					}
					return;
				}

				await reportEnableResult(result, options);
			},
		);
}

/**
 * Prints the human-facing outcome of a full `jolli enable` and, when
 * interactive, runs the API-key setup flow. Repo-hooks-only stays silent.
 */
async function reportEnableResult(
	result: InstallResult,
	options: { cwd: string; yes?: boolean; integrationsOnly?: boolean },
): Promise<void> {
	if (result.success) {
		track("surface_enabled", { trigger: "cli" });
		if (options.integrationsOnly) {
			console.log("\n  Jolli Memory integrations enabled (MCP + skills; no hooks installed).\n");
		} else {
			console.log("\n  Jolli Memory enabled successfully!\n");
			console.log("  Hooks installed:");
			console.log(`    - Git post-commit hook (${result.gitHookPath ?? ".git/hooks/post-commit"})`);
			console.log(`    - Git post-rewrite hook (${result.postRewriteHookPath ?? ".git/hooks/post-rewrite"})`);
			console.log(
				`    - Git prepare-commit-msg hook (${result.prepareMsgHookPath ?? ".git/hooks/prepare-commit-msg"})`,
			);
			console.log(`    - Git post-merge hook (${result.postMergeHookPath ?? ".git/hooks/post-merge"})`);
			console.log(`    - Git pre-push hook (${result.prePushHookPath ?? ".git/hooks/pre-push"})`);
			console.log(`    - Claude Code hooks (${result.claudeSettingsPath ?? ".claude/settings.local.json"})`);
			if (result.geminiSettingsPath) {
				console.log(`    - Gemini CLI hook (${result.geminiSettingsPath})`);
			}
		}

		for (const warning of result.warnings) {
			console.warn(`  Warning: ${warning}`);
		}

		if (!options.integrationsOnly) {
			console.log("\n  IMPORTANT: Restart your AI agent session for the hooks to take effect.");
		}
		console.log("  Run 'jolli doctor' to verify installation.");

		// Onboarding disclosure: telemetry is opt-out, so state it plainly here
		// (the once-only first-run banner also covers non-enable first commands).
		console.log("\n  Telemetry: anonymous, content-free usage data is on by default to improve");
		console.log("  Jolli Memory (never your code, paths, or memory content). Turn it off with");
		console.log("  'jolli telemetry off' (or DO_NOT_TRACK=1) · https://www.jolli.ai/telemetry");

		// Step 2: Interactive provider configuration
		if (isInteractive() && !options.yes) {
			await promptSetup();
			// Sign-in nudge (parity with the guided front door's Rung 2): a user
			// who just configured local-agent / Anthropic generation but isn't
			// signed in gets offered cloud sync once. Kept INSIDE the interactive
			// guard so `-y` / non-interactive runs never open a browser login.
			const cfg = await loadConfig();
			const canGenerate =
				cfg.aiProvider === "local-agent"
					? isClaudeCodeUsable({ overridePath: cfg.localAgentPath })
					: resolveLlmCredentialSource(cfg) !== null;
			const canSync = Boolean((await loadAuthToken()) || cfg.jolliApiKey);
			if (canGenerate && !canSync) {
				await offerOptionalJolliLogin();
			}
		} else {
			// Non-interactive: print manual config guide
			const configDir = getGlobalConfigDir();
			console.log("\n  Configure a provider to enable summarization:");
			console.log(`    Edit: ${join(configDir, "config.json")}`);
			console.log('    - Set "apiKey" (Anthropic) and/or "jolliApiKey" (Jolli Space), or');
			console.log('    - Set "aiProvider": "local-agent" to drive a local Claude Code CLI (no key)\n');
		}

		// Pre-push sync catch-up (JOLLI-1900): retry any commits left in
		// push-pending.json from a previous session. Runs after promptSetup so a
		// user who just signed in gets their backlog pushed. Skipped in
		// integrations-only is a focused repair mode and does not own Git-hook
		// capture. Fully guarded — never throws, no-ops when nothing is pending.
		if (!options.integrationsOnly) {
			triggerPendingPushRetry(options.cwd, "cli-enable");
		}

		// Historical back-fill is no longer kicked off automatically at enable
		// time — it is user-driven now (VS Code cold-start card, or the manual
		// `jolli backfill` command) so nothing spends LLM budget without an
		// explicit opt-in.
	} else {
		console.error(`\n  Error: ${result.message}\n`);
		process.exitCode = 1;
		for (const warning of result.warnings) {
			console.warn(`  Warning: ${warning}`);
		}
	}
}

/** Registers the `disable` command on the given Commander program. */
export function registerDisableCommand(program: Command): void {
	program
		.command("disable")
		.description("Remove all Jolli Memory hooks")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.option(
			"--integrations-only",
			"Remove only the repo-scoped MCP registration; leave hooks, skills, and dist-paths (mirror of enable --integrations-only)",
		)
		.action(async (options: { cwd: string; integrationsOnly?: boolean }) => {
			setLogDir(options.cwd);

			log.info("Running 'disable' command");
			// Record the repo-wide opt-out BEFORE the async uninstall so the user's
			// intent survives even if uninstall throws. Skipped for integrations-only
			// (IntelliJ's MCP-only teardown), which is not a full disable.
			//
			// If we CANNOT persist the opt-out, do NOT remove hooks: a disable we
			// can't make durable would leave a deceptive half-state (hooks gone, but
			// a later upgrade / VS Code activation silently re-enables). Fail loudly
			// and change nothing so the state stays coherent (still enabled).
			const result = await uninstall(options.cwd, {
				integrationsOnly: options.integrationsOnly,
				preserveMenu: !options.integrationsOnly,
				persistManualDisable: !options.integrationsOnly,
			});

			if (result.success) {
				track("surface_disabled", { reason: "manual" });
				console.log(
					options.integrationsOnly
						? "\n  Jolli Memory integrations removed (MCP).\n"
						: "\n  Jolli Memory disabled. Hooks removed.\n",
				);
			} else {
				console.error(`\n  Error: ${result.message}\n`);
				process.exitCode = 1;
			}
		});
}
