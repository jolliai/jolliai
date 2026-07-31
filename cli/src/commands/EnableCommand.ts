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
import {
	type DetectedAgent,
	isLocalAgentUsable,
	type LocalAgentOverride,
	listPresentLocalAgents,
	localAgentOverrideFrom,
} from "../core/localagent/DetectAgents.js";
import { LOCAL_AGENT_TOOLS, localAgentToolLabel, localAgentToolLoginHint } from "../core/localagent/ToolMeta.js";
import { maybeEmitOnboardingProgress } from "../core/OnboardingFunnel.js";
import { getGlobalConfigDir, loadConfig, loadConfigFromDir, saveConfigScoped } from "../core/SessionTracker.js";
import { track } from "../core/Telemetry.js";
import { markSkipExitFlush } from "../core/TelemetryCommandHook.js";
import { triggerPendingPushRetry } from "../hooks/PushCompensation.js";
import { isValidSourceTag } from "../install/DistPathResolver.js";
import { install, uninstall } from "../install/Installer.js";
import { createLogger, setLogDir } from "../Logger.js";
import type { InstallResult, JolliMemoryConfig, LocalAgentToolId } from "../Types.js";
import { isInteractive, promptText, resolveProjectDir } from "./CliUtils.js";
import { canGenerateNow, promptGenerationFix } from "./GenerationFix.js";
import { offerOptionalJolliLogin } from "./OptionalLogin.js";

const log = createLogger("EnableCommand");

/**
 * How many unreadable answers the local-agent picker tolerates before it gives
 * up and skips. Bounds the one loop branch that consumes no candidate — see
 * {@link handleLocalAgent}. Three so a genuine typo costs nothing, while a
 * prompt stuck returning garbage (or a user holding Enter, since that menu has no
 * default) cannot spin.
 */
const MAX_INVALID_CHOICES = 3;

/**
 * What a run of {@link handleLocalAgent} settled on. `"exhausted"` is the one
 * outcome the caller must react to: every offered tool failed its capability
 * probe, so the local-agent route is closed on this machine and a caller that
 * ENTERED that route automatically (the multi-tool fast path) has to hand the
 * user back the full provider menu rather than dead-end them.
 */
type LocalAgentPickOutcome = "saved" | "skipped" | "exhausted";

