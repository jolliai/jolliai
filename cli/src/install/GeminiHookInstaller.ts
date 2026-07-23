/**
 * GeminiHookInstaller — Install/remove/detect Gemini CLI AfterAgent hooks
 * in `.gemini/settings.json`.
 *
 * Extracted from Installer.ts for single-responsibility.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../core/AtomicWrite.js";
import { createLogger } from "../Logger.js";
import type { HookOpResult } from "./HookSettingsHelper.js";
import {
	buildHookCommand,
	GEMINI_HOOK_IDENTIFIERS,
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
	let existingContent: string | undefined;
	try {
		existingContent = await readFile(settingsPath, "utf-8");
		settings = JSON.parse(existingContent) as Record<string, unknown>;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	// Get or create hooks section
	const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
	const afterAgentGroups = (hooks.AfterAgent ?? []) as Array<Record<string, unknown>>;

	// Remove every existing owner (including old Kotlin and duplicate canonical
	// entries), then append exactly one source-neutral hook.
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
	const nextContent = JSON.stringify(settings, null, "\t");
	if (existingContent === nextContent) return { path: settingsPath };
	await mkdir(settingsDir, { recursive: true });
	await atomicWriteFile(settingsPath, nextContent);
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
		const owned = afterAgentGroups.filter((group) =>
			(group.hooks as Array<Record<string, unknown>> | undefined)?.some(
				(hook) =>
					typeof hook.command === "string" &&
					GEMINI_HOOK_IDENTIFIERS.some((identifier) => (hook.command as string).includes(identifier)),
			),
		);
		if (owned.length !== 1) return false;
		const hookDefs = owned[0].hooks as Array<Record<string, unknown>> | undefined;
		return (
			hookDefs?.length === 1 &&
			hookDefs[0].type === "command" &&
			hookDefs[0].command === buildHookCommand("gemini-after-agent") &&
			hookDefs[0].name === "jolli-session-tracker"
		);
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

	await atomicWriteFile(settingsPath, JSON.stringify(settings, null, "\t"));
	log.info("Gemini AfterAgent hook removed");
}
