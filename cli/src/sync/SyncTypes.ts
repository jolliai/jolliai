/**
 * Shared types for the Memory Bank sync engine.
 *
 * Pure type module — no runtime imports — so every consumer (CLI hook,
 * VS Code Plugin, future IntelliJ port) imports from one source. Splitting
 * types out also keeps `import type` cycles trivial.
 */

/**
 * Identity of a source repository (e.g. the user's `~/jolli/jolliai` working
 * tree). Computed locally; never sent to the backend (the backend tracks one
 * vault per user, not per source repo).
 */
export interface RepoIdentity {
	/**
	 * The canonical string used to derive `repoFolderName`. Comes from the
	 * normalized git remote URL when available, else the workspace folder
	 * basename. Determines the on-disk vault subdirectory deterministically.
	 */
	readonly repoIdentity: string;
	/**
	 * Slugified source-repo name (NOT the user-slug). Derived from
	 * `KBPathResolver.extractRepoName` so it follows the same logic used to
	 * pick `<localFolder>/<repoName>/`. Lowercase, `[a-z0-9-]` only.
	 */
	readonly slug: string;
}

/**
 * Short-lived GitHub Installation Token + endpoint info returned by
 * `POST /api/mb-sync/credentials`. Cached in process memory only; never
 * persisted (token in `~/.git-credentials` or any other on-disk store is
 * a known leak surface).
 *
 * Shape mirrors backend's `MemoryBankSyncRouter.ts` response. `gitUrl` is the
 * client-side alias of `repoCloneUrl` (kept for backwards-compat with earlier
 * client drafts that used the shorter name).
 *
 * `alreadyVaultBound === false` drives the first-bind migration path in
 * `SyncEngine.runRound`; `true` skips it and goes straight to steady-state.
 */
export interface GitCredentials {
	readonly gitUrl: string; // alias of repoCloneUrl
	readonly token: string; // ghs_xxx, TTL ≤ 1h
	readonly expiresAt: number; // epoch ms — UTC
	readonly repoFullName: string; // "jolli-vaults/<user-slug>"
	readonly defaultBranch: string; // typically "main"
	readonly githubRepoCreated: boolean; // informational; not branched on
	readonly alreadyVaultBound: boolean;
	/**
	 * Per-space write-lock owner returned by `/credentials`. Echoed back to
	 * `/complete-migration` so the backend can verify the caller still holds
	 * the lock before flipping `metadata.vault`.
	 */
	readonly lockOwnerToken: string;
}

/**
 * A single doc returned by `GET /api/mb-sync/legacy-content`. Backend
 * pre-filters soft-deleted rows; client never inspects `deletedAt`.
 */
export interface LegacyDoc {
	readonly id: number;
	readonly jrn: string;
	readonly slug: string;
	readonly path: string;
	readonly docType: string;
	readonly parentId: number | null;
	readonly content: string;
	readonly contentType: string;
	readonly sortOrder: number;
	readonly createdAt: string; // ISO8601
	readonly updatedAt: string; // ISO8601
}

/**
 * Response shape of `GET /api/mb-sync/legacy-content`. Idempotent: once the
 * personal space has flipped to `backing_type=git` the backend returns
 * `alreadyMigrated: true` with empty `docs`, so the client can re-poll during
 * the db→git transition without duplicating writes.
 */
export interface LegacyContentResponse {
	readonly spaceId: number;
	readonly spaceSlug: string;
	readonly alreadyMigrated: boolean;
	readonly docs: ReadonlyArray<LegacyDoc>;
}

/** UI-facing sync state, surfaced as the four icons in the status bar. */
export type SyncState = "synced" | "syncing" | "conflicts" | "offline";

/**
 * Persisted device-local state at `~/.jolli/jollimemory/sync-state.json`.
 * File schema is `Record<userSlug, SyncStateFile>` so a single machine can
 * hold state for multiple users without conflict (rare but possible during
 * account switches).
 */
export interface SyncStateFile {
	readonly version: 1;
	readonly userSlug: string;
	readonly repoFolderName: string;
	readonly lastFetchAt?: string;
	readonly lastPushAt?: string;
	readonly lastSyncStatus: SyncState;
	readonly lastError?: { readonly code: string; readonly message: string; readonly at: string };
	readonly pendingConflicts: ReadonlyArray<ConflictRecord>;
	readonly checkoutPath: string;
}

/** A single conflict recorded as awaiting user resolution (Tier 3 skip path). */
export interface ConflictRecord {
	readonly path: string;
	readonly tier: 2 | 3;
	readonly detectedAt: string;
	readonly oursOid?: string;
	readonly theirsOid?: string;
	readonly baseOid?: string;
}

