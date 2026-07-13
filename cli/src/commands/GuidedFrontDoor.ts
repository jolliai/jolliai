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
import { resolveLlmCredentialSource } from "../core/LlmClient.js";
import { getGlobalConfigDir, loadConfig, saveConfigScoped } from "../core/SessionTracker.js";
import { createStorage } from "../core/StorageFactory.js";
import { getSummaryCount, setActiveStorage } from "../core/SummaryStore.js";
import { track } from "../core/Telemetry.js";
import { triggerPendingPushRetry } from "../hooks/PushCompensation.js";
import { isGitHookInstalled } from "../install/GitHookInstaller.js";
import { install } from "../install/Installer.js";
import { setLogDir } from "../Logger.js";
import type { JolliMemoryConfig } from "../Types.js";
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
		// enabled is now known true, so only the count can have changed — read it
		// directly instead of re-running the whole lightweight status.
		summaryCount = await getSummaryCount(cwd);
	}

	// ── Status line: reflect the real credential state, never a blanket sign-in ──
	// `credSource` uses the authoritative resolver (honours the chosen aiProvider),
	// so it can name the actual key in play and also gates "listening" below. A
	// bare OAuth token alone is not an LLM credential, hence null → "not signed in".
	const credSource = resolveLlmCredentialSource(config);
	if (token) {
		const site = siteHost(config.jolliUrl);
		console.log(site ? `\n  ✓ signed in · ${site}` : "\n  ✓ signed in");
	} else if (credSource) {
		const keyLabel = credSource === "jolli-proxy" ? "Jolli API key" : "Anthropic API key";
		console.log(`\n  ✓ ${keyLabel} set (not signed in to Jolli)`);
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
	let generatable = credSource !== null;
	if (!generatable && token) {
		// Signed in, but the chosen provider has no usable key. Offer an in-place
		// fix; it returns whether we can generate now (a key was set / provider switched).
		generatable = await promptGenerationFix(config);
		// NOTE: promptGenerationFix may have persisted config changes (via
		// saveConfigScoped); the in-memory `config` / `credSource` are now stale.
		// Nothing below re-reads them — re-read config if you add logic that does.
	}
	if (generatable) {
		const listening =
			summaryCount === 0
				? "Jolli is listening — your next commit is your first memory"
				: "Jolli is listening — last memory saved.";
		// Generating locally via an Anthropic key but with no Jolli credential at
		// all — nudge (never force) sign-in so memories can sync to a Space.
		const nudge =
			!token && !config.jolliApiKey
				? "\n  Not signed in to Jolli — run `jolli auth login` to sync memories to a Space."
				: "";
		console.log(`\n  ${listening}${nudge}\n`);
	}
}

/**
 * Signed in, but the active provider has no usable key. Offer to fix it in place:
 * enter an Anthropic key, or — when the user already has a Jolli sign-in key —
 * switch to the Jolli provider. The provider is only ever changed by an explicit
 * choice here, never silently. Each choice writes `aiProvider` so the saved
 * credential and the chosen provider can't drift out of sync.
 */
async function promptGenerationFix(config: JolliMemoryConfig): Promise<boolean> {
	const configDir = getGlobalConfigDir();
	// Reaching here means canGenerate() was false. If a jolliApiKey exists the
	// provider cannot be "jolli" (that would already generate), so offering to
	// switch to Jolli is always safe when a jolliApiKey is present.
	const canUseJolli = Boolean(config.jolliApiKey);

	console.log("\n  Signed in, but the current AI provider has no usable key — memories won't be generated.\n");
	if (canUseJolli) {
		console.log("    1. Enter an Anthropic API key          (keeps Anthropic)");
		console.log("    2. Switch to Jolli (use your sign-in)");
		console.log("    3. Skip for now");
		const choice = (await promptText("\n  Choice [1]: ")) || "1";
		if (choice === "3") {
			console.log("\n  Skipped. Set a key in settings or run `jolli configure` later.\n");
			return false;
		}
		if (choice === "2") {
			await saveConfigScoped({ aiProvider: "jolli" }, configDir);
			console.log("\n  ✓ switched to Jolli");
			return true;
		}
		return promptAndSaveAnthropicKey(configDir);
	}

	console.log("    1. Enter an Anthropic API key");
	console.log("    2. Skip for now");
	const choice = (await promptText("\n  Choice [1]: ")) || "1";
	if (choice === "2") {
		console.log("\n  Skipped. Set a key in settings or run `jolli configure` later.\n");
		return false;
	}
	return promptAndSaveAnthropicKey(configDir);
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
