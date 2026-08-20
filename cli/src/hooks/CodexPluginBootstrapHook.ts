#!/usr/bin/env node
/**
 * The Codex plugin's only manifest hook.
 *
 * Mirrors PluginBootstrapHook's ROLE — reconcile the shared repo runtime on
 * SessionStart, respect the durable manuallyDisabled opt-out, hand the model a
 * branch briefing — while sharing none of its Claude-specific steps. Business
 * capture work is never done here; see "What this deliberately does NOT do" below.
 *
 * Why a separate hook rather than reusing the Claude one: that hook writes
 * `.claude/**` (the bare `/jolli` project skill, Claude legacy-skill cleanup,
 * Claude's git-exclude entries, Claude's Stop/SessionStart agent hooks). Running it
 * from a Codex session would let installing one plugin rewrite, upgrade or clean the
 * other host's assets on every session. The shared half now lives behind
 * `install(..., { repoHooksOnly: true, sourceTag })`, which is host-parameterized.
 *
 * What this deliberately does NOT do:
 *   - **No `.claude/**` writes.** Nothing host-specific to Claude, and the disabled
 *     path passes `preserveMenu: true` for the same reason (see below).
 *   - **No bare-menu install.** Codex plugin skills are flat-named, so the plugin
 *     ships `skills/jolli/SKILL.md` directly and `$jolli` resolves from the bundle.
 *     Claude only needs a repo-written project skill because its plugin skills are
 *     forced into `/jolli:<name>`, leaving a bare `/jolli` unreachable.
 *   - **No git-exclude entry.** The bootstrap creates no Codex-specific project
 *     skill, so there is no path that needs excluding.
 *   - **No skill de-duplication.** A repo that also ran a full `jolli enable` shows
 *     the plugin's bundled skills AND the `.agents/skills/` copies; that duplication
 *     is ACCEPTED. The only removal this bootstrap performs is the host-neutral
 *     RETIRED-name sweep (`removeRetiredSkills`) — deleting an ACTIVE skill from
 *     `.agents/` to tidy one host's picker takes the only copy Cursor, Gemini,
 *     OpenCode, Windsurf and Copilot have. See the Codex branch of the
 *     repo-hooks-only bootstrap in `Installer.ts` for the full history.
 *   - **No session recording.** Claude's Stop hook persists sessionId +
 *     transcriptPath because that is how its transcripts are located later. Codex
 *     transcripts are discovered by scanning `~/.codex/sessions/` at post-commit
 *     (CodexSessionDiscoverer), so recording here would duplicate a scan that has to
 *     happen anyway. The hook input does carry `transcript_path`, but Codex documents
 *     the transcript format as an unstable interface, so nothing here parses it.
 *   - **No artifact discovery.** Plans and references are driven from the queue
 *     worker at post-commit (see CodexDiscovery). A SessionStart hook is the wrong
 *     place: it fires once per session, so it could only ever catch the *previous*
 *     session's transcript tail.
 */

import { basename, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isLocalAgentChild } from "../core/AgentReentry.js";
import { execGit, isInsideGitRepo } from "../core/GitOps.js";
import { withRepoHooksLock } from "../core/Locks.js";
import { readManualDisableFlag } from "../core/RepoProfile.js";
import { loadConfig } from "../core/SessionTracker.js";
import { install, uninstall } from "../install/Installer.js";
import { createLogger, setLogDir } from "../Logger.js";
import { readStdin } from "./HookUtils.js";
import { capturePluginOnboardingSnapshot, type PluginFunnelSnapshot } from "./PluginBootstrapTelemetry.js";
import { buildSessionStartContext, ensurePluginDefaultProvider } from "./SessionStartHook.js";

const log = createLogger("CodexPluginBootstrapHook");
const SOURCE_TAG = "codex-plugin";
const AUTO_LOCK_OPTS = { timeoutMs: 200, pollMs: 25 } as const;

