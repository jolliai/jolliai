/**
 * The guided front door — what bare `jolli` (no args, interactive TTY) runs.
 *
 * It reads two orthogonal capabilities and guides the next step:
 *   - can generate — is there a usable LLM key (`resolveLlmCredentialSource`)?
 *   - can sync     — is there any Jolli credential (OAuth token or jolliApiKey)
 *                    to push memories to a Space?
 * `signedIn` (an OAuth token) is display-only — it decides the status-line
 * wording, never the control flow.
 *
 * Flow: opening status line → capability ladder (fix generation if broken, then
 * offer sign-in if memories can't sync) → cloud side-effects with the settled
 * credentials → a closing "Jolli is listening" when generation works. It
 * replaces running `auth login`, `auth status`, `enable`, and `status` by hand
 * without removing those commands. Everything about the cloud side (pushing to a
 * Space, binding, sync prompts) is delegated to `runSpaceSyncStep`.
 */

import { getJolliUrl, loadAuthToken } from "../auth/AuthConfig.js";
import { browserLogin } from "../auth/Login.js";
import { validateJolliApiKey } from "../core/JolliApiUtils.js";
import { resolveLlmCredentialSource } from "../core/LlmClient.js";
import { writeManualDisableFlag } from "../core/RepoProfile.js";
import { getGlobalConfigDir, loadConfig, saveConfigScoped } from "../core/SessionTracker.js";
import { createStorage } from "../core/StorageFactory.js";
import { getSummaryCount, setActiveStorage } from "../core/SummaryStore.js";
import { track } from "../core/Telemetry.js";
import { loadUserProfile, saveUserProfile } from "../core/UserProfile.js";
import { triggerPendingPushRetry } from "../hooks/PushCompensation.js";
import { isGitHookInstalled } from "../install/GitHookInstaller.js";
import { install } from "../install/Installer.js";
import { createLogger, setLogDir } from "../Logger.js";
import type { JolliMemoryConfig } from "../Types.js";
import { runBackfillFrontDoorStep } from "./BackfillFrontDoorStep.js";
import { isAffirmative, promptText, resolveProjectDir } from "./CliUtils.js";
import { promptSetup } from "./EnableCommand.js";
import { runSpaceSyncStep } from "./SpaceSyncStep.js";

