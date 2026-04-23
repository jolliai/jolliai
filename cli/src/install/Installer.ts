/**
 * Installer Module — Orchestration layer.
 *
 * Coordinates install/uninstall/status across all hook types and the
 * per-source dist-paths registry. Individual hook implementations live in
 * their own modules:
 *   - ClaudeHookInstaller.ts  — Claude Code settings.local.json
 *   - GitHookInstaller.ts     — git shell hooks (post-commit, post-rewrite, prepare-commit-msg)
 *   - GeminiHookInstaller.ts  — Gemini CLI settings.json
 *   - DispatchScripts.ts      — resolve-dist-path / run-hook / run-cli templates
 *   - DistPathResolver.ts     — per-source dist-paths registry + installDistPath
 *   - HookSettingsHelper.ts   — shared types, constants, matcher helpers
 *
 * The installer is idempotent — running install multiple times is safe.
 */

import { stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isClaudeInstalled } from "../core/ClaudeDetector.js";
import { discoverCodexSessions, isCodexInstalled } from "../core/CodexSessionDiscoverer.js";
import { isGeminiInstalled } from "../core/GeminiSessionDetector.js";
import { getProjectRootDir, listWorktrees, orphanBranchExists } from "../core/GitOps.js";
import {
	isOpenCodeInstalled,
	type OpenCodeScanError,
	scanOpenCodeSessions,
} from "../core/OpenCodeSessionDiscoverer.js";
import {
	ensureJolliMemoryDir,
	filterSessionsByEnabledIntegrations,
	getGlobalConfigDir,
	loadAllSessions,
	loadConfig,
	loadConfigFromDir,
	saveConfig,
	saveConfigScoped,
} from "../core/SessionTracker.js";
import { getSummaryCount } from "../core/SummaryStore.js";
import { createLogger, getJolliMemoryDir, ORPHAN_BRANCH } from "../Logger.js";
import type { InstallResult, JolliMemoryConfig, SessionInfo, StatusInfo, TranscriptSource } from "../Types.js";
import {
	installClaudeHook,
	installSessionStartHook,
	isClaudeHookInstalled,
	removeClaudeHook,
} from "./ClaudeHookInstaller.js";
import { installHookScripts } from "./DispatchScripts.js";
import {
	deriveSourceTag,
	installDistPath,
	migrateLegacyDistPath,
	pickBestDistPath,
	traverseDistPaths,
} from "./DistPathResolver.js";
import { installGeminiHook, isGeminiHookInstalled, removeGeminiHook } from "./GeminiHookInstaller.js";
import {
	installGitHook,
	installPostRewriteHook,
	installPrepareMsgHook,
	isGitHookInstalled,
	isHookSectionInstalled,
	POST_REWRITE_MARKER_START,
	PREPARE_MSG_MARKER_START,
	removeGitHook,
	removePostRewriteHook,
	removePrepareMsgHook,
} from "./GitHookInstaller.js";
import type { HookOpResult } from "./HookSettingsHelper.js";
import { updateSkillIfNeeded } from "./SkillInstaller.js";

// ─── Re-exports for backward compatibility ──────────────────────────────────
// External consumers import from "./Installer.js" — these re-exports keep
// their import paths stable after the split.
export { installClaudeHook, removeClaudeHook } from "./ClaudeHookInstaller.js";
export { installHookScripts } from "./DispatchScripts.js";
export { installDistPath } from "./DistPathResolver.js";
export { installGeminiHook, isGeminiHookInstalled, removeGeminiHook } from "./GeminiHookInstaller.js";
export type { HookOpResult } from "./HookSettingsHelper.js";

const log = createLogger("Installer");

// ─── Path comparison ─────────────────────────────────────────────────────────

/** Case-insensitive path comparison on macOS/Windows; strict on Linux. */
function pathsEqual(a: string, b: string): boolean {
	/* v8 ignore start -- platform-specific: Linux branch only reachable on Linux */
	if (process.platform === "linux") {
		return a === b;
	}
	/* v8 ignore stop */
	return a.toLowerCase() === b.toLowerCase();
}

