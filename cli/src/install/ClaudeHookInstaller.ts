/**
 * ClaudeHookInstaller — Install/remove/detect Claude Code hooks in
 * `.claude/settings.local.json`.
 *
 * Also handles the SessionStart hook and legacy cleanup from
 * `.claude/settings.json` (previous versions wrote there).
 *
 * Extracted from Installer.ts for single-responsibility.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../core/AtomicWrite.js";
import type { HookOpResult } from "./HookSettingsHelper.js";
import {
	buildHookCommand,
	hasHookWithIdentifier,
	hasJolliMemoryHook,
	removeHooksWithIdentifier,
	removeJolliMemoryHook,
	SESSION_START_HOOK_IDENTIFIERS,
	STOP_HOOK_IDENTIFIERS,
} from "./HookSettingsHelper.js";

/**
 * Installs the Claude Code Stop hook in .claude/settings.local.json.
 *
 * Also cleans up any legacy Jolli Memory hooks from .claude/settings.json
 * (from previous versions that wrote to the shared file).
 */
export async function installClaudeHook(projectDir: string): Promise<HookOpResult> {
	return reconcileClaudeAgentHooks(projectDir);
}

/**
 * Reconciles both canonical Claude Code agent hooks in one read-modify-write.
 *
 * Keeping Stop and SessionStart in a single transaction prevents concurrent
 * surfaces from installing one hook while accidentally overwriting the other.
 */
export async function reconcileClaudeAgentHooks(projectDir: string): Promise<HookOpResult> {
	const settingsDir = join(projectDir, ".claude");
	const localSettingsPath = join(settingsDir, "settings.local.json");
	const stopCommand = buildHookCommand("stop");
	const sessionStartCommand = buildHookCommand("session-start");

	// Clean up legacy hooks from settings.json (previous versions wrote there)
	await cleanLegacyClaudeHook(projectDir);

	// Read existing local settings or create new. Only ENOENT is treated as an
	// empty file: malformed JSON or a permission error must never be overwritten.
	let settings: Record<string, unknown> = {};
	let existingContent: string | undefined;
	try {
		existingContent = await readFile(localSettingsPath, "utf-8");
		settings = JSON.parse(existingContent) as Record<string, unknown>;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
	const stopMatcherGroups = (hooks.Stop ?? []) as Array<Record<string, unknown>>;
	const sessionStartGroups = (hooks.SessionStart ?? []) as Array<Record<string, unknown>>;
	const cleanedStop = removeJolliMemoryHook(stopMatcherGroups);
	cleanedStop.push({
		hooks: [
			{
				type: "command",
				command: stopCommand,
				async: true,
			},
		],
	});

	const cleanedSessionStart = removeHooksWithIdentifier(sessionStartGroups, SESSION_START_HOOK_IDENTIFIERS);
	cleanedSessionStart.push({
		hooks: [
			{
				type: "command",
				command: sessionStartCommand,
			},
		],
	});

	hooks.Stop = cleanedStop;
	hooks.SessionStart = cleanedSessionStart;
	settings.hooks = hooks;
	const nextContent = JSON.stringify(settings, null, "\t");
	if (existingContent === nextContent) return { path: localSettingsPath };
	await mkdir(settingsDir, { recursive: true });
	await atomicWriteFile(localSettingsPath, nextContent);
	return { path: localSettingsPath };
}

/** Backward-compatible wrapper; the reconciler always installs both hooks. */
export async function installSessionStartHook(projectDir: string): Promise<void> {
	await reconcileClaudeAgentHooks(projectDir);
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

	await atomicWriteFile(settingsPath, JSON.stringify(settings, null, "\t"));
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

	await atomicWriteFile(localSettingsPath, JSON.stringify(settings, null, "\t"));
	return {};
}

/**
 * Checks if the Claude Code hook is installed.
 * Checks settings.local.json (current) and falls back to settings.json (legacy).
 */
export async function isClaudeHookInstalled(projectDir: string): Promise<boolean> {
	const health = await getClaudeAgentHookHealth(projectDir);
	return health.stop && health.sessionStart;
}

/**
 * Reports each canonical business hook independently so callers can repair a
 * partial installation instead of treating a lone Stop hook as healthy.
 */
export async function getClaudeAgentHookHealth(
	projectDir: string,
): Promise<{ readonly stop: boolean; readonly sessionStart: boolean }> {
	try {
		const content = await readFile(join(projectDir, ".claude", "settings.local.json"), "utf-8");
		const settings = JSON.parse(content) as Record<string, unknown>;
		const hooks = settings.hooks as Record<string, unknown> | undefined;
		if (!hooks) return { stop: false, sessionStart: false };

		const stopMatcherGroups = (hooks.Stop ?? []) as Array<Record<string, unknown>>;
		const sessionStartGroups = (hooks.SessionStart ?? []) as Array<Record<string, unknown>>;
		return {
			stop: hasExactlyOneCanonicalHook(stopMatcherGroups, STOP_HOOK_IDENTIFIERS, buildHookCommand("stop"), true),
			sessionStart: hasExactlyOneCanonicalHook(
				sessionStartGroups,
				SESSION_START_HOOK_IDENTIFIERS,
				buildHookCommand("session-start"),
				false,
			),
		};
	} catch {
		return { stop: false, sessionStart: false };
	}
}

function hasExactlyOneCanonicalHook(
	groups: ReadonlyArray<Record<string, unknown>>,
	identifiers: ReadonlyArray<string>,
	expectedCommand: string,
	expectedAsync: boolean,
): boolean {
	const owned = groups.filter((group) => {
		const innerHooks = group.hooks as Array<Record<string, unknown>> | undefined;
		return innerHooks?.some((hook) => {
			const command = hook.command;
			return typeof command === "string" && identifiers.some((identifier) => command.includes(identifier));
		});
	});
	if (owned.length !== 1) return false;
	const hooks = owned[0].hooks as Array<Record<string, unknown>> | undefined;
	if (!hooks || hooks.length !== 1) return false;
	const hook = hooks[0];
	return (
		hook.type === "command" &&
		hook.command === expectedCommand &&
		(expectedAsync ? hook.async === true : hook.async === undefined)
	);
}