/**
 * Interactive provider-setup flow after hooks are installed. When there is no
 * usable credential and exactly one present, working local agent tool, it
 * auto-selects that tool and returns; when two or more are present it prompts
 * among them; otherwise it offers browser sign-in (recommended), an Anthropic
 * key, a local-agent picker, or skip. Always uses the global config directory.
 * Shared by `jolli enable` and the bare-`jolli` guided front door.
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

	// Zero-friction default: when there is no usable credential AND local agent
	// tools are installed, generate summaries through the user's own subscription
	// (no API key, no sign-in).
	//
	// The gate is "no credential that could generate", NOT "aiProvider was never
	// written". A bare `aiProvider` with no key behind it is a STALE preference,
	// not a decision to honour — and it is routinely written by accident: VS Code's
	// Settings panel derives a provider for display when the field is unset
	// (`SettingsWebviewPanel.resolveProvider` → "anthropic" when not signed in) and
	// persists it on the next Apply, even one that only touched an unrelated field.
	// Gating on `=== undefined` let that one stray write permanently close the
	// local-agent route on a machine with four agents installed. A REAL Anthropic
	// credential still suppresses the route — that is what the two checks below do.
	// A jolliApiKey never reaches here (early return above).
	//
	// Presence detection is filesystem-only (~4 ms for all four tools); the
	// expensive capability probe (161-1772 ms each) runs for at most ONE tool,
	// never as a sweep.
	//
	// Exactly one present → auto-select it silently, as this command has always
	// done for Claude Code. Two or more → there is a real choice to make, so ask.
	const noCredential = !config.apiKey && !process.env.ANTHROPIC_API_KEY;
	const override = localAgentOverrideFrom(config);
	if (noCredential) {
		const present = listPresentLocalAgents(override);
		if (present.length === 1) {
			const only = present[0];
			if (await isLocalAgentUsable(only.id, { override })) {
				await autoSelectLocalAgent(configDir, only.id);
				return;
			}
			// Present but not runnable — fall through to the menu rather than
			// pinning a provider that cannot generate.
		} else if (present.length > 1) {
			// The user did not ASK for a local agent here — detection routed them
			// into the picker. So when every detected tool turns out to be unusable,
			// the route we chose for them is closed and the menu below (sign-in /
			// Anthropic key / skip) is still owed to them. Only "exhausted" falls
			// through: an explicit "Skip for now" is the user's own decision and has
			// already printed where to configure later.
			if ((await handleLocalAgent(configDir, present, override)) !== "exhausted") return;
			console.log("\n  No usable local agent CLI — here are the other ways to generate summaries.");
		}
	}

	// Otherwise present the provider menu. A local agent CLI is always offered —
	// even when Claude Code wasn't auto-detected, the user may have Codex, Cursor,
	// or OpenCode installed. "Skip" defers setup — hooks still install, nothing
	// generates until configured. (Manual Jolli-key entry was retired; set one
	// with `jolli configure` if needed.)
	console.log("\n  How would you like to generate summaries?\n");
	console.log("    1. Sign up / Sign in to Jolli (browser login)   [recommended]");
	console.log("    2. Enter Anthropic API key (sk-ant-...)");
	console.log("    3. Use a local agent CLI — no API key needed");
	console.log("    4. Skip for now (configure later)");

	const answer = await promptText("\n  Choice [1]: ");
	const choice = answer.trim() || "1";

	// Each choice is terminal — no fall-through to the Anthropic-key prompt (that
	// stays only on the "already have a Jolli key" path above).
	if (choice === "2") {
		await handleAnthropicKey(configDir);
	} else if (choice === "3") {
		// Outcome deliberately ignored: the user picked the local-agent route from
		// this very menu, so "exhausted" has nowhere better to fall through to —
		// re-offering the menu here would loop.
		await handleLocalAgent(configDir, undefined, override);
	} else if (choice === "4") {
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
 * Auto-selects the Local Agent provider after exactly one working tool was
 * detected: summaries are generated by driving that tool through the user's own
 * subscription, so no jollimemory-held API key is stored. Reached only when the
 * tool already passed its capability probe, so it skips the picker and states
 * the detection plainly, pointing at how to change it.
 */
async function autoSelectLocalAgent(configDir: string, tool: LocalAgentToolId): Promise<void> {
	const label = localAgentToolLabel(tool);
	await saveConfigScoped(
		{ aiProvider: "local-agent", localAgentTool: tool } as Partial<JolliMemoryConfig>,
		configDir,
	);
	console.log(`\n  ✓ Detected ${label} — using your subscription to generate summaries, no API key.`);
	console.log(`  Summaries run through your local ${label} login.`);
	console.log("  Change this anytime: 'jolli auth login', or 'jolli configure --set aiProvider=jolli'.");
	console.log(`\n  Configuration saved to ${join(configDir, "config.json")}\n`);
}

