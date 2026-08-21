/**
 * Installer Module — Orchestration layer.
 *
 * Coordinates install/uninstall/status across all hook types and the
 * per-source dist-paths registry. Individual hook implementations live in
 * their own modules:
 *   - ClaudeHookInstaller.ts  — Claude Code settings.local.json
 *   - GitHookInstaller.ts     — git shell hooks (post-commit, post-rewrite, prepare-commit-msg)
 *   - GeminiHookInstaller.ts  — Gemini settings.json
 *   - DispatchScripts.ts      — resolve-dist-path / run-hook / run-cli templates
 *   - DistPathResolver.ts     — per-source dist-paths registry + installDistPath
 *   - HookSettingsHelper.ts   — shared types, constants, matcher helpers
 *
 * The installer is idempotent — running install multiple times is safe.
 */

import { stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isAntigravityInstalled, isAntigravityPresent } from "../core/AntigravityDetector.js";
import { scanAntigravitySessions } from "../core/AntigravitySessionDiscoverer.js";
import { isClaudeInstalled } from "../core/ClaudeDetector.js";
import { isClineCliInstalled } from "../core/ClineCliDetector.js";
import { scanClineCliSessions } from "../core/ClineCliSessionDiscoverer.js";
import { isClineInstalled, isClinePresent } from "../core/ClineDetector.js";
import { scanClineSessions } from "../core/ClineSessionDiscoverer.js";
import type { ClineScanError } from "../core/ClineTranscriptShared.js";
import { discoverCodexSessions, isCodexInstalled } from "../core/CodexSessionDiscoverer.js";
import { isCopilotChatInstalled } from "../core/CopilotChatDetector.js";
import { scanCopilotChatSessions } from "../core/CopilotChatSessionDiscoverer.js";
import type { CopilotChatScanError } from "../core/CopilotChatTranscriptReader.js";
import { isCopilotInstalled, isCopilotPresent } from "../core/CopilotDetector.js";
import { scanCopilotSessions } from "../core/CopilotSessionDiscoverer.js";
import {
	type CursorCliScanError,
	isCursorCliInstalled,
	scanCursorCliSessions,
} from "../core/CursorCliSessionDiscoverer.js";
import { isCursorInstalled, isCursorPresent } from "../core/CursorDetector.js";
import { scanCursorSessions } from "../core/CursorSessionDiscoverer.js";
import { isDevinInstalled, isDevinPresent, scanDevinSessions } from "../core/DevinSessionDiscoverer.js";
import { isGeminiInstalled } from "../core/GeminiSessionDetector.js";
import { getProjectRootDir, isInsideGitRepo, listWorktrees } from "../core/GitOps.js";
import { resolveMemoryBankState } from "../core/KBPathResolver.js";
import { discoverKimiSessions, isKimiInstalled } from "../core/KimiSessionDiscoverer.js";
import { acquireRepoHooksLock, type StrictLockHandle, withRuntimeRegistryLock } from "../core/Locks.js";
import { applyPluginInitLocalAgentTool, pluginBootstrapHost } from "../core/localagent/PluginDefaults.js";
import {
	isOpenCodeInstalled,
	isOpenCodePresent,
	type OpenCodeScanError,
	scanOpenCodeSessions,
} from "../core/OpenCodeSessionDiscoverer.js";
import { readPushDisabledState } from "../core/PushControl.js";
import { readManualDisableFlag, writeManualDisableFlag } from "../core/RepoProfile.js";
import { migrateSchemaToV5, readSchemaV5State } from "../core/SchemaV5Migration.js";
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
import { isClaudeHookInstalled, reconcileClaudeAgentHooks, removeClaudeHook } from "./ClaudeHookInstaller.js";
import { installHookScripts } from "./DispatchScripts.js";
import {
	deriveSourceTag,
	installDistPath,
	isValidSourceTag,
	migrateLegacyDistPath,
	pickBestDistPath,
	pruneStaleDistPaths,
	traverseDistPaths,
} from "./DistPathResolver.js";
import { installGeminiHook, isGeminiHookInstalled, removeGeminiHook } from "./GeminiHookInstaller.js";
import { addGitExcludePaths, removeGitExcludePaths, updateGitExclude } from "./GitExclude.js";
import {
	installGitHook,
	installPostMergeHook,
	installPostRewriteHook,
	installPrePushHook,
	installPrepareMsgHook,
	isGitPipelineFullyInstalled,
	isHookSectionInstalled,
	PRE_PUSH_MARKER_START,
	removeGitHook,
	removePostMergeHook,
	removePostRewriteHook,
	removePrePushHook,
	removePrepareMsgHook,
} from "./GitHookInstaller.js";
import {
	installGlobalInstructions,
	removeGlobalInstructions,
	resolveGlobalInstructionsDecision,
} from "./GlobalInstructionsInstaller.js";
import type { HookOpResult } from "./HookSettingsHelper.js";
import {
	buildRegistrars,
	type DetectedHosts,
	registerGlobalMcpHosts,
	registerRepoMcpHosts,
	removeRepoMcpHosts,
} from "./mcp/HostRegistrars.js";
import {
	CURSOR_RETIRED_SKILL_GIT_EXCLUDE_PATHS,
	installPluginJolliMenu,
	JOLLI_MENU_GIT_EXCLUDE_PATHS,
	PLUGIN_JOLLI_MENU_GIT_EXCLUDE_PATHS,
	removeClaudeLegacySkills,
	removeCursorRepoSkills,
	removePluginJolliMenu,
	removeRetiredSkills,
	SKILL_GIT_EXCLUDE_PATHS,
	updateSkillIfNeeded,
} from "./SkillInstaller.js";

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

function hasRequiredWorktreeHooks(claudeHookInstalled: boolean, config: JolliMemoryConfig): boolean {
	return config.claudeEnabled === false || claudeHookInstalled;
}

/**
 * Applies the machine-global skill-preference block from the persisted
 * `globalInstructions` switch: writes the block when `enabled`, removes it when
 * `disabled`, does nothing when undecided. Never prompts — the block is only ever
 * written because the user explicitly opted in (VS Code Settings toggle or
 * `jolli configure --set globalInstructions=enabled`).
 *
 * Single source of host-gating for the block, shared by `install()` (which passes
 * pre-computed detection to avoid re-running detectors), the VS Code settings panel,
 * and `jolli configure` (which call it directly after persisting the switch, rather
 * than re-running the full installer). Fail-soft throughout — see
 * GlobalInstructionsInstaller.
 */
export async function syncGlobalInstructions(detected?: {
	readonly codexDetected: boolean;
	readonly geminiDetected: boolean;
}): Promise<void> {
	const config = await loadConfig();
	const decision = resolveGlobalInstructionsDecision(config.globalInstructions);
	if (decision.write) {
		const codexDetected = detected?.codexDetected ?? (await isCodexInstalled());
		const geminiDetected = detected?.geminiDetected ?? (await isGeminiInstalled());
		await installGlobalInstructions({
			claude: config.claudeEnabled !== false,
			gemini: geminiDetected && config.geminiEnabled !== false,
			codex: codexDetected && config.codexEnabled !== false,
		});
	} else if (decision.remove) {
		await removeGlobalInstructions();
	}
}

