#!/usr/bin/env node
/**
 * The Cursor plugin's only manifest hook.
 *
 * Sibling of {@link file://./CodexPluginBootstrapHook.ts} and the same ROLE —
 * reconcile the shared repo runtime on session start, respect the durable
 * manuallyDisabled opt-out, hand the model a branch briefing — sharing the
 * host-parameterized half through `install(..., { repoHooksOnly: true, sourceTag })`.
 * Business capture work is never done here; see "What this deliberately does NOT do".
 *
 * Three things differ from the Codex bootstrap, all forced by the host:
 *
 *   1. **The output envelope is FLAT.** Cursor's `sessionStart` hook returns
 *      `{ env?, additional_context? }` at the top level. Claude and Codex both nest
 *      the briefing under `hookSpecificOutput.additionalContext`; emitting that shape
 *      here would put the briefing where Cursor never looks. See
 *      {@link CursorBootstrapOutput}.
 *   2. **The project directory comes from `workspace_roots`, and `cwd` is a TRAP.**
 *      Cursor's common hook input carries `workspace_roots: string[]` and sets
 *      `CURSOR_PROJECT_DIR`; unlike Codex it documents no `cwd` field — and it runs a
 *      plugin hook with the PLUGIN INSTALL DIRECTORY as the process cwd (measured on
 *      3.15.6). See {@link resolveCursorProjectDir}, which refuses a plugin-bundle cwd
 *      rather than bootstrapping the bundle it was launched from.
 *   3. **MCP is repo-scoped, so nothing special happens here.** The Codex bootstrap
 *      has to punch a hole in `--repo-hooks-only` to write a GLOBAL
 *      `~/.codex/config.toml` entry, because a plugin-shipped `mcp.json` would pin the
 *      server's cwd to the plugin root and make it answer for the wrong repository.
 *      Cursor's own MCP config lives in the workspace (`.cursor/mcp.json`), so the
 *      normal repo registrar is already the right writer — this plugin likewise ships
 *      no `mcp.json`, and `Installer` registers the repo host for `pluginHost ===
 *      "cursor"`.
 *
 * What this deliberately does NOT do:
 *   - **No `.claude/**` writes.** Nothing host-specific to Claude, and the disabled
 *     path passes `preserveMenu: true` so tearing down this host cannot delete
 *     another host's assets.
 *   - **No install into a repository that has not opted in.** The one place this host
 *     diverges from the Claude and Codex bootstraps, which install into whatever
 *     repository the session names. See the consent gate in
 *     {@link runCursorPluginBootstrap}. The gate covers what lands in a WORKTREE;
 *     the two machine-global writes that make the front door work are unconditional
 *     — the `/jolli` skill itself (Cursor's chat-first window names no repository at
 *     all, so a per-repo copy could never reach it) and the runtime registry that
 *     gives every skill a `run-cli` to shell. See {@link main} for why the second one
 *     is load-bearing rather than an optimisation.
 *   - **No skill de-duplication.** A repo that also ran a full `jolli enable` shows
 *     the plugin's bundled skills AND the `.agents/skills/` copies; that duplication
 *     is ACCEPTED. Deleting an ACTIVE skill from `.agents/` to tidy one host's picker
 *     takes the only copy Codex, Gemini, OpenCode, Windsurf and Copilot have. The
 *     only removal performed is the host-neutral RETIRED-name sweep, which runs
 *     inside the shared repo-hooks-only path.
 *   - **No session recording and no artifact discovery.** Cursor sessions are
 *     discovered by scanning its own store at post-commit (CursorSessionDiscoverer /
 *     CursorDetector), so recording here would duplicate a scan that has to happen
 *     anyway — and a session-start hook could only ever catch the PREVIOUS session's
 *     transcript tail.
 */

import { homedir } from "node:os";
import { basename, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isLocalAgentChild } from "../core/AgentReentry.js";
import { execGit, isInsideGitRepo } from "../core/GitOps.js";
import { withRepoHooksLock } from "../core/Locks.js";
import { isPluginBundleCwd } from "../core/PluginBundlePaths.js";
import { readManualDisableFlag } from "../core/RepoProfile.js";
import { loadConfig } from "../core/SessionTracker.js";
import { removeCursorGlobalMenu } from "../install/CursorPluginSkills.js";
import { isGitHookInstalled } from "../install/GitHookInstaller.js";
import { install, reconcileRuntimeRegistry, uninstall } from "../install/Installer.js";
import { createLogger, setLogDir } from "../Logger.js";
import { readStdin } from "./HookUtils.js";
import { buildSessionStartContext, ensurePluginDefaultProvider } from "./SessionStartHook.js";