function hasRequiredWorktreeHooks(
	claudeHookInstalled: boolean,
	geminiHookInstalled: boolean,
	config: JolliMemoryConfig,
	geminiDetected: boolean,
): boolean {
	const claudeReady = config.claudeEnabled === false || claudeHookInstalled;
	const geminiReady = config.geminiEnabled === false || !geminiDetected || geminiHookInstalled;
	return claudeReady && geminiReady;
}

// ─── Install ────────────────────────────────────────────────────────────────

/**
 * Installs both Claude Code and Git hooks.
 *
 * Installs Claude/Gemini hooks in ALL worktrees. Git hooks are always installed
 * once (they live in the shared `.git/hooks/` directory).
 *
 * @param cwd - Optional working directory (defaults to process.cwd())
 * @param options.source - Installation source: "vscode-extension" or "cli" (default "cli").
 *   Written to the global dist-path file so refreshHookPathsIfStale() can distinguish
 *   extension-managed paths from CLI-managed paths and avoid unwanted overwrites.
 */
export async function install(cwd?: string, options?: { source?: "vscode-extension" | "cli" }): Promise<InstallResult> {
	/* v8 ignore next - process.cwd() fallback only used when called without cwd arg */
	const projectDir = cwd ?? process.cwd();
	const warnings: string[] = [];

	log.info("Installing Jolli Memory hooks");

	try {
		// Load config to check integration enabled flags (always global)
		const config = await loadConfig();

		// List all worktrees so we can install per-worktree hooks in each one
		const worktrees = await listWorktrees(projectDir);

		// Write run-hook + resolve-dist-path shim (once, outside worktree loop)
		const resolveScriptsOk = await installHookScripts();
		if (!resolveScriptsOk) {
			return {
				success: false,
				message: "Failed to write resolve-dist-path scripts — cannot install hooks that depend on them",
				warnings,
			};
		}

		// One-time migration of legacy single-file dist-path → dist-paths/<derived-tag>.
		// Idempotent and safe to retry. Logs but does not fail install on errors.
		try {
			await migrateLegacyDistPath();
			/* v8 ignore start -- defensive: migrateLegacyDistPath handles its own errors internally */
		} catch (error: unknown) {
			log.warn("Legacy dist-path migration failed (non-fatal): %s", (error as Error).message);
		}
		/* v8 ignore stop */

		// Determine this caller's source tag and write its per-source dist-paths/ entry.
		// CLI -> "cli"; VSCode-family -> derive from extension path (vscode/cursor/...).
		const callerDistDir = dirname(fileURLToPath(import.meta.url));
		const callerSource = options?.source ?? "cli";
		const sourceTag = callerSource === "vscode-extension" ? deriveSourceTag(callerDistDir) : "cli";

		const distPathOk = await installDistPath(sourceTag);
		if (!distPathOk) {
			return {
				success: false,
				message: "Failed to write per-source dist-paths/ entry — cannot install hooks that depend on it",
				warnings,
			};
		}

		// Install .jolli/jollimemory/ state dir (always) and Claude Code hook (if enabled)
		let claudeResult: HookOpResult = {};
		for (const wt of worktrees) {
			const jmDir = await ensureJolliMemoryDir(wt);
			// Bootstrap empty sessions.json so session tracking starts cleanly.
			// Uses 'wx' flag (exclusive create) to atomically skip if the file
			// already exists, avoiding a TOCTOU race with concurrent StopHook writes.
			const sessionsPath = join(jmDir, "sessions.json");
			try {
				await writeFile(sessionsPath, JSON.stringify({ version: 1, sessions: {} }, null, "\t"), {
					encoding: "utf-8",
					flag: "wx",
				});
			} catch (err: unknown) {
				/* v8 ignore start -- defensive: non-EEXIST errors (e.g. read-only fs) are rare in practice */
				if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
					log.warn("Failed to bootstrap sessions.json in %s: %s", wt, (err as Error).message);
				}
				/* v8 ignore stop */
			}
			if (config.claudeEnabled === false) continue;
			const result = await installClaudeHook(wt);
			/* v8 ignore start -- defensive: installClaudeHook currently never returns warnings */
			if (result.warning) {
				warnings.push(result.warning);
			}
			/* v8 ignore stop */
			// Capture the path from the primary worktree (first iteration = projectDir or first wt)
			if (wt === projectDir || claudeResult.path === undefined) {
				claudeResult = result;
			}
			// Write/update SKILL.md if version changed
			await updateSkillIfNeeded(wt);
			// Install SessionStart hook for auto-briefing
			await installSessionStartHook(wt);
		}

		// Git hooks are shared across all worktrees — install once
		const gitResult = await installGitHook(projectDir);
		if (gitResult.warning) {
			warnings.push(gitResult.warning);
		}

		// Install Git post-rewrite hook (handles amend/rebase summary migration)
		const postRewriteResult = await installPostRewriteHook(projectDir);
		if (postRewriteResult.warning) {
			warnings.push(postRewriteResult.warning);
		}

		// Install Git prepare-commit-msg hook (handles git merge --squash)
		const prepareMsgResult = await installPrepareMsgHook(projectDir);
		if (prepareMsgResult.warning) {
			warnings.push(prepareMsgResult.warning);
		}

		// Auto-detect Codex CLI and enable session discovery (saved to global config)
		const codexDetected = await isCodexInstalled();
		if (codexDetected) {
			if (config.codexEnabled === undefined) {
				await saveConfig({ codexEnabled: true });
				log.info("Codex CLI detected — enabled Codex session discovery");
			}
		}

		// Auto-detect Gemini CLI and install AfterAgent hook in all worktrees (if enabled)
		let geminiSettingsPath: string | undefined;
		const geminiDetected = await isGeminiInstalled();
		if (geminiDetected && config.geminiEnabled !== false) {
			for (const wt of worktrees) {
				const geminiResult = await installGeminiHook(wt);
				// Capture the path from the primary worktree
				if (wt === projectDir || geminiSettingsPath === undefined) {
					geminiSettingsPath = geminiResult.path;
				}
			}
			if (config.geminiEnabled === undefined) {
				await saveConfig({ geminiEnabled: true });
				log.info("Gemini CLI detected — enabled Gemini session tracking");
			}
		}

		// Auto-detect OpenCode and enable session discovery
		const openCodeDetected = config.openCodeEnabled !== false && (await isOpenCodeInstalled());
		if (openCodeDetected) {
			if (config.openCodeEnabled === undefined) {
				await saveConfig({ openCodeEnabled: true });
				log.info("OpenCode detected — enabled OpenCode session discovery");
			}
		}

		// Migrate any existing worktree-level API keys to the global config dir.
		// The worktrees list always includes the main repo root as its first entry.
		for (const wt of worktrees) {
			await migrateWorktreeConfig(wt);
		}

		log.info("Installation complete");
		return {
			success: true,
			message: "Jolli Memory hooks installed successfully",
			warnings,
			claudeSettingsPath: claudeResult.path,
			gitHookPath: gitResult.path,
			postRewriteHookPath: postRewriteResult.path,
			prepareMsgHookPath: prepareMsgResult.path,
			geminiSettingsPath,
		};
		/* v8 ignore start -- defensive: internal functions handle their own errors */
	} catch (error: unknown) {
		const message = `Installation failed: ${(error as Error).message}`;
		log.error(message);
		return { success: false, message, warnings };
	}
	/* v8 ignore stop */
}

