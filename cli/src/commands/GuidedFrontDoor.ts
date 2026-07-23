/**
 * The guided front door — what bare `jolli` (no args, interactive TTY) runs.
 *
 * It reads two orthogonal capabilities and guides the next step:
 *   - can generate — is there a usable engine (`canGenerateNow`)? For the local
 *     agent this actually probes that `claude` is runnable, so a broken CLI is
 *     caught here rather than silently at commit time.
 *   - can sync     — is there any Jolli credential (OAuth token or jolliApiKey)
 *                    to push memories to a Space?
 *
 * Flow (order is fixed and identical across states — a run only shows the steps
 * its state still needs):
 *   git repo? → onboarding (fresh only) → repair broken provider → Sign in? →
 *   Enable? → status line → cloud side-effects → backfill → listening / Next steps
 *
 * `Sign in?` deliberately precedes `Enable?`. The opening status line moved to
 * AFTER `Enable?` so `✓ enabled` is always truthful. Non-git directories are a
 * dead end (Jolli attaches memory to commits). The exit code is coarse: non-zero
 * only on a hard blocker (not a repo, install failure); a valid decline is 0.
 */

import { basename } from "node:path";
import { getJolliUrl, loadAuthToken } from "../auth/AuthConfig.js";
import { browserLogin } from "../auth/Login.js";
import { validateJolliApiKey } from "../core/JolliApiUtils.js";
import { resolveLlmCredentialSource } from "../core/LlmClient.js";
import { isClaudeCodeUsable } from "../core/localagent/ClaudeExecutableResolver.js";
import { getGlobalConfigDir, loadConfig, saveConfigScoped } from "../core/SessionTracker.js";
import { createStorage } from "../core/StorageFactory.js";
import { getSummaryCount, setActiveStorage } from "../core/SummaryStore.js";
import { track } from "../core/Telemetry.js";
import { triggerPendingPushRetry } from "../hooks/PushCompensation.js";
import { isGitHookInstalled } from "../install/GitHookInstaller.js";
import { install } from "../install/Installer.js";
import { setLogDir } from "../Logger.js";
import type { JolliMemoryConfig } from "../Types.js";
import { runBackfillFrontDoorStep } from "./BackfillFrontDoorStep.js";
import { isAffirmative, isInsideGitWorkTree, promptText, resolveProjectDir } from "./CliUtils.js";
import { promptSetup } from "./EnableCommand.js";
import { offerOptionalJolliLogin } from "./OptionalLogin.js";
import { runSpaceSyncStep } from "./SpaceSyncStep.js";

/** Lightweight front-door status. Deliberately avoids the heavy `getStatus()`. */
export interface GuidedFrontDoorStatus {
	readonly enabled: boolean;
	readonly summaryCount: number;
}

/**
 * Reads only what the front door needs: whether the git hook is installed and
 * how many memories exist. Unlike `getStatus()`, this does not probe every AI
 * host, scan Codex / OpenCode sessions, or enumerate worktrees.
 */
export async function getGuidedFrontDoorStatus(cwd: string): Promise<GuidedFrontDoorStatus> {
	const enabled = await isGitHookInstalled(cwd);
	// Read the count straight from the active storage (set by runGuidedFrontDoor
	// before calling this). getSummaryCount returns 0 when no index exists, so
	// this covers the fresh-repo case without gating on the orphan branch —
	// gating on it would report 0 for folder-only repos that have memories but
	// no orphan branch.
	const summaryCount = await getSummaryCount(cwd);
	return { enabled, summaryCount };
}

/** Extracts the host from a saved Jolli site URL, if any, for the status line. */
function siteHost(jolliUrl: string | undefined): string | undefined {
	if (!jolliUrl) return undefined;
	try {
		return new URL(jolliUrl).host;
	} catch {
		return undefined;
	}
}

/**
 * Whether summaries can be generated with the current config. Mirrors
 * `resolveLlmCredentialSource`, EXCEPT for the local agent: that resolver returns
 * "local-agent" unconditionally (it never probes the binary), so here we
 * additionally verify `claude` is actually runnable — this is what surfaces a
 * broken local agent (R3) on the interactive path instead of at commit time.
 */
function canGenerateNow(config: JolliMemoryConfig): boolean {
	// Probe the SAME binary the commit-time runtime would use — honor an explicit
	// localAgentPath, else default PATH discovery — so this never disagrees with
	// what actually generates summaries.
	if (config.aiProvider === "local-agent") return isClaudeCodeUsable({ overridePath: config.localAgentPath });
	return resolveLlmCredentialSource(config) !== null;
}

/**
 * Runs the guided front door. Assumes the caller (Api.ts) has already confirmed
 * an interactive TTY on both stdin and stdout — this never guards for that.
 */