/**
 * Codex hook output — the SAME `hookSpecificOutput` envelope Claude Code uses, and
 * the nesting is mandatory.
 *
 * An earlier revision emitted a flat `{ additionalContext }` on the belief that Codex
 * reads those fields off the top level. It does not, and the failure was silent in
 * the worst way: `codex exec` printed `hook: SessionStart Failed` among other hooks'
 * failures, while the bootstrap's side effects (repo hooks, MCP registration) all
 * landed — so everything looked installed and no briefing ever reached the model.
 *
 * The contract is pinned by the JSON schema embedded in the codex binary
 * (`session-start.command.output`, read from codex-cli 0.146.0):
 *
 *     additionalProperties: false            ← an unknown TOP-LEVEL key is rejected
 *     properties: continue | hookSpecificOutput | stopReason | suppressOutput
 *                 | systemMessage
 *     SessionStartHookSpecificOutputWire:
 *       hookEventName: const "SessionStart"  ← REQUIRED
 *       additionalContext: string
 *       additionalProperties: false
 *
 * So `hookEventName` is not decoration — omitting it fails the same way the flat
 * shape did. There is deliberately no `reloadSkills`: Codex has no equivalent (it is
 * absent from the schema), and nothing needs reloading since the plugin's skills come
 * from its own bundle rather than a file this hook writes.
 *
 * Codex caps model-visible hook output at roughly 2,500 tokens and spills the excess
 * to disk; a briefing targets 300-500, so the cap is not a live constraint, but do
 * not grow this into a transcript dump.
 */
export interface CodexBootstrapOutput {
	readonly hookSpecificOutput: {
		readonly hookEventName: "SessionStart";
		readonly additionalContext: string;
	};
}

export function buildCodexBootstrapOutput(additionalContext: string | null): CodexBootstrapOutput | null {
	return additionalContext ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } } : null;
}

export async function runCodexPluginBootstrap(projectDir: string): Promise<CodexBootstrapOutput | null> {
	if (!(await isInsideGitRepo(projectDir))) return null;
	const topLevel = await execGit(["rev-parse", "--show-toplevel"], projectDir);
	if (topLevel.exitCode !== 0 || !topLevel.stdout.trim()) return null;
	const worktreeRoot = topLevel.stdout.trim();
	setLogDir(worktreeRoot);

	// Manual disable is repo-WIDE (RepoProfile anchors it to the main worktree), not
	// per-host, so a disabled repo means no host may run — tearing down the shared
	// repo hooks is the documented semantics of that flag, not an overreach into
	// Claude's territory.
	//
	// `preserveMenu: true` is load-bearing here even though this host never installs
	// a menu: with `false`, uninstall() calls removePluginJolliMenu() and would
	// delete Claude's `.claude/skills/jolli/`. A Codex session must not remove
	// another host's assets, so the flag stays true regardless of what this host owns.
	let disabled = false;
	const disablePhase = await withRepoHooksLock(
		worktreeRoot,
		async () => {
			disabled = await readManualDisableFlag(worktreeRoot);
			if (disabled) {
				await uninstall(worktreeRoot, { preserveMenu: true, repoLockHeld: true });
			}
		},
		AUTO_LOCK_OPTS,
	);
	if (!disablePhase.acquired) {
		log.info("Codex plugin bootstrap deferred — repo hook lifecycle lock is busy");
		return null;
	}
	if (disabled) return null;

	const result = await install(worktreeRoot, {
		repoHooksOnly: true,
		sourceTag: SOURCE_TAG,
		respectManualDisable: true,
		automatic: true,
	});
	if (!result.success) {
		log.warn("Codex plugin repo-hook reconciliation failed: %s", result.message);
		// Snapshot on the failure branch too — a setup that installs but never
		// reaches a working state is precisely the drop-off the funnel observes.
		// Nothing to overlap here, so await inline.
		await capturePluginOnboardingSnapshot(worktreeRoot, undefined, "codex").done;
		return null;
	}

	// Onboarding-funnel snapshot — this SessionStart hook is the only
	// per-session trigger for the codex-plugin surface (and it is trust-gated,
	// so /jolli:init's --repo-hooks-only emit can be the surface's only other
	// one). Mirrors the Claude hook: started INSIDE the context phase right
	// after ensurePluginDefaultProvider seeds the capture route (any earlier
	// and a fresh install's first snapshot misreports capture_method "none"),
	// started WITHOUT awaiting so its probes and bounded flush overlap the
	// briefing build, and awaited in the finally so no exit — thrown or
	// returned — orphans the in-flight chain. The Codex hook input carries no
	// session id.
	let funnel: PluginFunnelSnapshot | undefined;
	let context: string | null = null;
	let contextDeferred = false;
	try {
		const contextPhase = await withRepoHooksLock(
			worktreeRoot,
			async () => {
				// Re-read: the flag can flip between the phases above and this one.
				if (await readManualDisableFlag(worktreeRoot)) return;
				const config = await loadConfig();
				// Gated on codexEnabled, the mirror of the Claude path's claudeEnabled —
				// a user who turned Codex discovery off gets no briefing from it either.
				if (config.codexEnabled === false) return;
				// Seeds `local-agent` + this host's own tool (`codex`), first-wins. Shared
				// with the Claude path precisely so the two hosts cannot seed different
				// values for the same machine-global config.
				await ensurePluginDefaultProvider(SOURCE_TAG, config);
				funnel = capturePluginOnboardingSnapshot(worktreeRoot, undefined, "codex");
				// Always include the briefing: unlike the Claude path there is no
				// repo-installed SessionStart hook that would also produce one, so
				// skipping it here would mean no briefing at all.
				context = await buildSessionStartContext(worktreeRoot, SOURCE_TAG, {
					includeBriefing: true,
					includePluginReminders: true,
				});
			},
			AUTO_LOCK_OPTS,
		);
		contextDeferred = !contextPhase.acquired;
	} finally {
		funnel ??= capturePluginOnboardingSnapshot(worktreeRoot, undefined, "codex");
		await funnel.done;
	}
	if (contextDeferred) {
		log.info("Codex plugin context deferred — repo hook lifecycle lock is busy");
	}

	return buildCodexBootstrapOutput(context);
}

