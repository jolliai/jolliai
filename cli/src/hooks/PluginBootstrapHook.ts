#!/usr/bin/env node
/**
 * The Claude plugin's only manifest hook.
 *
 * It keeps the bare /jolli menu available in every Git worktree and reconciles
 * the source-neutral repo hooks unless the repository carries the durable
 * manuallyDisabled opt-out. Business Stop/SessionStart work is never performed
 * by the plugin manifest itself; those hooks are installed into the repo and
 * dispatched through the shared run-hook resolver.
 */

import { resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isLocalAgentChild } from "../core/AgentReentry.js";
import { execGit, isInsideGitRepo } from "../core/GitOps.js";
import { withRepoHooksLock } from "../core/Locks.js";
import { readManualDisableFlag } from "../core/RepoProfile.js";
import { loadConfig, saveSession } from "../core/SessionTracker.js";
import { getClaudeAgentHookHealth } from "../install/ClaudeHookInstaller.js";
import { addGitExcludePaths } from "../install/GitExclude.js";
import { install, uninstall } from "../install/Installer.js";
import {
	installPluginJolliMenu,
	isPluginJolliMenuCanonical,
	PLUGIN_JOLLI_MENU_GIT_EXCLUDE_PATHS,
	removeClaudeLegacySkills,
} from "../install/SkillInstaller.js";
import { createLogger, setLogDir } from "../Logger.js";
import { readStdin } from "./HookUtils.js";
import { buildSessionStartContext, ensurePluginDefaultProvider } from "./SessionStartHook.js";

const log = createLogger("PluginBootstrapHook");
const SOURCE_TAG = "claude-plugin";
const AUTO_LOCK_OPTS = { timeoutMs: 200, pollMs: 25 } as const;

export interface PluginBootstrapOutput {
	readonly hookSpecificOutput: {
		readonly hookEventName: "SessionStart";
		readonly reloadSkills?: true;
		readonly additionalContext?: string;
	};
}

export function buildPluginBootstrapOutput(
	reloadSkills: boolean,
	additionalContext: string | null,
): PluginBootstrapOutput | null {
	if (!reloadSkills && !additionalContext) return null;
	return {
		hookSpecificOutput: {
			hookEventName: "SessionStart",
			...(reloadSkills ? { reloadSkills: true as const } : {}),
			...(additionalContext ? { additionalContext } : {}),
		},
	};
}

export async function runPluginBootstrap(
	projectDir: string,
	session?: { readonly sessionId?: string; readonly transcriptPath?: string },
): Promise<PluginBootstrapOutput | null> {
	if (!(await isInsideGitRepo(projectDir))) return null;
	const topLevel = await execGit(["rev-parse", "--show-toplevel"], projectDir);
	if (topLevel.exitCode !== 0 || !topLevel.stdout.trim()) return null;
	const worktreeRoot = topLevel.stdout.trim();
	setLogDir(worktreeRoot);

	const menuWasCanonicalAtEntry = await isPluginJolliMenuCanonical(worktreeRoot);
	const hookHealthAtEntry = await getClaudeAgentHookHealth(worktreeRoot);
	let disabled = false;

	const menuPhase = await withRepoHooksLock(
		worktreeRoot,
		async () => {
			await installPluginJolliMenu(worktreeRoot);
			await removeClaudeLegacySkills(worktreeRoot);
			await addGitExcludePaths(worktreeRoot, [...PLUGIN_JOLLI_MENU_GIT_EXCLUDE_PATHS]);
			disabled = await readManualDisableFlag(worktreeRoot);
			if (disabled) {
				await uninstall(worktreeRoot, { preserveMenu: true, repoLockHeld: true });
				return;
			}
			const config = await loadConfig();
			if (config.claudeEnabled !== false && session?.sessionId && session.transcriptPath) {
				try {
					await saveSession(
						{
							sessionId: session.sessionId,
							transcriptPath: session.transcriptPath,
							updatedAt: new Date().toISOString(),
							source: "claude",
						},
						worktreeRoot,
					);
				} catch (error: unknown) {
					log.warn("Plugin bootstrap could not record the first session: %s", (error as Error).message);
				}
			}
		},
		AUTO_LOCK_OPTS,
	);
	if (!menuPhase.acquired) {
		log.info("Plugin bootstrap deferred — repo hook lifecycle lock is busy");
		const reloadAfterPeer = !menuWasCanonicalAtEntry && (await isPluginJolliMenuCanonical(worktreeRoot));
		return buildPluginBootstrapOutput(reloadAfterPeer, null);
	}

	const reloadSkills = !menuWasCanonicalAtEntry && (await isPluginJolliMenuCanonical(worktreeRoot));
	if (disabled) return buildPluginBootstrapOutput(reloadSkills, null);

	const result = await install(worktreeRoot, {
		repoHooksOnly: true,
		sourceTag: SOURCE_TAG,
		respectManualDisable: true,
		automatic: true,
	});
	if (!result.success) {
		log.warn("Plugin repo-hook reconciliation failed: %s", result.message);
		return buildPluginBootstrapOutput(reloadSkills, null);
	}

	let context: string | null = null;
	const contextPhase = await withRepoHooksLock(
		worktreeRoot,
		async () => {
			if (await readManualDisableFlag(worktreeRoot)) return;
			const config = await loadConfig();
			if (config.claudeEnabled === false) return;
			await ensurePluginDefaultProvider(SOURCE_TAG, config);
			const hooksWereComplete = hookHealthAtEntry.stop && hookHealthAtEntry.sessionStart;
			context = await buildSessionStartContext(worktreeRoot, SOURCE_TAG, {
				includeBriefing: !hooksWereComplete,
				includePluginReminders: true,
			});
		},
		AUTO_LOCK_OPTS,
	);
	if (!contextPhase.acquired) {
		log.info("Plugin context deferred — repo hook lifecycle lock is busy");
	}

	return buildPluginBootstrapOutput(reloadSkills, context);
}

export async function main(): Promise<void> {
	if (isLocalAgentChild()) {
		log.info("Plugin bootstrap skipped — running inside a jollimemory-spawned local agent");
		return;
	}
	try {
		const input = await readStdin();
		const parsed = input.trim()
			? (JSON.parse(input) as { cwd?: string; session_id?: string; transcript_path?: string })
			: {};
		const output = await runPluginBootstrap(parsed.cwd ?? process.cwd(), {
			sessionId: parsed.session_id,
			transcriptPath: parsed.transcript_path,
		});
		if (output) process.stdout.write(JSON.stringify(output));
	} catch (error: unknown) {
		log.info("Plugin bootstrap failed: %s", (error as Error).message);
	}
}

/* v8 ignore start */
function isMainScript(): boolean {
	const scriptPath = fileURLToPath(import.meta.url);
	const argv1 = process.argv[1];
	return !process.env.VITEST && !!argv1 && pathResolve(argv1) === pathResolve(scriptPath);
}

if (isMainScript()) {
	main().catch(() => {
		console.error("[PluginBootstrapHook] Fatal error: bootstrap failed.");
		process.exit(0);
	});
}
/* v8 ignore stop */
