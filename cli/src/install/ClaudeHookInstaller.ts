/**
 * ClaudeHookInstaller — Install/remove/detect Claude Code hooks in
 * `.claude/settings.local.json`.
 *
 * Also handles the SessionStart hook and legacy cleanup from
 * `.claude/settings.json` (previous versions wrote there).
 *
 * Extracted from Installer.ts for single-responsibility.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import type { HookOpResult } from "./HookSettingsHelper.js";
import {
	buildHookCommand,
	hasHookWithIdentifier,
	hasJolliMemoryHook,
	hasJolliMemoryHookWithCommand,
	removeHooksWithIdentifier,
	removeJolliMemoryHook,
	SESSION_START_HOOK_IDENTIFIERS,
} from "./HookSettingsHelper.js";

const log = createLogger("ClaudeHookInstaller");

/**
 * Installs the Claude Code Stop hook in .claude/settings.local.json.
 *
 * Also cleans up any legacy Jolli Memory hooks from .claude/settings.json
 * (from previous versions that wrote to the shared file).
 */
export async function installClaudeHook(projectDir: string): Promise<HookOpResult> {
	const settingsDir = join(projectDir, ".claude");
	const localSettingsPath = join(settingsDir, "settings.local.json");

	// Build hook command using dist-path indirection (resolved at runtime via shell)
	const hookCommand = buildHookCommand("stop");

	// Clean up legacy hooks from settings.json (previous versions wrote there)
	await cleanLegacyClaudeHook(projectDir);

	// Read existing local settings or create new
	let settings: Record<string, unknown> = {};
	try {
		const content = await readFile(localSettingsPath, "utf-8");
		settings = JSON.parse(content) as Record<string, unknown>;
	} catch {
		// No existing settings — create new
	}

	// Get or create hooks section
	const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
	const stopMatcherGroups = (hooks.Stop ?? []) as Array<Record<string, unknown>>;

	// Check if our hook already exists with the correct command path
	if (hasJolliMemoryHookWithCommand(stopMatcherGroups, hookCommand)) {
		return { path: localSettingsPath };
	}

	// Remove any existing Jolli Memory hooks (may have outdated paths)
	const cleaned = removeJolliMemoryHook(stopMatcherGroups);

	// Add our hook using the new matcher group format:
	// { hooks: [{ type, command, async }] }
	cleaned.push({
		hooks: [
			{
				type: "command",
				command: hookCommand,
				async: true,
			},
		],
	});

	hooks.Stop = cleaned;
	settings.hooks = hooks;

	// Write local settings
	await mkdir(settingsDir, { recursive: true });
	await writeFile(localSettingsPath, JSON.stringify(settings, null, "\t"), "utf-8");
	return { path: localSettingsPath };
}

/**
 * Installs the SessionStart hook in .claude/settings.local.json.
 * Outputs a mini-briefing when a new Claude Code session starts.
 */
export async function installSessionStartHook(projectDir: string): Promise<void> {
	const settingsDir = join(projectDir, ".claude");
	const localSettingsPath = join(settingsDir, "settings.local.json");

	// Build hook command using dist-path indirection (resolved at runtime via shell)
	const hookCommand = buildHookCommand("session-start");

	// Read existing local settings (installClaudeHook runs before this, so the file
	// should exist with the Stop hook already installed). If the file doesn't exist
	// yet, start with empty settings. If it exists but can't be read/parsed, propagate
	// the error to avoid silently overwriting the Stop hook with an empty object.
	let settings: Record<string, unknown> = {};
	try {
		const content = await readFile(localSettingsPath, "utf-8");
		settings = JSON.parse(content) as Record<string, unknown>;
	} catch (error: unknown) {
		// ENOENT = file doesn't exist yet — safe to start fresh
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}

	const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
	const sessionStartGroups = (hooks.SessionStart ?? []) as Array<Record<string, unknown>>;

	// Check if our hook already exists with the correct command path
	if (hasJolliMemoryHookWithCommand(sessionStartGroups, hookCommand)) {
		return;
	}

	// Remove any existing Jolli Memory SessionStart hooks (outdated paths)
	const cleaned = removeHooksWithIdentifier(sessionStartGroups, SESSION_START_HOOK_IDENTIFIERS);

	cleaned.push({
		hooks: [
			{
				type: "command",
				command: hookCommand,
			},
		],
	});

	hooks.SessionStart = cleaned;
	settings.hooks = hooks;

	try {
		await mkdir(settingsDir, { recursive: true });
		await writeFile(localSettingsPath, JSON.stringify(settings, null, "\t"), "utf-8");
	} catch (error: unknown) {
		log.warn("Failed to install SessionStart hook: %s", (error as Error).message);
	}
}