// ─── Runtime registry ───────────────────────────────────────────────────────

/**
 * Reconcile the MACHINE-GLOBAL runtime registry: the three dispatch scripts plus
 * this bundle's `dist-paths/<sourceTag>` entry.
 *
 * Extracted from {@link install} because it is the half of an install that is not
 * about a repository at all. Nothing it writes lives under a worktree — it is all
 * `~/.jolli/jollimemory/` — and nothing it writes is specific to one repo: the
 * scripts are byte-identical across every surface, and the dist entry says "a
 * runtime of this version lives here", which is true the moment the bundle exists.
 *
 * Kept as ONE function rather than two calls at each site because the four steps
 * are ordered and interdependent: the scripts are useless without a registered
 * dist (`resolve-dist-path` enumerates `dist-paths/` and exits non-zero when it
 * finds no complete runtime, so `run-cli` exits 1 before running anything), and the
 * migration/prune steps only make sense around the write. Two callers duplicating
 * that order is exactly the drift this removes.
 *
 * The second caller is the Cursor bootstrap, which must reconcile even for a
 * repository that has not opted in — see the call site for why that is not a hole
 * in its consent gate.
 *
 * @param sourceTag - Already validated by the caller; `installDistPath` re-validates
 *   at the write boundary as defense-in-depth.
 * @param distDir - The dist to register. Undefined (every in-process caller) means
 *   "the directory this module was bundled into".
 * @param lockOpts - Short budget for automatic callers, so a session hook defers
 *   instead of blocking; undefined takes the default budget.
 * @returns false when the registry could not be reconciled — the caller must not
 *   install anything that depends on it.
 */
