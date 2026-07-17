/**
 * DI helper that assembles a fully-wired `SyncEngine` from the user's
 * config plus optional source-repo context, or returns `null` when sync is
 * dormant (no auth token).
 *
 * Plan §0.7: the only prerequisite for the engine to exist is a valid
 * `jolliApiKey`. The `autoSyncEnabled` flag controls whether the orchestrator
 * schedules a polling tick — not whether the engine can be built. Manual
 * "Sync to Personal Space" must work whenever the user is signed in,
 * regardless of the auto-sync toggle, so this builder does NOT gate on
 * `autoSyncEnabled`.
 *
 * Called by the VS Code `StatusOrchestrator` (one engine per workspace
 * activate; long-lived plugin process). The CLI side only invokes sync
 * via an explicit subcommand path (TBD); the auto post-commit handoff was
 * dropped in Phase 4. Returning `null` is intentional — callers branch on
 * it and skip the round entirely.
 */

import { basename } from "node:path";
import { extractRepoName, getRemoteUrl, peekKBPath, resolveKbParent } from "../core/KBPathResolver.js";
import { loadConfig } from "../core/SessionTracker.js";
import { launchWorker } from "../hooks/QueueWorker.js";
import { createLogger } from "../Logger.js";
import { BackendClient } from "./BackendClient.js";
import type { ConflictUi } from "./ConflictResolver.js";
import { GitClient } from "./GitClient.js";
import { LocalAiMergeProvider } from "./LocalAiMergeProvider.js";
import { consumePendingWorkers } from "./PendingWorkers.js";
import { computeRepoIdentity } from "./RepoIdentity.js";
import { type RoundContext, SyncEngine, type SyncEngineOpts } from "./SyncEngine.js";
import type { SyncRoundOptions, SyncState } from "./SyncTypes.js";

const log = createLogger("Sync:Bootstrap");

export interface BootstrapOpts {
	/** Source-repository checkout. Omit when only the Memory Bank vault is being synced. */
	readonly cwd?: string;
	readonly ui: ConflictUi;
	readonly onStateChange?: (state: SyncState) => void;
	/**
	 * Plan §0.12 — mid-round notification fired when `/credentials` returns
	 * 423 and the engine decides to wait before retrying. Wired by
	 * `VsCodeSyncBootstrap` to flip the status bar to "Personal Space busy"
	 * during the up-to-9-minute backoff window so the user isn't staring
	 * at a silent "Syncing…" spinner.
	 */
	readonly onLockedWait?: SyncEngineOpts["onLockedWait"];
	/**
	 * Per-phase progress signal — fired at the entry of each user-facing
	 * phase (download / merge / resolve / upload / wait). Wired by
	 * `VsCodeSyncBootstrap` to the sidebar Branch-tab toolbar so the user
	 * sees granular labels like "Getting latest memories…" instead of a
	 * silent "Syncing…" spinner.
	 */
	readonly onPhase?: SyncEngineOpts["onPhase"];
	/**
	 * Plan §P2#3 — fired when `repos.json` has 2+ identities claiming
	 * the same folder. VS Code surfaces this as a warning notification;
	 * CLI just logs.
	 */
	readonly onRepoMappingConflict?: SyncEngineOpts["onRepoMappingConflict"];
	/** Test seam — overrides the default `BackendClient`. */
	readonly backend?: BackendClient;
	/** Test seam — overrides the default `ai` factory (per-round Tier 2 provider). */
	readonly aiFactoryOverride?: SyncEngineOpts["ai"];
	/** Test seam — explicit context resolver, skips reading config from disk. */
	readonly resolveContextOverride?: (opts: SyncRoundOptions) => Promise<RoundContext>;
	/** Test seam — provides the vault client without spawning real git. */
	readonly makeVaultClientOverride?: SyncEngineOpts["makeGitClient"];
}

/**
 * Returns a configured `SyncEngine` or `null` when prerequisites are missing.
 * Callers MUST treat `null` as "skip this round — sync is dormant".
 */