/**
 * Migrates settings stored in a worktree-level (or project-level) config to
 * the global config directory (~/.jolli/jollimemory/).
 *
 * Backfills only: global values are never overwritten. This prevents a stale
 * worktree key from silently replacing a newer global key. All config fields
 * are migrated (not just API keys) so users don't lose model, integration
 * toggles, or exclude pattern settings they had configured per-project.
 *
 * After copying, removes migrated fields from the source config so they
 * aren't re-migrated on subsequent runs. This makes the operation idempotent.
 *
 * @param worktreeDir - The worktree (or main repo) directory to read config from
 */
async function migrateWorktreeConfig(worktreeDir: string): Promise<void> {
	// Skip if the worktree config directory doesn't exist — nothing to migrate,
	// and we don't want to create an empty directory as a side-effect.
	const worktreeConfigDir = getJolliMemoryDir(worktreeDir);
	try {
		await stat(worktreeConfigDir);
		/* v8 ignore start -- defensive: ensureJolliMemoryDir creates the dir earlier in install() */
	} catch {
		return;
	}
	/* v8 ignore stop */

	const targetDir = getGlobalConfigDir();

	// Skip when source and target are the same directory (e.g., when the
	// global config dir is already the worktree config dir).
	// Use case-insensitive comparison on macOS/Windows where filesystems are
	// case-insensitive — git worktree list may return different casing than resolve().
	if (pathsEqual(resolve(worktreeConfigDir), resolve(targetDir))) {
		return;
	}

	const worktreeConfig = await loadConfigFromDir(worktreeConfigDir);

	// Collect all defined fields from the worktree config
	const definedFields: Partial<JolliMemoryConfig> = {};
	for (const [key, value] of Object.entries(worktreeConfig)) {
		/* v8 ignore start -- defensive: JSON.parse never produces undefined values in Object.entries */
		if (value !== undefined) {
			(definedFields as Record<string, unknown>)[key] = value;
		}
		/* v8 ignore stop */
	}

	if (Object.keys(definedFields).length === 0) {
		return; // Nothing to migrate
	}

	// Backfill only: copy worktree values into global config where global
	// doesn't already have a value. This prevents a stale worktree key from
	// overwriting a newer global key.
	const globalConfig = await loadConfigFromDir(targetDir);
	const backfill: Partial<JolliMemoryConfig> = {};
	for (const [key, value] of Object.entries(definedFields)) {
		if ((globalConfig as Record<string, unknown>)[key] === undefined) {
			(backfill as Record<string, unknown>)[key] = value;
		}
	}

	if (Object.keys(backfill).length > 0) {
		await saveConfigScoped(backfill, targetDir);
	}

	// Only remove fields that were actually backfilled to global. Fields where
	// the worktree had a different value than global are kept so the user's
	// project-level settings are not silently lost.
	const fieldsToRemove: Partial<JolliMemoryConfig> = {};
	for (const key of Object.keys(backfill)) {
		(fieldsToRemove as Record<string, unknown>)[key] = undefined;
	}
	if (Object.keys(fieldsToRemove).length > 0) {
		await saveConfigScoped(fieldsToRemove, worktreeConfigDir);
	}

	// Warn about conflicting fields that were NOT migrated (worktree value
	// differs from existing global value). These remain in the worktree config
	// file on disk but are no longer read — global config takes effect.
	// Log both values so the user can manually reconcile if needed.
	const conflicting = Object.keys(definedFields).filter((k) => !(k in backfill));
	for (const key of conflicting) {
		log.warn(
			"Worktree %s field %s not migrated: worktree=%s, global=%s (global value takes effect)",
			worktreeDir,
			key,
			String((definedFields as Record<string, unknown>)[key]),
			String((globalConfig as Record<string, unknown>)[key]),
		);
	}

	log.info("Migrated %d config fields from worktree %s to global", Object.keys(backfill).length, worktreeDir);
}

