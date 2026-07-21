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
import { isValidSourceTag } from "./DistPathResolver.js";
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

export const POST_MERGE_MARKER_START = "# >>> JolliMemory post-merge hook >>>";
const POST_MERGE_MARKER_END = "# <<< JolliMemory post-merge hook <<<";

export const PRE_PUSH_MARKER_START = "# >>> JolliMemory pre-push hook >>>";
const PRE_PUSH_MARKER_END = "# <<< JolliMemory pre-push hook <<<";

// ─── Install ────────────────────────────────────────────────────────────────

/**
 * Installs the git post-commit hook.
 * If a hook already exists, appends Jolli Memory's section.
 */
export async function installGitHook(projectDir: string, distSource?: string): Promise<HookOpResult> {
	const hooksDir = await resolveGitHooksDir(projectDir);
	const hookPath = join(hooksDir, "post-commit");

	// Build hook command using dist-path indirection (resolved at runtime via shell).
	// distSource soft-prefers resolution toward one source (version tie only; Claude Code plugin: "claude-plugin").
	const hookCommandLine = buildHookCommand("post-commit", "", distSource);
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
export async function installPostRewriteHook(projectDir: string, distSource?: string): Promise<HookOpResult> {
	// post-rewrite receives the command ("amend" or "rebase") as $1
	const hookCommandLine = buildHookCommand("post-rewrite", '"$1"', distSource);
	const hookSection = [POST_REWRITE_MARKER_START, hookCommandLine, POST_REWRITE_MARKER_END].join("\n");

	return installGenericGitHook(projectDir, "post-rewrite", hookSection, POST_REWRITE_MARKER_START);
}

/**
 * Installs the git prepare-commit-msg hook (handles git merge --squash).
 * If a hook already exists, appends Jolli Memory's section.
 *
 * Guarded the same three ways as pre-push: `[ -x ]` skips a missing/incomplete
 * run-hook, `|| true` swallows a non-zero exit from Jolli itself, and — because
 * this section is APPENDED to any existing hook — the preceding command's exit
 * status is captured and restored via a subshell. git aborts the commit on a
 * non-zero prepare-commit-msg exit, so a preceding section's failure must still
 * abort; without the restore, our best-effort `if … || true; fi` (which always
 * exits 0) would silently turn that failure into success.
 */
export async function installPrepareMsgHook(projectDir: string, distSource?: string): Promise<HookOpResult> {
	// prepare-commit-msg receives the commit message file as $1 and source type as $2.
	const runHook = '"$HOME/.jolli/jollimemory/run-hook"';
	// Defense-in-depth, unreachable in the normal flow: install() validates the tag
	// once up front and aborts all-or-nothing. Kept here (and matching buildHookCommand)
	// because this line interpolates the tag into an auto-executing hook — a direct
	// caller that bypasses the up-front check must still hard-fail, not emit unsafe shell.
	if (distSource !== undefined && !isValidSourceTag(distSource)) {
		throw new Error(
			`Refusing to build prepare-commit-msg hook with unsafe source tag: ${JSON.stringify(distSource)}`,
		);
	}
	const prefer = distSource ? `JOLLI_DIST_PREFER_SOURCE='${distSource}' ` : "";
	// Mirror the pre-push guard exactly: preserve the preceding command's status so an
	// existing validation failure still aborts the commit, while the [ -x ] + || true
	// pair keeps a missing run-hook or a Jolli-side error from blocking it.
	const hookCommandLine = [
		"__jolli_prepare_msg_previous_status=$?",
		`if [ -x ${runHook} ]; then ${prefer}${runHook} prepare-commit-msg "$1" "$2" || true; fi`,
		'(exit "$__jolli_prepare_msg_previous_status")',
	].join("\n");
	const hookSection = [PREPARE_MSG_MARKER_START, hookCommandLine, PREPARE_MSG_MARKER_END].join("\n");

	return installGenericGitHook(projectDir, "prepare-commit-msg", hookSection, PREPARE_MSG_MARKER_START);
}

/**
 * Installs the git post-merge hook (auto-compiles merged branch summaries
 * after `git pull`/`git merge` completes).
 * If a hook already exists, appends Jolli Memory's section.
 */
export async function installPostMergeHook(projectDir: string, distSource?: string): Promise<HookOpResult> {
	const hookCommandLine = buildHookCommand("post-merge", "", distSource);
	const hookSection = [POST_MERGE_MARKER_START, hookCommandLine, POST_MERGE_MARKER_END].join("\n");

	return installGenericGitHook(projectDir, "post-merge", hookSection, POST_MERGE_MARKER_START);
}

/**
 * Installs the git pre-push hook (auto-syncs pushed commits' memory to Jolli
 * Space). If a hook already exists, appends Jolli Memory's section.
 *
 * pre-push receives `<remote-name> <url>` as $1/$2 and the ref lines on stdin;
 * `"$@"` forwards the args and `exec` inherits stdin, so PrePushHook.js sees
 * both.
 */
export async function installPrePushHook(projectDir: string, distSource?: string): Promise<HookOpResult> {
	// pre-push is the only hook where non-zero exit aborts the git operation.
	// Guard with [ -x ] + || true so a missing run-hook or absent Node can
	// NEVER block the user's push (aligned with IntelliJ's prePushScript).
	// Preserve the status of the existing hook content: this section is appended,
	// so letting our best-effort command become the script's final status would
	// turn a preceding failure into success and incorrectly allow the push.
	const runHook = '"$HOME/.jolli/jollimemory/run-hook"';
	// distSource SOFT-prefers one source (Claude Code plugin: "claude-plugin") via
	// JOLLI_DIST_PREFER_SOURCE — resolve-dist-path picks it only when present,
	// complete, and at the top version, else falls through to cross-source. Mirrors
	// buildHookCommand; the other four git hooks bake the same var through it, but
	// pre-push builds its line inline (the [ -x ] + || true guard), so re-assert the
	// tag shape here too — this value is interpolated into an auto-executing hook.
	// Like prepare-commit-msg, this is unreachable defense-in-depth: install() already
	// validated the tag up front. It THROWS (not returns) for the same reason — a bad
	// tag reaching a shell-interpolation boundary must hard-fail.
	if (distSource !== undefined && !isValidSourceTag(distSource)) {
		throw new Error(`Refusing to build pre-push hook with unsafe source tag: ${JSON.stringify(distSource)}`);
	}
	const prefer = distSource ? `JOLLI_DIST_PREFER_SOURCE='${distSource}' ` : "";
	const hookCommandLine = [
		"__jolli_pre_push_previous_status=$?",
		`if [ -x ${runHook} ]; then ${prefer}${runHook} pre-push "$@" || true; fi`,
		'(exit "$__jolli_pre_push_previous_status")',
	].join("\n");
	const hookSection = [PRE_PUSH_MARKER_START, hookCommandLine, PRE_PUSH_MARKER_END].join("\n");

	return installGenericGitHook(projectDir, "pre-push", hookSection, PRE_PUSH_MARKER_START);
}

/**
 * Generic helper to install a Jolli Memory section into any git hook file.
 * Handles idempotent install, path updates, and appending to existing hooks.
 */
async function installGenericGitHook(
	projectDir: string,
	hookName: string,
	hookSection: string,
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
			// Check if the section is already byte-identical to what we'd write.
			// (A naive `includes(scriptPath)` substring check would false-positive
			// when the existing line carries a JOLLI_DIST_PREFER_SOURCE prefix that
			// the current caller omits — the unprefixed scriptPath is a substring
			// of the prefixed line.)
			if (existingContent.includes(hookSection)) {
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
 * Removes the Jolli Memory section from the git post-merge hook.
 */
export async function removePostMergeHook(projectDir: string): Promise<void> {
	await removeGenericGitHook(projectDir, "post-merge", POST_MERGE_MARKER_START, POST_MERGE_MARKER_END);
}

/**
 * Removes the Jolli Memory section from the git pre-push hook.
 */
export async function removePrePushHook(projectDir: string): Promise<void> {
	await removeGenericGitHook(projectDir, "pre-push", PRE_PUSH_MARKER_START, PRE_PUSH_MARKER_END);
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