export async function reconcileRuntimeRegistry(
	sourceTag: string,
	distDir?: string,
	lockOpts?: { readonly timeoutMs: number; readonly pollMs: number },
): Promise<boolean> {
	const reconcile = async () => {
		if (!(await installHookScripts())) return false;
		try {
			await migrateLegacyDistPath();
			/* v8 ignore start -- defensive: migrateLegacyDistPath handles its own errors internally */
		} catch (error: unknown) {
			log.warn("Legacy dist-path migration failed (non-fatal): %s", (error as Error).message);
		}
		/* v8 ignore stop */
		if (!(await installDistPath(sourceTag, distDir))) return false;
		try {
			const pruned = await pruneStaleDistPaths();
			if (pruned.length > 0) log.info("Pruned stale dist-paths entries: %s", pruned.join(", "));
			/* v8 ignore start -- defensive: pruneStaleDistPaths swallows its own per-entry errors */
		} catch (error: unknown) {
			log.warn("Pruning stale dist-paths failed (non-fatal): %s", (error as Error).message);
		}
		/* v8 ignore stop */
		return true;
	};
	const result = lockOpts
		? await withRuntimeRegistryLock(reconcile, lockOpts)
		: await withRuntimeRegistryLock(reconcile);
	return result.acquired && result.value === true;
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
export async function install(
	cwd?: string,
	options?: {
		source?: "vscode-extension" | "cli";
		integrationsOnly?: boolean;
		repoHooksOnly?: boolean;
		sourceTag?: string;
		respectManualDisable?: boolean;
		clearManualDisableOnSuccess?: boolean;
		/** Automatic surface repair: short lock waits and current-worktree-only reconciliation. */
		automatic?: boolean;
		/**
		 * Absolute path to register in `dist-paths/<sourceTag>` — the dist `run-hook`
		 * will exec from. Defaults to THIS bundle's own directory, which is right only
		 * when the process running the install IS the dist being registered.
		 *
		 * That holds for `jolli enable` and VS Code's in-process call, but NOT for a
		 * long-lived server installing on another dist's behalf: the IntelliJ plugin
		 * serves this from its own `cli-dist` inside the IDE's plugins directory, which
		 * dies on plugin uninstall or an IDE major upgrade (that path is version-scoped),
		 * while the dist it wants registered is the stable `~/.jolli/…/dist-intellij`
		 * copy. Getting that wrong is invisible: `run-hook` exits silently by design
		 * (never block git), so capture just stops.
		 */
		distDir?: string;
	},
): Promise<InstallResult> {
	/* v8 ignore next - process.cwd() fallback only used when called without cwd arg */
	const projectDir = cwd ?? process.cwd();
	const warnings: string[] = [];

	// integrations-only: set up the node-side integrations (dispatch scripts,
	// dist-paths, MCP registration, skills) but install NO hooks (git or agent).
	// Kept as a focused integrations repair mode. All current surfaces, including
	// IntelliJ, delegate Agent/Git hook ownership to the canonical full lifecycle.
	const integrationsOnly = options?.integrationsOnly === true;

	// repo-hooks-only installs the repo-owned lifecycle: source-neutral Git hooks,
	// project-local state, the `.agents/skills/` retired sweep, plus the acting
	// host's own agent hooks and menu. It skips host detection, MCP registration,
	// and unrelated skills.
	//
	// This is the PLUGIN BOOTSTRAP mode, and it is host-PARAMETERIZED, not
	// Claude-specific: which host's assets get written comes from the source tag
	// (see `pluginHost` below). The name predates the second plugin host and is
	// kept only because `--repo-hooks-only` is a shipped CLI surface that older
	// plugin bundles pass to newer CLIs — renaming it would break exactly the
	// cross-version dispatch the dist registry exists to support. Read it as
	// "repo-owned lifecycle for one host", not "Claude".
	const repoHooksOnly = options?.repoHooksOnly === true;

	if (integrationsOnly && repoHooksOnly) {
		return {
			success: false,
			message: "install: integrationsOnly and repoHooksOnly are mutually exclusive",
			warnings,
		};
	}

	// Hook install — and the worktree enumeration every mode runs below — only
	// makes sense inside a git repository. Without this guard `listWorktrees` fails
	// deep with a confusing "Failed to list worktrees" error, and callers whose
	// cwd isn't a repo (e.g. an editor extension host whose process.cwd() is "/")
	// retry in a failed-enable loop. Bail early and cheaply with a clear reason;
	// no successful path changes, since reaching listWorktrees already required a
	// repo. Guards on repo-presence (not work-tree) so a bare repo hosting linked
	// worktrees — a valid `git worktree` setup — still installs as before.
	if (!(await isInsideGitRepo(projectDir))) {
		log.info("Skipping Jolli Memory install — %s is not inside a git work tree", projectDir);
		return {
			success: false,
			message: `Not a git repository — skipping Jolli Memory install (${projectDir})`,
			warnings,
		};
	}

	log.info(
		repoHooksOnly
			? "Installing Jolli Memory repo hooks only (no integrations)"
			: integrationsOnly
				? "Installing Jolli Memory integrations (no hooks)"
				: "Installing Jolli Memory hooks",
	);

	let repoLock: StrictLockHandle | null = null;
	try {
		// Load config to check integration enabled flags (always global)
		const config = await loadConfig();

		// List all worktrees so we can install per-worktree hooks in each one
		const worktrees = options?.automatic ? [projectDir] : await listWorktrees(projectDir);
		const lifecycleLockOpts = options?.automatic ? { timeoutMs: 200, pollMs: 25 } : undefined;

		// Determine this caller's source tag and write its per-source dist-paths/ entry.
		// An explicit sourceTag (e.g. "intellij" passed by the IntelliJ plugin) wins;
		// otherwise CLI -> "cli"; VSCode-family -> derive from extension path.
		const callerDistDir = dirname(fileURLToPath(import.meta.url));
		const callerSource = options?.source ?? "cli";
		const sourceTag =
			options?.sourceTag ?? (callerSource === "vscode-extension" ? deriveSourceTag(callerDistDir) : "cli");

		// Validate the source tag ONCE, up front, before anything is written. The
		// tag's only downstream consumer is installDistPath, which uses it as a
		// FILENAME (`dist-paths/<sourceTag>`), so a malformed tag is a path-segment
		// hazard — NOT a shell-interpolation one: no source tag ever reaches a shell
		// hook (the repo Git and Agent hooks are source-neutral and byte-identical
		// across surfaces, dispatching through run-hook). installDistPath re-validates
		// and returns false on a bad tag as defense-in-depth, but failing here keeps
		// the whole install all-or-nothing under one uniform result rather than doing
		// partial work before that late guard fires. Normal callers never trip this:
		// "cli", the IntelliJ/plugin explicit tags, and deriveSourceTag's output are
		// all valid — only a malformed injected tag is rejected.
		if (!isValidSourceTag(sourceTag)) {
			return {
				success: false,
				message: `Refusing to install with an unsafe source tag: ${JSON.stringify(sourceTag)}`,
				warnings,
			};
		}

		// Which AI host a repo-hooks-only bootstrap acts for. Only that host's own
		// assets may be written, so a second plugin host can share this mode without
		// touching the first one's files. Derived from the source tag (see
		// pluginBootstrapHost); irrelevant outside repoHooksOnly, where the full
		// lifecycle writes every enabled host's assets by design.
		const pluginHost = pluginBootstrapHost(sourceTag);

		// `options?.distDir` (undefined for every in-process caller) keeps the
		// historical "register my own directory" default while letting a daemon-hosted
		// caller name the dist it is installing on behalf of. See the option's docs.
		if (!(await reconcileRuntimeRegistry(sourceTag, options?.distDir, lifecycleLockOpts))) {
			return {
				success: false,
				message: "Failed to reconcile the shared runtime registry — cannot install hooks that depend on it",
				warnings,
			};
		}

		if (!integrationsOnly) {
			repoLock = lifecycleLockOpts
				? await acquireRepoHooksLock(projectDir, lifecycleLockOpts)
				: await acquireRepoHooksLock(projectDir);
			if (!repoLock) {
				return {
					success: false,
					message: "Another Jolli enable/disable operation is still running; retry shortly",
					warnings,
				};
			}
			if (options?.respectManualDisable && (await readManualDisableFlag(projectDir))) {
				// `manuallyDisabled: true` marks this as a zero-write success — see the
				// field's docstring. Without it a caller cannot tell this apart from a
				// real install, and the IntelliJ bridge stamped "enabled for this
				// version" on the strength of `success` alone, which then suppressed
				// every later integrations catch-up for that version.
				return {
					success: true,
					message: "Repository remains manually disabled",
					warnings,
					manuallyDisabled: true,
				};
			}

			// EXPLICIT plugin setup: `/jolli:init` runs this command WITHOUT --automatic,
			// so the host the user initialized from seeds the local-agent tool — but only
			// when nothing is configured, never over a tool already on disk (see
			// applyPluginInitLocalAgentTool). Sits after the manual-disable early return so
			// a disabled repo stays a true zero-write. Non-plugin source tags return null
			// and write nothing, which is every ordinary `jolli enable`.
			//
			// LOCK ORDER — this nests: `saveConfig` takes the machine-global `config.lock`
			// while this flow still holds the repository's `repo-hooks.lock`. That order
			// (repo-hooks → config) is the only direction that exists, because nothing
			// guarded by `config.lock` acquires a repository lock, so there is no cycle.
			// Keep it that way: a `config.lock` holder that reached for `repo-hooks.lock`
			// would complete the deadlock. Distinct from the `repo-hooks` ↔
			// `runtime-registry` pair, which spec 297 forbids holding simultaneously at
			// all. Cost of the nesting: `config.lock` is best-effort with a 5 s budget, so
			// heavy contention can add that much inside the repo-lock critical section
			// rather than failing.
			//
			// The `!automatic` gate is load-bearing, not a fast path: the plugin's
			// SessionStart bootstrap reaches this same install() with a plugin sourceTag
			// and automatic: true. It survives the tool write becoming first-wins, because
			// the two gates are not the same gate: `ensurePluginDefaultProvider` writes
			// only while `aiProvider` is unset, whereas this one also seeds a missing
			// `localAgentTool` under an already-chosen paid provider. Letting the bootstrap
			// through would put that machine-global write on every session of every
			// repository a window happens to open, and take `config.lock` there too.
			if (!options?.automatic) {
				try {
					const applied = await applyPluginInitLocalAgentTool(sourceTag, config);
					if (applied !== null && (applied.seededTool || applied.seededProvider)) {
						log.info(
							"Plugin init seeded localAgentTool=%s (source %s, seededTool=%s, seededProvider=%s)",
							applied.tool,
							sourceTag,
							applied.seededTool,
							applied.seededProvider,
						);
					}
					// Neither outcome warrants a warning, because neither is a change the user
					// did not ask for: filling in a blank is invisible by design, and keeping a
					// tool they configured is now the whole point. What the kept case still
					// needs is a trace — from here on this host's memories are generated by
					// another host's CLI — and the user-facing half of that is already the
					// status line every front door prints ("summaries via <tool>"), which reads
					// this same field.
					if (applied?.keptTool !== undefined) {
						log.info(
							"Plugin init kept localAgentTool=%s (source %s drives %s; left alone)",
							applied.keptTool,
							sourceTag,
							applied.tool,
						);
					}
				} catch (error: unknown) {
					warnings.push(`Could not record the local agent tool for this host: ${(error as Error).message}`);
				}
			}
		}

		// Run host detectors once before the per-worktree loop so each detector
		// is called exactly once. Results are reused both inside the loop (for MCP
		// registration) and after it (for auto-enable config writes / hook installs).
		// In repo-hooks-only mode every host integration is skipped, so these results
		// go unused — short-circuit the filesystem probes to keep the SessionStart
		// bootstrap fast (it runs on every new Claude Code session).
		const codexDetectedOnce = repoHooksOnly ? false : await isCodexInstalled();
		const geminiDetectedOnce = repoHooksOnly ? false : await isGeminiInstalled();
		const cursorDetectedOnce = repoHooksOnly ? false : await isCursorInstalled();
		const opencodeDetectedOnce = repoHooksOnly ? false : await isOpenCodeInstalled();
		const copilotDetectedOnce = repoHooksOnly ? false : await isCopilotInstalled();
		const copilotChatDetectedOnce = repoHooksOnly ? false : await isCopilotChatInstalled();
		const clineDetectedOnce = repoHooksOnly ? false : (await isClineInstalled()) || (await isClineCliInstalled());
		// NOTE: Devin and Antigravity have no SQLite-gated auto-enable step inside
		// install() (unlike OpenCode/Cursor/Copilot below), so their only consumer
		// here is MCP registration — which keys off the PRESENCE flags below, not a
		// *DetectedOnce flag. isDevinInstalled/isAntigravityInstalled are still used
		// by getStatus() for the status tree.

		// MCP-registration presence flags. Distinct from the *DetectedOnce flags
		// above for the five SQLite-gated hosts (Cursor, OpenCode, Copilot, Devin,
		// Antigravity): *DetectedOnce answers "is the host installed AND can THIS
		// runtime read its transcripts" — the right gate for session discovery and
		// the auto-enable writes below. But MCP registration only writes a config
		// file; it never reads the DB, so it must key off raw on-disk PRESENCE
		// instead. Otherwise a runtime below the Node floor (no built-in
		// node:sqlite) would silently skip MCP for a host the user genuinely has
		// installed. Hosts that are not SQLite-gated (Codex, Gemini, Copilot Chat)
		// already work on any supported Node, so they reuse their *DetectedOnce flag
		// directly.
		//
		// Cline needs its own present flag for a DIFFERENT reason: it is not
		// SQLite-gated, but `clineDetectedOnce` above is `extension OR CLI` — and the
		// Cline CLI ships no MCP config file, so it is not an MCP host. Feeding the
		// broad flag to MCP would build+run clineRegistrar for a CLI-only user and
		// write nothing, making `detected.cline` mean "some Cline" while every other
		// field means "this MCP host is here". isClinePresent() is extension-only.
		const cursorPresentOnce = repoHooksOnly ? false : await isCursorPresent();
		const opencodePresentOnce = repoHooksOnly ? false : await isOpenCodePresent();
		const copilotPresentOnce = repoHooksOnly ? false : await isCopilotPresent();
		const clinePresentOnce = repoHooksOnly ? false : await isClinePresent();
		const devinPresentOnce = repoHooksOnly ? false : await isDevinPresent();
		const antigravityPresentOnce = repoHooksOnly ? false : await isAntigravityPresent();
		// Kimi is a file-based (mcp.json) MCP host, not SQLite-gated, so presence is a
		// plain on-disk check (does ~/.kimi-code exist) — same as Codex/Gemini.
		const kimiPresentOnce = repoHooksOnly ? false : await isKimiInstalled();

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
			if (repoHooksOnly) {
				// The `.agents/skills/` retired-skill sweep is HOST-NEUTRAL and runs for
				// every plugin host: `.agents/` is the cross-platform skills dir that
				// Codex/Cursor/Gemini read, and `SKILL_TARGETS` deliberately no longer
				// includes `.claude/skills/`. The plugin never calls updateSkillIfNeeded
				// (below), which is where this sweep normally runs — so do it here too,
				// or a repo that ran a full `jolli enable` before a skill was retired
				// (e.g. `jolli-pr`) keeps exposing the dead copy after a plugin-only
				// upgrade. Marker-guarded.
				await removeRetiredSkills(wt);
				// Everything below is Claude Code's OWN assets, so it is gated on the
				// host this bootstrap acts for. Installing a Codex plugin must not
				// modify `.claude/**` — a user with both plugins would otherwise see
				// the Codex bootstrap rewrite, upgrade or clean Claude-side assets on
				// every Codex session. The host comes from the source tag, the only
				// signal that survives both the in-process SessionStart path and the
				// `run-cli` init path (see pluginBootstrapHost).
				if (pluginHost === "claude") {
					// A plugin skill can only be invoked as `/jolli:<name>`; a BARE `/jolli`
					// front door has to come from a non-plugin project skill. Write just the
					// umbrella menu (routing to the plugin's own `/jolli:*` skills) into
					// .claude/skills/jolli/ and keep it out of `git status`.
					await installPluginJolliMenu(wt);
					// The plugin ships recall/search/run as namespaced `/jolli:*` skills,
					// so the unnamespaced `.claude/skills/jolli-*` a pre-plugin `jolli enable`
					// wrote are now duplicates in the `/` menu. Delete the Jolli-owned ones
					// (a user's own same-named skill is left untouched). Ordered after the
					// umbrella write so the plugin-variant umbrella (which outranks the
					// standalone menu by revision) reclaims `.claude/skills/jolli/` and can't
					// be left pointing at a skill this just removed.
					await removeClaudeLegacySkills(wt);
					// UNION (not replace): PluginBootstrapHook re-runs on every plugin
					// SessionStart and only knows its own umbrella entry. Replacing the
					// block would shrink a set a prior full `jolli enable` populated,
					// un-hiding those paths in `git status` and churning the file each
					// session. `addGitExcludePaths` merges, leaving other entries intact.
					await addGitExcludePaths(wt, [...PLUGIN_JOLLI_MENU_GIT_EXCLUDE_PATHS]);
					if (config.claudeEnabled !== false) {
						const result = await reconcileClaudeAgentHooks(wt);
						if (wt === projectDir || claudeResult.path === undefined) claudeResult = result;
					}
				} else if (pluginHost === "cursor") {
					// The ONE thing a Cursor plugin bootstrap must do beyond the shared repo
					// hooks: write this worktree's `.cursor/mcp.json`. It is the only way the
					// plugin gets a WORKING MCP server — the plugin ships no `mcp.json` of its
					// own, because a plugin-shipped entry resolves its relative `cwd` against
					// the PLUGIN root, and every memory tool derives the repository it serves
					// from its cwd (the measurements are on the Codex side; the failure mode is
					// identical here, and `startMcpServer` refuses a plugin-cache cwd as the
					// backstop). Cursor's own MCP config is repo-scoped, so unlike Codex this
					// needs no exception to the global-host skip — the normal repo registrar is
					// already the right writer.
					//
					// No detector is consulted: this code is running inside a Cursor session, so
					// Cursor is present by construction, and repo-hooks-only deliberately skips
					// the filesystem probes to stay fast. ONLY cursor — a Cursor plugin install
					// must not go writing MCP config for Claude or any global host.
					//
					// Deliberately NOT gated on `!automatic`: the sessionStart bootstrap is
					// exactly the path that must keep the registration alive, and a user who
					// removed the entry (or upgraded from a bundle that never wrote it) has no
					// other way to get it back. `upsertJsonMcpServer` short-circuits when the
					// entry already matches, so the repeat cost on every session is a read.
					const cursorOnly: DetectedHosts = {
						claude: false,
						codex: false,
						cursor: true,
						gemini: false,
						opencode: false,
						copilot: false,
						copilotChat: false,
						cline: false,
						devin: false,
						antigravity: false,
						kimi: false,
					};
					await registerRepoMcpHosts(wt, cursorOnly);
					// UNION (not replace), same reasoning as the Claude branch above: this hook
					// re-runs on every session start and only knows its own entry, so replacing
					// the block would shrink a set a prior full `jolli enable` populated.
					await addGitExcludePaths(
						wt,
						buildRegistrars(cursorOnly).flatMap((r) => r.gitExcludePaths()),
					);
				}

				/*
				 * Sweep the RETIRED Cursor per-repo mirror on EVERY plugin bootstrap, not just
				 * Cursor's — and drop the git-excludes that served it.
				 *
				 * The bundle ships all four host-neutral skills directly now, so a leftover
				 * `.cursor/skills/jolli-recall` symlink is a second menu entry for a name the
				 * bundle already supplies, and after a marketplace upgrade it is a dangling
				 * one. The exclude lines have to go with it: nothing writes that directory any
				 * more, so an exclude for it would hide skills the USER puts there.
				 *
				 * Host-neutral placement is what the retired reconcile got right, and the
				 * reason carries over unchanged: a user who removes the Cursor plugin through
				 * Cursor's own UI runs no Jolli code at that moment, and the Cursor bootstrap's
				 * own opt-in gate means an un-opted-in repo never reaches it either. Every
				 * other host's bootstrap keeps running, per SESSION — far sooner than the next
				 * commit, which may never come in a repo the user has stopped committing to.
				 *
				 * Cheap and idempotent both ways: four stats against a repo that has nothing to
				 * remove, and `removeGitExcludePaths` rewrites only when a line actually goes.
				 */
				await removeCursorRepoSkills(wt);
				await removeGitExcludePaths(wt, [...CURSOR_RETIRED_SKILL_GIT_EXCLUDE_PATHS]);
				// Neither non-Claude bootstrap owns any SKILL assets — the Cursor branch above
				// writes MCP config and nothing else. Both hosts load their skills from the
				// plugin bundle (Codex namespaces them `jolli:<name>`; the Cursor bundle keeps
				// the canonical `jolli-` prefix instead — see CursorPluginSkills) and,
				// independently, from the repository's `.agents/skills/` — so a repo that also
				// ran a full `jolli enable` shows both. That is ACCEPTED duplication, not a bug
				// to clean up. The names do not collide and neither shadows the other (verified
				// on codex-cli 0.146.0: a repo-local `worktree` and a plugin's `j:worktree`
				// coexist as separate entries), and `.agents/skills/` is the CROSS-PLATFORM
				// directory Cursor, Gemini, OpenCode, Windsurf and Copilot read as well.
				//
				// An earlier revision removed the repo copies from here to de-duplicate one
				// host's picker. It took the only copy those other hosts had, silently, and
				// flapped against every later `jolli enable` — a functional loss traded for a
				// cosmetic gain. The right fix is to stop shipping the four host-neutral
				// skills in the bundle at all, not to delete a shared resource on one host's
				// behalf. Do NOT reintroduce a `.agents/skills/` removal here.
				continue;
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
				cursor: cursorPresentOnce,
				gemini: geminiDetectedOnce,
				opencode: opencodePresentOnce,
				copilot: copilotPresentOnce,
				copilotChat: copilotChatDetectedOnce,
				cline: clinePresentOnce,
				devin: devinPresentOnce,
				antigravity: antigravityPresentOnce,
				kimi: kimiPresentOnce,
			};
			// Keep the user's `git status` clean by adding Jolli-managed paths to
			// `.git/info/exclude`. Worktree-aware: linked worktrees may have their
			// own gitdir, so we resolve per-worktree. We compute the union of all
			// active registrars' gitExcludePaths so each host's config file is
			// covered (e.g. `.cursor/mcp.json` when Cursor is detected). Global
			// hosts contribute [] here — their configs live outside the repo.
			await updateGitExclude(wt, [
				...SKILL_GIT_EXCLUDE_PATHS,
				...PLUGIN_JOLLI_MENU_GIT_EXCLUDE_PATHS,
				...buildRegistrars(detected).flatMap((r) => r.gitExcludePaths()),
			]);
			// Register the MCP server in the detected REPO-scoped hosts (Claude,
			// Cursor) whose config lives in this worktree. This runs BEFORE the
			// claudeEnabled gate so Cursor users with Claude disabled still get MCP
			// registered. Each host is isolated — a failure in one never blocks the
			// others. Global hosts are registered once after the loop (below).
			await registerRepoMcpHosts(wt, detected);

			// integrations-only stops here: MCP + skills + git-exclude are done, but no
			// Claude/SessionStart hooks (the caller manages its own hooks).
			if (integrationsOnly) continue;
			if (config.claudeEnabled === false) continue;
			const result = await reconcileClaudeAgentHooks(wt);
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
		}

		// Register the MCP server in the detected GLOBAL hosts (Codex, Gemini,
		// OpenCode, Copilot, Copilot Chat, Cline, Devin, Antigravity). Their config
		// files are machine-wide and shared across every repo, so we write them ONCE
		// here rather than rewriting the same file on each worktree iteration above.
		// Detection-gated only.
		//
		// ONE host escapes the repo-hooks-only skip: a Codex plugin bootstrap must
		// register Codex's own global entry, because that entry is the only way the
		// plugin gets a WORKING MCP server. The plugin ships no `.mcp.json` — a plugin
		// MCP entry has to pin `cwd` to the plugin root, and the server reads the
		// repository it serves off its cwd, so such a server answers for the plugin's
		// cache directory rather than the user's repo (see the codexRegistrar comment
		// for the measurements, and startMcpServer's guard for the backstop). No
		// detector is consulted — this code is running inside a Codex session, so Codex
		// is present by construction, and repo-hooks-only deliberately skips the
		// filesystem probes to stay fast. Still ONLY codex: a Codex plugin install must
		// not go writing MCP config for Gemini, Copilot, Cline, Devin or Antigravity.
		//
		// Deliberately NOT gated on `!automatic`: the SessionStart bootstrap is exactly
		// the path that must keep the registration alive, and a user who removed the
		// entry (or upgraded from a bundle that never wrote it) has no other way to get
		// it back. The cost is that this runs on EVERY Codex session, which makes
		// `upsertCodexMcpServer` a hot path over a file that is mostly other tools'
		// configuration — so that writer short-circuits when the entry already matches
		// and writes atomically when it does not. Keep it that way before adding
		// anything else to this call.
		const codexPluginBootstrap = repoHooksOnly && pluginHost === "codex";
		await registerGlobalMcpHosts({
			claude: false,
			cursor: false,
			codex: codexDetectedOnce || codexPluginBootstrap,
			gemini: geminiDetectedOnce,
			opencode: opencodePresentOnce,
			copilot: copilotPresentOnce,
			copilotChat: copilotChatDetectedOnce,
			cline: clinePresentOnce,
			devin: devinPresentOnce,
			antigravity: antigravityPresentOnce,
			kimi: kimiPresentOnce,
		});

		// Prefer Jolli's skills by default: write a standing rule into each
		// enabled host's GLOBAL instruction file. Machine-global (one per host,
		// shared by every repo) — mirrors registerGlobalMcpHosts above, and like
		// it, uninstall deliberately leaves the block in place. Gating matches the
		// hooks: gemini/codex are detection-gated (never create their file on a
		// machine without them), while Claude has no filesystem detector and is
		// gated only on `claudeEnabled` — so `~/.claude/CLAUDE.md` is created
		// whenever Claude isn't explicitly disabled, consistent with the rest of
		// the installer treating Claude as the primary host. This is an integration
		// (skill preference), not a hook, so it runs in integrations-only mode too.
		// Never prompts: enable only APPLIES a decision the user already made. An
		// undecided switch (fresh install, before the user opts in via the VS Code
		// Settings toggle or `jolli configure`) is a no-op; `enabled` re-writes the
		// block idempotently, `disabled` heals any stale block. Delegated to
		// syncGlobalInstructions so every surface shares identical host-gating and
		// the write/remove decision logic.
		// Automatic repo-hook reconciliation deliberately leaves machine-global
		// instructions untouched. Full explicit enable remains their sole owner,
		// so coexisting surfaces never create a SessionStart write tug-of-war.
		if (!repoHooksOnly) {
			await syncGlobalInstructions({
				codexDetected: codexDetectedOnce,
				geminiDetected: geminiDetectedOnce,
			});
		}

		// Git hooks are shared across all worktrees — install once. Skipped in
		// integrations-only mode (the caller owns its own git hooks); the *HookPath
		// results then stay undefined, which the return below handles.
		let gitResult: HookOpResult = {};
		let postRewriteResult: HookOpResult = {};
		let prepareMsgResult: HookOpResult = {};
		let postMergeResult: HookOpResult = {};
		let prePushResult: HookOpResult = {};
		if (!integrationsOnly) {
			// Repo hooks are byte-identical and source-neutral across every surface.
			// Runtime selection happens only inside the shared dispatcher.
			gitResult = await installGitHook(projectDir);
			if (gitResult.warning) {
				warnings.push(gitResult.warning);
			}

			// Install Git post-rewrite hook (handles amend/rebase summary migration)
			postRewriteResult = await installPostRewriteHook(projectDir);
			if (postRewriteResult.warning) {
				warnings.push(postRewriteResult.warning);
			}

			// Install Git prepare-commit-msg hook (handles git merge --squash)
			prepareMsgResult = await installPrepareMsgHook(projectDir);
			if (prepareMsgResult.warning) {
				warnings.push(prepareMsgResult.warning);
			}

			// Install Git post-merge hook (auto-compiles merged branch summaries after pull/merge)
			postMergeResult = await installPostMergeHook(projectDir);
			if (postMergeResult.warning) {
				warnings.push(postMergeResult.warning);
			}

			// Install Git pre-push hook (auto-syncs pushed commits' memory to Jolli Space)
			prePushResult = await installPrePushHook(projectDir);
			if (prePushResult.warning) {
				warnings.push(prePushResult.warning);
			}
		}

		// Auto-detect Codex and enable session discovery (saved to global config)
		if (codexDetectedOnce) {
			if (config.codexEnabled === undefined) {
				await saveConfig({ codexEnabled: true });
				log.info("Codex detected — enabled Codex session discovery");
			}
		}

		// Auto-detect Gemini and install AfterAgent hook in all worktrees (if enabled).
		// The AfterAgent hook install is skipped in integrations-only mode; the config
		// flag is still recorded so session discovery works for the caller's own hooks.
		let geminiSettingsPath: string | undefined;
		if (geminiDetectedOnce && config.geminiEnabled !== false) {
			if (!integrationsOnly) {
				for (const wt of worktrees) {
					const geminiResult = await installGeminiHook(wt);
					// Capture the path from the primary worktree
					if (wt === projectDir || geminiSettingsPath === undefined) {
						geminiSettingsPath = geminiResult.path;
					}
				}
			}
			if (config.geminiEnabled === undefined) {
				await saveConfig({ geminiEnabled: true });
				log.info("Gemini detected — enabled Gemini session tracking");
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

		// Auto-detect Cursor in either form (Composer IDE or cursor-agent CLI) and
		// enable the shared cursorEnabled flag. Both sources share one toggle —
		// mirrors the copilotEnabled treatment for Copilot CLI + Chat below.
		const cursorCliDetectedOnce = repoHooksOnly ? false : await isCursorCliInstalled();
		const cursorDetected = config.cursorEnabled !== false && cursorDetectedOnce;
		const cursorCliDetected = config.cursorEnabled !== false && cursorCliDetectedOnce;
		if ((cursorDetected || cursorCliDetected) && config.cursorEnabled === undefined) {
			await saveConfig({ cursorEnabled: true });
			log.info("Cursor detected (IDE=%s, CLI=%s) — enabled session discovery", cursorDetected, cursorCliDetected);
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

		// Auto-detect Cline (extension or CLI) and enable session discovery
		if (clineDetectedOnce && config.clineEnabled === undefined) {
			await saveConfig({ clineEnabled: true });
			log.info("Cline detected — enabled Cline session discovery");
		}

		// Migrate any existing worktree-level API keys to the global config dir.
		// The worktrees list always includes the main repo root as its first entry.
		// Skipped in repo-hooks-only mode — the plugin bootstrap runs on every session
		// start and this key migration is a one-time integration concern, not a hook.
		if (!repoHooksOnly) {
			for (const wt of worktrees) {
				await migrateWorktreeConfig(wt);
			}
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
		} else if (repoHooksOnly) {
			log.info("Skipping v5 migration in repo-hooks-only mode — runs on every session start");
		} else {
			try {
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

		if (options?.clearManualDisableOnSuccess && !integrationsOnly) {
			// Best-effort: every hook is already installed by this point, so a failure
			// to clear the opt-out (e.g. a profile-lock timeout — writeManualDisableFlag
			// throws) must NOT turn a successful enable into a reported failure. Warn and
			// continue; a later enable re-clears it. Contrast uninstall's
			// persistManualDisable, where a write failure MUST abort (fail-atomic).
			try {
				await writeManualDisableFlag(projectDir, false);
			} catch (err: unknown) {
				const detail = (err as Error).message;
				warnings.push(
					`Enabled, but could not clear the manual-disable opt-out (${detail}). Run enable again to clear it.`,
				);
				log.warn("Could not clear manual-disable opt-out after enable (non-fatal): %s", detail);
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
			prePushHookPath: prePushResult.path,
			geminiSettingsPath,
		};
		/* v8 ignore start -- defensive: internal functions handle their own errors */
	} catch (error: unknown) {
		const message = `Installation failed: ${(error as Error).message}`;
		log.error(message);
		return { success: false, message, warnings };
	} finally {
		if (repoLock) await repoLock.release();
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
export async function uninstall(
	cwd?: string,
	options?: {
		integrationsOnly?: boolean;
		preserveMenu?: boolean;
		repoLockHeld?: boolean;
		persistManualDisable?: boolean;
	},
): Promise<InstallResult> {
	/* v8 ignore next - process.cwd() fallback only used when called without cwd arg */
	const projectDir = cwd ?? process.cwd();
	const warnings: string[] = [];

	// integrations-only: mirror of `install --integrations-only` — remove only the
	// repo-scoped MCP registration (the caller owns its own hooks, so leave them,
	// the git hooks, skills, and dist-paths alone). Used by the IntelliJ plugin on
	// disable so it doesn't tear out hooks it never installed.
	const integrationsOnly = options?.integrationsOnly === true;

	log.info(integrationsOnly ? "Removing Jolli Memory integrations (MCP)" : "Removing Jolli Memory hooks");

	let uninstallLock: StrictLockHandle | null = null;
	try {
		if (!integrationsOnly && !options?.repoLockHeld) {
			uninstallLock = await acquireRepoHooksLock(projectDir);
			if (!uninstallLock) {
				return {
					success: false,
					message: "Another Jolli enable/disable operation is still running; retry shortly",
					warnings,
				};
			}
		}
		if (!integrationsOnly && options?.persistManualDisable) {
			await writeManualDisableFlag(projectDir, true);
		}
		// Attempt to list all worktrees; fall back to just this directory if it fails
		let worktrees: ReadonlyArray<string>;
		try {
			worktrees = await listWorktrees(projectDir);
		} catch {
			worktrees = [projectDir];
		}

		if (integrationsOnly) {
			for (const wt of worktrees) {
				try {
					await removeRepoMcpHosts(wt);
				} catch (mcpErr) {
					log.warn("MCP removal failed in %s (non-fatal): %s", wt, (mcpErr as Error).message);
				}
			}
			log.info("Integrations removal complete");
			return { success: true, message: "Jolli Memory integrations removed (MCP)", warnings };
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
			// Remove the bare `/jolli` umbrella menu. It's written outside the Claude
			// Code plugin (into this repo's `.claude/skills/jolli/`), so a plugin-manager
			// uninstall can't reach it — a code-driven uninstall must, or it lingers as a
			// broken menu routing to `/jolli:*` skills that no longer exist. Guarded by
			// our vendor marker so a user's own `jolli` skill is never deleted (see
			// removePluginJolliMenu). This is the ONE skill uninstall actively removes;
			// the `jolli-*` siblings stay per the conservative policy noted below.
			if (!options?.preserveMenu) await removePluginJolliMenu(wt);

			// The RETIRED Cursor per-repo mirror. Earlier versions planted four
			// host-neutral skills into this repo's `.cursor/skills/`; the bundle ships them
			// directly now, so this is a sweep of what those versions left behind — see
			// CURSOR_RETIRED_MIRROR_SKILLS. Being repo-level is what made them survive a
			// plugin-manager uninstall, and a code-driven uninstall is the only thing that
			// can reach them. (The `/jolli` umbrella is NOT among them: it is machine-global,
			// shared by every repo, so no per-repo teardown may take it — `jolli uninstall`
			// reaches it through UninstallScan's machine-global surface instead.)
			//
			// NOT gated on `preserveMenu`: that flag exists so one host's teardown cannot
			// delete ANOTHER host's assets, and `.cursor/skills/` is written by nothing
			// else. A Cursor session tearing down a disabled repo should still take the
			// leftovers with it, exactly as it would its own MCP entry.
			//
			// Ownership-guarded, so a user's own `.cursor/skills/jolli-recall` survives.
			//
			// The exclude lines go WITH the files, unlike the `jolli-*` entries dropped
			// below: those are kept precisely because their SKILL.md files are kept, and
			// here the files are being deleted. Nothing writes `.cursor/skills/` any more,
			// so a surviving exclude for it hides skills the USER later puts there — and
			// git reports an untracked DIRECTORY as one `?? .cursor/` line rather than
			// descending, which is why CURSOR_RETIRED_SKILL_GIT_EXCLUDE_PATHS carries both
			// `/.cursor/skills/` and the four per-skill paths. Reached only by an uninstall
			// on a machine that upgraded THROUGH a version which planted the mirror; the
			// install paths sweep the same pair (see the bootstrap above and
			// `updateSkillIfNeeded`), so a repo that never had it has nothing to remove and
			// `removeGitExcludePaths` rewrites only when a line actually goes.
			await removeCursorRepoSkills(wt);
			await removeGitExcludePaths(wt, [...CURSOR_RETIRED_SKILL_GIT_EXCLUDE_PATHS]);
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
		await removePrePushHook(projectDir);

		// Drop the bare `/jolli` umbrella's exclude line(s) from the shared managed
		// block (git hooks live in the common dir, so this runs once). The `jolli-*`
		// sibling entries are deliberately kept — their SKILL.md files are left in
		// place by the conservative policy below, so their exclude lines stay too.
		if (!options?.preserveMenu) await removeGitExcludePaths(projectDir, JOLLI_MENU_GIT_EXCLUDE_PATHS);

		// Conservative skill-cleanup policy: leave the generated `jolli-*` SKILL.md
		// files (and their `.git/info/exclude` lines) alone. Users sometimes ship
		// their own skills alongside Jolli's under `.claude/skills/` or
		// `.agents/skills/`, and a blind `rm -rf` of those directories on uninstall
		// would delete unrelated user content. Leaving them behind also means
		// re-enabling Jolli later is a no-op. The bare `jolli` umbrella is the sole
		// exception (removed above): it's unambiguously ours and, living outside the
		// plugin, would otherwise orphan into a broken menu.
		warnings.push(
			"The `jolli-*` skill files were left in place. To remove them manually: `rm -rf .agents/skills/jolli-* .claude/skills/jolli-*` and delete the `# >>> jolli skill exclude >>>` block from `.git/info/exclude` if you no longer want it.",
		);

		log.info("Uninstallation complete");
		return {
			success: true,
			message: "Jolli Memory hooks removed successfully",
			warnings,
		};
		// The catch is a real path, not just a defensive wrapper: the manual-disable
		// behavioral tests drive it via a forced persist write failure (fail-atomic)
		// and a forced teardown-step throw (opt-out survives). The finally's null-lock
		// branch is covered by the integrations-only uninstall (no repo lock acquired).
	} catch (error: unknown) {
		const message = `Uninstallation failed: ${(error as Error).message}`;
		log.error(message);
		return { success: false, message, warnings };
	} finally {
		if (uninstallLock) await uninstallLock.release();
	}
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
	const gitHookInstalled = await isGitPipelineFullyInstalled(projectDir);
	const prePushHookInstalled = await isHookSectionInstalled(projectDir, "pre-push", PRE_PUSH_MARKER_START);
	const sessions = await loadAllSessions(projectDir);
	// No `orphanBranchExists` gate. It used to short-circuit the count to 0
	// whenever that branch was absent, which reads as "this repo has no
	// memories" — true only while the branch IS the system of record. A clone
	// made after a cutover carries no orphan branch at all, so a fully
	// populated repo reported 0 summaries in `jolli status`, the MCP `status`
	// tool and both IDE surfaces. `getSummaryCount` resolves the system of
	// record itself and already answers 0 when there is no index, so the gate
	// only ever subtracted truth.
	const summaryCount = await getSummaryCount(projectDir, storage);
	const geminiHookInstalled = await isGeminiHookInstalled(projectDir);
	const claudeDetected = await isClaudeInstalled();
	const codexDetected = await isCodexInstalled();
	const geminiDetected = await isGeminiInstalled();
	const openCodeDetected = await isOpenCodeInstalled();
	const cursorDetected = await isCursorInstalled();
	const devinDetected = await isDevinInstalled();
	const cursorCliDetected = await isCursorCliInstalled();
	const copilotDetected = await isCopilotInstalled();
	const copilotChatDetected = await isCopilotChatInstalled();
	const clineVscodeDetected = await isClineInstalled();
	const clineCliDetected = await isClineCliInstalled();
	const clineDetected = clineVscodeDetected || clineCliDetected;
	const antigravityDetected = await isAntigravityInstalled();
	const kimiDetected = await isKimiInstalled();

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

	// Discover Devin CLI sessions on-demand (not stored in sessions.json).
	let devinScanError: SqliteScanError | undefined;
	if (config.devinEnabled !== false && devinDetected) {
		const scan = await scanDevinSessions(projectDir);
		if (scan.sessions.length > 0) {
			allEnabledSessions = [...allEnabledSessions, ...scan.sessions];
		}
		devinScanError = scan.error;
	}

	// Discover Cursor CLI (cursor-agent) sessions on-demand (not stored in sessions.json).
	// Shares cursorEnabled with the Composer IDE source (one "Cursor" toggle).
	let cursorCliScanError: CursorCliScanError | undefined;
	if (config.cursorEnabled !== false && cursorCliDetected) {
		const scan = await scanCursorCliSessions(projectDir);
		if (scan.sessions.length > 0) {
			allEnabledSessions = [...allEnabledSessions, ...scan.sessions];
		}
		cursorCliScanError = scan.error;
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

	// Discover Cline sessions on-demand (extension + CLI), merged under one row.
	// Each channel keeps its OWN scan-error field — collapsing them (the old
	// `ext.error ?? cli.error`) dropped a concurrent CLI failure and let one
	// broken channel mask a healthy sibling on the merged row (JOLLI-2034).
	let clineVscodeScanError: ClineScanError | undefined;
	let clineCliScanError: ClineScanError | undefined;
	if (config.clineEnabled !== false && clineDetected) {
		const ext = await scanClineSessions(projectDir);
		const cli = await scanClineCliSessions(projectDir);
		const merged = [...ext.sessions, ...cli.sessions];
		if (merged.length > 0) allEnabledSessions = [...allEnabledSessions, ...merged];
		clineVscodeScanError = ext.error;
		clineCliScanError = cli.error;
	}

	// Discover Antigravity conversations on-demand (not stored in sessions.json).
	let antigravityScanError: SqliteScanError | undefined;
	if (config.antigravityEnabled !== false && antigravityDetected) {
		const scan = await scanAntigravitySessions(projectDir);
		if (scan.sessions.length > 0) {
			allEnabledSessions = [...allEnabledSessions, ...scan.sessions];
		}
		antigravityScanError = scan.error;
	}

	// Discover Kimi Code CLI sessions on-demand (not stored in sessions.json).
	// Plain array like Codex — Kimi is file-based, so no scan-error channel.
	if (config.kimiEnabled !== false && kimiDetected) {
		const kimiSessions = await discoverKimiSessions(projectDir);
		if (kimiSessions.length > 0) {
			allEnabledSessions = [...allEnabledSessions, ...kimiSessions];
		}
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
					return hasRequiredWorktreeHooks(worktreeClaudeHookInstalled, config);
				}),
			);
			enabledWorktrees = hookChecks.filter(Boolean).length;
		} catch {
			// Git repo resolved but worktree enumeration failed — leave count undefined
		}
	}

	const worktreeHooksInstalled = hasRequiredWorktreeHooks(claudeHookInstalled, config);

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

	// Effective Memory Bank state. Resolved through `peekKBPath`, so asking
	// `jolli status` where the folder is can never create it — the same reason
	// the Rebuild/Migrate flow peeks instead of resolving.
	const memoryBank = resolveMemoryBankState(projectDir, config);

	// Per-repo outbound-push opt-out (spec 306). Read the STATE form, not the
	// boolean: both halves go into StatusInfo so a surface can tell the user's
	// recorded choice apart from a fail-closed read of an unreadable store.
	const pushState = await readPushDisabledState(projectDir);

	const status: StatusInfo = {
		// The extension is "enabled" when the git hook is installed.
		// Individual integration hooks (Claude, Codex, Gemini) have their own
		// status fields — a missing Claude hook should not disable the entire
		// extension when other integrations are still active.
		enabled: gitHookInstalled,
		claudeHookInstalled,
		gitHookInstalled,
		prePushHookInstalled,
		geminiHookInstalled,
		worktreeHooksInstalled,
		activeSessions: allEnabledSessions.length,
		mostRecentSession: filteredMostRecent,
		summaryCount,
		orphanBranch: ORPHAN_BRANCH,
		// readPushDisabledState is already fail-safe (catches internally, reports
		// disabled on a bad store) and never rejects — a `.catch(() => false)` was dead
		// code, and would have wrongly reported "enabled" for an unreadable store,
		// contradicting fail-closed. The `error` half rides along so a status surface can
		// distinguish the user's opt-out from a fail-closed read (see StatusInfo).
		pushDisabled: pushState.disabled,
		...(pushState.error ? { pushDisabledError: pushState.error } : {}),
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
		devinDetected,
		devinEnabled: config.devinEnabled,
		devinScanError,
		cursorCliDetected,
		cursorCliScanError,
		copilotDetected,
		copilotEnabled: config.copilotEnabled,
		copilotScanError,
		copilotChatDetected,
		copilotChatScanError,
		clineDetected,
		clineCliDetected,
		clineVscodeDetected,
		clineEnabled: config.clineEnabled,
		clineVscodeScanError,
		clineCliScanError,
		antigravityDetected,
		antigravityEnabled: config.antigravityEnabled,
		antigravityScanError,
		kimiDetected,
		kimiEnabled: config.kimiEnabled,
		globalConfigDir,
		worktreeStatePath,
		memoryBank,
		enabledWorktrees,
		hookSource: activeSource?.source,
		hookVersion: activeSource?.version,
		allSources,
		sessionsBySource,
		openCodeScanError,
		...(schemaV5 !== undefined && { schemaV5 }),
	};

	log.info(
		"Status: enabled=%s, claude=%s, git=%s, geminiHook=%s, worktreeHooks=%s, sessions=%d, summaries=%d, codex=%s/%s, gemini=%s/%s, enabledWorktrees=%s, opencode=%s/%s, cursor=%s/%s, copilot=%s/%s, copilotChat=%s, cline=%s/%s",
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
		status.clineDetected,
		status.clineEnabled,
	);

	return status;
}
