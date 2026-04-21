/**
 * GitHookInstaller — Install/remove/detect git shell hooks (post-commit,
 * post-rewrite, prepare-commit-msg).
 *
 * These hooks are marker-delimited sections appended to the standard
 * `.git/hooks/<name>` shell scripts, safe to coexist with other hooks.
 *
 * Extracted from Installer.ts for single-responsibility.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveGitHooksDir } from "../core/GitOps.js";
import { createLogger } from "../Logger.js";
import type { HookOpResult } from "./HookSettingsHelper.js";
import { buildHookCommand } from "./HookSettingsHelper.js";

const log = createLogger("GitHookInstaller");

// ─── Marker templates ───────────────────────────────────────────────────────

/** Marker templates used to identify Jolli Memory's section in each git hook type */
const HOOK_MARKER_START = "# >>> JolliMemory post-commit hook >>>";
const HOOK_MARKER_END = "# <<< JolliMemory post-commit hook <<<";

export const POST_REWRITE_MARKER_START = "# >>> JolliMemory post-rewrite hook >>>";
const POST_REWRITE_MARKER_END = "# <<< JolliMemory post-rewrite hook <<<";

export const PREPARE_MSG_MARKER_START = "# >>> JolliMemory prepare-commit-msg hook >>>";
const PREPARE_MSG_MARKER_END = "# <<< JolliMemory prepare-commit-msg hook <<<";

// ─── Install ────────────────────────────────────────────────────────────────

/**
 * Installs the git post-commit hook.
 * If a hook already exists, appends Jolli Memory's section.
 */
export async function installGitHook(projectDir: string): Promise<HookOpResult> {
	const hooksDir = await resolveGitHooksDir(projectDir);
	const hookPath = join(hooksDir, "post-commit");

	// Build hook command using dist-path indirection (resolved at runtime via shell)
	const hookCommandLine = buildHookCommand("post-commit");
	const hookSection = [HOOK_MARKER_START, hookCommandLine, HOOK_MARKER_END].join("\n");

	let warning: string | undefined;

	// Check for existing hook file
	let existingContent = "";
	try {
		existingContent = await readFile(hookPath, "utf-8");

		if (existingContent.includes(HOOK_MARKER_START)) {
			// Check if the hook section already has the correct command
			if (existingContent.includes(hookCommandLine)) {
				return { path: hookPath };
			}

			// Hook exists but with an outdated command — replace the section
			const regex = new RegExp(`${escapeRegExp(HOOK_MARKER_START)}[\\s\\S]*?${escapeRegExp(HOOK_MARKER_END)}`);
			existingContent = existingContent.replace(regex, hookSection);

			await writeFile(hookPath, existingContent, "utf-8");
			return { path: hookPath };
		}

		warning = "Existing post-commit hook found — Jolli Memory section appended";
		log.warn(warning);
	} catch {
		// No existing hook — create new
	}

	// Build the final hook content
	let hookContent: string;
	if (existingContent) {
		hookContent = `${existingContent}\n\n${hookSection}\n`;
	} else {
		hookContent = `#!/bin/sh\n\n${hookSection}\n`;
	}

	// Write the hook file
	await mkdir(hooksDir, { recursive: true });
	await writeFile(hookPath, hookContent, "utf-8");

	// Make executable (Unix)
	try {
		await chmod(hookPath, 0o755);
		/* v8 ignore start -- chmod succeeds silently on Windows, catch only for rare permission errors */
	} catch {}
	/* v8 ignore stop */

	log.info("Git post-commit hook installed");
	return { warning, path: hookPath };
}

/**
 * Installs the git post-rewrite hook (handles amend/rebase summary migration).
 * If a hook already exists, appends Jolli Memory's section.
 */
export async function installPostRewriteHook(projectDir: string): Promise<HookOpResult> {
	// post-rewrite receives the command ("amend" or "rebase") as $1
	const hookCommandLine = buildHookCommand("post-rewrite", '"$1"');
	const hookSection = [POST_REWRITE_MARKER_START, hookCommandLine, POST_REWRITE_MARKER_END].join("\n");

	return installGenericGitHook(projectDir, "post-rewrite", hookSection, hookCommandLine, POST_REWRITE_MARKER_START);
}

/**
 * Installs the git prepare-commit-msg hook (handles git merge --squash).
 * If a hook already exists, appends Jolli Memory's section.
 */
export async function installPrepareMsgHook(projectDir: string): Promise<HookOpResult> {
	// prepare-commit-msg receives the commit message file as $1 and source type as $2
	const hookCommandLine = buildHookCommand("prepare-commit-msg", '"$1" "$2"');
	const hookSection = [PREPARE_MSG_MARKER_START, hookCommandLine, PREPARE_MSG_MARKER_END].join("\n");

	return installGenericGitHook(
		projectDir,
		"prepare-commit-msg",
		hookSection,
		hookCommandLine,
		PREPARE_MSG_MARKER_START,
	);
}

/**
 * Generic helper to install a Jolli Memory section into any git hook file.
 * Handles idempotent install, path updates, and appending to existing hooks.
 */
