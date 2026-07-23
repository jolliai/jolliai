/**
 * The provider/engine "repair ladder" plus the `canGenerateNow` predicate,
 * shared by the guided front door (bare `jolli`) and `jolli enable`. When a
 * credential or provider is configured but generation is still broken, this
 * offers a one-step fix; both entry points run ONE implementation so their
 * wording and behavior can't drift.
 *
 * Extracted to a neutral module (mirrors `OptionalLogin`) so neither command has
 * to import the other — `GuidedFrontDoor` already imports `promptSetup` from
 * `EnableCommand`, so routing the ladder through either would form an import
 * cycle. This module depends only on `auth/*`, the core config + api-key
 * helpers, the LLM credential resolver, and the local-agent probe — none of
 * which import the command modules back.
 */

import { getJolliUrl } from "../auth/AuthConfig.js";
import { browserLogin } from "../auth/Login.js";
import { validateJolliApiKey } from "../core/JolliApiUtils.js";
import { resolveLlmCredentialSource } from "../core/LlmClient.js";
import { isClaudeCodeUsable } from "../core/localagent/ClaudeExecutableResolver.js";
import { getGlobalConfigDir, saveConfigScoped } from "../core/SessionTracker.js";
import type { JolliMemoryConfig } from "../Types.js";
import { promptText } from "./CliUtils.js";

/**
 * True when the current config can actually generate summaries right now. For
 * the local agent this PROBES the same `claude` binary the commit-time runtime
 * would use (honoring an explicit `localAgentPath`) so it never disagrees with
 * what actually generates; for every other provider it defers to
 * {@link resolveLlmCredentialSource}. Shared verbatim by both the guided front
 * door and `jolli enable` so the two paths agree on "can generate?".
 */
export function canGenerateNow(config: JolliMemoryConfig): boolean {
	if (config.aiProvider === "local-agent") return isClaudeCodeUsable({ overridePath: config.localAgentPath });
	return resolveLlmCredentialSource(config) !== null;
}

/**
 * Reached only when generation is broken while a credential exists. Routes to the
 * local-agent repair (R3) when the provider is the local agent, else the
 * anthropic/jolli key-mismatch repair (R1/R2). Returns whether generation can now
 * proceed. The provider is only ever changed by an explicit choice here.
 */
export async function promptGenerationFix(config: JolliMemoryConfig): Promise<boolean> {
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