export async function runGuidedFrontDoor(): Promise<void> {
	const cwd = resolveProjectDir();

	// ── Repo gate: Jolli attaches memory to commits, so it must run inside a git
	// working tree. Checked BEFORE storage init so a non-repo doesn't resolve a
	// bogus Memory Bank path off the cwd. Dead end by design (no git-init offer). ──
	if (!isInsideGitWorkTree(cwd)) {
		console.log("\n  Jolli guided setup");
		console.log(`  Checking directory ${cwd} ..... not a git repository`);
		console.log("  Jolli attaches memory to your commits, so it must run inside a git repository.");
		console.log("  Change into a repo and run `jolli` again:");
		console.log("    % cd ~/code/your-repo");
		console.log("    % jolli\n");
		process.exitCode = 1;
		return;
	}

	// Repo confirmed: emit the same "Jolli guided setup" header the dead-end
	// branch prints, plus a positive confirmation line, so the framing is
	// identical whether the directory is a repo or not.
	console.log("\n  Jolli guided setup");
	console.log(`  ✓ Git repository ${cwd}`);

	// Initialise storage the way every other memory-reading command does, so
	// folder-mode users read from their Memory Bank rather than the orphan-branch
	// fallback (which also logs a resolveStorage warning).
	setActiveStorage(await createStorage(cwd, cwd));
	let token = await loadAuthToken();
	let config = await loadConfig();
	let { enabled, summaryCount } = await getGuidedFrontDoorStatus(cwd);

	// Any of these counts as "has some credential" and skips the sign-in guide.
	// `aiProvider: "local-agent"` is self-sufficient for generation — it drives the
	// local agent tool's own login, holding no jollimemory credential — so it must
	// short-circuit the onboarding guide too.
	const hasCredential = (): boolean =>
		Boolean(
			token ||
				config.jolliApiKey ||
				config.apiKey ||
				process.env.ANTHROPIC_API_KEY ||
				config.aiProvider === "local-agent",
		);

	// Snapshot NOW whether onboarding runs this run — it gates Next steps at the
	// very end, and `hasCredential()` flips to true after a sign-in mid-run, so it
	// cannot be recomputed there.
	const ranOnboarding = !hasCredential();

	// ── Auth axis: no credential at all → run the onboarding guide (Claude
	// auto-detect / provider menu). Shared with `jolli enable` via promptSetup. ──
	if (ranOnboarding) {
		await promptSetup();
		token = await loadAuthToken();
		config = await loadConfig();
	}

	// ── Two orthogonal capabilities, recomputed after each interactive step. ──
	let canGenerate = canGenerateNow(config);
	let canSync = Boolean(token || config.jolliApiKey);

	// ── Rung 1 (blocking): a credential exists but the chosen provider can't use
	// it → repair the provider mismatch. Covers R1/R2 (anthropic/jolli) and R3 (a
	// configured local agent whose `claude` isn't runnable). `hasCredential()`
	// excludes the fresh user who just skipped setup (nothing to repair). ──
	if (!canGenerate && hasCredential()) {
		await promptGenerationFix(config);
		token = await loadAuthToken();
		config = await loadConfig();
		// Recompute from the freshly-saved config, not the fix's optimistic return:
		// a switch to Jolli only actually restores generation if a jolliApiKey now
		// exists, so trust canGenerateNow.
		canGenerate = canGenerateNow(config);
		canSync = Boolean(token || config.jolliApiKey);
	}

	// ── Sign in BEFORE enable: generation works but memories can't sync → offer
	// sign-in once (default Yes; a prior global decline suppresses it). ──
	if (canGenerate && !canSync) {
		await offerOptionalJolliLogin();
		token = await loadAuthToken();
		config = await loadConfig();
		// Signing in can flip an unset provider to "jolli"; if no jolliApiKey was
		// minted, generation is no longer possible — recompute so the closing
		// "listening" promise stays honest.
		canGenerate = canGenerateNow(config);
		canSync = Boolean(token || config.jolliApiKey);
	}

	// ── Enable axis: offer to enable AFTER identity/provider are settled. ──
	if (!enabled) {
		const repoName = basename(cwd);
		const answer = await promptText(`\n  Enable Jolli Memory in ${repoName}? [Y/n] `);
		if (!isAffirmative(answer)) {
			console.log("\n  Not enabled. Run `jolli` or `jolli enable` anytime.\n");
			return; // exitCode stays 0 — a valid choice, not an error.
		}
		setLogDir(cwd);
		const result = await install(cwd, { source: "cli", clearManualDisableOnSuccess: true });
		if (!result.success) {
			console.error(`\n  Error: ${result.message}\n`);
			for (const warning of result.warnings) console.warn(`  Warning: ${warning}`);
			process.exitCode = 1;
			return;
		}
		track("surface_enabled", { trigger: "cli" });
		for (const warning of result.warnings) console.warn(`  Warning: ${warning}`);
		// Concise install confirmation (the full per-path list stays in `jolli enable`).
		console.log("\n  ✓ Git hooks added (post-commit, post-rewrite, prepare-commit-msg)");
		console.log("  ✓ Agent hooks + MCP server added");
		console.log(`  ✓ Jolli Memory enabled in ${repoName}.`);
		// Git hooks record commits immediately, but the AI-agent session hooks
		// (Claude, Gemini) only attach on a fresh session — say so once here.
		console.log("  Restart your AI agent session so it records that session too.");
		enabled = true;
		summaryCount = await getSummaryCount(cwd);
	}

	// ── Status line (AFTER enable, so `✓ enabled` is always truthful). ──
	if (token) {
		const site = siteHost(config.jolliUrl);
		const engine = canGenerate && config.aiProvider === "local-agent" ? " · summaries via Claude Code" : "";
		console.log(site ? `\n  ✓ signed in · ${site}${engine}` : `\n  ✓ signed in${engine}`);
	} else if (canGenerate && config.aiProvider === "local-agent") {
		console.log("\n  ✓ local agent set (not signed in to Jolli)");
	} else if (canGenerate) {
		// Label the key that would ACTUALLY be used (credSource), not just whichever
		// is present — a jolliApiKey alongside aiProvider="anthropic" still generates
		// via Anthropic.
		const keyLabel = resolveLlmCredentialSource(config) === "jolli-proxy" ? "Jolli API key" : "Anthropic API key";
		console.log(`\n  ✓ ${keyLabel} set (not signed in to Jolli)`);
	} else {
		console.log("\n  ✗ not signed in — run `jolli auth login` to start generating memories");
	}
	console.log(`  ✓ enabled · ${summaryCount} ${summaryCount === 1 ? "memory" : "memories"}`);

	// ── Cloud side-effects: only after credentials are settled. Bind the Space
	// first, then push the backlog — triggerPendingPushRetry no-ops when not
	// signed in. We are always enabled by here (the enable axis returned early on
	// decline). ──
	await runSpaceSyncStep(cwd);
	triggerPendingPushRetry(cwd, "cli-front-door");

	// ── Closing: only promise "listening" when generation works. ──
	if (canGenerate) {
		// Cold-start back-fill offer (unchanged). Best-effort — never throws.
		await runBackfillFrontDoorStep(cwd);
		summaryCount = await getSummaryCount(cwd);
		const listening =
			summaryCount === 0
				? "Jolli is listening — your next commit is your first memory"
				: "Jolli is listening — last memory saved.";
		console.log(`\n  ${listening}\n`);

		// Next steps only on a fresh setup (onboarding ran this run) — a returning
		// user doesn't need the orientation again, and the not-a-repo / not-enabled
		// dead ends never reach here.
		if (ranOnboarding) printNextSteps();
	}
}