export async function buildSyncEngine(opts: BootstrapOpts): Promise<SyncEngine | null> {
	const config = await loadConfig();
	if (!config.jolliApiKey) {
		log.debug("jolliApiKey missing — engine dormant (user must sign in)");
		return null;
	}

	const backend = opts.backend ?? new BackendClient();
	// Re-read `apiKey` / `model` per round instead of capturing them once at
	// build time. Without this, an Anthropic key swap (Settings → save) kept
	// using the old key until a window reload because the engine instance is
	// long-lived. The factory does a fresh `loadConfig` on every Tier 2 merge
	// attempt — cheap (one disk read), and Tier 2 isn't a hot path anyway.
	const ai = opts.aiFactoryOverride ?? defaultAiFactory;

	// Re-read `localFolder` on every round instead of capturing it at build
	// time. The orchestrator (VS Code) and the dormant-then-built path (CLI)
	// both keep a single engine instance across many rounds; if the user
	// re-points "Local Folder" in Settings between rounds, the UI and bridge
	// reload storage immediately, but a build-time capture would keep
	// sync'ing the OLD vault while the UI shows the NEW one — split-brain
	// where the next round push could either resurrect stale content or
	// (worse) leave fresh content unsync'd. Reloading per round costs one
	// extra `loadConfig()` read; cheap compared to a round's network I/O.
	const resolveContext =
		opts.resolveContextOverride ??
		(async (round: SyncRoundOptions) => {
			const fresh = await loadConfig();
			return defaultResolveContext(round, fresh.localFolder);
		});

	return new SyncEngine({
		backend,
		resolveContext,
		makeGitClient: opts.makeVaultClientOverride ?? defaultMakeGitClient,
		ai,
		ui: opts.ui,
		onStateChange: opts.onStateChange,
		onLockedWait: opts.onLockedWait,
		onPhase: opts.onPhase,
		onRepoMappingConflict: opts.onRepoMappingConflict,
		// P2 #1 — chain-spawn a QueueWorker after every sync release so a
		// worker that previously hit the 60 s `vault-write.lock` timeout
		// gets a retry without waiting for the next post-commit hook. The
		// worker's own startup quickly exits if the queue is empty (cheap
		// no-op), so spawning unconditionally is fine. `launchWorker` is
		// fire-and-forget — it spawns a detached child process.
		//
		// Cross-repo wakeup (P2): also drain the per-vault pending-worker
		// registry — any worker that timed out waiting on `vault-write.lock`
		// while sync held it recorded its cwd there. Without this, only the
		// round's own cwd would get a worker spawn; workers from OTHER
		// source repos sharing this vault would sit until their next
		// post-commit hook.
		onRoundComplete: (cwd) => {
			if (cwd !== undefined) launchWorker(cwd);
			void (async () => {
				try {
					const fresh = await loadConfig();
					// Resolve via `deriveMemoryBankRoot` so default-config
					// users (no `localFolder` set → `~/Documents/jolli/`)
					// also get the cross-repo wakeup. Passing raw
					// `fresh.localFolder` would no-op for them.
					const memoryBankRoot = deriveMemoryBankRoot(fresh.localFolder);
					const pending = await consumePendingWorkers(memoryBankRoot);
					for (const pendingCwd of pending) {
						if (pendingCwd !== cwd) {
							log.info("Waking pending worker after sync release: cwd=%s", pendingCwd);
							launchWorker(pendingCwd);
						}
					}
				} catch (e) {
					log.warn("onRoundComplete pending-worker drain failed (non-fatal): %s", (e as Error).message);
				}
			})();
		},
		// Tier 3 strategy: user-saved config wins; otherwise default to
		// `"prompt"`. The earlier `"newest"` default was misleading — the
		// engine always makes a reconcile commit a few ms before
		// `pull --rebase`, so timestamp comparison degenerated to "mine
		// always wins". `"prompt"` is the honest default: the UI
		// surfaces the conflict and the user picks. In practice Tier 1.5
		// / 2 / 2.7 absorb almost all real conflicts, so this prompt
		// path is cold.
		//
		// Narrow against the current union before handing off: the type
		// system trusts `config.syncConflictPolicy` but the value comes
		// from JSON on disk, so a stale `"newest"` written by an older
		// build would otherwise reach `ConflictResolver` and trip the
		// exhaustive `runTier3` (CLI has no UI; the prompt loop would
		// just spin returning `"skip"`).
		conflictPolicy: narrowConflictPolicy(config.syncConflictPolicy),
	});
}

/**
 * Validates the on-disk `syncConflictPolicy` against the current
 * `ConflictPolicy` union. Returns `"prompt"` when the value is missing
 * or unrecognized; warns loudly in the latter case so legacy `"newest"`
 * configs (or typos in the settings JSON) don't degrade silently into
 * a no-op prompt loop in headless CLI contexts.
 *
 * Exported for testing.
 */