const log = createLogger("CursorPluginBootstrapHook");
const SOURCE_TAG = "cursor-plugin";
const AUTO_LOCK_OPTS = { timeoutMs: 200, pollMs: 25 } as const;

/**
 * Cursor `sessionStart` hook output — FLAT, with snake_case keys.
 *
 * Cursor documents this event's output as `{ env?: object, additional_context?:
 * string }` at the top level. Do not "unify" it with the Claude/Codex
 * `hookSpecificOutput` envelope: that nesting is those hosts' contract, and Cursor
 * would simply not find the briefing. `env` is left unset — seeding environment
 * variables into the user's session is a bigger claim than a briefing, and nothing
 * needs it.
 *
 * `sessionStart` is fire-and-forget on this host, so an empty briefing means writing
 * nothing at all rather than an empty object.
 */
export interface CursorBootstrapOutput {
	readonly additional_context: string;
}

export function buildCursorBootstrapOutput(additionalContext: string | null): CursorBootstrapOutput | null {
	return additionalContext ? { additional_context: additionalContext } : null;
}

/**
 * The workspace this session is for, or null when the host did not name one.
 *
 * **`process.cwd()` is NOT a usable fallback here, and that is measured.** Cursor runs
 * a plugin hook with the PLUGIN INSTALL DIRECTORY as its cwd — captured live on Cursor
 * 3.15.6, where a `sessionStart` probe reported
 * `pwd=~/.cursor/plugins/local/<plugin>` while `workspace_roots` named the real
 * workspace. (`_getHookCwd` in Cursor's bundle returns `file(installPath)` for every
 * plugin-sourced hook; only `stop` and `subagentStop` get `workspace.folders[0]`.) So
 * trusting cwd would hand this bootstrap the bundle it was launched from — and because
 * a marketplace served over git leaves its cache as a REAL checkout, `rev-parse
 * --show-toplevel` would succeed there and jolli would install git hooks into the
 * plugin cache repository. Same class of failure as a plugin-launched MCP server
 * answering for its own cache directory.
 *
 * Order, therefore:
 *   1. `workspace_roots[0]` — the documented common field, present on every event this
 *      hook sees (verified in the capture above).
 *   2. `CURSOR_PROJECT_DIR` — documented as always present, and confirmed set to the
 *      workspace even while cwd was the bundle. Covers a build that drops the array.
 *   3. `process.cwd()` — kept so a future Cursor that runs hooks in the workspace still
 *      works.
 *
 * **Every candidate is screened, not just cwd.** The harm being prevented is installing
 * this repo's git hooks into a marketplace cache — which is itself a real checkout, so
 * `rev-parse` would happily accept it — and that harm is identical whichever channel
 * supplied the path. The screen is a pure string compare, so applying it uniformly
 * costs nothing and removes the need to trust each source separately. A screened-out
 * candidate falls through to the next one rather than aborting: a bundle-valued
 * `workspace_roots` should not suppress a perfectly good `CURSOR_PROJECT_DIR`.
 *
 * Returning null when all three are unusable is deliberate: no bootstrap is a safe
 * no-op, whereas bootstrapping the wrong directory is not.
 *
 * A multi-root workspace yields several roots; the first is taken and the rest
 * ignored, matching every other surface's "one repository per install" model.
 */
export function resolveCursorProjectDir(input: { workspace_roots?: unknown }, env: NodeJS.ProcessEnv): string | null {
	const roots = input.workspace_roots;
	const candidates: ReadonlyArray<string | undefined> = [
		Array.isArray(roots)
			? roots.find((root): root is string => typeof root === "string" && root.trim().length > 0)
			: undefined,
		env.CURSOR_PROJECT_DIR,
		process.cwd(),
	];
	for (const candidate of candidates) {
		if (candidate === undefined || candidate.trim().length === 0) continue;
		if (isPluginBundleCwd(candidate)) continue;
		return candidate;
	}
	return null;
}