/**
 * Stable error codes carried on `SyncRoundResult.lastError`. The string union
 * is the source of truth used by the engine, status orchestrator, and status
 * bar; adding a new code requires updating consumers.
 *
 *   - `network`                    Backend unreachable / DNS / timeout.
 *   - `mint_failed`                `/credentials` returned 401 / 4xx / 5xx.
 *   - `git_missing`                `git` binary not on PATH.
 *   - `clone_failed`               Step-level clone exhausted retries.
 *   - `fetch_failed`               Step-level fetch exhausted retries.
 *   - `pull_failed`                `git pull --rebase` errored non-conflict.
 *   - `migration_failed`           db→git first-bind migration errored.
 *   - `sync_failed_after_retries`  push exhausted retries (incl. recovery).
 *   - `vault_mismatch`             `<memoryBankRoot>/.git` exists but the
 *     vault marker is missing OR the origin URL doesn't match the freshly
 *     minted credentials. Terminal — the engine refuses to write to a
 *     folder it can't prove belongs to this personal space (otherwise a
 *     user who pointed Memory Bank at a non-vault repo would have it
 *     rewritten + pushed to the wrong origin). User must reselect the
 *     Memory Bank folder.
 *
 * Engine emits the most specific code it has; status bar text decides "Sync
 * failed" vs plain "Offline" based on whether the code is terminal (anything
 * other than `network`).
 */
/**
 * Mid-round progress notification fired when `mintGitCredentials` hits a
 * 423 vault_locked and decides to wait before retrying (plan §0.12). The
 * engine emits one event per retry attempt, before each backoff sleep, so
 * the UI can flip from the silent "Syncing…" state into a visible
 * "Personal Space busy" indicator — otherwise the user stares at a
 * spinner for up to 9 minutes with no clue what's holding things up.
 */
export interface VaultLockedWaitInfo {
	/** 1-indexed attempt number that just observed 423 (1 = the initial mint). */
	readonly attempt: number;
	/** Total attempts including the initial; e.g. 4 for default schedule. */
	readonly totalAttempts: number;
	/** Wait in ms before the next retry; 0 on the final attempt (no more retries). */
	readonly nextRetryInMs: number;
	/** Human-readable message from `VaultLockedError`. */
	readonly message: string;
	/**
	 * `true` iff the 423 is verifiably caused by THIS device's prior round
	 * — a previous `mintGitCredentials` succeeded (acquired the backend
	 * write-lock), the resulting `lockOwnerToken` is persisted in
	 * `pending-lock.json`, never cleared by a subsequent `notifyPush` /
	 * `completeMigration`, and the entry is still within the backend's
	 * lock-TTL grace window. `false` when no such evidence exists — either
	 * a peer device is holding the lock, or the previous lock has timed
	 * out on the backend (in which case the 423 is from yet another race
	 * we can't attribute locally). Drives the status-bar `selfLocked`
	 * relabel — `false` means "another device is syncing", `true` means
	 * "your previous sync's lock is still releasing".
	 *
	 * Persistence-backed (not an in-memory memo): survives plugin reload,
	 * works for CLI rounds, and clears itself once the TTL grace window
	 * elapses so a peer-locked 423 isn't mislabelled forever after one
	 * unrelated self-locked failure.
	 */
	readonly selfLocked: boolean;
}

/**
 * Recoverable / transient failure — the next round may succeed without
 * user action. Today the only transient code is `network` (DNS hiccup,
 * dropped connection, timeout). StatusBar renders these as plain
 * "Offline" rather than the red "Sync failed" branch.
 */
export type TransientSyncErrorCode = "network";

/**
 * Terminal failure — the next round will not succeed until the user
 * fixes something (auth, folder selection, server-side permission, …).
 * StatusBar renders these as red "Sync failed" with the code-specific
 * message in the tooltip.
 *
 * Adding a new code here is a compile-time signal to every `switch`
 * statement on `SyncErrorCode` to add a branch — see `isTerminal` and
 * the StatusBar renderer's `assertNever` exhaustiveness check.
 */
export type TerminalSyncErrorCode =
	| "mint_failed"
	| "vault_locked"
	| "vault_mismatch"
	/**
	 * User-configured `localFolder` is unusable (not absolute, or contains
	 * `..`). Raised by `assertValidLocalFolder` on the sync write path so
	 * the status bar shows "Memory Bank folder invalid" instead of silently
	 * falling back to `~/Documents/jolli/` while Settings still shows the
	 * user's chosen path. Auto-clears once the user fixes the setting.
	 */
	| "localfolder_invalid"
	/**
	 * `git push` rejected by a server-side hook / branch protection
	 * (pre-receive `declined`, protected-branch policy, payload-size
	 * limit, etc.). Distinguished from `network` because the next round
	 * cannot recover by waiting — the server has refused the content.
	 */
	| "push_rejected"
	| "git_missing"
	| "clone_failed"
	| "fetch_failed"
	| "pull_failed"
	| "migration_failed"
	/* `symlink_quarantine_failed` REMOVED in Phase 1 alongside SymlinkSweep.
	 * Symlink defence is now per-write (FolderStorage.safeAtomicWriteSync)
	 * and per-stage (stageVault's symlinked canary bucket), neither of which
	 * terminates the round — sync continues with the rogue entries excluded
	 * and the warn log surfaces the offending path. No SyncErrorCode is
	 * needed because symlink-related skips no longer escalate to a terminal
	 * round result. */
	| "sync_failed_after_retries";