// ─── Uninstall ──────────────────────────────────────────────────────────────

/**
 * Removes both Claude Code and Git hooks.
 *
 * Removes Claude/Gemini hooks from ALL worktrees. Git hooks are removed once
 * (they live in the shared `.git/hooks/` directory).
 * Falls back to operating on just `projectDir` if worktree listing fails.
 *
 * @param cwd - Optional working directory (defaults to process.cwd())
 */
export async function uninstall(cwd?: string): Promise<InstallResult> {
	/* v8 ignore next - process.cwd() fallback only used when called without cwd arg */
	const projectDir = cwd ?? process.cwd();
	const warnings: string[] = [];

	log.info("Removing Jolli Memory hooks");

	try {
		// Attempt to list all worktrees; fall back to just this directory if it fails
		let worktrees: ReadonlyArray<string>;
		try {
			worktrees = await listWorktrees(projectDir);
		} catch {
			worktrees = [projectDir];
		}

		// Remove Claude Code and Gemini hooks from every worktree
		for (const wt of worktrees) {
			const claudeResult = await removeClaudeHook(wt);
			/* v8 ignore start -- defensive: removeClaudeHook currently never returns warnings */
			if (claudeResult.warning) {
				warnings.push(claudeResult.warning);
			}
			/* v8 ignore stop */
			await removeGeminiHook(wt);
		}

		// Git hooks are shared — remove once from the common hooks directory
		const gitResult = await removeGitHook(projectDir);
		/* v8 ignore start -- defensive: removeGitHook currently never returns warnings */
		if (gitResult.warning) {
			warnings.push(gitResult.warning);
		}
		/* v8 ignore stop */

		await removePostRewriteHook(projectDir);
		await removePrepareMsgHook(projectDir);

		log.info("Uninstallation complete");
		return {
			success: true,
			message: "Jolli Memory hooks removed successfully",
			warnings,
		};
		/* v8 ignore start -- defensive wrapper: helper paths already catch expected filesystem failures */
	} catch (error: unknown) {
		const message = `Uninstallation failed: ${(error as Error).message}`;
		log.error(message);
		return { success: false, message, warnings };
	}
	/* v8 ignore stop */
}

