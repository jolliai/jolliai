/**
 * The guided front door — what bare `jolli` (no args, interactive TTY) runs.
 *
 * It reads two axes of state — auth (global sign-in / credentials) and enable
 * (per-repo hooks) — and offers the next step: sign in, enable the repo, then
 * confirm "Jolli is listening". It replaces having to run `auth login`, `auth
 * status`, `enable`, and `status` by hand, without removing those commands.
 *
 * Everything about the cloud side (pushing memories to a Jolli Space, binding,
 * sync prompts) is delegated to `runSpaceSyncStep` — the front door only calls
 * it once the repo is enabled and prints nothing about push/sync itself.
 */

import { loadAuthToken } from "../auth/AuthConfig.js";
import { orphanBranchExists } from "../core/GitOps.js";
import { resolveLlmCredentialSource } from "../core/LlmClient.js";
import { loadConfig } from "../core/SessionTracker.js";
import { createStorage } from "../core/StorageFactory.js";
import { getSummaryCount, setActiveStorage } from "../core/SummaryStore.js";
import { track } from "../core/Telemetry.js";
import { triggerPendingPushRetry } from "../hooks/PushCompensation.js";
import { isGitHookInstalled } from "../install/GitHookInstaller.js";
import { install } from "../install/Installer.js";
import { ORPHAN_BRANCH, setLogDir } from "../Logger.js";
import { isAffirmative, promptText, resolveProjectDir } from "./CliUtils.js";
import { promptSetup } from "./EnableCommand.js";
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
	const summaryCount = (await orphanBranchExists(ORPHAN_BRANCH, cwd)) ? await getSummaryCount(cwd) : 0;
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
	// Initialise storage the way every other memory-reading command does, so
	// folder-mode users read from their Memory Bank rather than the orphan-branch
	// fallback (which also logs a resolveStorage warning).
	setActiveStorage(await createStorage(cwd, cwd));
	let token = await loadAuthToken();
	let config = await loadConfig();
	let { enabled, summaryCount } = await getGuidedFrontDoorStatus(cwd);

	// Any of these counts as "has some credential" and skips the sign-in guide.
	const hasCredential = (): boolean =>
		Boolean(token || config.jolliApiKey || config.apiKey || process.env.ANTHROPIC_API_KEY);
	// Whether summaries can actually be generated. Uses the authoritative resolver
	// so it honours the chosen aiProvider — e.g. provider "anthropic" with only a
	// jolliApiKey (and no Anthropic key) cannot generate. "Jolli is listening" is
	// a capability promise, so it is gated on this, not on being signed in.
	const canGenerate = (): boolean => resolveLlmCredentialSource(config) !== null;

	// ── Auth axis: no credential at all → run the existing sign-in / config guide ──
	if (!hasCredential()) {
		await promptSetup();
		token = await loadAuthToken();
		config = await loadConfig();
	}

	// ── Enable axis: not enabled → offer to enable ──
	if (!enabled) {
		const answer = await promptText("\n  Enable Jolli in this repo? [Y/n] ");
		if (!isAffirmative(answer)) {
			console.log("\n  Not enabled. Run `jolli` or `jolli enable` anytime.\n");
			return;
		}
		setLogDir(cwd);
		const result = await install(cwd, { source: "cli" });
		if (!result.success) {
			console.error(`\n  Error: ${result.message}\n`);
			for (const warning of result.warnings) console.warn(`  Warning: ${warning}`);
			process.exitCode = 1;
			return;
		}
		track("surface_enabled", { trigger: "cli" });
		for (const warning of result.warnings) console.warn(`  Warning: ${warning}`);
		// Git hooks record commits immediately, but the AI-agent session hooks
		// (Claude, Gemini) only attach on a fresh session — say so once here.
		console.log("\n  Restart your AI agent session so it records that session too.");
		enabled = true;
		summaryCount = (await getGuidedFrontDoorStatus(cwd)).summaryCount;
	}

	// ── Status line: reflect the real credential state, never a blanket sign-in ──
	if (token) {
		const site = siteHost(config.jolliUrl);
		console.log(site ? `\n  ✓ signed in · ${site}` : "\n  ✓ signed in");
	} else if (canGenerate()) {
		console.log("\n  ✓ configured (not signed in via OAuth)");
	} else {
		console.log("\n  ✗ not signed in — run `jolli auth login` to start generating memories");
	}
	console.log(`  ✓ enabled · ${summaryCount} ${summaryCount === 1 ? "memory" : "memories"}`);

	// ── Cloud sync + push catch-up: whenever enabled. triggerPendingPushRetry is
	// idempotent and no-ops when not signed in, so a returning user who just
	// signed in still gets their backlog pushed (matches `jolli enable`). ──
	if (enabled) {
		void triggerPendingPushRetry(cwd);
		await runSpaceSyncStep(cwd);
	}

	// ── Confirmation: only promise "listening" when memories can be generated ──
	if (canGenerate()) {
		console.log(
			summaryCount === 0
				? "\n  Jolli is listening — your next commit is your first memory\n"
				: "\n  Jolli is listening — last memory saved.\n",
		);
	} else if (token) {
		// Signed in, but the chosen provider has no usable key (e.g. provider is
		// Anthropic but its key is unset). Be honest and point at the fix — don't
		// suggest `auth login`, which only helps the Jolli provider.
		console.log(
			"\n  Signed in, but the current AI provider has no usable key — memories won't be generated.\n  Set one in Jolli Memory settings or run `jolli configure`.\n",
		);
	}
}