export type SyncErrorCode = TransientSyncErrorCode | TerminalSyncErrorCode;

/**
 * Type-narrowing predicate. Use everywhere the previous code did
 * `code !== "network"` so adding a new terminal code (or splitting
 * `network` into `network_transient` / `network_dns_terminal` later)
 * becomes a compile error rather than a silent classifier drift.
 */
export function isTerminalSyncError(code: SyncErrorCode): code is TerminalSyncErrorCode {
	return code !== "network";
}

/**
 * Result of a single `SyncEngine.runRound()` invocation.
 *
 * **Trust caveat for `fetched` / `pulled` / `pushed`:** these booleans are
 * authoritative only when the engine returned normally. When the value was
 * synthesized by `StatusOrchestrator.tick`'s catch block (mid-round throw —
 * the engine's `runRound` contract does not surface partial progress on an
 * unexpected exception), all three are hardcoded to `false` even though a
 * partial pull / partial push may have already landed bytes on disk. Use
 * `newState === "offline" && lastError?.code === "sync_failed_after_retries"`
 * as the marker that the booleans are not load-bearing; in that branch only
 * `newState` and `lastError` are trustworthy. Downstream consumers that
 * need an "anything might have changed on disk" signal (cache invalidation,
 * tree refresh) should fire unconditionally on round-finish rather than
 * gating on the booleans.
 */
export interface SyncRoundResult {
	readonly fetched: boolean;
	readonly pulled: boolean;
	readonly pushed: boolean;
	readonly conflicts: ReadonlyArray<ConflictRecord>;
	readonly newState: SyncState;
	/**
	 * Populated when the round ends in `offline` state. Carries the failure
	 * code (see `SyncErrorCode`) and a human-readable message. `synced` /
	 * `syncing` / `conflicts` outcomes leave this undefined.
	 *
	 * `selfLocked` is set ONLY on `code === "vault_locked"`. Semantics match
	 * `VaultLockedWaitInfo.selfLocked` — `true` when persisted evidence
	 * proves the lock is held by this device's prior round; `false` /
	 * absent otherwise. Other codes leave it absent.
	 */
	readonly lastError?: {
		readonly code: SyncErrorCode;
		readonly message: string;
		readonly selfLocked?: boolean;
	};
	/**
	 * Non-fatal canary surface populated by `stageVault` when the staging
	 * allowlist filter encountered paths that should not have been there:
	 *
	 *   - `symlinked` — leaf or path-chain symlink at a classifier-matching
	 *     location (`<repoFolder>/.jolli/...` etc.). Strong hostile-placement
	 *     signal. Round still completes; the symlinked path is excluded from
	 *     the commit. Status bar / UI consumers should surface these even
	 *     when `newState === "synced"`.
	 *   - `unowned` — path that classifier didn't recognise (foreign writer,
	 *     classifier-drift candidate, or a manual file the user dropped in
	 *     the vault). Weak signal — typically benign but worth logging.
	 *
	 * Both fields are capped at the first 10 paths per round to keep
	 * structured logs small; the warn-log inside `stageVault` carries the
	 * complete count. Undefined when no canary entries were observed across
	 * any of the round's `stageVault` invocations.
	 */
	readonly canary?: {
		readonly symlinked: ReadonlyArray<string>;
		readonly unowned: ReadonlyArray<string>;
	};
}

/**
 * Coarse, user-facing phases the sync engine emits via `SyncEngineOpts.onPhase`
 * so the VS Code sidebar toolbar can show progress like "Getting latest
 * memories… → Bringing it together… → Sharing your changes…".
 *
 * Deliberately narrower than the engine's actual step list — only the slow
 * (user-perceived wait) or failure-prone phases are in the union. Fast and
 * reliable steps (credential mint, `git --version`, symlink sweep, `git add`,
 * `git commit`) are *not* signalled; whichever phase last emitted stays
 * visible while they run.
 *
 * Multiple engine steps may collapse onto the same phase (e.g. `autoReconcile`
 * + `pullRebase` both emit `"merging"`; first-bind migration push and the
 * steady-state push both emit `"uploading"`). That collapse is intentional —
 * the UI doesn't benefit from distinguishing them.
 */
export type SyncPhase = "downloading" | "merging" | "resolving" | "uploading" | "waiting";

/** Caller-supplied options for `SyncEngine.runRound()`. */
export type SyncRoundOptions =
	| {
			readonly cwd: string;
			readonly reason: "post-commit" | "poll" | "manual" | "first-bind";
			readonly transcripts: boolean;
	  }
	| {
			/** A missing cwd is valid only for an explicit vault-only manual sync. */
			readonly cwd?: undefined;
			readonly reason: "manual";
			readonly transcripts: boolean;
	  };