/**
 * Picks a local agent from a list and pins it as the provider. Summaries are
 * generated by driving the chosen CLI through its own subscription login, so no
 * jollimemory-held API key is stored.
 *
 * `candidates` is the detected list when any tool is present. When nothing is
 * detected we still offer all four with a note, because reaching here means the
 * user asked for a local agent explicitly and the command must not dead-end.
 * `override` is the config's tool-scoped explicit path (see
 * {@link localAgentOverrideFrom}); it reaches the probe only for the tool it
 * actually names, so choosing a *different* tool is auto-discovered rather than
 * probed at someone else's binary.
 *
 * The choice is capability-probed BEFORE it is written: this used to save any of
 * the four unprobed and defer verification to `jolli doctor`, which let a
 * known-broken configuration land in config.json.
 *
 * The prompt deliberately has NO default. This is an N-way choice the user did
 * not necessarily ask to be in (the multi-tool fast path routes them here), and
 * its outcome is a global-config write pinning a provider — so a bare Enter must
 * not decide it. It used to be coerced to `1`, which meant a single stray newline
 * (one queued in the TTY buffer while startup did its git + storage work is
 * enough) silently pinned Claude Code. Blank now takes the same rejection path as
 * `99`, bounded by {@link MAX_INVALID_CHOICES}, so the worst case is "nothing was
 * saved" rather than "a provider the user never named".
 *
 * Termination has two independent guarantees, because the loop can turn over for
 * two different reasons:
 *
 * - A tool that FAILS its probe is REMOVED from the menu, so a probing round
 *   either writes a config, returns, or strictly shrinks a finite list. Leaving
 *   the failed entry in place would offer a tool already known to be broken, and
 *   re-picking it costs another 161-1772 ms probe to learn nothing new.
 * - A BLANK / UNPARSEABLE / out-of-range answer consumes no candidate, so it is
 *   capped separately by {@link MAX_INVALID_CHOICES}; without that cap a prompt
 *   wired to keep returning garbage would spin forever.
 *
 * "Skip for now" stays available at every step. No exit path writes.
 *
 * Returns which of the three exits was taken (see {@link LocalAgentPickOutcome}),
 * because "every tool failed" is not the same answer as "the user declined" and
 * the auto-routed caller must be able to tell them apart.
 */