/** Prints the one-time orientation shown after a successful first-run setup. */
function printNextSteps(): void {
	console.log("  Next steps");
	console.log("    1. Keep working in your agent — every commit becomes a memory, automatically.");
	console.log("    2. Reach back: jolli recall · jolli search · jolli compile · jolli graph · jolli mcp");
	console.log("    3. In your editor: add the VS Code extension or IntelliJ plugin.");
	console.log("    4. See all commands: jolli help\n");
}

/**
 * Reached only when generation is broken while a credential exists. Routes to the
 * local-agent repair (R3) when the provider is the local agent, else the
 * anthropic/jolli key-mismatch repair (R1/R2). Returns whether generation can now
 * proceed. The provider is only ever changed by an explicit choice here.
 */
async function promptGenerationFix(config: JolliMemoryConfig): Promise<boolean> {
	const configDir = getGlobalConfigDir();

	// R3: the local agent is configured but `claude` isn't runnable.
	if (config.aiProvider === "local-agent") {
		return promptLocalAgentFix(configDir, config.localAgentPath);
	}

	const provider = config.aiProvider === "jolli" ? "jolli" : "anthropic";
	const providerName = provider === "jolli" ? "Jolli" : "Anthropic";
	const hasJolliKey = Boolean(config.jolliApiKey);
	const hasAnthropicKey = Boolean(config.apiKey || process.env.ANTHROPIC_API_KEY);
	// The *other* provider already has a key → switching to it fixes generation
	// with no typing. Symmetric: covers both provider directions.
	const otherHasKey = provider === "anthropic" ? hasJolliKey : hasAnthropicKey;
	const otherProvider = provider === "anthropic" ? "jolli" : "anthropic";
	const otherName = otherProvider === "jolli" ? "Jolli" : "Anthropic";
	const enterKeyLabel = provider === "anthropic" ? "an Anthropic key" : "a Jolli key";
	const enterMissingKey = (): Promise<boolean> =>
		provider === "anthropic" ? promptAndSaveAnthropicKey(configDir) : promptAndSaveJolliKey(configDir);

	console.log(
		`\n  AI provider is set to ${providerName} but no ${providerName} key is available — memories won't be generated.\n`,
	);

	if (otherHasKey) {
		const switchHint = otherProvider === "jolli" ? "use your sign-in" : "use existing key";
		console.log(`    1. Switch to ${otherName} (${switchHint})`);
		console.log(`    2. Enter ${enterKeyLabel}`);
		console.log("    3. Skip for now");
		const choice = (await promptText("\n  Choice [1]: ")) || "1";
		if (choice === "3") {
			console.log("\n  Skipped. Set a key in settings or run `jolli configure` later.\n");
			return false;
		}
		if (choice === "1") {
			await saveConfigScoped({ aiProvider: otherProvider }, configDir);
			console.log(`\n  ✓ switched to ${otherName}`);
			return true;
		}
		return enterMissingKey();
	}

	console.log(`    1. Enter ${enterKeyLabel}`);
	console.log("    2. Skip for now");
	const choice = (await promptText("\n  Choice [1]: ")) || "1";
	if (choice === "2") {
		console.log("\n  Skipped. Set a key in settings or run `jolli configure` later.\n");
		return false;
	}
	return enterMissingKey();
}