export async function main(): Promise<void> {
	if (isLocalAgentChild()) {
		log.info("Codex plugin bootstrap skipped — running inside a jollimemory-spawned local agent");
		return;
	}
	try {
		const input = await readStdin();
		// `cwd` is the session cwd. Codex documents that hook commands run with it as
		// their working directory and advises resolving from the git root rather than
		// relying on relative paths — `runCodexPluginBootstrap` does exactly that via
		// `rev-parse --show-toplevel`, which is also what keeps this correct inside a
		// linked git worktree.
		const parsed = input.trim() ? (JSON.parse(input) as { cwd?: string }) : {};
		const output = await runCodexPluginBootstrap(parsed.cwd ?? process.cwd());
		if (output) process.stdout.write(JSON.stringify(output));
		const { triggerEnsureGlobalDaemon } = await import("../daemon/EnsureGlobalDaemon.js");
		triggerEnsureGlobalDaemon();
	} catch (error: unknown) {
		log.info("Codex plugin bootstrap failed: %s", (error as Error).message);
	}
}

/**
 * True only when THIS module is the process entry point.
 *
 * The basename check is not redundant with the path comparison. esbuild rewrites
 * every inlined module's `import.meta.url` to the *bundle's* path, which is also
 * `argv[1]`, so the path comparison alone is true for every module inside a bundle —
 * and any module that self-runs on it executes as a side effect of being imported.
 * That has already shipped twice in this repo (`QueueWorker`, then `SessionStartHook`,
 * whose plain-text briefing landed on stdout ahead of THIS hook's JSON and failed the
 * whole SessionStart schema). Nothing imports this module today; the guard is here so
 * that stays a safe thing to do rather than a silent regression, since a stray write
 * to stdout from here is precisely what Codex rejects.
 */
/* v8 ignore start */
function isMainScript(): boolean {
	const argv1 = process.argv[1];
	if (process.env.VITEST || !argv1) return false;
	if (pathResolve(argv1) !== pathResolve(fileURLToPath(import.meta.url))) return false;
	const entryName = basename(argv1).toLowerCase();
	return entryName === "codexpluginbootstraphook.js" || entryName === "codexpluginbootstraphook.ts";
}

if (isMainScript()) {
	void main();
}
/* v8 ignore stop */