async function handleLocalAgent(
	configDir: string,
	candidates?: DetectedAgent[],
	override?: LocalAgentOverride,
): Promise<LocalAgentPickOutcome> {
	const detected = candidates ?? listPresentLocalAgents(override);
	const none = detected.length === 0;
	// Mutable: failed probes are spliced out (see the docstring). Copied so a
	// caller's array is never mutated under it.
	const list: DetectedAgent[] = none
		? (Object.keys(LOCAL_AGENT_TOOLS) as LocalAgentToolId[]).map((id) => ({
				id,
				label: localAgentToolLabel(id),
			}))
		: [...detected];

	const skip = (): void => {
		console.log("\n  Skipped. Configure later with 'jolli auth login' or 'jolli configure'.");
		console.log(`    ${join(configDir, "config.json")}\n`);
	};

	let invalid = 0;
	// `for(;;)`, not `while (list.length > 0)`: `list` is non-empty on entry in
	// both branches above, and the only way it empties is the splice below —
	// which returns "exhausted" on the spot. A length condition here would
	// therefore be a loop exit that cannot be taken, forcing an unreachable tail
	// after the loop that no test can cover (see the 97% cli/src floor in
	// AGENTS.md). Every exit is an explicit return inside the body; termination
	// is guaranteed by the two bounds described in the docstring.
	for (;;) {
		// Recomputed each round: the skip entry always sits directly below the
		// remaining tools, so its number moves down as failed tools are removed.
		const skipChoice = list.length + 1;
		console.log("\n  Which local agent CLI would you like to use?\n");
		if (none) console.log("    (None detected on this machine — pick one to configure anyway.)\n");
		list.forEach((a, i) => {
			console.log(`    ${i + 1}. ${a.label}`);
		});
		console.log(`    ${skipChoice}. Skip for now (configure later)`);

		// No default — see the docstring. `parseInt("")` is NaN, so a bare Enter
		// falls into the same rejection branch as any other unreadable answer.
		const answer = await promptText(`\n  Choice (1-${skipChoice}): `);
		const index = Number.parseInt(answer.trim(), 10) - 1;

		if (index === skipChoice - 1) {
			skip();
			return "skipped";
		}

		// Blank, out-of-range and non-numeric input are all REJECTED, never coerced
		// to the first entry: typing `9` — or pressing Enter — used to probe (and
		// could pin) a tool the user never named. Consumes no candidate, so it needs
		// its own bound.
		if (!Number.isInteger(index) || index < 0 || index >= list.length) {
			invalid++;
			if (invalid >= MAX_INVALID_CHOICES) {
				console.log(`\n  Couldn't read a choice after ${MAX_INVALID_CHOICES} tries.`);
				skip();
				return "skipped";
			}
			console.log(`\n  Enter a number between 1 and ${skipChoice}.`);
			continue;
		}

		const chosen = list[index];

		if (await isLocalAgentUsable(chosen.id, { override })) {
			await saveConfigScoped(
				{ aiProvider: "local-agent", localAgentTool: chosen.id } as Partial<JolliMemoryConfig>,
				configDir,
			);
			console.log(`\n  AI provider:       Local Agent (${chosen.label}) ✓`);
			console.log(`  No API key needed — summaries run through your local ${chosen.label} login.`);
			console.log(`  ${localAgentToolLoginHint(chosen.id)}`);
			console.log(`\n  Configuration saved to ${join(configDir, "config.json")}\n`);
			return "saved";
		}

		console.log(`\n  ${chosen.label} isn't usable on this machine — nothing was saved.`);
		list.splice(index, 1);
		if (list.length === 0) {
			// Wording splits on WHY the list is empty. `none` means we offered all four
			// blind, so "install one" is the right advice. Otherwise the tools were
			// detected on disk and merely failed to run — telling that user to install
			// something they already have reads as a broken diagnosis, and the real
			// fixes are an upgrade or a different provider.
			console.log(
				none
					? "  Install one, then run 'jolli enable' again.\n"
					: "  Every detected tool failed to run — upgrade one, or pick another provider.\n",
			);
			return "exhausted";
		}
	}
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
				console.log(`    - Gemini hook (${result.geminiSettingsPath})`);
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
			let cfg = await loadConfig();
			let token = await loadAuthToken();
			const hasCredential = (): boolean =>
				Boolean(
					token ||
						cfg.jolliApiKey ||
						cfg.apiKey ||
						process.env.ANTHROPIC_API_KEY ||
						cfg.aiProvider === "local-agent",
				);
			let canGenerate = await canGenerateNow(cfg);
			// Onboarding menu — EXCEPT when a provider is already configured but simply
			// broken (has a credential yet can't generate). That case skips straight to
			// the repair ladder below, so the user sees ONE menu (the fix), not two: the
			// provider menu AND then the repair menu. Fresh users still onboard;
			// configured-but-working users still get promptSetup (e.g. to add a second
			// key). Mirrors the guided front door, which likewise repairs before asking.
			if (!(hasCredential() && !canGenerate)) {
				await promptSetup();
				cfg = await loadConfig();
				token = await loadAuthToken();
				canGenerate = await canGenerateNow(cfg);
			}
			// Repair ladder (parity with the guided front door's Rung 1): a provider
			// that is configured but can't actually generate — a broken local agent
			// tool, or an anthropic/jolli key mismatch — gets a one-step fix BEFORE the
			// sync nudge, so `jolli enable` can't finish with generation silently broken.
			// Skipped for the fresh user who just chose "Skip" (no credential to repair).
			if (!canGenerate && hasCredential()) {
				await promptGenerationFix(cfg);
				cfg = await loadConfig();
				token = await loadAuthToken();
				canGenerate = await canGenerateNow(cfg);
			}
			// Sign-in nudge (parity with the guided front door's Rung 2): a user
			// who just configured local-agent / Anthropic generation but isn't
			// signed in gets offered cloud sync once. Kept INSIDE the interactive
			// guard so `-y` / non-interactive runs never open a browser login.
			const canSync = Boolean(token || cfg.jolliApiKey);
			if (canGenerate && !canSync) {
				await offerOptionalJolliLogin();
			}
		} else {
			// Non-interactive: print manual config guide
			const configDir = getGlobalConfigDir();
			console.log("\n  Configure a provider to enable summarization:");
			console.log(`    Edit: ${join(configDir, "config.json")}`);
			console.log('    - Set "apiKey" (Anthropic) and/or "jolliApiKey" (Jolli Space), or');
			console.log('    - Set "aiProvider": "local-agent" to drive a local agent CLI (no key)\n');
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

	// Onboarding-funnel snapshot: record where this install now sits (in-git →
	// enabled → has-capture → memories). Fires on BOTH success and the non-git
	// failure path (which reports in_git_repo=false), so the "installed but never
	// got into a git repo" drop-off is visible. Config is reloaded because the
	// interactive provider flow above may have just added a capture route. Fully
	// guarded — never throws.
	await maybeEmitOnboardingProgress({ cwd: options.cwd, config: await loadConfig() });
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