const log = createLogger("GuidedFrontDoor");

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
	// `aiProvider: "local-agent"` is self-sufficient for generation — it drives the
	// local agent tool's own login, holding no jollimemory credential — so it must
	// short-circuit the sign-in guide too, matching resolveLlmCredentialSource
	// (which always honors a "local-agent" choice without a presence check).
	const hasCredential = (): boolean =>
		Boolean(
			token ||
				config.jolliApiKey ||
				config.apiKey ||
				process.env.ANTHROPIC_API_KEY ||
				config.aiProvider === "local-agent",
		);

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
		// Enabling here is an explicit user choice — clear any repo-wide
		// manual-disable opt-out so a later upgrade / VS Code activation keeps it on
		// (the front door is never integrations-only). Mirrors `jolli enable`.
		await writeManualDisableFlag(cwd, false);
		for (const warning of result.warnings) console.warn(`  Warning: ${warning}`);
		// Git hooks record commits immediately, but the AI-agent session hooks
		// (Claude, Gemini) only attach on a fresh session — say so once here.
		console.log("\n  Restart your AI agent session so it records that session too.");
		enabled = true;
		// enabled is now known true, so only the count can have changed — read it
		// directly instead of re-running the whole lightweight status.
		summaryCount = await getSummaryCount(cwd);
	}

	// ── Two orthogonal capabilities. `signedIn` (a token) is display-only. ──
	const credSource = resolveLlmCredentialSource(config);
	let canGenerate = credSource !== null;
	let canSync = Boolean(token || config.jolliApiKey);

	// ── Status line (opening snapshot; the token picks the wording only) ──
	if (token) {
		const site = siteHost(config.jolliUrl);
		console.log(site ? `\n  ✓ signed in · ${site}` : "\n  ✓ signed in");
	} else if (credSource === "local-agent") {
		console.log("\n  ✓ local agent set (not signed in to Jolli)");
	} else if (credSource) {
		const keyLabel = credSource === "jolli-proxy" ? "Jolli API key" : "Anthropic API key";
		console.log(`\n  ✓ ${keyLabel} set (not signed in to Jolli)`);
	} else {
		console.log("\n  ✗ not signed in — run `jolli auth login` to start generating memories");
	}
	console.log(`  ✓ enabled · ${summaryCount} ${summaryCount === 1 ? "memory" : "memories"}`);

	// ── Rung 1 (blocking): a credential exists but the chosen provider can't use
	// it → repair the provider/key mismatch. `hasCredential()` excludes the fresh
	// user who just skipped setup (nothing to repair — don't re-ask). ──
	if (!canGenerate && hasCredential()) {
		canGenerate = await promptGenerationFix(config);
		// A key entered / provider switched above may now allow sync too.
		config = await loadConfig();
		canSync = Boolean(token || config.jolliApiKey);
	}

	// ── Rung 2 (non-blocking): generation works, but memories can't leave the
	// machine → offer sign-in once, defaulting to Yes. A prior decline (persisted
	// in profile.json) suppresses it. Read the profile lazily — only here. ──
	if (canGenerate && !canSync) {
		const profile = await loadUserProfile();
		if (!profile.signInPromptDeclined) {
			await promptOptionalLogin();
			token = await loadAuthToken();
			config = await loadConfig();
			canSync = Boolean(token || config.jolliApiKey);
		}
	}
	// ── Cloud side-effects: only after credentials are settled, so a sign-in or
	// key established above is picked up this run. We are always enabled by here
	// (the enable axis above either enabled the repo or returned early). Bind the
	// Space first (runSpaceSyncStep), then push the backlog to it —
	// triggerPendingPushRetry is idempotent and no-ops when not signed in. ──
	await runSpaceSyncStep(cwd);
	triggerPendingPushRetry(cwd, "cli-front-door");

	// ── Closing confirmation: only promise "listening" when generation works. ──
	if (canGenerate) {
		// Cold-start back-fill offer. Runs after the capability ladder + cloud
		// side-effects (so it benefits from any key/sign-in just established) and
		// re-reads the count so the "listening" line reflects memories just built.
		// Best-effort — the step never throws into the front door. See BackfillFrontDoorStep.
		await runBackfillFrontDoorStep(cwd);
		summaryCount = await getSummaryCount(cwd);
		const listening =
			summaryCount === 0
				? "Jolli is listening — your next commit is your first memory"
				: "Jolli is listening — last memory saved.";
		console.log(`\n  ${listening}\n`);
	}
}

/**
 * Reached only when generation is broken while a credential exists: the chosen
 * `aiProvider` has no usable key. Offer the zero-typing fix first — switch to
 * whichever provider a key already exists for — then entering the missing key,
 * then skip. The provider is only ever changed by an explicit choice here.
 * Returns whether generation can now proceed (a key was set / provider switched).
 */
async function promptGenerationFix(config: JolliMemoryConfig): Promise<boolean> {
	const configDir = getGlobalConfigDir();
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

/**
 * Generation works locally, but there's no Jolli credential to sync memories to
 * a Space. Offer to sign in — default Yes, asked once. On an explicit "no" we
 * persist the decline (profile.json) so this never reappears; a login failure is
 * NOT a decline, so it stays unrecorded and the next run can offer again.
 */
async function promptOptionalLogin(): Promise<void> {
	const answer = await promptText("\n  Not signed in to Jolli. Sign in now to sync memories to a Space? [Y/n] ");
	if (!isAffirmative(answer)) {
		// Persisting the decline is best-effort: a cosmetic "don't ask again" flag
		// must never abort the front door if the profile dir isn't writable — we
		// just offer again next run.
		try {
			await saveUserProfile({ signInPromptDeclined: true });
		} catch {
			log.debug("Could not persist the sign-in decline; will offer again next run");
		}
		console.log("  You can sign in anytime with `jolli auth login`.\n");
		return;
	}
	try {
		await browserLogin(getJolliUrl());
		console.log("\n  ✓ signed in — memories will sync to your Space.\n");
	} catch (err) {
		console.error(`\n  Login failed: ${err instanceof Error ? err.message : String(err)}`);
		console.log("  You can try again with `jolli auth login`.\n");
	}
}