export function narrowConflictPolicy(value: unknown): "prompt" | "mine" | "theirs" {
	if (value === "prompt" || value === "mine" || value === "theirs") return value;
	if (value !== undefined) {
		log.warn(
			'syncConflictPolicy=%j is not a recognized value; falling back to "prompt". Update Settings to pick one of: prompt, mine, theirs.',
			value,
		);
	}
	return "prompt";
}

/**
 * Default `resolveContext`. Exported for testing.
 *
 * Plan §0.13: `<localFolder>` is the git working tree (no separate
 * `~/.jolli/vaults/<user>/` clone). `memoryBankRoot` is the same directory;
 * per-source-repo content lives in `<localFolder>/<repoFolderName>/...`
 * as a subdirectory of that working tree.
 */
export async function defaultResolveContext(
	round: SyncRoundOptions,
	localFolder: string | undefined,
): Promise<RoundContext> {
	const memoryBankRoot = deriveMemoryBankRoot(localFolder);
	const author = { name: "Jolli Memory", email: "memory@jolli.ai" };
	if (round.cwd === undefined) return { memoryBankRoot, author };

	const identity = computeRepoIdentity(round.cwd);
	// `repoFolderName` MUST match the directory FolderStorage actually writes
	// to on disk — otherwise `repos.json` claims a folder that holds no
	// content while the real content sits in a sibling. Pre-fix this could
	// happen e.g. when KBPathResolver picked `<slug>-2` (legacy `-N`
	// collision logic) but the sync engine independently allocated
	// `<slug>-<hash6>` in `repos.json`. Use the same resolver FolderStorage
	// uses so the two layers always agree.
	//
	// `peekKBPath` (not `resolveKBPath`): we only need the folder name here.
	// `resolveKBPath` writes `.jolli/config.json` + creates the directory
	// as a side effect, which would make `fetchOrCloneWithRetry` see a
	// pre-existing folder and skip the real `git clone` for a fresh cold
	// start — falling through to `git init` + fetch + rebase against an
	// auto-initialized remote with no common ancestor.
	const repoName = extractRepoName(round.cwd);
	const remoteUrl = getRemoteUrl(round.cwd);
	const folderRootAbs = peekKBPath(repoName, remoteUrl, memoryBankRoot);
	const repoFolderName = basename(folderRootAbs);
	return {
		memoryBankRoot,
		repoFolderName,
		repoIdentity: identity.repoIdentity,
		author,
	};
}

/** Default vault-client factory. Exported for testing. */
/* v8 ignore start -- thin GitClient constructor wrapper, no logic; tests inject `makeVaultClientOverride` instead */
export function defaultMakeGitClient(
	creds: import("./SyncTypes.js").GitCredentials,
	memoryBankRoot: string,
): GitClient {
	return new GitClient({ memoryBankRoot, credentials: creds });
}
/* v8 ignore stop */

/**
 * `<localFolder>` resolves to the user-configured path or
 * `~/Documents/jolli/` by default. Plan §0.13 makes this directory the
 * single git working tree for the user's vault (no separate clone under
 * `~/.jolli/vaults/...`). Exported for testing.
 *
 * Delegates to {@link resolveKbParent}, which silently falls back to the
 * default `~/Documents/jolli/` for invalid `localFolder` values (relative
 * paths, `..` segments) with a `WARN` log. This mirrors the lenient
 * behavior of `resolveKBPath` so every write path in the system agrees on
 * the same fallback target — without that agreement, an invalid
 * `localFolder` would split-brain by sending FolderStorage to the default
 * while git init aimed elsewhere. Surface-level UX for "your localFolder
 * is invalid" is handled in a separate PR via input-boundary validation
 * (configure / Settings UI) rather than a use-point exception.
 */
export function deriveMemoryBankRoot(localFolder: string | undefined): string {
	return resolveKbParent(localFolder);
}

/**
 * Per-round Tier 2 AI provider factory. Reads `apiKey` + `model` fresh from
 * CLI config on every call so a Settings change takes effect on the next
 * conflict merge without a window reload. Exported for testing.
 */
export async function defaultAiFactory(): Promise<LocalAiMergeProvider | null> {
	const fresh = await loadConfig();
	if (!fresh.apiKey) return null;
	return new LocalAiMergeProvider({ apiKey: fresh.apiKey, model: fresh.model });
}
