/**
 * GeminiHookInstaller — Install/remove/detect Gemini CLI AfterAgent hooks
 * in `.gemini/settings.json`.
 *
 * Extracted from Installer.ts for single-responsibility.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import type { HookOpResult } from "./HookSettingsHelper.js";
import {
	buildHookCommand,
	GEMINI_HOOK_IDENTIFIERS,
	hasHookWithCommand,
	hasHookWithIdentifier,
	removeHooksWithIdentifier,
} from "./HookSettingsHelper.js";

const log = createLogger("GeminiHookInstaller");

/**
 * Installs the Gemini CLI AfterAgent hook in .gemini/settings.json at the project root.
 * Uses the same matcher group format as Claude Code hooks.
 */
export async function installGeminiHook(projectDir: string): Promise<HookOpResult> {
	const settingsDir = join(projectDir, ".gemini");
	const settingsPath = join(settingsDir, "settings.json");

	// Build hook command using dist-path indirection (resolved at runtime via shell)
	const hookCommand = buildHookCommand("gemini-after-agent");

	// Read existing settings or create new
	let settings: Record<string, unknown> = {};
	try {
		const content = await readFile(settingsPath, "utf-8");
		settings = JSON.parse(content) as Record<string, unknown>;
	} catch {
		// No existing settings — create new
	}

	// Get or create hooks section
	const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
	const afterAgentGroups = (hooks.AfterAgent ?? []) as Array<Record<string, unknown>>;

	// Check if our hook already exists with the correct command path
	if (hasHookWithCommand(afterAgentGroups, hookCommand)) {
		return { path: settingsPath };
	}

	// Remove any existing Jolli Memory hooks (may have outdated paths)
	const cleaned = removeHooksWithIdentifier(afterAgentGroups, GEMINI_HOOK_IDENTIFIERS);

	// Add our hook
	cleaned.push({
		hooks: [
			{
				type: "command",
				command: hookCommand,
				name: "jolli-session-tracker",
			},
		],
	});

	hooks.AfterAgent = cleaned;
	settings.hooks = hooks;

	// Write settings
	await mkdir(settingsDir, { recursive: true });
	await writeFile(settingsPath, JSON.stringify(settings, null, "\t"), "utf-8");
	log.info("Gemini AfterAgent hook installed");
	return { path: settingsPath };
}

/**
 * Checks whether the Jolli Memory AfterAgent hook is installed in .gemini/settings.json.
 */
export async function isGeminiHookInstalled(projectDir: string): Promise<boolean> {
	const settingsPath = join(projectDir, ".gemini", "settings.json");
	try {
		const content = await readFile(settingsPath, "utf-8");
		const settings = JSON.parse(content) as Record<string, unknown>;
		const hooks = settings.hooks as Record<string, unknown> | undefined;
		if (!hooks) return false;
		const afterAgentGroups = (hooks.AfterAgent ?? []) as Array<Record<string, unknown>>;
		return hasHookWithIdentifier(afterAgentGroups, GEMINI_HOOK_IDENTIFIERS);
	} catch {
		return false;
	}
}

/**
 * Removes the Jolli Memory AfterAgent hook from .gemini/settings.json.
 */
export async function removeGeminiHook(projectDir: string): Promise<void> {
	const settingsPath = join(projectDir, ".gemini", "settings.json");

	let settings: Record<string, unknown>;
	try {
		const content = await readFile(settingsPath, "utf-8");
		settings = JSON.parse(content) as Record<string, unknown>;
	} catch {
		return; // No settings file — nothing to clean
	}

	const hooks = settings.hooks as Record<string, unknown> | undefined;
	if (!hooks) return;

	const afterAgentGroups = (hooks.AfterAgent ?? []) as Array<Record<string, unknown>>;
	if (!hasHookWithIdentifier(afterAgentGroups, GEMINI_HOOK_IDENTIFIERS)) return;

	const filtered = removeHooksWithIdentifier(afterAgentGroups, GEMINI_HOOK_IDENTIFIERS);

	if (filtered.length === 0) {
		delete hooks.AfterAgent;
	} else {
		hooks.AfterAgent = filtered;
	}

	if (Object.keys(hooks).length === 0) {
		delete settings.hooks;
	} else {
		settings.hooks = hooks;
	}

	await writeFile(settingsPath, JSON.stringify(settings, null, "\t"), "utf-8");
	log.info("Gemini AfterAgent hook removed");
}
