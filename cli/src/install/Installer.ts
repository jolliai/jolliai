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
import { isCopilotChatInstalled } from "../core/CopilotChatDetector.js";
import { scanCopilotChatSessions } from "../core/CopilotChatSessionDiscoverer.js";
import type { CopilotChatScanError } from "../core/CopilotChatTranscriptReader.js";
import { isCopilotInstalled } from "../core/CopilotDetector.js";
import { scanCopilotSessions } from "../core/CopilotSessionDiscoverer.js";
import { isCursorInstalled } from "../core/CursorDetector.js";
import { scanCursorSessions } from "../core/CursorSessionDiscoverer.js";
import { isGeminiInstalled } from "../core/GeminiSessionDetector.js";
import { getProjectRootDir, listWorktrees, orphanBranchExists } from "../core/GitOps.js";
import {
	isOpenCodeInstalled,
	type OpenCodeScanError,
	scanOpenCodeSessions,
} from "../core/OpenCodeSessionDiscoverer.js";
import { readSchemaV5State } from "../core/SchemaV5Migration.js";
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
import type { SqliteScanError } from "../core/SqliteHelpers.js";
import type { StorageProvider } from "../core/StorageProvider.js";
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
import { updateGitExclude } from "./GitExclude.js";
import {
	installGitHook,
	installPostMergeHook,
	installPostRewriteHook,
	installPrepareMsgHook,
	isGitHookInstalled,
	isHookSectionInstalled,
	POST_MERGE_MARKER_START,
	POST_REWRITE_MARKER_START,
	PREPARE_MSG_MARKER_START,
	removeGitHook,
	removePostMergeHook,
	removePostRewriteHook,
	removePrepareMsgHook,
} from "./GitHookInstaller.js";
import { installGlobalInstructions } from "./GlobalInstructionsInstaller.js";
import type { HookOpResult } from "./HookSettingsHelper.js";
import {
	buildRegistrars,
	type DetectedHosts,
	registerGlobalMcpHosts,
	registerRepoMcpHosts,
	removeRepoMcpHosts,
} from "./mcp/HostRegistrars.js";
import { SKILL_GIT_EXCLUDE_PATHS, updateSkillIfNeeded } from "./SkillInstaller.js";

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

		// Run host detectors once before the per-worktree loop so each detector
		// is called exactly once. Results are reused both inside the loop (for MCP
		// registration) and after it (for auto-enable config writes / hook installs).
		const codexDetectedOnce = await isCodexInstalled();
		const geminiDetectedOnce = await isGeminiInstalled();
		const cursorDetectedOnce = await isCursorInstalled();
		const opencodeDetectedOnce = await isOpenCodeInstalled();
		const copilotDetectedOnce = await isCopilotInstalled();
		const copilotChatDetectedOnce = await isCopilotChatInstalled();

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
			// SKILL.md is written for every enabled target — the cross-platform
			// `.agents/skills/` target is unconditional, and `.claude/skills/`
			// is gated inside the installer on `config.claudeEnabled !== false`.
			// We update SKILL.md before the Claude-hook gate below so disabling
			// Claude doesn't strand the `.agents/` skills target unupdated.
			await updateSkillIfNeeded(wt, { claudeEnabled: config.claudeEnabled });
			// Build the set of detected hosts for this worktree iteration.
			// Claude's detected state mirrors the claudeEnabled config flag so
			// a user who has disabled Claude still gets non-Claude hosts registered.
			// Other detectors use the values computed once before the loop.
			// NOTE: MCP registration is intentionally gated by host DETECTION only,
			// independent of the per-host *Enabled discovery flags (cursorEnabled,
			// copilotEnabled, …) — the documented MCP philosophy: "MCP registration
			// runs regardless of claudeEnabled; the hook and MCP are independent
			// decisions." So a detected host is wired for MCP even if its session
			// discovery is disabled. Do not "fix" this into flag-gating.
			const detected: DetectedHosts = {
				claude: config.claudeEnabled !== false,
				codex: codexDetectedOnce,
				cursor: cursorDetectedOnce,
				gemini: geminiDetectedOnce,
				opencode: opencodeDetectedOnce,
				copilot: copilotDetectedOnce,
				copilotChat: copilotChatDetectedOnce,
			};
			// Keep the user's `git status` clean by adding Jolli-managed paths to
			// `.git/info/exclude`. Worktree-aware: linked worktrees may have their
			// own gitdir, so we resolve per-worktree. We compute the union of all
			// active registrars' gitExcludePaths so each host's config file is
			// covered (e.g. `.cursor/mcp.json` when Cursor is detected). Global
			// hosts contribute [] here — their configs live outside the repo.
			await updateGitExclude(wt, [
				...SKILL_GIT_EXCLUDE_PATHS,
				...buildRegistrars(detected).flatMap((r) => r.gitExcludePaths()),
			]);
			// Register the MCP server in the detected REPO-scoped hosts (Claude,
			// Cursor) whose config lives in this worktree. This runs BEFORE the
			// claudeEnabled gate so Cursor users with Claude disabled still get MCP
			// registered. Each host is isolated — a failure in one never blocks the
			// others. Global hosts are registered once after the loop (below).
			await registerRepoMcpHosts(wt, detected);

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
			// Install SessionStart hook for auto-briefing
			await installSessionStartHook(wt);
		}

		// Register the MCP server in the detected GLOBAL hosts (Codex, Gemini,
		// OpenCode, Copilot, Copilot Chat). Their config files are machine-wide and
		// shared across every repo, so we write them ONCE here rather than rewriting
		// the same file on each worktree iteration above. Detection-gated only.
		await registerGlobalMcpHosts({
			claude: false,
			cursor: false,
			codex: codexDetectedOnce,
			gemini: geminiDetectedOnce,
			opencode: opencodeDetectedOnce,
			copilot: copilotDetectedOnce,
			copilotChat: copilotChatDetectedOnce,
		});

		// Prefer Jolli's skills by default: write a standing rule into each
		// enabled host's GLOBAL instruction file. Machine-global (one per host,
		// shared by every repo) — mirrors registerGlobalMcpHosts above, and like
		// it, uninstall deliberately leaves the block in place. Gating matches the
		// hooks: gemini/codex are detection-gated (never create their file on a
		// machine without them), while Claude has no filesystem detector and is
		// gated only on `claudeEnabled` — so `~/.claude/CLAUDE.md` is created
		// whenever Claude isn't explicitly disabled, consistent with the rest of
		// the installer treating Claude as the primary host.
		await installGlobalInstructions({
			claude: config.claudeEnabled !== false,
			gemini: geminiDetectedOnce && config.geminiEnabled !== false,
			codex: codexDetectedOnce && config.codexEnabled !== false,
		});

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

		// Install Git post-merge hook (auto-compiles merged branch summaries after pull/merge)
		const postMergeResult = await installPostMergeHook(projectDir);
		if (postMergeResult.warning) {
			warnings.push(postMergeResult.warning);
		}

		// Auto-detect Codex CLI and enable session discovery (saved to global config)
		if (codexDetectedOnce) {
			if (config.codexEnabled === undefined) {
				await saveConfig({ codexEnabled: true });
				log.info("Codex CLI detected — enabled Codex session discovery");
			}
		}

		// Auto-detect Gemini CLI and install AfterAgent hook in all worktrees (if enabled)
		let geminiSettingsPath: string | undefined;
		if (geminiDetectedOnce && config.geminiEnabled !== false) {
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
		const openCodeDetected = config.openCodeEnabled !== false && opencodeDetectedOnce;
		if (openCodeDetected) {
			if (config.openCodeEnabled === undefined) {
				await saveConfig({ openCodeEnabled: true });
				log.info("OpenCode detected — enabled OpenCode session discovery");
			}
		}

		// Auto-detect Cursor and enable Composer session discovery
		const cursorDetected = config.cursorEnabled !== false && cursorDetectedOnce;
		if (cursorDetected) {
			if (config.cursorEnabled === undefined) {
				await saveConfig({ cursorEnabled: true });
				log.info("Cursor detected — enabled Cursor Composer session discovery");
			}
		}

		// Auto-detect GitHub Copilot in either form (terminal CLI or vscode Chat) and
		// enable the shared copilotEnabled flag. Both sources share one toggle —
		// see docs/superpowers/specs/2026-05-06-copilot-chat-support-design.md.
		const copilotDetected = config.copilotEnabled !== false && copilotDetectedOnce;
		const copilotChatDetected = config.copilotEnabled !== false && copilotChatDetectedOnce;
		if ((copilotDetected || copilotChatDetected) && config.copilotEnabled === undefined) {
			await saveConfig({ copilotEnabled: true });
			log.info(
				"GitHub Copilot detected (CLI=%s, Chat=%s) — enabled session discovery",
				copilotDetected,
				copilotChatDetected,
			);
		}

		// Migrate any existing worktree-level API keys to the global config dir.
		// The worktrees list always includes the main repo root as its first entry.
		for (const wt of worktrees) {
			await migrateWorktreeConfig(wt);
		}

		// v3 → v4 → v5 unified schema migration. Idempotent: `migrateSchemaToV5`
		// reads its own state file, skips when already completed, and also
		// skips when no orphan branch exists yet (fresh install with no commits
		// to migrate). Failure is non-fatal so an LLM-quota-exhausted or
		// lock-contended install still succeeds; user can re-run via
		// `jolli migrate`.
		//
		// Skipped on the VSCode path because Extension.ts owns the migration
		// call there — it wraps the work in `setMigrating(true/false)` across
		// the three sidebar stores so the user sees a "Migrating memories..."
		// affordance, which we cannot reproduce from inside the CLI. Running
		// here as well would have both callers race for `orphan-write.lock`
		// and time one of them out after 30 s (the symptom that originally
		// surfaced this bug — see git history of this block).
		if (options?.source === "vscode-extension") {
			log.info("Skipping v5 migration on vscode-extension source — Extension.ts owns it with UI");
		} else {
			try {
				const { migrateSchemaToV5 } = await import("../core/SchemaV5Migration.js");
				const v5Result = await migrateSchemaToV5(projectDir);
				log.info(
					"Schema v5 migration: alreadyDone=%s fresh=%s migrated=%d skipped=%d",
					v5Result.alreadyDone,
					v5Result.fresh,
					v5Result.migrated,
					v5Result.skipped,
				);
			} catch (err: unknown) {
				log.warn("Schema v5 migration failed (non-fatal): %s", (err as Error).message);
			}
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
			postMergeHookPath: postMergeResult.path,
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
			// Remove MCP entries from this repo's REPO-scoped hosts (Claude's
			// .mcp.json, Cursor's .cursor/mcp.json). Global hosts (Codex/Gemini/
			// OpenCode/Copilot/Copilot Chat) are intentionally left untouched: their
			// jollimemory entry is shared by every repo on the machine, so removing
			// it here would break MCP for other repos still using Jolli. Non-fatal: a
			// failure in one host (e.g. EPERM on a read-only .mcp.json) must not abort
			// the uninstall, or the shared git hooks below would leak and post-commit
			// would keep firing after the user believes they've uninstalled.
			// removeRepoMcpHosts is internally per-host non-fatal, so no outer
			// try/catch is needed here, but we keep one for defensive parity.
			try {
				await removeRepoMcpHosts(wt);
			} catch (mcpErr) {
				log.warn("MCP removal failed in %s (non-fatal): %s", wt, (mcpErr as Error).message);
			}
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
		await removePostMergeHook(projectDir);

		// Conservative skill-cleanup policy: leave the generated SKILL.md files
		// AND the `.git/info/exclude` block alone. Users sometimes ship their
		// own skills alongside Jolli's under `.claude/skills/` or
		// `.agents/skills/`, and a blind `rm -rf` of those directories on
		// uninstall would delete unrelated user content. The exclude block is
		// also harmless if left behind — git silently ignores entries that no
		// longer match anything. Leaving the files behind also means re-enabling
		// Jolli later is a no-op.
		warnings.push(
			"Skill files were left in place. To remove them manually: `rm -rf .agents/skills/jolli-* .claude/skills/jolli-*` and delete the `# >>> jolli skill exclude >>>` block from `.git/info/exclude` if you no longer want it.",
		);

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
 * @param cwd     - Optional working directory (defaults to process.cwd())
 * @param storage - Optional StorageProvider for `getSummaryCount`. Threaded by
 *                  the VS Code extension's `JolliMemoryBridge`; the CLI/hook
 *                  process omits it and relies on the module-level
 *                  `setActiveStorage` override installed by `QueueWorker`.
 */
export async function getStatus(cwd?: string, storage?: StorageProvider): Promise<StatusInfo> {
	/* v8 ignore next - process.cwd() fallback only used when called without cwd arg */
	const projectDir = cwd ?? process.cwd();
	log.info("Checking Jolli Memory status");

	const claudeHookInstalled = await isClaudeHookInstalled(projectDir);
	const gitHookInstalled =
		(await isGitHookInstalled(projectDir)) &&
		(await isHookSectionInstalled(projectDir, "post-rewrite", POST_REWRITE_MARKER_START)) &&
		(await isHookSectionInstalled(projectDir, "prepare-commit-msg", PREPARE_MSG_MARKER_START)) &&
		(await isHookSectionInstalled(projectDir, "post-merge", POST_MERGE_MARKER_START));
	const sessions = await loadAllSessions(projectDir);
	const branchExists = await orphanBranchExists(ORPHAN_BRANCH, projectDir);
	const summaryCount = branchExists ? await getSummaryCount(projectDir, storage) : 0;
	const geminiHookInstalled = await isGeminiHookInstalled(projectDir);
	const claudeDetected = await isClaudeInstalled();
	const codexDetected = await isCodexInstalled();
	const geminiDetected = await isGeminiInstalled();
	const openCodeDetected = await isOpenCodeInstalled();
	const cursorDetected = await isCursorInstalled();
	const copilotDetected = await isCopilotInstalled();
	const copilotChatDetected = await isCopilotChatInstalled();

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

	// Discover Cursor Composer sessions on-demand (not stored in sessions.json).
	let cursorScanError: SqliteScanError | undefined;
	if (config.cursorEnabled !== false && cursorDetected) {
		const scan = await scanCursorSessions(projectDir);
		if (scan.sessions.length > 0) {
			allEnabledSessions = [...allEnabledSessions, ...scan.sessions];
		}
		cursorScanError = scan.error;
	}

	// Discover Copilot CLI sessions on-demand (not stored in sessions.json).
	let copilotScanError: SqliteScanError | undefined;
	if (config.copilotEnabled !== false && copilotDetected) {
		const scan = await scanCopilotSessions(projectDir);
		if (scan.sessions.length > 0) {
			allEnabledSessions = [...allEnabledSessions, ...scan.sessions];
		}
		copilotScanError = scan.error;
	}

	// Discover Copilot Chat sessions on-demand (not stored in sessions.json).
	let copilotChatScanError: CopilotChatScanError | undefined;
	if (config.copilotEnabled !== false && copilotChatDetected) {
		const scan = await scanCopilotChatSessions(projectDir);
		if (scan.sessions.length > 0) {
			allEnabledSessions = [...allEnabledSessions, ...scan.sessions];
		}
		copilotChatScanError = scan.error;
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

	// v5 schema migration state. `readSchemaV5State` reads through the active
	// StorageProvider (passed `storage` when the VS Code bridge supplies one,
	// otherwise constructed from `cwd`), so this reports correctly in
	// folder-only mode too — NOT gated on `branchExists`, which would leave
	// folder-only repos (no orphan branch) permanently showing "Not migrated".
	// `null` = pending → schemaV5 stays undefined, same as a genuinely empty
	// repo with no data to migrate.
	let schemaV5: StatusInfo["schemaV5"];
	try {
		const state = await readSchemaV5State(projectDir, storage);
		if (state) {
			schemaV5 = state.status;
		}
	} catch {
		// Read errors are non-fatal — leave schemaV5 undefined ("unknown") so
		// the status display can prompt the user to check / re-run migrate.
	}

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
		cursorDetected,
		cursorEnabled: config.cursorEnabled,
		cursorScanError,
		copilotDetected,
		copilotEnabled: config.copilotEnabled,
		copilotScanError,
		copilotChatDetected,
		copilotChatScanError,
		globalConfigDir,
		worktreeStatePath,
		enabledWorktrees,
		hookSource: activeSource?.source,
		hookVersion: activeSource?.version,
		allSources,
		sessionsBySource,
		openCodeScanError,
		...(schemaV5 !== undefined && { schemaV5 }),
	};

	log.info(
		"Status: enabled=%s, claude=%s, git=%s, geminiHook=%s, worktreeHooks=%s, sessions=%d, summaries=%d, codex=%s/%s, gemini=%s/%s, enabledWorktrees=%s, opencode=%s/%s, cursor=%s/%s, copilot=%s/%s, copilotChat=%s",
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
		status.cursorDetected,
		status.cursorEnabled,
		status.copilotDetected,
		status.copilotEnabled,
		status.copilotChatDetected,
	);

	return status;
}