/**
 * Removes any Jolli Memory hooks from .claude/settings.json (legacy location).
 * Previous versions wrote hooks there; we now use settings.local.json.
 */
async function cleanLegacyClaudeHook(projectDir: string): Promise<void> {
	const settingsPath = join(projectDir, ".claude", "settings.json");

	let settings: Record<string, unknown>;
	try {
		const content = await readFile(settingsPath, "utf-8");
		settings = JSON.parse(content) as Record<string, unknown>;
	} catch {
		return; // No settings.json — nothing to clean
	}

	const hooks = settings.hooks as Record<string, unknown> | undefined;
	if (!hooks) return;

	const stopMatcherGroups = (hooks.Stop ?? []) as Array<Record<string, unknown>>;
	if (!hasJolliMemoryHook(stopMatcherGroups)) return;

	const filtered = removeJolliMemoryHook(stopMatcherGroups);

	if (filtered.length === 0) {
		delete hooks.Stop;
	} else {
		hooks.Stop = filtered;
	}

	if (Object.keys(hooks).length === 0) {
		delete settings.hooks;
	} else {
		settings.hooks = hooks;
	}

	await writeFile(settingsPath, JSON.stringify(settings, null, "\t"), "utf-8");
}

/**
 * Removes the Jolli Memory hook from .claude/settings.local.json.
 * Also cleans up any legacy hooks from .claude/settings.json.
 */
export async function removeClaudeHook(projectDir: string): Promise<HookOpResult> {
	// Clean up legacy hooks from settings.json
	await cleanLegacyClaudeHook(projectDir);

	// Remove from settings.local.json
	const localSettingsPath = join(projectDir, ".claude", "settings.local.json");

	let settings: Record<string, unknown>;
	try {
		const content = await readFile(localSettingsPath, "utf-8");
		settings = JSON.parse(content) as Record<string, unknown>;
	} catch {
		return {};
	}

	const hooks = settings.hooks as Record<string, unknown> | undefined;
	/* v8 ignore start -- defensive: settings without hooks property */
	if (!hooks) {
		return {};
	}
	/* v8 ignore stop */

	// Remove Stop hook
	const stopMatcherGroups = (hooks.Stop ?? []) as Array<Record<string, unknown>>;
	const hasStop = hasJolliMemoryHook(stopMatcherGroups);

	if (hasStop) {
		const filtered = removeJolliMemoryHook(stopMatcherGroups);
		if (filtered.length === 0) {
			delete hooks.Stop;
		} else {
			hooks.Stop = filtered;
		}
	}

	// Remove SessionStart hook
	const sessionStartGroups = (hooks.SessionStart ?? []) as Array<Record<string, unknown>>;
	const hasSessionStart = hasHookWithIdentifier(sessionStartGroups, SESSION_START_HOOK_IDENTIFIERS);

	if (hasSessionStart) {
		const filteredSS = removeHooksWithIdentifier(sessionStartGroups, SESSION_START_HOOK_IDENTIFIERS);
		if (filteredSS.length === 0) {
			delete hooks.SessionStart;
		} else {
			hooks.SessionStart = filteredSS;
		}
	}

	/* v8 ignore start -- defensive: settings have hooks but none from Jolli Memory */
	if (!hasStop && !hasSessionStart) {
		return {};
	}
	/* v8 ignore stop */

	// Clean up empty hooks object
	if (Object.keys(hooks).length === 0) {
		delete settings.hooks;
	} else {
		settings.hooks = hooks;
	}

	await writeFile(localSettingsPath, JSON.stringify(settings, null, "\t"), "utf-8");
	return {};
}

/**
 * Checks if the Claude Code hook is installed.
 * Checks settings.local.json (current) and falls back to settings.json (legacy).
 */
export async function isClaudeHookInstalled(projectDir: string): Promise<boolean> {
	// Check settings.local.json first (current location)
	if (await hasClaudeHookInFile(join(projectDir, ".claude", "settings.local.json"))) {
		return true;
	}
	// Fall back to settings.json (legacy location)
	return hasClaudeHookInFile(join(projectDir, ".claude", "settings.json"));
}

/**
 * Checks if a specific settings file contains a Jolli Memory hook.
 */
async function hasClaudeHookInFile(settingsPath: string): Promise<boolean> {
	try {
		const content = await readFile(settingsPath, "utf-8");
		const settings = JSON.parse(content) as Record<string, unknown>;
		const hooks = settings.hooks as Record<string, unknown> | undefined;
		if (!hooks) return false;

		const stopMatcherGroups = (hooks.Stop ?? []) as Array<Record<string, unknown>>;
		return hasJolliMemoryHook(stopMatcherGroups);
	} catch {
		return false;
	}
}
