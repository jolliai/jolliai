/**
 * HookSettingsHelper — Shared types, constants, and helpers for JSON-based hook
 * settings (Claude Code settings.local.json, Gemini settings.json).
 *
 * Extracted from Installer.ts to keep each hook installer focused on a single
 * integration while sharing the common matcher/identifier infrastructure.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** Result of a single hook install/remove operation. */
export interface HookOpResult {
	warning?: string;
	/** Absolute path to the installed hook file */
	path?: string;
}

// ─── Hook command builder ───────────────────────────────────────────────────

/**
 * Shell reference to the runtime entry point. All hooks call this script,
 * passing the hook type as first arg. The script enumerates `dist-paths/<source>`,
 * picks the highest available version, and execs `node .../<HookType>.js`.
 */
const RUN_HOOK_SHELL = '"$HOME/.jolli/jollimemory/run-hook"';

/** Build a hook command (Claude/Gemini JSON hooks) that calls run-hook. */
export function buildHookCommand(hookType: string, args = ""): string {
	const suffix = args ? ` ${args}` : "";
	return `${RUN_HOOK_SHELL} ${hookType}${suffix}`;
}

// ─── Hook identifier constants ──────────────────────────────────────────────

/**
 * Per-hook-type identifier sets. Each hook type lists substrings whose
 * presence in a `command` string identifies a Jolli Memory hook.
 *
 * Both new (`run-hook <hook-type>`) and legacy (`<HookType>.js`) forms
 * are recognized so a current install can detect and replace legacy hook
 * sections during upgrade.
 */
export const STOP_HOOK_IDENTIFIERS = ["run-hook", "StopHook"] as const;
export const SESSION_START_HOOK_IDENTIFIERS = ["run-hook", "SessionStartHook"] as const;
export const GEMINI_HOOK_IDENTIFIERS = ["run-hook", "GeminiAfterAgentHook"] as const;

// ─── Matcher helpers ────────────────────────────────────────────────────────

/**
 * Checks if any matcher group contains a hook whose command includes the given
 * identifier (or any of the given identifiers if an array is provided).
 * Handles the hooks format: [{ hooks: [{ type, command }] }]
 */
export function hasHookWithIdentifier(
	matcherGroups: ReadonlyArray<Record<string, unknown>>,
	identifier: string | ReadonlyArray<string>,
): boolean {
	/* v8 ignore start -- all internal callers pass arrays; string overload is a public API convenience */
	const ids = typeof identifier === "string" ? [identifier] : identifier;
	/* v8 ignore stop */
	return matcherGroups.some((group) => {
		const innerHooks = group.hooks as Array<Record<string, unknown>> | undefined;
		/* v8 ignore start -- defensive: matcher groups from settings should always have hooks array */
		if (!Array.isArray(innerHooks)) return false;
		/* v8 ignore stop */
		return innerHooks.some(
			(h) => typeof h.command === "string" && ids.some((id) => (h.command as string).includes(id)),
		);
	});
}

/**
 * Checks if any matcher group contains a hook with the exact command string.
 * Used to detect whether the hook path needs updating (e.g., after a new install location).
 */
export function hasHookWithCommand(matcherGroups: ReadonlyArray<Record<string, unknown>>, command: string): boolean {
	return matcherGroups.some((group) => {
		const innerHooks = group.hooks as Array<Record<string, unknown>> | undefined;
		/* v8 ignore start -- defensive: matcher groups from settings should always have hooks array */
		if (!Array.isArray(innerHooks)) return false;
		/* v8 ignore stop */
		return innerHooks.some((h) => h.command === command);
	});
}

/**
 * Returns a filtered copy of matcher groups with hooks matching the identifier
 * (or any of the identifiers if an array is provided) removed. Removes
 * individual hook entries, and drops the entire matcher group if empty.
 */
export function removeHooksWithIdentifier(
	matcherGroups: ReadonlyArray<Record<string, unknown>>,
	identifier: string | ReadonlyArray<string>,
): Array<Record<string, unknown>> {
	/* v8 ignore start -- all internal callers pass arrays; string overload is a public API convenience */
	const ids = typeof identifier === "string" ? [identifier] : identifier;
	/* v8 ignore stop */
	const result: Array<Record<string, unknown>> = [];
	for (const group of matcherGroups) {
		const innerHooks = group.hooks as Array<Record<string, unknown>> | undefined;
		/* v8 ignore start -- defensive: matcher group without hooks array */
		if (!Array.isArray(innerHooks)) {
			result.push(group);
			continue;
		}
		/* v8 ignore stop */
		const filtered = innerHooks.filter(
			(h) => !(typeof h.command === "string" && ids.some((id) => (h.command as string).includes(id))),
		);
		// Only keep the matcher group if it still has hooks
		if (filtered.length > 0) {
			result.push({ ...group, hooks: filtered });
		}
	}
	return result;
}

// ─── Claude-specific wrappers ───────────────────────────────────────────────
// Backward-compatible wrappers for Claude Code Stop hooks (used in multiple places).
// These match BOTH new ("run-hook stop") and legacy ("StopHook") forms.

export function hasJolliMemoryHook(matcherGroups: ReadonlyArray<Record<string, unknown>>): boolean {
	return hasHookWithIdentifier(matcherGroups, STOP_HOOK_IDENTIFIERS);
}

export function hasJolliMemoryHookWithCommand(
	matcherGroups: ReadonlyArray<Record<string, unknown>>,
	command: string,
): boolean {
	return hasHookWithCommand(matcherGroups, command);
}

export function removeJolliMemoryHook(
	matcherGroups: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	return removeHooksWithIdentifier(matcherGroups, STOP_HOOK_IDENTIFIERS);
}