// ─── Status ─────────────────────────────────────────────────────────────────

/**
 * Gets the current status of Jolli Memory installation.
 *
 * Includes config paths and the count of worktrees that have the Claude hook
 * installed. Git repo information is resolved gracefully — if not in a git repo,
 * worktree-related fields are omitted.
 *
 * @param cwd - Optional working directory (defaults to process.cwd())
 */
export async function getStatus(cwd?: string): Promise<StatusInfo> {
	/* v8 ignore next - process.cwd() fallback only used when called without cwd arg */
	const projectDir = cwd ?? process.cwd();
	log.info("Checking Jolli Memory status");

	const claudeHookInstalled = await isClaudeHookInstalled(projectDir);
	const gitHookInstalled =
		(await isGitHookInstalled(projectDir)) &&
		(await isHookSectionInstalled(projectDir, "post-rewrite", POST_REWRITE_MARKER_START)) &&
		(await isHookSectionInstalled(projectDir, "prepare-commit-msg", PREPARE_MSG_MARKER_START));
	const sessions = await loadAllSessions(projectDir);
	const branchExists = await orphanBranchExists(ORPHAN_BRANCH, projectDir);
	const summaryCount = branchExists ? await getSummaryCount(projectDir) : 0;
	const geminiHookInstalled = await isGeminiHookInstalled(projectDir);
	const claudeDetected = await isClaudeInstalled();
	const codexDetected = await isCodexInstalled();
	const geminiDetected = await isGeminiInstalled();
	const openCodeDetected = await isOpenCodeInstalled();

	// Check if we can enumerate worktrees; falls back gracefully if not a git repo
	let enabledWorktrees: number | undefined;
	let canEnumerateWorktrees = false;

	try {
		await getProjectRootDir(projectDir);
		canEnumerateWorktrees = true;
	} catch {
		// Not a git repo or git not available — skip worktree enumeration
	}

	// Always load config from the global config directory
	const globalConfigDir = getGlobalConfigDir();
	const config = await loadConfigFromDir(globalConfigDir);
	const worktreeStatePath = getJolliMemoryDir(projectDir);

	// Only count sessions from enabled integrations
	const enabledSessions = filterSessionsByEnabledIntegrations(sessions, config);

	// Discover Codex sessions on-demand (not stored in sessions.json)
	let allEnabledSessions: ReadonlyArray<SessionInfo> = enabledSessions;
	if (config.codexEnabled !== false && codexDetected) {
		const codexSessions = await discoverCodexSessions(projectDir);
		if (codexSessions.length > 0) {
			allEnabledSessions = [...enabledSessions, ...codexSessions];
		}
	}

	// Discover OpenCode sessions on-demand (not stored in sessions.json).
	// Use scanOpenCodeSessions so we can surface real scan failures (corrupt DB,
	// schema drift, permission denied) rather than silently showing "0 sessions".
	let openCodeScanError: OpenCodeScanError | undefined;
	if (config.openCodeEnabled !== false && openCodeDetected) {
		const scan = await scanOpenCodeSessions(projectDir);
		if (scan.sessions.length > 0) {
			allEnabledSessions = [...allEnabledSessions, ...scan.sessions];
		}
		openCodeScanError = scan.error;
	}

	// Compute per-source session counts for integration status rows
	const sessionsBySource: Partial<Record<TranscriptSource, number>> = {};
	for (const s of allEnabledSessions) {
		const src = s.source ?? "claude";
		sessionsBySource[src] = (sessionsBySource[src] ?? 0) + 1;
	}

	const filteredMostRecent =
		allEnabledSessions.length > 0 ? allEnabledSessions.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b)) : null;

	if (canEnumerateWorktrees) {
		try {
			const worktrees = await listWorktrees(projectDir);
			const hookChecks = await Promise.all(
				worktrees.map(async (wt) => {
					const worktreeClaudeHookInstalled = await isClaudeHookInstalled(wt);
					const worktreeGeminiHookInstalled = geminiDetected ? await isGeminiHookInstalled(wt) : false;
					return hasRequiredWorktreeHooks(
						worktreeClaudeHookInstalled,
						worktreeGeminiHookInstalled,
						config,
						geminiDetected,
					);
				}),
			);
			enabledWorktrees = hookChecks.filter(Boolean).length;
		} catch {
			// Git repo resolved but worktree enumeration failed — leave count undefined
		}
	}

	const worktreeHooksInstalled = hasRequiredWorktreeHooks(
		claudeHookInstalled,
		geminiHookInstalled,
		config,
		geminiDetected,
	);

	// Enumerate all registered sources from dist-paths/<source>.
	// "Active runtime" = highest-version available entry — mirrors the run-hook
	// shell script's selection logic. No legacy `dist-path` fallback: every
	// install() runs migrateLegacyDistPath() which converts the legacy single
	// file into dist-paths/<derived> and deletes the original, so by the time
	// getStatus() runs the legacy file is gone.
	const allSources = traverseDistPaths();
	const winning = pickBestDistPath(allSources);
	const activeSource: { source: string; version: string } | undefined = winning
		? { source: winning.source, version: winning.version }
		: undefined;

	const status: StatusInfo = {
		// The extension is "enabled" when the git hook is installed.
		// Individual integration hooks (Claude, Codex, Gemini) have their own
		// status fields — a missing Claude hook should not disable the entire
		// extension when other integrations are still active.
		enabled: gitHookInstalled,
		claudeHookInstalled,
		gitHookInstalled,
		geminiHookInstalled,
		worktreeHooksInstalled,
		activeSessions: allEnabledSessions.length,
		mostRecentSession: filteredMostRecent,
		summaryCount,
		orphanBranch: ORPHAN_BRANCH,
		claudeDetected,
		codexDetected,
		codexEnabled: config.codexEnabled,
		geminiDetected,
		geminiEnabled: config.geminiEnabled,
		openCodeDetected,
		openCodeEnabled: config.openCodeEnabled,
		globalConfigDir,
		worktreeStatePath,
		enabledWorktrees,
		hookSource: activeSource?.source,
		hookVersion: activeSource?.version,
		allSources,
		sessionsBySource,
		openCodeScanError,
	};

	log.info(
		"Status: enabled=%s, claude=%s, git=%s, geminiHook=%s, worktreeHooks=%s, sessions=%d, summaries=%d, codex=%s/%s, gemini=%s/%s, enabledWorktrees=%s, opencode=%s/%s",
		status.enabled,
		status.claudeHookInstalled,
		status.gitHookInstalled,
		status.geminiHookInstalled,
		status.worktreeHooksInstalled,
		status.activeSessions,
		status.summaryCount,
		status.codexDetected,
		status.codexEnabled,
		status.geminiDetected,
		status.geminiEnabled,
		status.enabledWorktrees,
		status.openCodeDetected,
		status.openCodeEnabled,
	);

	return status;
}
