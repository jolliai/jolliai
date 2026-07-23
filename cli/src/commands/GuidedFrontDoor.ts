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
import { loadAuthToken } from "../auth/AuthConfig.js";
import { resolveLlmCredentialSource } from "../core/LlmClient.js";
import { loadConfig } from "../core/SessionTracker.js";
import { createStorage } from "../core/StorageFactory.js";
import { getSummaryCount, setActiveStorage } from "../core/SummaryStore.js";
import { track } from "../core/Telemetry.js";
import { triggerPendingPushRetry } from "../hooks/PushCompensation.js";
import { isGitHookInstalled } from "../install/GitHookInstaller.js";
import { install } from "../install/Installer.js";
import { setLogDir } from "../Logger.js";
import { runBackfillFrontDoorStep } from "./BackfillFrontDoorStep.js";
import { isAffirmative, isInsideGitWorkTree, promptText, resolveProjectDir } from "./CliUtils.js";
import { promptSetup } from "./EnableCommand.js";
import { canGenerateNow, promptGenerationFix } from "./GenerationFix.js";
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

	// ── Closing: only promise "listening" when generation actually works. The
	// back-fill offer and the listening line stay gated on canGenerate so we never
	// claim to be capturing memories with no engine to build them. ──
	if (canGenerate) {
		// Cold-start back-fill offer (unchanged). Best-effort — never throws.
		await runBackfillFrontDoorStep(cwd);
		summaryCount = await getSummaryCount(cwd);
		const listening =
			summaryCount === 0
				? "Jolli is listening — your next commit is your first memory"
				: "Jolli is listening — last memory saved.";
		console.log(`\n  ${listening}`);
	}

	// Next steps orientation — printed on EVERY path that reaches here, for new
	// and returning users alike and whether or not generation is configured
	// (unlike the listening line above, it makes no promise that could be false).
	// The ONLY states that never show Next steps are the three early-return dead
	// ends earlier in this function, none of which reach this line:
	//   1. not a git repository        → returned early with exitCode 1
	//   2. enable declined at the [Y/n] prompt → returned early (a valid choice)
	//   3. install failure             → returned early with exitCode 1
	printNextSteps();
}

/** Prints the closing orientation shown on every non-dead-end front-door run. */
function printNextSteps(): void {
	console.log("\n  Next steps");
	console.log("    1. Keep working in your agent — every commit becomes a memory, automatically.");
	console.log("    2. Reach back: jolli recall · jolli search · jolli compile · jolli graph · jolli mcp");
	console.log("    3. In your editor: add the VS Code extension or IntelliJ plugin.");
	console.log("    4. See all commands: jolli help\n");
}