export async function runCursorPluginBootstrap(projectDir: string): Promise<CursorBootstrapOutput | null> {
	// Both "not a repository" exits are LOGGED, and that is not noise.
	//
	// `setLogDir` has not run yet at this point, so these land in the machine-global
	// `~/.jolli/jollimemory/debug.log` — deliberately, since there is no repository to
	// write into. Without them, "the hook ran and decided to do nothing" is
	// indistinguishable in the log from "the hook never ran", and the two have opposite
	// fixes: the first is a cwd that names no repository, the second is Cursor not
	// registering the plugin's hooks until it is fully restarted. Diagnosing exactly that
	// pair took several rounds against a silent log.
	if (!(await isInsideGitRepo(projectDir))) {
		log.info("Cursor plugin bootstrap: %s is not inside a git repository — nothing to do", projectDir);
		return null;
	}
	const topLevel = await execGit(["rev-parse", "--show-toplevel"], projectDir);
	if (topLevel.exitCode !== 0 || !topLevel.stdout.trim()) {
		log.info("Cursor plugin bootstrap: could not resolve a worktree root from %s — nothing to do", projectDir);
		return null;
	}
	const worktreeRoot = topLevel.stdout.trim();

	// THE CONSENT GATE, and it has to be the FIRST thing that happens to this path.
	//
	// "Untouched" means byte-identical, and the two lines that used to precede it both
	// WRITE into the repository: `setLogDir` re-points the logger, whose first line
	// creates `.jolli/jollimemory/debug.log`, and `readManualDisableFlag` normalises and
	// saves `profile.json`. Measured on a fresh `git init` repo — the gate worked, no
	// git hooks and no `.cursor/` were written, and the repo still came out with a
	// `.jolli/` directory whose debug.log said "leaving it untouched".
	//
	// Ordering it ahead of the manual-disable check costs nothing: that check exists to
	// TEAR DOWN a repo whose user opted out, and a repo with no hooks has nothing to
	// tear down.
	//
	// This is the one place this host diverges from the Claude and Codex bootstraps,
	// which install into whatever repository the session names, every session. On Cursor
	// "a repository the session names" includes every repo listed in the sidebar — a
	// `workspaceOpen` fires for each at startup — so auto-install would reach
	// repositories the user only ever browsed. An un-opted-in repo is left ALONE, which
	// is the correct state for it and not a fault to repair: `/jolli` is machine-global
	// (see `ensureCursorGlobalMenu`) and its Step 2 routes a not-set-up repo into
	// `/jolli-init`, which owns enable → sign-in → bind.
	//
	// `isGitHookInstalled` is the predicate rather than a flag of our own because
	// `getStatus` already derives `enabled` from it — so this gate and the state
	// `/jolli` displays cannot disagree.
	//
	// The log line goes to the machine-global `~/.jolli/jollimemory/` rather than the
	// repo, and that is not a detail — the logger falls back to `process.cwd()` when no
	// dir is set, which in this hook is the PLUGIN BUNDLE, so staying silent about where
	// to write would drop a debug.log inside the marketplace cache instead.
	if (!(await isGitHookInstalled(worktreeRoot))) {
		setLogDir(homedir());
		log.info("Cursor plugin bootstrap: %s has not opted in — leaving it untouched", worktreeRoot);
		return null;
	}

	setLogDir(worktreeRoot);

	// Manual disable is repo-WIDE (RepoProfile anchors it to the main worktree), not
	// per-host, so a disabled repo means no host may run — tearing down the shared
	// repo hooks is the documented semantics of that flag, not an overreach into
	// another host's territory.
	//
	// `preserveMenu: true` is load-bearing here even though this host never installs
	// a menu: with `false`, uninstall() calls removePluginJolliMenu() and would
	// delete Claude's `.claude/skills/jolli/`. A Cursor session must not remove
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
		log.info("Cursor plugin bootstrap deferred — repo hook lifecycle lock is busy");
		return null;
	}
	if (disabled) return null;

	// Everything below MAINTAINS a repo that already said yes — an upgrade moves the
	// version-stamped bundle, and the mirrored skills are symlinks into it that someone
	// has to re-point. The consent gate that decides "already said yes" is at the top of
	// this function, where it has to be; see the comment there.
	const result = await install(worktreeRoot, {
		repoHooksOnly: true,
		sourceTag: SOURCE_TAG,
		respectManualDisable: true,
		automatic: true,
	});
	if (!result.success) {
		log.warn("Cursor plugin repo-hook reconciliation failed: %s", result.message);
		return null;
	}

	let context: string | null = null;
	const contextPhase = await withRepoHooksLock(
		worktreeRoot,
		async () => {
			// Re-read: the flag can flip between the phases above and this one.
			if (await readManualDisableFlag(worktreeRoot)) return;
			const config = await loadConfig();
			// Gated on cursorEnabled, the mirror of the Claude path's claudeEnabled —
			// a user who turned Cursor discovery off gets no briefing from it either.
			if (config.cursorEnabled === false) return;
			// Seeds `local-agent` + this host's own tool (`cursor-agent`), first-wins.
			// Shared with the other plugin hosts precisely so no two of them can seed
			// different values for the same machine-global config.
			await ensurePluginDefaultProvider(SOURCE_TAG, config);
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
	if (!contextPhase.acquired) {
		log.info("Cursor plugin context deferred — repo hook lifecycle lock is busy");
	}

	return buildCursorBootstrapOutput(context);
}

export async function main(): Promise<void> {
	if (isLocalAgentChild()) {
		log.info("Cursor plugin bootstrap skipped — running inside a jollimemory-spawned local agent");
		return;
	}
	try {
		const input = await readStdin();
		const parsed = input.trim() ? (JSON.parse(input) as { workspace_roots?: unknown }) : {};
		// Machine-global from here to the repository branch, so say so before the first
		// write. The logger falls back to `process.cwd()`, which in this hook is the
		// PLUGIN BUNDLE — the same hazard the consent gate documents, reached one step
		// earlier: `installHookScripts` and `upsertSkill` both log at info level, so
		// staying silent here drops a `.jolli/jollimemory/debug.log` inside the
		// marketplace cache. `runCursorPluginBootstrap` re-points this to the worktree
		// once it has one.
		setLogDir(homedir());
		// The front door is BUNDLED now, so there is nothing to write here — only an old
		// copy to take away. Earlier versions planted it machine-global at
		// `~/.cursor/skills/jolli/` because the chat-first Agents Window names no
		// workspace; measured on 3.16.29, a bundled skill reaches that surface perfectly
		// well (see CURSOR_PLUGIN_SKILLS), and bundling additionally fixes what this hook
		// could never fix from here: a freshly installed plugin's hooks are not registered
		// until Cursor fully restarts, so on a new install this line did not run at all and
		// the user had eleven skills and no menu.
		//
		// Ownership-guarded, and idempotent once the leftover is gone. Ordered ahead of the
		// repository branch so a repo-side failure cannot leave a duplicate behind.
		await removeCursorGlobalMenu();
		// Then register this runtime, and do it WITHOUT a repository — which is not a
		// hole in the consent gate below, because nothing here touches a repository.
		// The three dispatch scripts and `dist-paths/cursor-plugin` are machine-global
		// (`~/.jolli/jollimemory/`), byte-identical across every surface, and say only
		// "a runtime of this version lives here" — the same claim `recordCursorPluginRoot`
		// just made one line up. What the gate protects is `.git/hooks/*` and `.cursor/`
		// in a repository the user only browsed; that stays gated.
		//
		// Without this, a plugin-only machine has NO `run-cli` at all, and the entire
		// documented setup path is a closed loop: `/jolli`'s Step 0 finds neither an MCP
		// tool (this bundle ships no `mcp.json`, and `.cursor/mcp.json` is written by the
		// install the gate defers) nor the dispatcher, so it reports Jolli as uninstalled
		// and offers `rm -rf ~/.cursor/skills/jolli` — to a user who installed it minutes
		// ago. `/jolli-init` fares no better: every step shells `run-cli`, and its
		// dispatcher-missing remedy is "reload the window so the sessionStart hook runs",
		// which is THIS hook, which used to return before writing it. Reload forever.
		//
		// Ordered after the front door for the same reason the front door is first: a
		// failure here must not cost the user their menu. It is not fatal on its own —
		// the reconcile answers false on a busy lock or an incomplete dist, and a session
		// with the MCP tools registered still routes fine — so it is logged, not thrown.
		if (!(await reconcileRuntimeRegistry(SOURCE_TAG, undefined, AUTO_LOCK_OPTS))) {
			log.info("Cursor plugin runtime registration deferred — run-cli may be unavailable this session");
		}
		const projectDir = resolveCursorProjectDir(parsed, process.env);
		if (projectDir === null) {
			log.info(
				"Cursor plugin bootstrap: no workspace named — runtime registered, nothing repo-scoped to do (the /jolli front door ships in the bundle)",
			);
			return;
		}
		const output = await runCursorPluginBootstrap(projectDir);
		if (output) process.stdout.write(JSON.stringify(output));
	} catch (error: unknown) {
		// Cursor's command hooks are fail-OPEN: a nonzero exit or unparseable stdout
		// lets the action proceed. Swallowing here keeps that promise explicit rather
		// than relying on it — a bootstrap must never be able to break a session.
		log.info("Cursor plugin bootstrap failed: %s", (error as Error).message);
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
 * whose plain-text briefing landed on stdout ahead of a bootstrap's JSON). Nothing
 * imports this module today; the guard is here so that stays a safe thing to do.
 */
/* v8 ignore start */
function isMainScript(): boolean {
	const argv1 = process.argv[1];
	if (process.env.VITEST || !argv1) return false;
	if (pathResolve(argv1) !== pathResolve(fileURLToPath(import.meta.url))) return false;
	const entryName = basename(argv1).toLowerCase();
	return entryName === "cursorpluginbootstraphook.js" || entryName === "cursorpluginbootstraphook.ts";
}

if (isMainScript()) {
	void main();
}
/* v8 ignore stop */