async function installGenericGitHook(
	projectDir: string,
	hookName: string,
	hookSection: string,
	scriptPath: string,
	markerStart: string,
): Promise<HookOpResult> {
	const markerEnd = hookSection.slice(hookSection.lastIndexOf("\n") + 1);
	const hooksDir = await resolveGitHooksDir(projectDir);
	const hookPath = join(hooksDir, hookName);

	let warning: string | undefined;
	let existingContent = "";

	try {
		existingContent = await readFile(hookPath, "utf-8");

		if (existingContent.includes(markerStart)) {
			// Check if the section already has the correct script path
			if (existingContent.includes(scriptPath)) {
				return { path: hookPath };
			}

			// Hook exists but with an outdated path — replace the section
			// nosemgrep: detect-non-literal-regexp -- markers are internal constants, escaped via escapeRegExp()
			const regex = new RegExp(`${escapeRegExp(markerStart)}[\\s\\S]*?${escapeRegExp(markerEnd)}`);
			existingContent = existingContent.replace(regex, hookSection);

			await writeFile(hookPath, existingContent, "utf-8");
			return { path: hookPath };
		}

		warning = `Existing ${hookName} hook found — Jolli Memory section appended`;
		log.warn(warning);
	} catch {
		// No existing hook — create new
	}

	// Build the final hook content
	let hookContent: string;
	if (existingContent) {
		hookContent = `${existingContent}\n\n${hookSection}\n`;
	} else {
		hookContent = `#!/bin/sh\n\n${hookSection}\n`;
	}

	await mkdir(hooksDir, { recursive: true });
	await writeFile(hookPath, hookContent, "utf-8");

	try {
		await chmod(hookPath, 0o755);
		/* v8 ignore start -- chmod succeeds silently on Windows, catch only for rare permission errors */
	} catch {}
	/* v8 ignore stop */

	log.info("Git %s hook installed", hookName);
	return { warning, path: hookPath };
}

// ─── Remove ─────────────────────────────────────────────────────────────────

/**
 * Removes the Jolli Memory section from the git post-commit hook.
 */
export async function removeGitHook(projectDir: string): Promise<HookOpResult> {
	let hookPath: string;
	try {
		const hooksDir = await resolveGitHooksDir(projectDir);
		hookPath = join(hooksDir, "post-commit");
		/* v8 ignore start -- defensive: no .git directory in project */
	} catch {
		return {};
	}
	/* v8 ignore stop */

	let content: string;
	try {
		content = await readFile(hookPath, "utf-8");
	} catch {
		return {};
	}

	if (!content.includes(HOOK_MARKER_START)) {
		return {};
	}

	// Remove our section (including marker lines and surrounding blank lines)
	const regex = new RegExp(`\\n*${escapeRegExp(HOOK_MARKER_START)}[\\s\\S]*?${escapeRegExp(HOOK_MARKER_END)}\\n*`);
	const cleaned = content.replace(regex, "\n");

	// If only the shebang remains, delete the file
	if (cleaned.trim() === "#!/bin/sh" || cleaned.trim() === "") {
		const { rm } = await import("node:fs/promises");
		await rm(hookPath, { force: true });
	} else {
		await writeFile(hookPath, cleaned, "utf-8");
	}

	return {};
}

/**
 * Removes the Jolli Memory section from the git post-rewrite hook.
 */
export async function removePostRewriteHook(projectDir: string): Promise<void> {
	await removeGenericGitHook(projectDir, "post-rewrite", POST_REWRITE_MARKER_START, POST_REWRITE_MARKER_END);
}

/**
 * Removes the Jolli Memory section from the git prepare-commit-msg hook.
 */
export async function removePrepareMsgHook(projectDir: string): Promise<void> {
	await removeGenericGitHook(projectDir, "prepare-commit-msg", PREPARE_MSG_MARKER_START, PREPARE_MSG_MARKER_END);
}

/**
 * Generic helper to remove a Jolli Memory section from a git hook file.
 */
async function removeGenericGitHook(
	projectDir: string,
	hookName: string,
	markerStart: string,
	markerEnd: string,
): Promise<void> {
	let hooksDir: string;
	try {
		hooksDir = await resolveGitHooksDir(projectDir);
		/* v8 ignore start -- defensive: no .git directory in project */
	} catch {
		return;
	}
	/* v8 ignore stop */

	const hookPath = join(hooksDir, hookName);
	let content: string;
	try {
		content = await readFile(hookPath, "utf-8");
	} catch {
		return;
	}

	if (!content.includes(markerStart)) {
		return;
	}

	// Remove our section (including marker lines and surrounding blank lines)
	// nosemgrep: detect-non-literal-regexp -- markers are internal constants, escaped via escapeRegExp()
	const regex = new RegExp(`\\n*${escapeRegExp(markerStart)}[\\s\\S]*?${escapeRegExp(markerEnd)}\\n*`);
	const cleaned = content.replace(regex, "\n");

	if (cleaned.trim() === "#!/bin/sh" || cleaned.trim() === "") {
		const { rm } = await import("node:fs/promises");
		await rm(hookPath, { force: true });
	} else {
		await writeFile(hookPath, cleaned, "utf-8");
	}
}

// ─── Detection ──────────────────────────────────────────────────────────────

/**
 * Checks if the git post-commit hook contains Jolli Memory's section.
 */
export async function isGitHookInstalled(projectDir: string): Promise<boolean> {
	return isHookSectionInstalled(projectDir, "post-commit", HOOK_MARKER_START);
}

/**
 * Checks if a named git hook file contains a Jolli Memory marker section.
 */
export async function isHookSectionInstalled(
	projectDir: string,
	hookName: string,
	markerStart: string,
): Promise<boolean> {
	try {
		const hooksDir = await resolveGitHooksDir(projectDir);
		const hookPath = join(hooksDir, hookName);
		const content = await readFile(hookPath, "utf-8");
		return content.includes(markerStart);
	} catch {
		return false;
	}
}

// ─── Utility ────────────────────────────────────────────────────────────────

/**
 * Escapes special regex characters in a string.
 */
function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