/**
 * R3 repair: the provider is Local Agent but no usable `claude` was found.
 * Offers a retry (re-probe once), or a switch to Jolli / Anthropic, or skip.
 * Every branch terminates — no infinite retry loop. Returns whether generation
 * can now proceed.
 */
async function promptLocalAgentFix(configDir: string, localAgentPath: string | undefined): Promise<boolean> {
	console.log(
		"\n  AI provider is set to Local Agent but no usable `claude` was found — memories won't be generated.\n",
	);
	console.log("    1. Retry (after install / upgrade, or `claude login`)");
	console.log("    2. Switch to Jolli (sign in)");
	console.log("    3. Enter an Anthropic key");
	console.log("    4. Skip for now");
	const choice = (await promptText("\n  Choice [1]: ")) || "1";

	if (choice === "4") {
		console.log("\n  Skipped. Fix Claude Code or run `jolli configure` later.\n");
		return false;
	}
	if (choice === "2") {
		try {
			await browserLogin(getJolliUrl());
		} catch (err) {
			console.error(`\n  Login failed: ${err instanceof Error ? err.message : String(err)}\n`);
			return false;
		}
		// Sign-in preserves an explicit local-agent choice (AuthConfig guard), so
		// switching the engine to Jolli must be set explicitly here.
		await saveConfigScoped({ aiProvider: "jolli" }, configDir);
		console.log("\n  ✓ switched to Jolli");
		return true;
	}
	if (choice === "3") {
		return promptAndSaveAnthropicKey(configDir);
	}
	// choice 1 — retry the probe exactly once, then stop.
	if (isClaudeCodeUsable({ overridePath: localAgentPath })) {
		console.log("\n  ✓ Claude Code is working now.");
		return true;
	}
	console.log("\n  Still no usable `claude`. Fix it and run `jolli` again, or `jolli configure`.\n");
	return false;
}

/** Prompts for an Anthropic API key, saves it, and pins the provider to Anthropic. Returns whether a key was saved. */
async function promptAndSaveAnthropicKey(configDir: string): Promise<boolean> {
	const key = await promptText("\n  Anthropic API Key (press Enter to skip): ");
	if (!key) {
		console.log("  Skipped. Set a key in settings or run `jolli configure` later.\n");
		return false;
	}
	await saveConfigScoped({ apiKey: key, aiProvider: "anthropic" }, configDir);
	console.log("\n  ✓ Anthropic key saved");
	return true;
}

/** Prompts for a Jolli API key, validates + saves it, and pins the provider to Jolli. Returns whether a key was saved. */
async function promptAndSaveJolliKey(configDir: string): Promise<boolean> {
	const key = await promptText("\n  Jolli API Key (press Enter to skip): ");
	if (!key) {
		console.log("  Skipped. Set a key in settings or run `jolli configure` later.\n");
		return false;
	}
	try {
		validateJolliApiKey(key);
	} catch (err) {
		console.error(`\n  Error: ${(err as Error).message}\n`);
		return false;
	}
	await saveConfigScoped({ jolliApiKey: key, aiProvider: "jolli" }, configDir);
	console.log("\n  ✓ Jolli key saved");
	return true;
}
