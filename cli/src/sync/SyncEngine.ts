/**
 * Memory Bank sync engine — the round-driver that ties everything together.
 *
 * Single public entry: `runRound(opts)`. The flow (see
 * `plan-personal-memory-bank-jolly-breeze.md §0.6` for the revised token
 * lifecycle, §1 SyncEngine.runRound for the high-level sequence):
 *
 *   1. Acquire `sync.lock` with the source-plan 10 s budget.
 *   2. **Mint fresh credentials** (every round, no cross-round cache).
 *   3. Probe `git --version`.
 *   4. Ensure `<memoryBankRoot>` is a git working tree pointed at the
 *      personal-space remote — three paths: existing `.git` → fetch; dir
 *      exists without `.git` → `git init` + `remote add` + fetch; nothing
 *      yet → `git clone`. Step-level retry (≤3 attempts) with
 *      at-most-one-per-round re-mint on 401/404.
 *   5. `git fetch origin` — same step-level retry policy.
 *   6. Auto-reconcile any user-side edits in `<memoryBankRoot>` so
 *      pull-rebase doesn't trip on a dirty working tree, then
 *      `git pull --rebase` — drive conflict resolver on conflicts.
 *   7. `MemoryBankBootstrap.ensureBootstrap` (writes `.gitignore`, prunes
 *      transcripts from the index on toggle-off) + optional
 *      `LegacyMigration.apply` for db→git first-bind only.
 *   8. `git add --all` + `commit` (skipped when nothing to commit) + `push`
 *      with step-level retry up to 3 times (non-FF → pull-rebase; 401/404 →
 *      tryRemint + retry; other → terminal).
 *   9. `backend.notifyPush(headOid)` — fire-and-forget.
 *  10. Emit `synced` state, release `sync.lock`.
 *
 * **Re-mint idempotency (§0.6)**: the engine tracks `remintsUsed` per round
 * and refuses a second recovery mint, returning `sync_failed_after_retries`
 * instead. This keeps backend `ensureGithubRepoExists` from being invoked
 * twice in one round — combined with backend's own idempotent
 * GET-then-create-by-fixed-name logic, no duplicate `<slug>-2` private repos
 * are ever created.
 *
 * All long-running phases bump the `sync.lock` mtime via `setInterval` so
 * a slow Tier-2 LLM call cannot be reaped by the stale-lock reclaimer.
 *
 * State transitions are surfaced via `onStateChange` so the VS Code
 * `StatusOrchestrator` can drive the status-bar machine. Errors are mapped
 * into the four UI states: network / git-missing / mint-failed → `offline`;
 * skipped conflicts → `conflicts`; success → `synced`. Each `offline`
 * outcome carries a `lastError: { code, message }` so the status bar can
 * render "Sync failed" vs "Offline" and surface the cause in its tooltip.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { track } from "../core/Telemetry.js";
import { runWithTrace } from "../core/TraceContext.js";
import { createLogger } from "../Logger.js";
import {
	type BackendClient,
	SyncBackendNetworkError,
	SyncBackendUnauthorizedError,
	VaultLockedError,
	WebFlushPendingError,
} from "./BackendClient.js";
import { runBootstrapMerge, shouldRunBootstrapMerge } from "./BootstrapMerge.js";
import { buildCommitMessage } from "./CommitMessage.js";
import {
	type AiMergeProvider,
	type ConflictPolicy,
	ConflictResolver,
	type ConflictResolverOpts,
	type ConflictUi,
} from "./ConflictResolver.js";
import { quarantineCorruptJson } from "./CorruptJsonQuarantine.js";
import { type GitClient, isNetworkErrorMessage, isRepoMissingMessage, isServerRejectionMessage } from "./GitClient.js";
import { LegacyMigration } from "./LegacyMigration.js";
import { isPerDeviceJsonPath, MemoryBankBootstrap } from "./MemoryBankBootstrap.js";
import { clearPendingLock, readPendingLock, writePendingLock } from "./PendingLockStore.js";
import {
	canonicalizeRepoMapping,
	findRepoMappingConflicts,
	loadRepoMapping,
	type RepoMappingConflict,
	reconcileMappingAdditive,
	resolveOrAssignFolder,
	saveRepoMapping,
	scanFolderIdentities,
} from "./RepoMapping.js";
import { stageVault } from "./StageVault.js";
import { acquireSyncLock, refreshSyncLockMtime, releaseSyncLock } from "./SyncLock.js";
import type {
	ConflictRecord,
	GitCredentials,
	SyncErrorCode,
	SyncPhase,
	SyncRoundOptions,
	SyncRoundResult,
	SyncState,
	VaultLockedWaitInfo,
} from "./SyncTypes.js";
import { normalizeGitUrl, verifyVaultMarker, writeVaultMarker } from "./VaultMarker.js";
import { classifyVaultPath } from "./VaultPathClassifier.js";
import { acquireVaultWriteLock, DEFAULT_PULL_LOCK_WAIT_MS } from "./VaultWriteLock.js";

const log = createLogger("Sync:Engine");

/**
 * Sentinel thrown by `pullRebaseLocked` when `vault-write.lock` is held by
 * a concurrent QueueWorker longer than `DEFAULT_PULL_LOCK_WAIT_MS` allows.
 * Caught in `runRound` and routed to the transient `network` outcome so
 * the next round retries; not a terminal red "Sync failed".
 */
class VaultLockBusyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VaultLockBusyError";
	}
}

/**
 * One factory per round so a single `SyncEngine` instance can drive
 * multiple `SyncRoundOptions` without stashing the credentials/path
 * derivation on `this`.
 */
/** Builds a `GitClient` for the given credentials and vault root. */
export type GitClientFactory = (creds: GitCredentials, memoryBankRoot: string) => GitClient;

export type MemoryBankBootstrapFactory = (opts: {
	vaultClient: GitClient;
	memoryBankRoot: string;
	transcripts: boolean;
}) => MemoryBankBootstrap;

export type LegacyMigrationFactory = (opts: { memoryBankRoot: string; transcripts: boolean }) => LegacyMigration;

export type ResolverFactory = (client: GitClient) => ConflictResolver;

interface RoundContextBase {
	/**
	 * Git working tree root — also the FolderStorage root (plan §0.13).
	 * Defaults to `<localFolder>` (≈ `~/Documents/jolli/`).
	 */
	readonly memoryBankRoot: string;
	/** `git commit --author` flag. */
	readonly author: { readonly name: string; readonly email: string };
}

export type RoundContext = RoundContextBase &
	(
		| {
				/** Subdirectory of `memoryBankRoot` holding this source repo's Memory Bank content. */
				readonly repoFolderName: string;
				/** Stable source-repo identity, normally derived from its normalized Git remote URL. */
				readonly repoIdentity: string;
		  }
		| {
				/** Vault-only rounds have no source-repository mapping to add. */
				readonly repoFolderName?: undefined;
				readonly repoIdentity?: undefined;
		  }
	);

export interface SyncEngineOpts {
	readonly backend: BackendClient;
	readonly resolveContext: (opts: SyncRoundOptions) => Promise<RoundContext>;
	readonly makeGitClient: GitClientFactory;
	readonly makeBootstrap?: MemoryBankBootstrapFactory;
	readonly makeLegacyMigration?: LegacyMigrationFactory;
	readonly makeResolver?: (
		client: GitClient,
		extra: Pick<ConflictResolverOpts, "resolveVaultPath" | "author">,
	) => ConflictResolver;
	/**
	 * Tier 2 AI merge provider, resolved on-demand per round. Returning a
	 * factory (rather than a pre-built instance) lets the bootstrap re-read
	 * `apiKey` / `model` from CLI config every round so a Settings change
	 * takes effect on the very next merge — pre-fix the provider was
	 * captured at engine construction and outlived the config it was built
	 * with, so an Anthropic key swap silently kept using the old key until
	 * a window reload.
	 *
	 * `null` means Tier 2 is unavailable (no `apiKey` configured) — the
	 * resolver falls straight through to Tier 3.
	 */
	readonly ai: () => Promise<AiMergeProvider | null>;
	readonly ui: ConflictUi;
	readonly onStateChange?: (state: SyncState, ctx: SyncRoundResult) => void;
	/**
	 * Fired AFTER `sync.lock` (and any per-round `vault-write.lock` held by
	 * `withPullLock`) have been released, regardless of round outcome.
	 *
	 * Closes the "chain-spawn from sync release" promise documented at
	 * `QueueWorker.ts` (~line 264). A worker that hit the 60 s
	 * `vault-write.lock` wait and exited leaves its queue entries undrained;
	 * historically the only thing that woke them was the next `post-commit`
	 * hook on the source repo. If the user stopped committing right after
	 * the timeout, summaries sat in the queue indefinitely.
	 *
	 * The wireup point (`SyncBootstrap` for CLI, `VsCodeSyncBootstrap` for
	 * the extension) passes `launchWorker(cwd)` here. The engine itself does
	 * NOT import `QueueWorker` — that would couple `cli/src/sync/` to
	 * `cli/src/hooks/` and create a layering cycle. Errors thrown from the
	 * callback are caught + logged (same convention as `onStateChange` /
	 * `onLockedWait`).
	 *
	 * `cwd` is the optional source-repo cwd from `SyncRoundOptions`. Vault-only
	 * rounds omit it but still fire the callback so cross-repo pending workers
	 * can be drained after the vault lock is released.
	 */
	readonly onRoundComplete?: (cwd?: string) => void;
	readonly lockTimeoutMs?: number;
	readonly refreshIntervalMs?: number;
	readonly maxPushRetries?: number;
	/**
	 * Override the 423-retry backoff schedule (plan §0.8). Each entry is
	 * the wait in ms before the next retry attempt; the array length =
	 * number of retries (initial attempt is implicit). Tests pass an
	 * array of zeros (e.g. `[0, 0, 0]`) to keep the retry count but skip
	 * the wall-clock waits; production code uses
	 * `VAULT_LOCKED_RETRY_SCHEDULE_MS` (1 min → 3 min → 5 min).
	 */
	readonly vaultLockedRetrySchedule?: ReadonlyArray<number>;
	/**
	 * Mid-round notification fired every time `mintGitCredentials` observes
	 * 423 vault_locked and decides to wait before the next retry (plan
	 * §0.12). The orchestrator wires this through to the status bar so the
	 * user sees "Personal Space busy" instead of an opaque "Syncing…"
	 * spinner during the up-to-9-minute backoff window. Errors thrown from
	 * the callback are caught + logged (don't break the round).
	 */
	readonly onLockedWait?: (info: VaultLockedWaitInfo) => void;
	/**
	 * Mid-round phase progress fired at the entry of each user-facing phase
	 * (download / merge / resolve / upload / wait). Drives the sidebar
	 * toolbar's per-phase label so the user can tell *where* a round is —
	 * and, on failure, which phase broke. See `SyncPhase` doc for which
	 * engine steps map to which phase. Best-effort: errors thrown by the
	 * callback are caught + logged (don't break the round), same semantics
	 * as `onStateChange` and `onLockedWait`.
	 */
	readonly onPhase?: (phase: SyncPhase) => void;
	/**
	 * Fired when `repos.json` is observed with 2+ `repoIdentity` values
	 * claiming the same folder (plan §P2#3). The merge layer no longer
	 * silently renames the loser to `<folder>-<hash6>` (that produced a
	 * lying mapping because no code moved disk content), so the engine
	 * surfaces the conflict and lets the user manually rename one side's
	 * source repo or `localFolder`. VS Code wires this to a warning
	 * notification; CLI just logs. Errors from the callback are caught
	 * and logged so they never break a round.
	 */
	readonly onRepoMappingConflict?: (conflicts: ReadonlyArray<RepoMappingConflict>) => void;
	/**
	 * Tier 3 fallback strategy for conflicts that Tier 1.5 / 2 / 2.7 can't
	 * handle losslessly. Surfaced verbatim from `config.syncConflictPolicy`
	 * by `SyncBootstrap`. Defaults to `"newest"` (sync-friendly last-writer-
	 * wins) inside `ConflictResolver` when unset, so an undefined value
	 * still works without crashing.
	 */
	readonly conflictPolicy?: ConflictPolicy;
}

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
/** Step-level attempt budget for clone / fetch / push (plan §0.6). */
const DEFAULT_MAX_STEP_ATTEMPTS = 3;
/**
 * Hard cap on recovery re-mints within a single phase of a round (§0.6
 * idempotency invariant). A "phase" is either the first-bind migration
 * push OR the steady-state push; `remintsUsed` is reset to 0 between
 * them so a 401 that burned the budget during migration doesn't doom
 * the steady-state push that follows.
 *
 * The §0.6 "no duplicate private repos" invariant is preserved because
 * the backend's `ensureGithubRepoExists` is idempotent (looks up
 * `<org>/<slug>` before POSTing), so a second mint within the same
 * round still results in at most one repo creation. The client-side
 * budget is belt-and-suspenders; loosening to per-phase only changes
 * what we tolerate from a misbehaving network, not what gets
 * provisioned.
 */
const MAX_REMINTS_PER_PHASE = 1;
/**
 * 423 vault_locked retry schedule (plan §0.8). Backoff delays in ms, one
 * per retry. The initial attempt is NOT in this array — it runs at t=0
 * unconditionally; the schedule kicks in only when the initial attempt
 * returns 423.
 *
 * Default schedule: 1 min → 2 min → 3 min (4 total attempts, 6 min total
 * budget). Tuned to:
 *   - Cover one normal sync round at the upper end (rare > 1 min) on the
 *     first retry, plus give a struggling peer extra slack on the 2nd/3rd.
 *   - Keep the user's "Sync Now" click responsive enough that they don't
 *     stare at a stuck spinner — the bar flips to `Personal Space busy`
 *     within seconds of the first 423.
 *
 * Previous 9 min budget came from assuming the lock was held by *another
 * device* whose own sync round might run long. The dominant failure mode
 * in the field turned out to be **self-locked** — a previous round on the
 * SAME device acquired the lock at mint time, then bailed before push
 * (vault_mismatch, pull conflict, push-after-retries), leaving the
 * backend lock dangling for its full TTL. Tightening the schedule to 6
 * min trims the worst-case "stare at busy banner" experience while still
 * exceeding the typical lock TTL.
 */
const VAULT_LOCKED_RETRY_SCHEDULE_MS: ReadonlyArray<number> = [60_000, 120_000, 180_000];

/**
 * How long a persisted `lockOwnerToken` is treated as "still possibly
 * held by THIS device's previous round" before being considered stale.
 *
 * Backend's per-space write-lock TTL is ≤ the retry-schedule total (6 min,
 * see `VAULT_LOCKED_RETRY_SCHEDULE_MS`); after that the backend has
 * released the lock on its own, even without a `notifyPush` call. Once
 * the persisted entry is older than this window, a fresh 423 is almost
 * certainly peer-induced, not self-induced. Picking exactly the retry
 * total means a worst-case "previous round crashed mid-push" entry
 * stays self-attributed through the full backoff of the very next
 * attempt — and then auto-clears for any later round so a stale entry
 * can't mislabel an unrelated peer-locked 423 hours later.
 */
const SELF_LOCK_TTL_GRACE_MS = 6 * 60_000;

/**
 * Per-round mutable state threaded through the step-level retry helpers.
 *
 * Replaces the old module-level `TokenCache` (deleted in §0.6). Token is
 * minted at round start and ONLY mutated by `tryRemint`, which is itself
 * capped at `MAX_REMINTS_PER_PHASE` recovery calls. `remintsUsed` is reset
 * to 0 at phase boundaries (currently: after a successful first-bind
 * migration push) so each phase gets its own at-most-one recovery budget.
 * Backend's `ensureGithubRepoExists` is idempotent, so per-phase budgets
 * still satisfy §0.6's "no duplicate `<slug>-2` private repos" guarantee
 * — a second mint within the same round resolves to the same repo.
 *
 * When `tryRemint` succeeds it ALSO swaps `client` for a fresh
 * `GitClient` (the askpass-resolved token is baked into the spawned
 * git process's env at `prepareAskpass()` time — recovery requires a new
 * client, not just new creds).
 */
interface RoundState {
	creds: GitCredentials;
	client: GitClient;
	remintsUsed: number;
	readonly ctx: RoundContext;
}

/** Recovery cause passed to `tryRemint` purely for log/telemetry clarity. */
type RemintCause = "unauthorized" | "repoMissing";

/**
 * JOLLI-1577 — per-round backend-lock disposition tracker.
 *
 * Created fresh in `runRound`, threaded into every helper that touches a
 * mint or release transition, and consulted in `runRound`'s finally to
 * decide whether to call `backend.releaseLock`.
 *
 * Why an external mutable holder (not a field on `RoundState`):
 * `RoundState` lives entirely inside `doRound`; this holder must outlive
 * it so `runRound`'s `finally` block (one level up the call stack) can
 * still inspect it after `doRound` returns / throws.
 *
 * Mutation rules — kept in lockstep with the wrappers that update them:
 *   - `mintFresh` success → set `token` + `releaseInFinally = true`.
 *   - `notifyPush` success (call sites at lines 1140, 1290) → clear
 *     `releaseInFinally` (backend already released).
 *   - `tryCompleteMigration` success (`deferred: false` branch) → clear
 *     `releaseInFinally` (backend already released).
 *   - `tryCompleteMigration` success (`deferred: true` branch — HEAD
 *     unborn) → clear `releaseInFinally` (defer to next round; explicit
 *     user choice).
 *   - `runFirstBindMigration` sets `completionDeferred = true` → caller
 *     clears `releaseInFinally` at the same moment (defer rationale as
 *     above).
 */
interface RoundLockHolder {
	/** Latest minted lockOwnerToken this round, or null if mint never succeeded. */
	token: string | null;
	/**
	 * True iff `runRound`'s finally should call `backend.releaseLock`.
	 * Cleared on every success path that already released via
	 * `notifyPush` / `completeMigration`. Does NOT alone govern the
	 * deferred-completion case — see `deferredCompletion` below.
	 *
	 * Re-mint mid-round sets this back to `true` (the new token is now
	 * the candidate for finally release). This is correct in the
	 * non-deferred case but would override the deferred-completion
	 * choice if used alone — which is why finally also checks
	 * `!deferredCompletion`.
	 */
	releaseInFinally: boolean;
	/**
	 * True iff the round has established a `completeMigration` defer
	 * (either via `runFirstBindMigration` returning
	 * `completionDeferred: true`, or `tryCompleteMigration` returning
	 * `{ ok: true, deferred: true }`). Set once and ONLY cleared by a
	 * successful `completeMigration` against the backend. Crucially,
	 * `mintFresh` does NOT touch this — so a recovery re-mint after the
	 * defer boundary cannot accidentally re-arm finally release and
	 * violate the user's "delay-path doesn't release lock" choice.
	 *
	 * Finally consults this in addition to `releaseInFinally`: release
	 * only iff `token !== null && releaseInFinally && !deferredCompletion`.
	 */
	deferredCompletion: boolean;
}

/** Cap on per-round canary path lists to keep structured logs small. */
const CANARY_PATH_CAP = 10;

export class SyncEngine {
	private readonly opts: SyncEngineOpts;
	/**
	 * Per-round accumulator for `stageVault` canary buckets. Reset at the
	 * start of each `runRound` and folded into the returned `SyncRoundResult`
	 * before the lock is released. `runRound` is serialised by `sync.lock`,
	 * so this field is never observed by two rounds concurrently.
	 */
	private canary: { symlinked: string[]; unowned: string[] } = { symlinked: [], unowned: [] };

	constructor(opts: SyncEngineOpts) {
		this.opts = opts;
	}

	/**
	 * Stages via `stageVault` and folds the report's `symlinked` / `unowned`
	 * arrays into `this.canary`. Replaces every direct `stageVault` call so
	 * a synced-but-rogue round can still surface the canary on
	 * `SyncRoundResult.canary` — without this, `symlinked` paths would only
	 * appear in StageVault's own warn log and the round would show green
	 * with no UI affordance.
	 */
	private async stageVaultTracked(
		client: GitClient,
		memoryBankRoot: string,
		opts: { syncTranscripts: boolean },
	): Promise<void> {
		const report = await stageVault(client, memoryBankRoot, opts);
		if (report.symlinked.length > 0) {
			const room = CANARY_PATH_CAP - this.canary.symlinked.length;
			if (room > 0) this.canary.symlinked.push(...report.symlinked.slice(0, room));
		}
		if (report.unowned.length > 0) {
			const room = CANARY_PATH_CAP - this.canary.unowned.length;
			if (room > 0) this.canary.unowned.push(...report.unowned.slice(0, room));
		}
	}

	/**
	 * Classifier-aware "is there anything owned that needs to be committed?"
	 * probe. Used as the idle short-circuit gate in `doRound` — see the doc
	 * comment at the call site for why `GitClient.hasUncommittedChanges`
	 * (plain `git status --porcelain`, no `--ignored`) is the wrong gate
	 * under the deny-all `.gitignore` regime.
	 *
	 * Mirrors `stageVault`'s entry-by-entry classification:
	 *
	 *   - Unmerged (`U`) → counted as dirty. The conflict resolver should have
	 *     handled these earlier, but if one slipped through we must NOT
	 *     idle-skip — staging them later will at least surface the issue.
	 *   - `classifyVaultPath(path) === null` → unowned. Skipped here; the
	 *     canary surface (via `stageVaultTracked`) is the right reporting
	 *     channel and forcing a stage round just for unowned noise (e.g. the
	 *     `.memorybank-state.json` sentinel, P3 #1) wastes a network push.
	 *   - `kind === "transcript"` + `syncTranscripts: false` → skipped (same
	 *     rule `stageVault` applies — transcripts gated by config).
	 *   - Renames contribute their `path` (new side) for classification; the
	 *     old side's del is captured by the same entry implicitly.
	 *   - Anything else with a non-null `kind` → DIRTY → returns true
	 *     immediately (no need to inspect the rest).
	 *
	 * The classifier knows nothing about leaf-symlink hostile placement
	 * (that's `stageVault`'s domain). For an idle-gate probe a symlink at
	 * a classifier-matching location is still "dirty" — we want the round
	 * to continue into `stageVaultTracked`, where the symlink gets routed
	 * into the canary instead of the commit. So we DON'T lstat here.
	 */
	private async hasOwnedDirtyPaths(client: GitClient, syncTranscripts: boolean): Promise<boolean> {
		const entries = await client.statusPorcelainZ();
		// R2: a rename entry has `path = newPath` and `oldPath = oldPath`.
		// `stageVault.decomposeOps` splits it into `del(old) + add(new)` and
		// classifies each side independently — so a rename FROM an owned
		// path TO an unowned path emits a real `git rm --cached` for the
		// owned old side, even though the new side classifies to `null`.
		// This probe must mirror that: classify BOTH sides for rename
		// entries, otherwise an "owned → unowned" rename looks idle here
		// and the del never reaches a commit until the next non-idle round
		// happens to bundle it in. Window is small (next owned write fixes
		// it via step 7's stageVault), but it's an avoidable
		// time-of-eventual-consistency gap.
		const isOwnedDirty = (path: string): boolean => {
			const kind = classifyVaultPath(path);
			if (kind === null) return false;
			if (kind === "transcript" && !syncTranscripts) return false;
			return true;
		};
		for (const e of entries) {
			if (e.indexStatus === "U" || e.worktreeStatus === "U") return true;
			if (isOwnedDirty(e.path)) return true;
			if (e.oldPath !== undefined && isOwnedDirty(e.oldPath)) return true;
			// P2#2 — engine-driven per-device JSON cleanup. `ensureBootstrap`
			// runs `git rm --cached` against `PER_DEVICE_JSON_GLOBS`
			// (currently just `**/.jolli/shadow-status.json`) every round so
			// legacy committed copies get untracked. On repos that actually
			// have such a legacy entry, this produces a staged `D` against
			// HEAD. The classifier returns null for the path (it's
			// per-device, not owned in the sync sense), so without this
			// case the round would idle-short-circuit and the deletion
			// would never reach `commit` + `push` — it would re-stage
			// every round in perpetuity. Treat staged deletions of these
			// engine-owned cleanup targets as dirty so the round runs
			// through to commit.
			if (e.indexStatus === "D" && isPerDeviceJsonPath(e.path)) return true;
		}
		return false;
	}

	/** Returns the per-round canary if either bucket is non-empty, else undefined. */
	private takeCanary(): SyncRoundResult["canary"] {
		const { symlinked, unowned } = this.canary;
		if (symlinked.length === 0 && unowned.length === 0) return undefined;
		return { symlinked: [...symlinked], unowned: [...unowned] };
	}

	/**
	 * Runs one sync round under a fresh trace scope. A round's
	 * backend calls are not tied to a queue entry, so each round mints its own
	 * id; all its logs + outbound git/credential calls share it.
	 */
	async runRound(round: SyncRoundOptions): Promise<SyncRoundResult> {
		return runWithTrace(undefined, () => this.runRoundTraced(round));
	}

	private async runRoundTraced(round: SyncRoundOptions): Promise<SyncRoundResult> {
		log.info("runRound start reason=%s cwd=%s", round.reason, round.cwd ?? "<vault-only>");
		const roundStart = Date.now();
		this.canary = { symlinked: [], unowned: [] };
		const lockAcquired = await acquireSyncLock({
			timeoutMs: this.opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
		});
		if (!lockAcquired) {
			log.info("Skipping round — sync.lock held by another process");
			return this.report("syncing", { fetched: false, pulled: false, pushed: false, conflicts: [] });
		}

		// `vault-write.lock` is NOT acquired around the whole round any more
		// — per UX feedback, a user committing during a 30-90 s sync round
		// would otherwise wait the full round before their summary appears.
		// Instead, the lock is held only inside `pullRebase` (a few seconds),
		// which is the actual window where a concurrent worker could corrupt
		// the working tree (R9). The non-pull phases (stage / commit / push
		// for sync; LLM + writeFiles for worker) can run concurrently — at
		// worst they produce a partial commit that next round captures
		// cleanly (R8, benign / eventually consistent).
		//
		// `doRound` calls the wrapped `pullRebase` directly via this engine's
		// `pullRebaseLocked` helper (defined below), so all pull sites get
		// the same lock treatment without runRound caring.

		const refresher = setInterval(() => {
			void refreshSyncLockMtime();
		}, this.opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS);

		// JOLLI-1577 — per-round backend-lock disposition tracker. Threaded
		// into `doRound` and the mint/release wrappers so the finally below
		// can decide whether to call `backend.releaseLock` for failure paths.
		const lockHolder: RoundLockHolder = {
			token: null,
			releaseInFinally: false,
			deferredCompletion: false,
		};

		try {
			// Resolve round context once, up front, and thread into doRound so
			// we don't double-call `resolveContext` per round.
			const ctx = await this.opts.resolveContext(round);
			const result = await this.doRound(round, ctx, lockHolder);
			log.info("runRound end state=%s pushed=%s pulled=%s", result.newState, result.pushed, result.pulled);
			track("sync_completed", { outcome: result.newState, duration_ms: Date.now() - roundStart });
			return result;
		} catch (e) {
			// Catch any uncaught error (e.g. SyncBackendError 4xx/5xx that
			// isn't network/auth, a bogus `localFolder`, a `resolveContext`
			// throw, or a programming bug). Logging here is the only way the
			// user sees what went wrong — the orchestrator's IIFE swallows
			// the throw and only marks status=offline.
			log.error(
				"runRound threw — going offline: %s\n%s",
				(e as Error).message,
				(e as Error).stack ?? "(no stack)",
			);
			// Pipeline-health visibility: the success path emits sync_completed, so
			// emit it on the failure path too (content-free — outcome marker only),
			// otherwise the sync-health view would only ever see successes.
			track("sync_completed", { outcome: "failed", duration_ms: Date.now() - roundStart });
			// `VaultLockBusyError` is the polite "worker is busy" surface from
			// `pullRebaseLocked` — retry semantics are transient (next round
			// succeeds), so route to `network` rather than the terminal red
			// "Sync failed" branch.
			if (e instanceof VaultLockBusyError) {
				return this.reportOffline(
					{ fetched: false, pulled: false, pushed: false, conflicts: [] },
					{ code: "network", message: e.message },
				);
			}
			// Map to a terminal failure code so StatusOrchestrator renders the
			// red "Sync failed" branch with the exception message in the tooltip,
			// rather than a bare "Offline" that's indistinguishable from a
			// dropped network.
			return this.reportOffline(
				{ fetched: false, pulled: false, pushed: false, conflicts: [] },
				{ code: "sync_failed_after_retries", message: (e as Error).message },
			);
		} finally {
			clearInterval(refresher);
			// JOLLI-1577 — release backend Personal Space write-lock on
			// every round outcome (success + failure). Placed BEFORE
			// `releaseSyncLock`: the next `runRound` is gated by `sync.lock`,
			// and if we released `sync.lock` first, the next round's mint
			// would race our in-flight `releaseLock` HTTP call and likely
			// 423 → backend retry schedule kicks in with a 60 s first delay
			// (see `vaultLockedRetrySchedule` default), pushing user-visible
			// "Personal Space busy" for the worst part of a minute.
			// Holding `sync.lock` for the extra ~100-500 ms of the release
			// POST is the cheaper trade.
			//
			// Signal / hard-crash caveat: there is no SIGINT handler
			// installed (`SyncCommand.ts` just awaits `engine.runRound`), so
			// Ctrl-C / SIGKILL / power loss bypass this path; backend's
			// 5–9 min TTL is the only release mechanism for those.
			// `!deferredCompletion` is the third gate: even if a recovery
			// re-mint after the defer boundary re-armed `releaseInFinally`,
			// the deferred-completion choice ("don't release this round —
			// next round's `completeMigration` is the chosen release path")
			// must still hold. `mintFresh` deliberately does NOT touch
			// `deferredCompletion`, so this check is the single point that
			// honours the defer choice across re-mints.
			if (lockHolder.token !== null && lockHolder.releaseInFinally && !lockHolder.deferredCompletion) {
				try {
					await this.opts.backend.releaseLock({ lockOwnerToken: lockHolder.token });
					// `pending-lock.json` self-lock evidence — same posture
					// as the `notifyPush` / `completeMigration` success
					// paths.
					await this.clearPersistedLock();
				} catch (e) {
					// `pending-lock.json` is intentionally NOT cleared on
					// release failure: the persisted entry then drives the
					// next round's 423-attribution toward `selfLocked=true`,
					// surfacing "Personal Space busy — last round failed"
					// instead of attributing the lock to a peer.
					log.warn("release-lock failed (swallowed; backend TTL will release): %s", (e as Error).message);
				}
			}
			await releaseSyncLock();
			// Chain-spawn hook (P2 #1). Fire AFTER the lock release so the
			// worker we spawn won't immediately re-collide with our own
			// `sync.lock`. `vault-write.lock` held by `withPullLock` is
			// already released by its own finally inside `doRound`. Errors
			// from the callback are best-effort — logged, not propagated;
			// the worker spawn is recovery, not correctness.
			if (this.opts.onRoundComplete !== undefined) {
				try {
					this.opts.onRoundComplete(round.cwd);
				} catch (e) {
					log.debug("onRoundComplete callback threw (swallowed): %s", (e as Error).message);
				}
			}
		}
	}

	/**
	 * Wraps `client.pullRebase` in a brief `vault-write.lock` so a concurrent
	 * QueueWorker's writes don't tear the working tree mid-merge (R9). Lock
	 * is held only for the pull duration (typically 2-5 s, not the whole
	 * round). On timeout, the lock is treated as held by a long-running worker
	 * and the caller decides what to do — same surface as the underlying
	 * `pullRebase` call would have on a network error.
	 *
	 * Wait budget: `DEFAULT_PULL_LOCK_WAIT_MS` (10 s). A worker's
	 * `vault-write.lock` can be held for its whole drain (~30 s with LLM),
	 * so 10 s is intentionally below worst-case worker time — we *want*
	 * sync to yield rather than wait through a long worker drain. On
	 * timeout we throw `VaultLockBusyError`, `runRound` maps it to
	 * `network` (transient), and the next 90-min poll retries.
	 */
	private async pullRebaseLocked(
		client: GitClient,
		memoryBankRoot: string,
		author: { readonly name: string; readonly email: string },
	): Promise<Awaited<ReturnType<GitClient["pullRebase"]>>> {
		return this.withPullLock(memoryBankRoot, async () => client.pullRebase(author));
	}

	/**
	 * Acquires `vault-write.lock`, runs `fn`, releases the lock on every
	 * exit path. Extracted from `pullRebaseLocked` so the main doRound pull
	 * site can extend the lock window across conflict resolution — when
	 * `pullRebase` returns `{ conflicted: [...] }`, the rebase is PAUSED
	 * on disk and `ConflictResolver.resolveAll` writes files + eventually
	 * calls `rebase --continue`. Releasing the lock between the two halves
	 * lets a concurrent QueueWorker write into the paused-rebase window,
	 * which is exactly the corruption surface the lock was meant to close.
	 *
	 * The push-retry site uses the shorter pullRebase-only form (no
	 * resolver involvement — it aborts on conflict and returns).
	 *
	 * On timeout, throws `VaultLockBusyError` so `runRound`'s outer catch
	 * routes the round to transient `network`.
	 */
	private async withPullLock<T>(memoryBankRoot: string, fn: () => Promise<T>): Promise<T> {
		const lock = await acquireVaultWriteLock(memoryBankRoot, {
			wait: DEFAULT_PULL_LOCK_WAIT_MS,
		});
		if (lock === null) {
			throw new VaultLockBusyError(
				"vault-write.lock unavailable for pullRebase (a QueueWorker is busy writing to this vault). Will retry on next sync round.",
			);
		}
		// Refresh `vault-write.lock`'s mtime while `fn` runs. The lock can be
		// held across `ConflictResolver.resolveAll`, which may invoke N Tier 2
		// AI merges (~30 s each) and/or open-ended Tier 3 user prompts. If the
		// total exceeds `LOCK_TIMEOUT_MS` (5 min), a peer `acquireWithPoll`
		// would mtime-reclaim the lock and a concurrent QueueWorker write could
		// land in the paused-rebase window — exactly the R9 race this lock was
		// added to close. The 60 s interval matches the `sync.lock` refresher
		// (well below the 5 min reclaim threshold).
		const refresher = setInterval(() => {
			void lock.refresh();
		}, this.opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS);
		try {
			return await fn();
		} finally {
			clearInterval(refresher);
			await lock.release();
		}
	}

	private async doRound(
		round: SyncRoundOptions,
		ctx: RoundContext,
		lockHolder: RoundLockHolder,
	): Promise<SyncRoundResult> {
		// `ctx` is resolved once in `runRound` (before vault-write.lock
		// acquisition) and threaded in here so we don't double-call
		// `resolveContext` per round. Pre-fix `doRound` called it again;
		// safe because `defaultResolveContext` is pure, but two `loadConfig()`
		// reads per round is wasteful.

		// 1. Mint fresh credentials at round start. No cross-round cache (§0.6).
		const initialMint = await this.mintFresh(lockHolder);
		if (!initialMint.ok) {
			return this.reportOffline(
				{ fetched: false, pulled: false, pushed: false, conflicts: [] },
				{ code: initialMint.code, message: initialMint.message, selfLocked: initialMint.selfLocked },
			);
		}
		const state: RoundState = {
			creds: initialMint.creds,
			client: this.opts.makeGitClient(initialMint.creds, ctx.memoryBankRoot),
			remintsUsed: 0,
			ctx,
		};

		// 2. git --version.
		const gitCheck = await state.client.checkGitInstalled();
		if (!gitCheck.ok) {
			log.warn("git not on PATH — going offline");
			return this.reportOffline(
				{ fetched: false, pulled: false, pushed: false, conflicts: [] },
				{ code: "git_missing", message: "git binary not found on PATH" },
			);
		}

		// 2b. Self-heal stale `rebase` state from a previous round that was
		// killed mid-flight (SIGTERM on VSIX reinstall, laptop sleep, crash).
		// `.git/rebase-merge/` or `.git/rebase-apply/` left behind blocks
		// every subsequent `pull --rebase` and surfaces as a sticky
		// "Couldn't merge changes" with no actionable UI path forward — the
		// customer would otherwise have to `cd` into the vault and run
		// `git rebase --abort` by hand.
		//
		// Safe to abort unconditionally: the vault working tree is exclusively
		// driven by SyncEngine, so any in-progress rebase there is one we
		// started ourselves; the temporary "preserve work from HEAD" commit
		// `ensureOnDefaultBranch` makes pre-rebase is dropped, but the user's
		// actual edits live in a separate `[jolli-mb] reconcile: …` commit
		// that's already on `<defaultBranch>` and survives the abort.
		//
		// `isRebaseInProgress` swallows ENOENT (no `.git/` yet → first-bind),
		// so this is a no-op on the cold-clone path.
		try {
			if (await state.client.isRebaseInProgress()) {
				log.warn("Stale rebase state detected at round start — aborting (previous round was interrupted)");
				try {
					await state.client.rebaseAbort();
				} catch (e) {
					// Last-resort: if `git rebase --abort` itself fails (e.g.
					// corrupt state files), continue anyway — fetch / pullRebase
					// below will report a real error with a useful code that
					// the toolbar can surface, rather than hiding it behind a
					// "couldn't self-heal" message that the customer can't act
					// on.
					log.warn("rebase --abort during self-heal failed (continuing): %s", (e as Error).message);
				}
			}
		} catch (e) {
			// Probe itself failed (very rare; means stat() threw something
			// other than ENOENT). Log + continue — round may still succeed.
			log.debug("isRebaseInProgress probe threw (continuing): %s", (e as Error).message);
		}

		// 2c. Self-heal stale `.git/*.lock` files from a SIGKILL'd previous
		// git op (`index.lock`, `HEAD.lock`, `refs/**.lock`, `packed-refs.lock`,
		// `config.lock`). Leaving them would make the next `git add` /
		// `git commit` / `git fetch` fail with "File exists" and surface as a
		// sticky terminal error with no actionable UI path.
		//
		// TTL is 5 minutes (set in `sweepStaleLockFiles`). Long enough that
		// an out-of-band manual `git fetch` / `git gc` / `git rebase` the
		// user might run in the vault folder isn't ripped out from under
		// them — engine ops finish in milliseconds, so a 5 min lock is
		// definitively a corpse.
		try {
			const sweep = await state.client.sweepStaleLockFiles();
			if (sweep.removed.length > 0) {
				log.warn(
					"Removed %d stale .git/*.lock file(s) from previous interrupted round: %s",
					sweep.removed.length,
					sweep.removed.join(", "),
				);
			}
		} catch (e) {
			log.debug("sweepStaleLockFiles threw (continuing): %s", (e as Error).message);
		}

		// 3. Clone-or-fetch with step-level retry + at-most-one re-mint
		// recovery on 401 / 404. "Needs clone" is detected by probing
		// `<memoryBankRoot>/.git` rather than parsing git's stderr — git can
		// return non-zero with empty stderr, and parsing error strings
		// broke once in the field already.
		this.emitPhase("downloading");
		const fetched = await this.fetchOrCloneWithRetry(state, lockHolder);
		if (!fetched.ok) {
			log.warn("Clone/fetch failed: %s — going offline", fetched.message);
			return this.reportOffline(
				{ fetched: false, pulled: false, pushed: false, conflicts: [] },
				{ code: fetched.code, message: fetched.message },
			);
		}
		// Distinguish first-bind from regular round so commit messages use
		// `[jolli-mb] migrate: …` on the very first push (source plan §4.1).
		const isFirstBind = fetched.cloned;

		// Pre-round symlink sweep — REMOVED in Phase 1. Replacement is
		// INCOMPLETE by design (single-user multi-device threat model, not
		// team-shared vaults):
		//
		//   - `stageVault` blocks staging of symlinked paths (canary +
		//     refuse-to-add). Only catches staging, not earlier writes.
		//   - `safeAtomicWriteSync` guards `FolderStorage.atomicWrite` and
		//     `MemoryBankBootstrap`.
		//   - NOT guarded: `MetadataManager`, `RepoMapping`,
		//     `LegacyMigration`, `ConflictResolver`'s default writer.
		//     Deferred — engine-generated content (no peer payload
		//     control) except `ConflictResolver`, which is the one to
		//     revisit if team-shared vaults are introduced.

		// 3b. Ensure HEAD is on the backend-declared default branch before
		// any further git activity (plan §P1#2). The vault working tree is
		// engine-owned; an external actor (a debug `git checkout`, a
		// crashed round mid-rebase, a half-finished migration) can leave
		// HEAD on a side branch. Pre-fix this manifested as
		// `git push origin <defaultBranch>` reporting "Everything
		// up-to-date" silently because the local `<defaultBranch>` ref
		// hadn't moved while the new commits piled up on HEAD's side
		// branch. The push refspec change to `HEAD:refs/heads/<branch>`
		// would technically also recover, but staying on the right branch
		// keeps pullRebase + commit acting on the same ref the remote
		// expects.
		//
		// Runs BEFORE the first-bind migration block so the migration
		// commit also lands on the default branch — the migration uses
		// the same stage/commit/push chain and would have the same drift
		// problem.
		//
		// Pending work on the side branch is preserved by committing it
		// FIRST (so reflog can recover it later) — the assumption is the
		// content belongs to a Memory Bank state, not random work.
		const branchSwitch = await this.ensureOnDefaultBranch(state, ctx, round.transcripts);
		if (!branchSwitch.ok) {
			return this.reportOffline(
				{ fetched: true, pulled: false, pushed: false, conflicts: [] },
				{ code: branchSwitch.code, message: branchSwitch.message },
			);
		}

		// 3c. db → git first-bind migration (JOLLI-1316 §8). When the backend
		// reports `alreadyVaultBound === false`, the plugin is responsible
		// for dumping legacy DB content into the vault, pushing it, and
		// telling the backend to flip the backing. Skipped entirely when
		// `alreadyVaultBound === true` (steady-state).
		let completionDeferred = false;
		if (!state.creds.alreadyVaultBound) {
			const migrationResult = await this.runFirstBindMigration(state, round, lockHolder);
			if (!migrationResult.ok) {
				log.warn("Legacy migration failed: %s — going offline", migrationResult.message);
				return this.reportOffline(
					{
						fetched: true,
						pulled: false,
						pushed: migrationResult.pushed,
						conflicts: [],
					},
					{ code: migrationResult.code, message: migrationResult.message },
				);
			}
			completionDeferred = migrationResult.completionDeferred;
			// JOLLI-1577 — once defer is established, finally must NOT
			// release. Setting this at the boundary (not inside the retry
			// block below) protects EVERY exit between here and the retry
			// — auto-reconcile failure, pull-rebase abort, push failure,
			// uncaught throw — which would otherwise leak the lock-release
			// to the round teardown and force the next round into a re-mint
			// cycle, losing `complete-migration`'s idempotency benefit.
			// Backend TTL holds the gap on the off chance the deferred
			// retry below (and the next round) don't reach completion.
			//
			// `deferredCompletion = true` is the sticky version: a recovery
			// re-mint via `pushWithRetry`'s 401/404 path would otherwise
			// re-arm `releaseInFinally` and undo this clear. `mintFresh`
			// deliberately doesn't touch `deferredCompletion`; finally
			// gates release on `!deferredCompletion`.
			if (completionDeferred) {
				lockHolder.releaseInFinally = false;
				lockHolder.deferredCompletion = true;
			}
		}

		// 3d. Auto-reconcile user-edited vault state (plan §0.9). Memory
		// Bank is meant to be user-editable — manual `rm`/edit in the vault
		// clone (or files written by an earlier round that crashed before
		// commit) leave the working tree dirty, which makes `pull --rebase`
		// hard-fail with "cannot pull with rebase: You have unstaged
		// changes" and drops the round to offline. Pre-stage + commit
		// whatever's dirty so pull-rebase sees a clean tree.
		//
		// Failure here is logged but NOT fatal — pullRebase will hit the
		// same dirty state and surface a clear error in that case.
		this.emitPhase("merging");
		try {
			// R9 — use the classifier-aware probe (same gate as the idle
			// short-circuit). Plain `hasUncommittedChanges` is blind to
			// gitignored-but-owned files (the deny-all `.gitignore` regime
			// marks every FolderStorage write as ignored), so it would
			// route a brand-new owned file through the no-reconcile path
			// — the commit message would then label that round
			// `[jolli-mb] sync: …` instead of `[jolli-mb] reconcile: …`.
			// Data-wise step 7's unconditional `stageVaultTracked` covers
			// it; this fix only restores the message label so `git log`
			// reads as designed.
			if (await this.hasOwnedDirtyPaths(state.client, round.transcripts)) {
				log.info("Vault has uncommitted changes — auto-staging before pullRebase");
				// §I9 — quarantine corrupt aggregate JSON BEFORE stageAll so
				// a mid-write / truncated `.jolli/**/*.json` never reaches
				// the orphan history (where peers would pull and crash on
				// parse). Errors thrown from the helper itself are swallowed
				// by the outer catch — same non-fatal semantics as
				// auto-reconcile, the next round will retry.
				const dirty = await state.client.listDirtyPaths();
				const corrupt = await quarantineCorruptJson(state.ctx.memoryBankRoot, dirty);
				if (corrupt.quarantined > 0) {
					log.warn(
						"Auto-reconcile quarantined %d corrupt JSON file(s) (plan §I9) — paths=%s",
						corrupt.quarantined,
						corrupt.paths.join(", "),
					);
				}
				// Auto-reconcile path: stage classifier-owned paths only.
				// `stageAll` would have happily committed any user-dropped
				// file (OS junk, IDE swap files, hostile symlinks) that
				// happens to be in the working tree post-pull-rebase. The
				// allowlist staging keeps reconcile commits scoped to
				// FolderStorage's own write surface; canary surfaces
				// anything unowned.
				await this.stageVaultTracked(state.client, ctx.memoryBankRoot, {
					syncTranscripts: round.transcripts,
				});
				await state.client.commit("[jolli-mb] reconcile: user-modified vault entries", ctx.author);
			}
		} catch (e) {
			log.warn("Auto-reconcile pre-pullRebase failed (non-fatal): %s", (e as Error).message);
		}

		// 4. pull --rebase + Tier 2/3 if conflicts.
		//
		// Empty-remote first-bind: `git clone` of a brand-new GitHub repo
		// produces a local clone with unborn HEAD and no `origin/<default>`
		// ref. Running `git pull --rebase origin <default>` then errors with
		// "couldn't find remote ref <default>" and the round flips to
		// `pull_failed` before any first commit can be produced — exactly
		// the failure mode the comment at "later push will create HEAD"
		// assumes won't happen. Skip pullRebase when there is provably
		// nothing remote to integrate; commit + push below produces the
		// first commit and creates the remote branch.
		const defaultBranch = state.creds.defaultBranch;
		const remoteHasDefault = await state.client.refExists(`refs/remotes/origin/${defaultBranch}`);
		const allConflicts: ConflictRecord[] = [];
		let pulled = false;
		// `pull.fastForwarded === true` means pullRebase actually moved HEAD
		// forward (i.e. integrated a peer commit). Tracked separately from
		// `pulled` (which only means "pullRebase was called successfully")
		// because the idle short-circuit downstream needs to know whether
		// the working tree changed — when it did, we MUST run step 6's
		// pre-stage symlink sweep against the peer-pushed content. See the
		// short-circuit doc comment at step 5b for the full rationale.
		let workingTreeChangedByPull = false;
		if (!remoteHasDefault) {
			log.info(
				"pullRebase skipped — origin/%s not present (empty-remote first-bind); the round's commit + push will create it",
				defaultBranch,
			);
		}
		try {
			if (remoteHasDefault) {
				// Hold `vault-write.lock` across BOTH `pullRebase` AND any
				// follow-up `ConflictResolver.resolveAll`. The resolver
				// writes merged content + eventually calls `rebase
				// --continue`; releasing the lock between the two halves
				// would let a concurrent QueueWorker write into the
				// paused-rebase window. `withPullLock` throws
				// `VaultLockBusyError` on acquire timeout — `runRound`'s
				// outer catch routes that to transient `network`.
				const lockResult = await this.withPullLock(ctx.memoryBankRoot, async () => {
					const pull = await state.client.pullRebase(ctx.author);
					let resolverReport: { rebaseAdvanced: boolean; skipped: ReadonlyArray<string> } | null = null;
					if (pull.conflicted.length > 0) {
						this.emitPhase("resolving");
						const resolver = await this.buildResolver(state.client, ctx);
						resolverReport = await resolver.resolveAll(pull.conflicted);
					}
					return { pull, resolverReport };
				});
				const pull = lockResult.pull;
				pulled = true;
				if (pull.fastForwarded) {
					workingTreeChangedByPull = true;
				}
				if (lockResult.resolverReport !== null) {
					const report = lockResult.resolverReport;
					// Conflicted paths that resolved successfully wrote peer
					// content into the working tree — same defence concern
					// as fast-forward (sweep symlinks before staging).
					if (report.rebaseAdvanced) {
						workingTreeChangedByPull = true;
					}
					const detectedAt = new Date().toISOString();
					for (const path of report.skipped) {
						allConflicts.push({ path, tier: 3, detectedAt });
					}
					if (!report.rebaseAdvanced) {
						return this.report("conflicts", {
							fetched: true,
							pulled: false,
							pushed: false,
							conflicts: allConflicts,
						});
					}
				}
			}
		} catch (e) {
			// `VaultLockBusyError` is the polite "worker is busy" surface
			// from `pullRebaseLocked`. Re-throw so `runRound`'s outer catch
			// routes it to transient `network` — mapping to `pull_failed`
			// here would obscure a benign retry-soon condition as a
			// "Sync failed" red flag.
			if (e instanceof VaultLockBusyError) throw e;
			const msg = (e as Error).message;
			// Same classifier as clone/fetch so a TLS / DNS / connection
			// failure on `git pull --rebase` rolls up to `code: "network"`
			// instead of the alarming `pull_failed`. Plan §0.11.
			const code: SyncErrorCode = isNetworkErrorMessage(msg) ? "network" : "pull_failed";
			log.warn("pullRebase threw (%s): %s — going offline", code, msg);
			return this.reportOffline(
				{ fetched: true, pulled: false, pushed: false, conflicts: [] },
				{ code, message: msg },
			);
		}

		// 4b. Resolve vault folder via `.jolli/repos.json` mapping (now that
		// pullRebase has integrated any peer device's mapping updates).
		// `desiredFolder` is the basename `KBPathResolver.resolveKBPath()`
		// already picked locally; `resolveOrAssignFolder` honors it (no
		// silent hash-suffix renames any more — see P2#3).
		//
		// After loading, scan for cross-device folder collisions and
		// surface them so the user can manually rename one side. The
		// merge step (`mergeRepoMappingDoc`) does the detection, this
		// path catches both the freshly-merged file AND any stale
		// collisions left over from before P2#3 landed.
		// Reconcile `repos.json` with the repo folders actually on disk BEFORE
		// resolving this round's repo. Each round otherwise only writes its own
		// repo's row, so a folder whose first-bind round never reached this step
		// (e.g. an older client whose migration deadlocked before the mapping
		// write) stays missing from `repos.json` forever — and no other repo's
		// round will ever add it back. The reconcile is additive only (never
		// deletes a cross-device/-clone row) and skips identities backed by >1
		// local folder (deferred to the authoritative per-repo path below).
		//
		// Canonicalize first: rows written before SSH→https transport folding
		// carry the SCP-style identity, and the live identity (already
		// canonical) would not match them — the same repo would get a second
		// row and a bogus folder-collision warning below.
		const loadedMapping = await loadRepoMapping(ctx.memoryBankRoot);
		const canon = canonicalizeRepoMapping(loadedMapping);
		const reconcile = reconcileMappingAdditive(canon.merged, await scanFolderIdentities(ctx.memoryBankRoot));
		const mapping = reconcile.merged;
		const mappingConflicts = findRepoMappingConflicts(mapping);
		if (mappingConflicts.length > 0) {
			for (const c of mappingConflicts) {
				log.warn(
					"repos.json folder collision: %s claimed by %d identities (%s) — surface to user for manual rename",
					c.folder,
					c.identities.length,
					c.identities.join(", "),
				);
			}
			try {
				this.opts.onRepoMappingConflict?.(mappingConflicts);
			} catch (e) {
				log.warn("onRepoMappingConflict callback threw (swallowed): %s", (e as Error).message);
			}
		}
		if ((ctx.repoIdentity === undefined) !== (ctx.repoFolderName === undefined)) {
			throw new Error("round context must provide both repoIdentity and repoFolderName, or neither");
		}
		if (ctx.repoIdentity !== undefined && ctx.repoFolderName !== undefined) {
			const resolved = resolveOrAssignFolder(mapping, {
				repoIdentity: ctx.repoIdentity,
				authoritativeFolder: ctx.repoFolderName,
			});
			// Persist when the canonicalize pass collapsed legacy rows, the
			// reconcile added on-disk folders, OR `resolveOrAssignFolder` changed
			// this round's repo. `resolved` already carries the
			// canonicalized+reconciled mapping (it was fed `mapping`), so its
			// `updatedMapping` supersedes the earlier results when non-null.
			if (canon.changed || reconcile.changed || resolved.updatedMapping !== null) {
				await saveRepoMapping(ctx.memoryBankRoot, resolved.updatedMapping ?? mapping);
				log.info(
					"repos.json: persisted folder=%s for repoIdentity=%s (authoritative=%s, canonicalized=%s, reconciled=%s)",
					resolved.folder,
					ctx.repoIdentity,
					ctx.repoFolderName,
					canon.changed,
					reconcile.changed,
				);
			}
		} else if (canon.changed || reconcile.changed) {
			// A vault-only round has no live source repo to add, but it can still
			// repair mappings from identities persisted in each repo folder.
			await saveRepoMapping(ctx.memoryBankRoot, mapping);
			log.info(
				"repos.json: persisted vault-only reconciliation (canonicalized=%s, reconciled=%s)",
				canon.changed,
				reconcile.changed,
			);
		}

		// 5. Bootstrap: write/refresh .gitignore + untrack newly-denied paths
		//    (e.g., when syncTranscripts flipped OFF). No "mirror" step —
		//    `<localFolder>` is the working tree; FolderStorage already wrote
		//    the content there, `stageAll` below will capture it.
		const bootstrap = (
			this.opts.makeBootstrap ??
			/* v8 ignore next -- exercised only in real-bundle paths */ defaultBootstrapFactory
		)({
			vaultClient: state.client,
			memoryBankRoot: ctx.memoryBankRoot,
			transcripts: round.transcripts,
		});
		await bootstrap.ensureBootstrap();

		// 5b. Idle-round short-circuit (perf). When local HEAD already
		// equals `origin/<defaultBranch>` AND the working tree is clean,
		// every remaining step in this round (pre-stage sweep, stageAll,
		// commit, push, notify-push) is a guaranteed no-op — but each one
		// still costs a child-process spawn or a network round-trip. On a
		// fully idle poll tick (no local edits, no remote pushes) this
		// trims ~2-3 s off the round.
		//
		// Conditions:
		//   - `remoteHasDefault` (skip on empty-remote first-bind; we MUST
		//     create + push the initial branch in that path).
		//   - `!workingTreeChangedByPull` — pullRebase neither fast-forwarded
		//     nor resolved any conflicts. When peer content landed in the
		//     working tree, step 6's pre-stage symlink sweep is the
		//     designed defence (see the step-6 doc comment); gating the
		//     short-circuit on this flag keeps that defence in position
		//     for exactly the rounds it matters in. The cost is one extra
		//     sweep + commit cycle on the poll that just absorbed peer
		//     changes — ~50 ms, dwarfed by the network round-trip we
		//     already paid for the pull. A pullRebase that was called but
		//     returned `fastForwarded: false` (the no-op case) leaves this
		//     flag false and the short-circuit still fires.
		//   - local and remote HEAD resolve to the same OID. Covers the
		//     "no new local commits" case (no auto-reconcile, no historical
		//     un-pushed commits). Together with the flag above, this means
		//     "nothing on either side changed since the last successful
		//     round" — the genuine idle case the optimisation targets.
		//   - working tree clean. `bootstrap.ensureBootstrap` may have just
		//     written / rewrote `.gitignore`; if so we MUST commit + push
		//     so peers see the change.
		//
		// Probe failures fall through to the normal stageAll → commit →
		// push path. That path is its own self-check (commit's "nothing
		// to commit" branch + push's "Everything up-to-date" branch) so
		// correctness is preserved if we guess wrong.
		if (remoteHasDefault && !workingTreeChangedByPull) {
			try {
				const localHead = await state.client.currentHead();
				const remoteHead = await state.client.revParse(`refs/remotes/origin/${defaultBranch}`);
				// `hasUncommittedChanges` (plain `git status --porcelain` with
				// no `--ignored`) cannot see brand-new owned files: the
				// engine-managed `.gitignore` is `*` + `!.gitignore`, so every
				// FolderStorage-produced summary / aggregate / Markdown lands
				// as IGNORED, not UNTRACKED, and is omitted from plain status.
				// Using it as the idle gate would let a freshly-onboarded
				// repo folder (or any round where the only local change is a
				// new owned file) flip to `synced` without ever staging or
				// pushing — the user sees the green checkmark, the remote
				// never receives the data. The classifier-aware probe below
				// runs `statusPorcelainZ` (which DOES include ignored files
				// via `--ignored=matching`) and checks whether any entry
				// classifies as owned; only then is the round genuinely idle.
				const hasDirtyOwned = await this.hasOwnedDirtyPaths(state.client, round.transcripts);
				if (remoteHead !== null && localHead === remoteHead && !hasDirtyOwned) {
					log.info(
						"Idle round — local %s matches origin/%s and no owned paths dirty; skipping commit/push",
						localHead.slice(0, 12),
						defaultBranch,
					);
					return this.report("synced", {
						fetched: true,
						pulled,
						pushed: false,
						conflicts: allConflicts,
					});
				}
			} catch (e) {
				log.debug(
					"Idle short-circuit probe failed (continuing through normal commit/push path): %s",
					(e as Error).message,
				);
			}
		}

		// 6. Second symlink sweep — defence-in-depth (plan §P2 revised).
		//    The PRIMARY sweep ran at step 3a, before any commit or file
		//    write. This second pass catches anything created during the
		//    round. Pre-stage `runSweep` REMOVED in Phase 1 — same
		//    rationale as the pre-round site above. `stageVault`'s
		//    per-entry `symlinked` check is the new defence point for
		//    "a peer-pushed symlink landed via pullRebase and we're
		//    about to stage it" — the path goes into the canary bucket
		//    instead of the commit. See the comment block at the
		//    pre-round site for the full migration story.

		// 7. Commit + push. `stageVault` followed by `commit` is a no-op
		//    when the working tree matches HEAD AFTER classifier filtering;
		//    the unconditional push below is idempotent in that case too.
		//    `stageVault` (vs the pre-refactor `stageAll`) is the staging
		//    allowlist enforcement point — only paths the classifier
		//    recognises get into the commit.
		const summary = makeCommitSummary(isFirstBind);
		await this.stageVaultTracked(state.client, ctx.memoryBankRoot, { syncTranscripts: round.transcripts });
		await state.client.commit(summary, ctx.author);
		this.emitPhase("uploading");
		const pushed = await this.pushWithRetry(state, lockHolder);
		if (!pushed.ok) {
			log.warn("Push failed permanently: %s — going offline", pushed.message);
			return this.reportOffline(
				{ fetched: true, pulled, pushed: false, conflicts: [] },
				{ code: pushed.code, message: pushed.message },
			);
		}

		// 7a. Deferred completeMigration retry. When the first-bind migration
		// path saw an empty/already-migrated legacy space AND a not-yet-born
		// HEAD, it could not call backend `complete-migration` — `commitSha`
		// requires a real HEAD. The steady-state push above just produced one,
		// so retry now. Failure is fire-and-forget (log only): the next
		// round's `runFirstBindMigration` will re-enter this branch since
		// `alreadyVaultBound` stays false until backend flips, so the user
		// shouldn't see this round go red over a transient RPC blip — the
		// data is already safe on the remote. Same fire-and-forget posture
		// as the migration / steady-state notify-push paths below.
		//
		// JOLLI-1577 — `lockHolder.releaseInFinally` was already cleared
		// upstream at the moment defer was established (see the
		// `if (completionDeferred)` block right after
		// `runFirstBindMigration`), so neither this retry's success nor
		// its failure can re-arm finally's `releaseLock`. Retry-success
		// flows through `tryCompleteMigration`'s normal "lock released by
		// backend" path; retry-failure leaves the lock to the next round
		// or to backend TTL — explicit per-plan decision to avoid racing
		// the backend with two release attempts.
		if (completionDeferred) {
			const retry = await this.tryCompleteMigration(state, lockHolder);
			if (!retry.ok) {
				log.warn(
					"Deferred completeMigration retry failed (%s): %s — leaving for next round",
					retry.code,
					retry.message,
				);
			}
		}

		// 7. notify-push (fire-and-forget; errors are logged but don't fail the round).
		//    Plan §0.8: backend releases the per-user personal-space write
		//    lock here on the steady-state push success path. Ownership is
		//    verified via `lockOwnerToken` — the same token returned by
		//    the matching `/credentials` call that opened this round.
		//
		//    JOLLI-1577 — this is one of TWO canonical client-side release
		//    paths (the other is `completeMigration` for first-bind).
		//    Every other round outcome (push failed, pull-rebase aborted,
		//    exception inside `doRound`, idle short-circuit, …) is now
		//    covered by `releaseLock` in `runRound`'s finally — TTL is no
		//    longer the only failure-path fallback.
		//
		//    Skip the call when the push was idempotent ("Everything up-to-date"):
		//    the backend already knows about every commit currently on the
		//    remote (it was notified the round that originally pushed each
		//    one), so re-notifying the same SHA every 90-min idle tick is
		//    pure noise and pollutes per-user rate-limit signal.
		//
		//    Re-read HEAD AFTER push: `pushWithRetry` may run `pullRebase`
		//    on non-FF and rewrite the local HEAD before the successful
		//    retry. The SHA captured at `commit()` time would be the
		//    pre-rebase orphan; the backend needs the SHA that actually
		//    landed on the remote.
		if (pushed.transmitted) {
			const pushedHead = await state.client.currentHead();
			try {
				await this.opts.backend.notifyPush({
					commitSha: pushedHead,
					branch: state.creds.defaultBranch,
					lockOwnerToken: state.creds.lockOwnerToken,
				});
				// Backend has confirmed the lock release — clear the
				// persisted self-lock evidence so the next round's mint
				// retries can correctly attribute any 423 to a peer.
				await this.clearPersistedLock();
				// JOLLI-1577 — notify-push is one of the two canonical
				// release paths. Tell `runRound`'s finally not to call
				// `releaseLock` again.
				lockHolder.releaseInFinally = false;
			} catch (e) {
				log.debug("notify-push failed (swallowed): %s", (e as Error).message);
			}
		} else {
			log.debug("notify-push skipped: push reported 'Everything up-to-date'");
		}

		return this.report("synced", { fetched: true, pulled, pushed: true, conflicts: [] });
	}

	/**
	 * db→git first-bind migration body. Runs once when the backend reports
	 * `alreadyVaultBound === false`. Sequence:
	 *
	 *   a. GET /legacy-content
	 *   b. Race-condition: `alreadyMigrated === true` → skip writing, still
	 *      attempt complete-migration (POST is idempotent; cheap to confirm)
	 *   c. Mirror's `applyLegacyContent` writes the docs into `legacy/...`
	 *   d. stage + commit `[jolli-mb] migrate: N items from legacy space` + push
	 *      via `pushWithRetry(state)` — gets step-level retry + at-most-one
	 *      re-mint recovery. The re-mint budget is reset to 0 at the end of
	 *      this method (after `tryCompleteMigration` succeeds), so the
	 *      steady-state push that follows in the main round body gets its
	 *      own at-most-one recovery — a 401 here doesn't bleed into there.
	 *   e. POST /complete-migration — failures are **non-fatal** (logged
	 *      only); a subsequent round will retry because the backend hasn't
	 *      flipped backing yet
	 *
	 * Network / auth / 4xx-5xx failures bubble up as `{ ok: false, … }` so
	 * the caller can flip state to `offline` cleanly with a classified code.
	 */
	private async runFirstBindMigration(
		state: RoundState,
		round: SyncRoundOptions,
		lockHolder: RoundLockHolder,
	): Promise<
		| { readonly ok: true; readonly completionDeferred: boolean }
		| { readonly ok: false; readonly code: SyncErrorCode; readonly message: string; readonly pushed: boolean }
	> {
		let legacyResponse: import("./SyncTypes.js").LegacyContentResponse;
		try {
			legacyResponse = await this.opts.backend.getLegacyContent();
		} catch (e) {
			return {
				ok: false,
				code: "migration_failed",
				message: `getLegacyContent: ${(e as Error).message}`,
				pushed: false,
			};
		}

		// `alreadyMigrated` race: another device finished the flip before us.
		// Still call complete-migration (it's idempotent and returns
		// `alreadyMigrated: true`) so the next mint can see backing=git.
		if (legacyResponse.alreadyMigrated || legacyResponse.docs.length === 0) {
			log.info(
				"Legacy migration: alreadyMigrated=%s docs=%d — skipping import",
				legacyResponse.alreadyMigrated,
				legacyResponse.docs.length,
			);
			const completion = await this.tryCompleteMigration(state, lockHolder);
			if (!completion.ok) return completion;
			// `deferred === true` means HEAD is unborn so completeMigration
			// could not be called yet. Bubble the flag up so `doRound` can
			// retry it after the steady-state push creates HEAD — otherwise
			// the round reports `synced` while backend backing is still `db`.
			return { ok: true, completionDeferred: completion.deferred };
		}

		// Bootstrap .gitignore before writing legacy content, so the next
		// stageAll picks up the freshly-written files alongside .gitignore.
		const bootstrap = (
			this.opts.makeBootstrap ??
			/* v8 ignore next -- exercised only in real-bundle paths */ defaultBootstrapFactory
		)({
			vaultClient: state.client,
			memoryBankRoot: state.ctx.memoryBankRoot,
			transcripts: round.transcripts,
		});
		await bootstrap.ensureBootstrap();

		const legacy = (
			this.opts.makeLegacyMigration ??
			/* v8 ignore next -- exercised only in real-bundle paths */ defaultLegacyMigrationFactory
		)({
			memoryBankRoot: state.ctx.memoryBankRoot,
			transcripts: round.transcripts,
		});

		let legacyReport: { readonly filesWritten: number };
		try {
			legacyReport = await legacy.apply(legacyResponse);
		} catch (e) {
			return {
				ok: false,
				code: "migration_failed",
				message: `legacy.apply: ${(e as Error).message}`,
				pushed: false,
			};
		}

		// Even when filesWritten === 0 (every doc was rejected by allow-list
		// or sanitization), we still flip the backing so the next round
		// doesn't keep fetching the same dead legacy content forever.
		if (legacyReport.filesWritten > 0) {
			const commitMessage = buildCommitMessage({
				op: "migrate",
				summary: `${legacyReport.filesWritten} items from legacy space`,
			});
			// Migration path: legacy content has already been written
			// through FolderStorage so it lands on owned-path locations.
			// `stageVault` enforces that boundary — if `LegacyMigration`
			// ever writes a path outside the classifier's catalogue, the
			// canary fires loudly here.
			await this.stageVaultTracked(state.client, state.ctx.memoryBankRoot, {
				syncTranscripts: round.transcripts,
			});
			await state.client.commit(commitMessage, state.ctx.author);
			this.emitPhase("uploading");
			const pushed = await this.pushWithRetry(state, lockHolder);
			if (!pushed.ok) {
				return {
					ok: false,
					code: pushed.code,
					message: `migration push: ${pushed.message}`,
					pushed: false,
				};
			}
			// Notify backend of the migration HEAD. The steady-state push that
			// follows in the main round body is almost always idempotent
			// ("Everything up-to-date") because nothing has been written since
			// migration, so its `pushed.transmitted` is false and the L548
			// notifyPush gets skipped. Without notifying here, the backend
			// never learns the migration SHA via notify-push and the per-user
			// `/credentials` write lock (plan §0.8) waits for its TTL instead
			// of being released promptly — peers hit 423 vault_locked and
			// retry-with-backoff for the up-to-9-minute window. Fire-and-
			// forget; the GitHub webhook + reconciler cover the rare
			// notify-push failure.
			//
			// JOLLI-1577 — when notify-push throws here, `releaseInFinally`
			// stays true, and `runRound`'s finally calls `releaseLock`
			// against the same `lockOwnerToken`. Backend TTL is no longer
			// the only fallback for notify-push failure.
			if (pushed.transmitted) {
				try {
					const pushedHead = await state.client.currentHead();
					await this.opts.backend.notifyPush({
						commitSha: pushedHead,
						branch: state.creds.defaultBranch,
						lockOwnerToken: state.creds.lockOwnerToken,
					});
					// Migration notify-push also releases the backend lock —
					// clear evidence so the steady-state push downstream
					// can't be mislabelled as self-locked if it 423s.
					await this.clearPersistedLock();
					// JOLLI-1577 — backend released the lock; finally must
					// not call `releaseLock` again.
					lockHolder.releaseInFinally = false;
				} catch (e) {
					log.debug("migration notify-push failed (swallowed): %s", (e as Error).message);
				}
			}
		}

		const completion = await this.tryCompleteMigration(state, lockHolder);
		if (!completion.ok) return completion;
		// Phase boundary: migration push (if any) succeeded, completeMigration
		// succeeded, GitHub repo is provably writable. Reset the re-mint
		// budget so a transient 401 on the steady-state push that follows
		// doesn't get strangled by a budget that was already spent recovering
		// during migration. See `MAX_REMINTS_PER_PHASE` docstring for why
		// this still satisfies §0.6 (backend-side `ensureGithubRepoExists`
		// is idempotent on the second mint).
		state.remintsUsed = 0;
		// `completion.deferred === true` only in the docs>0 path if HEAD is
		// somehow still unborn — impossible after a successful migration
		// push, so this is always false here. Surface it for type-safety.
		return { ok: true, completionDeferred: completion.deferred };
	}

	private async tryCompleteMigration(
		state: RoundState,
		lockHolder: RoundLockHolder,
	): Promise<
		| { readonly ok: true; readonly deferred: boolean }
		| { readonly ok: false; readonly code: SyncErrorCode; readonly message: string; readonly pushed: false }
	> {
		try {
			// `commitSha` is the current HEAD of the vault — either the
			// migration push we just made, or (in the `filesWritten === 0`
			// / `alreadyMigrated` race) whatever HEAD the clone resolved to.
			// `lockOwnerToken` was minted alongside the credentials and is
			// required by the backend to verify lock ownership before
			// flipping `metadata.vault`.
			//
			// Defer completion whenever there is no commit the backend can
			// bind to *on the remote* yet. Two cases collapse here:
			//
			//   1) HEAD unborn — truly-empty remote (post-`git init`, fetched
			//      nothing, no docs). `currentHead` would throw "ambiguous
			//      argument 'HEAD'" and the backend would never flip.
			//   2) HEAD born locally but NOT yet reachable from
			//      `origin/<defaultBranch>` — the bootstrap-merge case.
			//      `ensureOnDefaultBranch` commits the fresh-local vault (e.g.
			//      172 files) WITHOUT pushing, so HEAD is already born before
			//      this runs. Calling `complete-migration` with that un-pushed
			//      `commitSha` makes the backend return 409 — it cannot find
			//      the commit in the personal-space repo. Because that 409 is
			//      fatal in `runFirstBindMigration`, the round never reaches
			//      the step 7 push that would upload the commit: a deadlock
			//      (push is gated behind migration; migration can only complete
			//      once the commit is pushed). Pre-fix, the `!hasHead()` guard
			//      only caught case 1, so the born-but-unpushed bootstrap HEAD
			//      fell straight through to the 409.
			//
			// Deferring routes BOTH cases through the existing defer → step 7
			// push → step 7a retry machinery: the steady-state push uploads
			// HEAD, then 7a (or the next round) completes against a commit the
			// remote actually has.
			const defaultBranch = state.creds.defaultBranch;
			const headBorn = await state.client.hasHead();
			const headOnRemote =
				headBorn && (await state.client.isAncestor("HEAD", `refs/remotes/origin/${defaultBranch}`));
			if (!headOnRemote) {
				log.info(
					"completeMigration: deferred — HEAD not yet on origin/%s (unborn or not-yet-pushed); doRound will retry after steady-state push",
					defaultBranch,
				);
				// JOLLI-1577 — defer release alongside completion. The
				// next round's `completeMigration` is the chosen release
				// path; calling `releaseLock` in finally would force the
				// next round into a re-mint cycle and lose
				// `complete-migration`'s idempotency benefit. Backend TTL
				// holds the gap on the off chance the next round doesn't
				// run.
				//
				// `deferredCompletion = true` makes this sticky across a
				// later recovery re-mint that would otherwise re-arm
				// `releaseInFinally`. See holder docstring for the gate.
				lockHolder.releaseInFinally = false;
				lockHolder.deferredCompletion = true;
				return { ok: true, deferred: true };
			}
			const commitSha = await state.client.currentHead();
			const res = await this.opts.backend.completeMigration({
				commitSha,
				lockOwnerToken: state.creds.lockOwnerToken,
			});
			// `complete-migration` is the second canonical lock-release
			// path (the first is `notify-push`). Clear evidence on success
			// so the next round's mint retries attribute any 423 correctly.
			await this.clearPersistedLock();
			// JOLLI-1577 — backend already released the lock; finally must
			// not call `releaseLock` a second time. Also clear
			// `deferredCompletion` so a prior defer in this same round
			// (deferred → push HEAD-born → retry succeeds) doesn't keep
			// suppressing future releases.
			lockHolder.releaseInFinally = false;
			lockHolder.deferredCompletion = false;
			log.info("completeMigration: alreadyMigrated=%s", res.alreadyMigrated);
			return { ok: true, deferred: false };
		} catch (e) {
			// I10: surface as terminal `migration_failed` instead of silently
			// returning. Pre-fix the swallowed catch left the round reporting
			// "Synced ✓" while the backend's `backing=db` flag never flipped —
			// the next round then re-ran `runFirstBindMigration` from scratch
			// and the user had zero signal that anything was wrong.
			// `complete-migration` is idempotent on the backend, so the next
			// round retries cleanly; the difference is the user sees red
			// "Sync failed" until the backend recovers, not a misleading
			// green check.
			const message = `completeMigration: ${(e as Error).message}`;
			log.warn("%s (will retry next round)", message);
			return { ok: false, code: "migration_failed", message, pushed: false };
		}
	}

	/**
	 * Mints fresh credentials from the backend, with classified error
	 * mapping for the round driver. **Always** calls `/credentials`; no
	 * cache lookup (§0.6 removed the cross-round cache entirely).
	 *
	 * Errors are bucketed into `network` (transient — UI stays "Offline")
	 * and `mint_failed` (terminal for this round — UI flips to "Sync
	 * failed"). Body text from `SyncBackendError` is preserved in the
	 * message so backend `error` codes like `vault_sync_disabled` /
	 * `github_api_error` show up without needing a curl repro.
	 */
	private async mintFresh(
		lockHolder: RoundLockHolder,
	): Promise<
		| { readonly ok: true; readonly creds: GitCredentials }
		| { readonly ok: false; readonly code: SyncErrorCode; readonly message: string; readonly selfLocked?: boolean }
	> {
		// Plan §0.8 — 423 vault_locked is retried per the schedule (initial
		// attempt + one retry per schedule entry). Any other error
		// short-circuits out of the loop and falls through to typed handling
		// below.
		//
		// Self-lock evidence is captured ONCE at the top of the retry loop
		// (before any new mint succeeds, which would overwrite the persisted
		// entry). The captured value drives `onLockedWait.selfLocked` for
		// every retry in this loop AND the terminal `vault_locked` return —
		// a mid-loop write from a concurrent process can't flip the
		// classification.
		const startSelfLock = await this.readSelfLockState();
		const schedule = this.opts.vaultLockedRetrySchedule ?? VAULT_LOCKED_RETRY_SCHEDULE_MS;
		const totalAttempts = schedule.length + 1;
		let lastLockedMessage = "Personal Space is being synced by another device";
		for (let attempt = 1; attempt <= totalAttempts; attempt++) {
			try {
				const creds = await this.opts.backend.mintGitCredentials();
				// JOLLI-1577 — backend lock is now held. Update the holder
				// IMMEDIATELY, BEFORE any awaited local persistence. If
				// `persistMintedLock` throws (disk full, permission error,
				// concurrent unlink), the catch below returns
				// `{ ok: false, code: "mint_failed" }` and the round unwinds
				// with the backend lock still held; `runRound`'s finally
				// needs the token already in the holder to release it.
				// Re-mint overwriting an earlier token is correct: the
				// earlier token is left to backend TTL by design (per the
				// "stale tokens from mid-round re-mint" decision).
				lockHolder.token = creds.lockOwnerToken;
				lockHolder.releaseInFinally = true;
				// Persist BEFORE returning so even a crash between this line
				// and the round's notify-push leaves correct self-lock
				// evidence on disk for the next round.
				await this.persistMintedLock(creds);
				return { ok: true, creds };
			} catch (e) {
				if (e instanceof VaultLockedError) {
					lastLockedMessage = e.message;
					if (attempt < totalAttempts) {
						const delayMs = schedule[attempt - 1];
						log.warn(
							"Mint got 423 vault_locked (attempt %d/%d, selfLocked=%s) — waiting %d ms then retrying",
							attempt,
							totalAttempts,
							startSelfLock.selfLocked,
							delayMs,
						);
						// Notify UI right BEFORE the sleep so the status bar
						// flips from silent "Syncing…" to visible "Personal
						// Space busy" while we wait. Errors here must not
						// abort the retry — log + swallow.
						try {
							this.opts.onLockedWait?.({
								attempt,
								totalAttempts,
								nextRetryInMs: delayMs,
								message: e.message,
								selfLocked: startSelfLock.selfLocked,
							});
						} catch (cbErr) {
							log.debug("onLockedWait callback threw (swallowed): %s", (cbErr as Error).message);
						}
						this.emitPhase("waiting");
						await sleep(delayMs);
						continue;
					}
					// Last attempt also locked — give up with the typed code so
					// the UI can render the "Sync failed: Personal Space busy"
					// tooltip and the user can retry manually.
					log.warn(
						"Mint got 423 vault_locked on final attempt %d/%d (selfLocked=%s) — giving up",
						attempt,
						totalAttempts,
						startSelfLock.selfLocked,
					);
					return {
						ok: false,
						code: "vault_locked",
						message: lastLockedMessage,
						selfLocked: startSelfLock.selfLocked,
					};
				}
				if (e instanceof WebFlushPendingError) {
					// Cooperative back-off — backend's web flusher hasn't sent
					// its pending edits to GitHub yet. Treat exactly like 423
					// vault_locked: emit `waiting`, sleep the server-suggested
					// delay, retry within the mint budget. Refusing to retry
					// would force the user to manually re-trigger sync 30 s
					// later — and most of the time the next attempt succeeds.
					if (attempt < totalAttempts) {
						const delayMs = Math.max(1000, e.retryAfterSeconds * 1000);
						log.warn(
							"Mint got 503 pending_flush_failed (attempt %d/%d) — waiting %d ms (server-suggested %ds) then retrying",
							attempt,
							totalAttempts,
							delayMs,
							e.retryAfterSeconds,
						);
						try {
							this.opts.onLockedWait?.({
								attempt,
								totalAttempts,
								nextRetryInMs: delayMs,
								message: e.message,
								selfLocked: startSelfLock.selfLocked,
							});
						} catch (cbErr) {
							log.debug("onLockedWait callback threw (swallowed): %s", (cbErr as Error).message);
						}
						this.emitPhase("waiting");
						await sleep(delayMs);
						continue;
					}
					log.warn(
						"Mint got 503 pending_flush_failed on final attempt %d/%d — giving up",
						attempt,
						totalAttempts,
					);
					return { ok: false, code: "network", message: e.message };
				}
				if (e instanceof SyncBackendNetworkError) {
					log.warn("Mint failed (network): %s", (e as Error).message);
					return { ok: false, code: "network", message: (e as Error).message };
				}
				if (e instanceof SyncBackendUnauthorizedError) {
					log.warn("Mint failed (unauthorized): %s", (e as Error).message);
					return { ok: false, code: "mint_failed", message: (e as Error).message };
				}
				const errAny = e as { message?: string; body?: string };
				log.warn("Mint failed (other): %s body=%s", errAny.message ?? String(e), errAny.body ?? "(none)");
				return {
					ok: false,
					code: "mint_failed",
					message: errAny.message ?? String(e),
				};
			}
		}
		// Every iteration of the for-loop either returns (success / typed
		// error / final-attempt vault_locked) or `continue`s after a sleep,
		// so this point is unreachable. Throw rather than fabricate a
		// terminal result — if a future refactor of the loop body changes
		// that, we want a loud stack rather than a silent "vault_locked"
		// papering over a real bug.
		throw new Error(
			`unreachable: mintFresh loop exited without returning (lastLockedMessage=${lastLockedMessage})`,
		);
	}

	/**
	 * Recovery mint after a step observed 401 / 404. Mutates `state.creds`
	 * + `state.client` on success; refuses (returns terminal failure) when
	 * the per-round mint budget is already spent. The budget guard is the
	 * concrete enforcement of plan §0.6's "no duplicate private repos / no
	 * duplicate data" invariant — combined with the backend's idempotent
	 * `ensureGithubRepoExists` (looks up `<org>/<space.slug>` first, only
	 * POSTs when GitHub returns 404 for that exact name), one recovery
	 * mint per round means at most one re-provision per round.
	 */
	private async tryRemint(
		state: RoundState,
		cause: RemintCause,
		lockHolder: RoundLockHolder,
	): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: SyncErrorCode; readonly message: string }> {
		if (state.remintsUsed >= MAX_REMINTS_PER_PHASE) {
			const msg = `recovery exhausted (${cause}): already re-minted ${state.remintsUsed} time(s) this round`;
			log.warn(msg);
			return { ok: false, code: "sync_failed_after_retries", message: msg };
		}
		log.warn("Triggering recovery re-mint (cause=%s, remintsUsed=%d)", cause, state.remintsUsed);
		// `mintFresh` itself updates `lockHolder.token` to the new credentials
		// — the prior token is left to backend TTL (per "stale tokens from
		// mid-round re-mint" decision in JOLLI-1577 plan).
		const fresh = await this.mintFresh(lockHolder);
		if (!fresh.ok) {
			return { ok: false, code: fresh.code, message: `re-mint after ${cause}: ${fresh.message}` };
		}
		state.creds = fresh.creds;
		state.client = this.opts.makeGitClient(fresh.creds, state.ctx.memoryBankRoot);
		state.remintsUsed += 1;
		return { ok: true };
	}

	/**
	 * Ensures HEAD points at the backend-declared default branch before
	 * the steady-state commit/push (plan §P1#2 + revised P2). The base
	 * case (HEAD already on default) is trivial; everything else recovers
	 * from a known drift state without losing commits:
	 *
	 *   - **Local default ref missing** (shallow clone, pruned). Create
	 *     it from `origin/<default>` and switch. Side-branch commits
	 *     remain on the side ref locally — recoverable via reflog if
	 *     ever needed.
	 *   - **HEAD is an ancestor of default** (side behind, e.g. user
	 *     checked out an old commit). Just switch. Default has every
	 *     commit head has.
	 *   - **Default is an ancestor of HEAD** — the side branch contains
	 *     every default commit and strictly more. This is the exact
	 *     shape of the pre-§P1#2 bug: a buggy older client landed
	 *     commits on a side branch while local default never advanced.
	 *     Fast-forward default to HEAD via `git checkout -B <default>
	 *     <head>` so the stranded commits ride out in this round's push.
	 *   - **Divergent** (commits on both sides). Refuse with
	 *     `vault_mismatch` and tell the user — auto-merge would risk
	 *     conflicts and is best handled with a human in the loop.
	 *
	 * Pending uncommitted work on a side branch is committed FIRST (to
	 * the side branch) so it's reachable for the ancestry checks. The
	 * extra commit is a no-op when the tree is clean.
	 *
	 * A failure here is terminal (`vault_mismatch`): proceeding while
	 * still on a side branch is the exact bug we're guarding against.
	 */
	private async ensureOnDefaultBranch(
		state: RoundState,
		ctx: RoundContext,
		syncTranscripts: boolean,
	): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: SyncErrorCode; readonly message: string }> {
		const defaultBranch = state.creds.defaultBranch;
		try {
			const head = await state.client.currentBranch();
			if (head === defaultBranch) {
				// Same-name branch but possibly unborn — typical after
				// `git init --initial-branch=<default>` + fetch (no clone).
				// `currentHead()` would then throw "ambiguous argument 'HEAD'"
				// and downstream callers like `tryCompleteMigration` would
				// silently swallow it. If the remote-tracking ref exists,
				// adopt it so HEAD is real before any commit / push.
				/* v8 ignore start -- unborn-HEAD adoption + §C1b deferral fire only on the first round after `git init --initial-branch` + fetch (no clone); both paths are covered indirectly by the §0.13 first-bind acceptance tests and §12 Tier 1.5 acceptance test, neither of which the unit-suite v8 reporter sees */
				if (!(await state.client.hasHead())) {
					if (await state.client.refExists(`refs/remotes/origin/${defaultBranch}`)) {
						// Pre-§C1b this was an unconditional
						// `git checkout -B <default> origin/<default>`. That
						// hard-fails when the local working tree already has
						// untracked files that share paths with the remote
						// tree — e.g. `<repoFolder>/.jolli/manifest.json`
						// written by FolderStorage between init and the first
						// sync round. Git refuses with "untracked working
						// tree files would be overwritten by checkout", the
						// round flips to `offline`, and the Tier 1.5
						// aggregate-merge path never gets a chance to run.
						//
						// When there's uncommitted/untracked content, leave
						// HEAD unborn: step 3d's auto-reconcile will stage +
						// commit it as the unborn branch's initial commit,
						// and step 4's `pullRebase` will replay that commit
						// onto `origin/<default>`. For aggregate files the
						// resulting conflict goes through the conflict
						// resolver's Tier 1.5 deterministic merge.
						// `includeIgnored: true` is critical here. The deny-all
						// `.gitignore` template (MemoryBankBootstrap.ts) makes
						// every FolderStorage-written summary / repos.json /
						// markdown match `*` → ignored. Plain `--porcelain`
						// returns empty, the check falls through, and
						// `checkoutTrackingBranch` silently overwrites the
						// ignored files when `origin/<default>` carries tracked
						// files at the same paths. Widening to `--ignored=matching`
						// surfaces them so we defer to the auto-reconcile path
						// instead.
						if (await state.client.hasUncommittedChanges({ includeIgnored: true })) {
							// Strict trigger check for bootstrap merge. C1+C2+C3
							// already hold by virtue of this code path; the
							// remaining gates (no local branches, no stash) make
							// sure we're not in a stranded-commits / user-stash
							// scenario where adopting origin would lose work.
							const verdict = await shouldRunBootstrapMerge(state.client, defaultBranch);
							if (verdict.ok) {
								log.warn(
									"Unborn HEAD on '%s' with local working-tree content — running bootstrap merge",
									defaultBranch,
								);
								const result = await runBootstrapMerge({
									client: state.client,
									vaultRoot: ctx.memoryBankRoot,
									defaultBranch,
									author: ctx.author,
									log: { info: log.info.bind(log), warn: log.warn.bind(log) },
								});
								if (!result.ok) {
									log.warn(
										"bootstrap merge failed (%s): %s — falling back to defer",
										result.code,
										result.message,
									);
								} else if (result.stashedSurvivors.length > 0) {
									const room = CANARY_PATH_CAP - this.canary.unowned.length;
									if (room > 0) {
										this.canary.unowned.push(...result.stashedSurvivors.slice(0, room));
									}
								}
							} else {
								log.warn(
									"Unborn HEAD on '%s' with local content but bootstrap merge skipped (%s) — deferring to auto-reconcile + pullRebase (Tier 1.5)",
									defaultBranch,
									verdict.reason,
								);
							}
						} else {
							log.warn(
								"Local '%s' is on an unborn HEAD — adopting origin/%s",
								defaultBranch,
								defaultBranch,
							);
							await state.client.checkoutTrackingBranch(defaultBranch);
						}
					}
					// Truly empty remote → leave unborn; the round's first
					// commit will be born from this branch. Callers that
					// need HEAD must guard via `hasHead()` themselves.
				}
				/* v8 ignore stop */
				return { ok: true };
			}
			log.warn("Vault HEAD is on '%s' but default branch is '%s' — recovering", head, defaultBranch);

			// Commit any pending edits to the current branch FIRST so the
			// subsequent ancestry checks see them. This is what makes the
			// pre-§P1#2 stranded-commits case recoverable: the commit lands
			// on `head`, then if `head` is strictly ahead of `default`, we
			// fast-forward default to include it.
			//
			// `includeIgnored: true` for the same reason as the unborn-HEAD
			// branch above: the deny-all `.gitignore` makes every
			// FolderStorage-written file ignored by default, so a plain
			// `--porcelain` check returns empty even when there's real
			// owned content to preserve. The subsequent `checkoutBranch` /
			// `checkoutTrackingBranch` (lines 1643 / 1637) would then
			// silently overwrite those ignored files when `origin/<default>`
			// carries tracked files at the same paths.
			if (await state.client.hasUncommittedChanges({ includeIgnored: true })) {
				// Branch-switch preservation: stage classifier-owned work
				// before checking out the default branch. The pre-§P1#2
				// rationale (commit pending work so it's reachable via
				// reflog after the checkout) is unchanged; the allowlist
				// filter just adds the property that any non-owned file
				// dropped into the working tree won't ride along into
				// the preservation commit.
				await this.stageVaultTracked(state.client, ctx.memoryBankRoot, { syncTranscripts });
				await state.client.commit(
					`[jolli-mb] reconcile: preserve work from ${head} before switching to ${defaultBranch}`,
					ctx.author,
				);
			}

			// Missing local default ref — clone-shallow or never-checked-out.
			// Recreate from origin and call it done. No commits from `head`
			// can land on default in this round because we don't know which
			// of the missing default's history to attach to, but reflog and
			// the side branch still hold them.
			if (!(await state.client.refExists(`refs/heads/${defaultBranch}`))) {
				log.warn("Local '%s' ref missing — recreating from origin/%s", defaultBranch, defaultBranch);
				await state.client.checkoutTrackingBranch(defaultBranch);
				return { ok: true };
			}

			// HEAD ⊆ default → side has nothing default doesn't. Plain switch.
			if (await state.client.isAncestor(head, defaultBranch)) {
				await state.client.checkoutBranch(defaultBranch);
				return { ok: true };
			}

			// default ⊆ HEAD → side is strictly ahead. Fast-forward default
			// to HEAD's tip; the round's push will then transmit the
			// previously-stranded commits.
			if (await state.client.isAncestor(defaultBranch, head)) {
				log.warn(
					"Side branch '%s' is strictly ahead of '%s' — fast-forwarding default to recover stranded commits",
					head,
					defaultBranch,
				);
				await state.client.recreateBranchAt(defaultBranch, head);
				return { ok: true };
			}

			// Divergent — refuse. The user has commits on both branches that
			// neither contains; we can't safely auto-merge without risking
			// conflicts that would silently drop content.
			const message = `vault branch '${head}' has diverged from '${defaultBranch}' — manual resolution required (merge or rebase '${head}' onto '${defaultBranch}' yourself)`;
			log.warn(message);
			return { ok: false, code: "vault_mismatch", message };
		} catch (e) {
			const message = `failed to switch vault to default branch '${defaultBranch}': ${(e as Error).message}`;
			log.warn(message);
			return { ok: false, code: "vault_mismatch", message };
		}
	}

	/**
	 * Verifies that `<memoryBankRoot>/.git` is a Jolli vault for the freshly
	 * minted credentials before any write touches it (plan §P1#1). Three
	 * outcomes:
	 *
	 *   - **Marker present and matching URL** → `{ ok: true }`. Normal
	 *     steady-state path; engine proceeds to fetch.
	 *   - **Marker missing but origin URL matches creds** → silently
	 *     backfills the marker (legitimate upgrade from a pre-marker
	 *     vault) and returns `{ ok: true }`. The user has the right repo
	 *     under the right folder — no reason to scare them.
	 *   - **Anything else** (marker missing + URL mismatch, marker present
	 *     with wrong URL, no origin configured) → `{ ok: false, code:
	 *     "vault_mismatch", message }`. Terminal: do not retry, do not
	 *     re-mint, never write. The caller surfaces this via the status
	 *     bar so the user reselects the Memory Bank folder.
	 *
	 * The backfill branch is what makes this safe to enable across
	 * existing installs without forcing a re-clone — pre-§P1#1 vaults
	 * never wrote a marker, but they DO have the correct origin remote,
	 * which is just as strong evidence.
	 */
	private async guardVaultIdentity(
		state: RoundState,
	): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: SyncErrorCode; readonly message: string }> {
		const originUrl = await state.client.getOriginUrl();
		const verdict = await verifyVaultMarker(state.ctx.memoryBankRoot, originUrl, state.creds);
		if (verdict.ok) {
			if (verdict.needsRewrite) {
				// Old-format marker (e.g. pre-541d00e path-lowercasing) —
				// matched via re-normalization in `verifyVaultMarker`. Rewrite
				// once in the canonical form so subsequent rounds take the
				// byte-equality fast path and the legacy form doesn't
				// re-trigger the same normalization branch on every round.
				log.info(
					"Rewriting vault marker at %s in canonical form (pre-normalization migration)",
					state.ctx.memoryBankRoot,
				);
				await writeVaultMarker(state.ctx.memoryBankRoot, state.creds);
			}
			return { ok: true };
		}
		if (verdict.reason === "missing_marker" && originUrl !== null) {
			// Pre-§P1#1 vault: marker was never written, but the live
			// origin remote matches creds → we trust the URL evidence.
			// Backfill the marker so subsequent rounds take the fast path.
			if (normalizeGitUrl(originUrl) === normalizeGitUrl(state.creds.gitUrl)) {
				log.info(
					"Backfilling missing vault marker at %s (pre-marker vault detected, origin URL matches credentials)",
					state.ctx.memoryBankRoot,
				);
				await writeVaultMarker(state.ctx.memoryBankRoot, state.creds);
				return { ok: true };
			}
		}
		log.warn(
			"Vault identity check failed (reason=%s) — refusing to write to %s. %s",
			verdict.reason,
			state.ctx.memoryBankRoot,
			verdict.message,
		);
		return { ok: false, code: "vault_mismatch", message: verdict.message };
	}

	/**
	 * Clone-or-fetch with step-level retry. The `<memoryBankRoot>/.git` probe
	 * decides clone vs fetch on each attempt — important because a recovery
	 * mint after a 404 on fetch may have left the vault present with stale
	 * remote refs that the next fetch can still service against the
	 * recreated repo.
	 */
	private async fetchOrCloneWithRetry(
		state: RoundState,
		lockHolder: RoundLockHolder,
	): Promise<
		| { readonly ok: true; readonly cloned: boolean }
		| { readonly ok: false; readonly code: SyncErrorCode; readonly message: string }
	> {
		const maxAttempts = this.opts.maxPushRetries ?? DEFAULT_MAX_STEP_ATTEMPTS;
		let lastMessage = "(no attempts)";
		let lastStep: "clone" | "init" | "fetch" = "fetch";
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const hasGit = await pathExists(join(state.ctx.memoryBankRoot, ".git"));
			const memoryBankExists = await pathExists(state.ctx.memoryBankRoot);
			try {
				if (hasGit) {
					// Steady state: existing local repo, just refresh refs —
					// but first verify this `.git` actually belongs to us.
					// See `VaultMarker.ts` for the threat model: without this
					// check, a user who points Memory Bank at any existing
					// repo would have it rewritten + pushed to its own origin.
					lastStep = "fetch";
					const guard = await this.guardVaultIdentity(state);
					if (!guard.ok) {
						// Terminal — never retry, never re-mint. The user
						// must reselect the Memory Bank folder.
						return guard;
					}
					await state.client.fetch();
					return { ok: true, cloned: false };
				}
				if (memoryBankExists) {
					// §0.13 first-bind: `<localFolder>` already exists with
					// FolderStorage content but isn't a git repo yet. `git init`
					// in place + add the remote + fetch. `git clone` would
					// refuse to overwrite a non-empty dir.
					//
					// Audit-only: record the directory's pre-init shape to
					// `debug.log`. There's no I4 guard here (decision: trust
					// the user's folder pick), but if a user later reports
					// surprise pushes after misconfiguring Memory Bank at
					// e.g. `~/Documents`, a forensic line in the log gives
					// us a real "you had 4,712 files / 312 MB at init time"
					// answer instead of guesswork.
					await logFirstBindAudit(state.ctx.memoryBankRoot);
					lastStep = "init";
					await state.client.initRemote(state.creds.gitUrl);
					await state.client.fetch();
					await writeVaultMarker(state.ctx.memoryBankRoot, state.creds);
					return { ok: true, cloned: true };
				}
				// Cold start: nothing exists yet. `git clone` creates the dir.
				lastStep = "clone";
				await state.client.clone(state.creds.gitUrl);
				await writeVaultMarker(state.ctx.memoryBankRoot, state.creds);
				return { ok: true, cloned: true };
			} catch (e) {
				const msg = (e as Error).message;
				lastMessage = msg;
				const cause = classifyGitError(msg);
				if (cause === "unauthorized" || cause === "repoMissing") {
					log.warn(
						"%s attempt %d/%d failed (%s) — attempting recovery re-mint",
						lastStep,
						attempt,
						maxAttempts,
						cause,
					);
					const remintResult = await this.tryRemint(state, cause, lockHolder);
					if (!remintResult.ok) return remintResult;
					continue;
				}
				if (cause === "network") {
					// Network-flavored failure (TLS handshake, DNS, connection
					// timeout, …). Route to `code: "network"` so the UI stays
					// neutral — the next poll tick almost always recovers.
					log.warn("%s attempt %d/%d failed (network): %s", lastStep, attempt, maxAttempts, msg);
					return { ok: false, code: "network", message: `${lastStep}: ${msg}` };
				}
				log.warn("%s attempt %d/%d failed (fatal): %s", lastStep, attempt, maxAttempts, msg);
				return {
					ok: false,
					code: lastStep === "clone" || lastStep === "init" ? "clone_failed" : "fetch_failed",
					message: `${lastStep}: ${msg}`,
				};
			}
		}
		// With `MAX_REMINTS_PER_PHASE = 1` the second 401/404 returns early
		// via tryRemint, and all other catch arms return immediately, so
		// the loop can't drain `maxAttempts` rounds naturally. Throw if it
		// somehow does — a fabricated `sync_failed_after_retries` would
		// hide whatever broke the invariant.
		throw new Error(
			`unreachable: fetchOrCloneWithRetry exhausted ${maxAttempts} attempts at step=${lastStep} (lastMessage=${lastMessage})`,
		);
	}

	/**
	 * Push with step-level retry — three recoverable failure modes share
	 * one attempt budget: non-FF (pull-rebase then retry), unauthorized
	 * (re-mint then retry), repoMissing (re-mint then retry). Any other
	 * push failure terminates this step immediately.
	 *
	 * Replaces the older "non-FF inline retry + 401 bubble-up" split — the
	 * 401 recovery now happens at the same layer as non-FF recovery so the
	 * round driver doesn't need a second pushWithRetry call after re-mint.
	 */
	private async pushWithRetry(
		state: RoundState,
		lockHolder: RoundLockHolder,
	): Promise<
		| { readonly ok: true; readonly transmitted: boolean }
		| { readonly ok: false; readonly code: SyncErrorCode; readonly message: string }
	> {
		const maxAttempts = this.opts.maxPushRetries ?? DEFAULT_MAX_STEP_ATTEMPTS;
		let lastMessage = "(no attempts)";
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const result = await state.client.push();
			if (result.ok) return { ok: true, transmitted: result.transmitted };
			lastMessage = result.message;
			if (result.unauthorized || result.repoMissing) {
				const cause: RemintCause = result.unauthorized ? "unauthorized" : "repoMissing";
				log.warn("push attempt %d/%d failed (%s) — attempting recovery re-mint", attempt, maxAttempts, cause);
				const remintResult = await this.tryRemint(state, cause, lockHolder);
				if (!remintResult.ok) return remintResult;
				continue;
			}
			if (!result.nonFastForward) {
				// Hard failure — no recovery, no retry. Network-flavored
				// causes (TLS handshake, DNS, etc.) get routed to the silent
				// `network` code per plan §0.11; everything else surfaces
				// as a terminal failure the user must act on.
				// Order matters: server rejection (pre-receive declined, branch
				// protection, payload-size limit) often presents as "remote end
				// hung up" / "early EOF" because the server closes the sideband
				// socket after refusing — so it has to be detected BEFORE the
				// network classifier or it gets routed to silent transient
				// retry forever (I5).
				const code: SyncErrorCode = isServerRejectionMessage(result.message)
					? "push_rejected"
					: isNetworkErrorMessage(result.message)
						? "network"
						: "sync_failed_after_retries";
				return { ok: false, code, message: result.message };
			}
			// Non-FF — pull --rebase to integrate, then retry. We don't drive
			// conflict resolution here because the round-level pull already
			// did; landing in non-FF again on retry means a remote raced.
			//
			// `pullRebase` keeps the rebase **paused on disk** when it
			// returns `conflicted: [...]` — the caller owns the cleanup.
			// The main round body hands that off to `ConflictResolver`,
			// which eventually calls `rebaseAbort`/`rebaseContinue`. This
			// recovery path doesn't drive resolution, so we must abort
			// ourselves before bailing — otherwise `.git/rebase-merge/`
			// stays in the vault and every subsequent round's `pullRebase`
			// gets rejected with "there is already a rebase-merge
			// directory", wedging sync until the user manually `cd`s into
			// the vault and runs `git rebase --abort`. The vault is meant
			// to be an opaque, user-untouched directory, so leaking that
			// state is a permanent wedge.
			try {
				const pull = await this.pullRebaseLocked(state.client, state.ctx.memoryBankRoot, state.ctx.author);
				if (pull.conflicted.length > 0) {
					await this.safeRebaseAbort(state, "non-FF retry hit unresolved conflicts");
					return {
						ok: false,
						code: "sync_failed_after_retries",
						message: "non-FF push raced with conflicting remote commit",
					};
				}
			} catch (e) {
				// `pullRebase` only throws when git fails with no unmerged
				// paths — normally that means no rebase was paused, so no
				// cleanup is required. Abort defensively anyway in case a
				// future GitClient path leaves state behind; the helper
				// swallows its own errors so it can't shadow `e`.
				await this.safeRebaseAbort(state, "non-FF retry pullRebase threw");
				// `VaultLockBusyError` is the "worker is busy" surface —
				// transient, retry-soon. Map to `network` so the round
				// downgrades to offline rather than the terminal red
				// `sync_failed_after_retries`. Outer `runRound` catch only
				// fires if pushWithRetry re-throws; pushWithRetry returns
				// a Result, so we have to map here.
				if (e instanceof VaultLockBusyError) {
					return { ok: false, code: "network", message: (e as Error).message };
				}
				const msg = (e as Error).message;
				const code: SyncErrorCode = isServerRejectionMessage(msg)
					? "push_rejected"
					: isNetworkErrorMessage(msg)
						? "network"
						: "sync_failed_after_retries";
				return { ok: false, code, message: msg };
			}
			log.debug(
				"Retrying push after non-FF (attempt %d/%d) for %s",
				attempt,
				maxAttempts,
				state.ctx.author.email,
			);
		}
		return {
			ok: false,
			code: "sync_failed_after_retries",
			message: `push exhausted ${maxAttempts} attempts: ${lastMessage}`,
		};
	}

	/**
	 * Best-effort `git rebase --abort`. Used by recovery paths that bail
	 * without driving conflict resolution but may have left the vault in
	 * a paused-rebase state. Swallows its own errors — abort failure must
	 * not shadow the upstream error that triggered this cleanup, and a
	 * leaked rebase is still preferable to losing the original cause in
	 * the user's status-bar tooltip.
	 */
	private async safeRebaseAbort(state: RoundState, reason: string): Promise<void> {
		try {
			await state.client.rebaseAbort();
			log.info("rebaseAbort succeeded (%s)", reason);
		} catch (e) {
			log.warn("rebaseAbort failed during recovery (%s): %s", reason, (e as Error).message);
		}
	}

	private async buildResolver(client: GitClient, ctx: RoundContext): Promise<ConflictResolver> {
		/* v8 ignore start -- default ConflictResolver path is exercised only in the real bundle; tests always pass makeResolver */
		if (!this.opts.makeResolver) {
			return new ConflictResolver({
				client,
				ai: await this.opts.ai(),
				ui: this.opts.ui,
				resolveVaultPath: (rel) => `${ctx.memoryBankRoot}/${rel}`,
				author: ctx.author,
				policy: this.opts.conflictPolicy,
			});
		}
		/* v8 ignore stop */
		return this.opts.makeResolver(client, {
			resolveVaultPath: (rel) => `${ctx.memoryBankRoot}/${rel}`,
			author: ctx.author,
		});
	}

	private emitPhase(phase: SyncPhase): void {
		try {
			this.opts.onPhase?.(phase);
		} catch (e) {
			log.debug("onPhase threw (swallowed): %s", (e as Error).message);
		}
	}

	private report(state: SyncState, partial: Omit<SyncRoundResult, "newState">): SyncRoundResult {
		// Fold per-round `stageVault` canary into every round result so a
		// `synced` outcome with a `symlinked` finding still surfaces to the
		// status bar. Caller-supplied `canary` (rare — only when a path
		// builds a SyncRoundResult by hand) wins so we don't silently
		// overwrite an explicit value.
		const canary = "canary" in partial && partial.canary !== undefined ? partial.canary : this.takeCanary();
		const result: SyncRoundResult =
			canary !== undefined ? { ...partial, canary, newState: state } : { ...partial, newState: state };
		try {
			this.opts.onStateChange?.(state, result);
		} catch (e) {
			log.debug("onStateChange threw (swallowed): %s", (e as Error).message);
		}
		return result;
	}

	/**
	 * Convenience wrapper around `report("offline", …)` that attaches a
	 * classified `lastError`. Always use this instead of `report("offline",
	 * …)` directly — the status orchestrator's "Sync failed" vs "Offline"
	 * branching keys off the presence/code of `lastError`.
	 */
	private reportOffline(
		partial: Omit<SyncRoundResult, "newState" | "lastError">,
		lastError: { code: SyncErrorCode; message: string; selfLocked?: boolean },
	): SyncRoundResult {
		// Spread shape preserves the optional `selfLocked` flag without
		// forcing every non-vault_locked caller to mention it. Only the
		// 423-path callers pass it through; other codes naturally leave it
		// undefined which the status bar reads as "not self-locked".
		return this.report("offline", { ...partial, lastError });
	}

	/**
	 * Reads the persisted `lockOwnerToken` written by a previous round's
	 * successful mint. Returns `{ selfLocked: true }` iff:
	 *
	 *   - An entry exists in `pending-lock.json` scoped to the current
	 *     `jolliApiKey` (account-switch safe).
	 *   - It was minted less than `SELF_LOCK_TTL_GRACE_MS` ago — older
	 *     entries are treated as released by backend TTL.
	 *
	 * Read once at the top of `mintFresh` and cached for the whole retry
	 * loop so a mid-loop write (from another concurrent process) can't
	 * flip the classification mid-flight.
	 */
	private async readSelfLockState(): Promise<{ readonly selfLocked: boolean }> {
		try {
			const apiKey = await this.opts.backend.getJolliApiKey();
			if (!apiKey) return { selfLocked: false };
			const entry = await readPendingLock(apiKey);
			if (entry === null) return { selfLocked: false };
			const age = Date.now() - entry.mintedAt;
			if (age < 0) {
				// Future-dated mintedAt (clock skew / corrupt file) — treat
				// as fresh. The grace window will retire it on the next read
				// once the clock settles.
				return { selfLocked: true };
			}
			return { selfLocked: age < SELF_LOCK_TTL_GRACE_MS };
		} catch (e) {
			log.debug("readSelfLockState failed (swallowed, defaulting to false): %s", (e as Error).message);
			return { selfLocked: false };
		}
	}

	/**
	 * Persists the freshly-minted `lockOwnerToken` so a later 423 can be
	 * classified as self-induced. Called from every successful mint
	 * (initial and recovery). Overwrites any prior entry — only the most
	 * recent token is tracked.
	 */
	private async persistMintedLock(creds: GitCredentials): Promise<void> {
		const apiKey = await this.opts.backend.getJolliApiKey();
		if (!apiKey) return;
		await writePendingLock(apiKey, creds.lockOwnerToken);
	}

	/**
	 * Clears the persisted `lockOwnerToken` after a confirmed backend
	 * release (successful `notifyPush` / `completeMigration`). A failure
	 * here is swallowed because the entry will auto-expire via the TTL
	 * grace window — at worst the next round sees a stale self-locked
	 * label for one cycle.
	 */
	private async clearPersistedLock(): Promise<void> {
		await clearPendingLock();
	}
}

/**
 * Classifies a `git clone` / `git fetch` error message into one of the
 * recoverable causes. Mirrors `GitClient.push()`'s in-band classifier
 * but operates on thrown Error messages (clone/fetch throw on failure,
 * push returns a typed result).
 *
 * Order matters: a single response can carry both auth and 404 strings (a
 * 401 page sometimes includes a "Repository not found" hint), and we want
 * the auth retry path in that case — a fresh token might re-authorize the
 * existing repo, whereas treating it as `repoMissing` would needlessly
 * trigger backend re-provisioning.
 */
function classifyGitError(message: string): "unauthorized" | "repoMissing" | "network" | "fatal" {
	const m = message.toLowerCase();
	if (
		/authentication failed|invalid username or password|401 unauthorized|requested url returned error: 401/.test(m)
	) {
		return "unauthorized";
	}
	if (isRepoMissingMessage(message)) {
		return "repoMissing";
	}
	// `network` placed AFTER auth/repo-missing on purpose: a 401 page can
	// contain "connection" / "TLS" hints, but we still want the auth-recovery
	// path; only when neither auth nor repo-missing signals match does the
	// network classifier get consulted. Routed to `lastError.code = "network"`
	// upstream so the UI stays neutral (plan §0.11).
	if (isNetworkErrorMessage(message)) {
		return "network";
	}
	return "fatal";
}

function makeCommitSummary(isFirstBind: boolean): string {
	// `<localFolder>` IS the working tree, so the commit content is whatever
	// FolderStorage wrote since the last round. We don't know per-file
	// counts without `git diff --cached` round-tripping — keep the message
	// generic; the actual diff is visible in `git log -p`.
	if (isFirstBind) {
		// First push for this user. Lets the backend mirror pin "seed point"
		// metadata to this commit (source plan §4.1).
		return buildCommitMessage({ op: "migrate", summary: "initial bootstrap from <localFolder>" });
	}
	return buildCommitMessage({ op: "add", summary: "memory bank changes" });
}

/* v8 ignore start -- default constructor; exercised only in real bundle */
function defaultBootstrapFactory(opts: {
	vaultClient: GitClient;
	memoryBankRoot: string;
	transcripts: boolean;
}): MemoryBankBootstrap {
	return new MemoryBankBootstrap(opts);
}
/* v8 ignore stop */

/* v8 ignore start -- default constructor; exercised only in real bundle */
function defaultLegacyMigrationFactory(opts: { memoryBankRoot: string; transcripts: boolean }): LegacyMigration {
	return new LegacyMigration(opts);
}
/* v8 ignore stop */

/** Promise-based timeout. Used by `mintFresh` for 423 retry backoff (§0.8). */
/**
/* `runSweep` / `formatSweepError` helpers REMOVED in Phase 1 along with
 * the `SymlinkSweep` module — see the comment at the deleted pre-round
 * sweep site in `doRound` for the migration story. */

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True iff `path` resolves to an existing filesystem entry (file, dir, or symlink target). */
async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Forensic audit for the first-bind branch (`memoryBankExists && !hasGit`).
 * Logs the top-level shape of `<memoryBankRoot>` before `git init` runs so
 * a misconfigured-folder report has a real "what was there?" trail. Shallow
 * (top level only) and best-effort: any I/O error is swallowed — the audit
 * must never block init.
 */
async function logFirstBindAudit(memoryBankRoot: string): Promise<void> {
	try {
		const entries = await readdir(memoryBankRoot, { withFileTypes: true });
		let totalBytes = 0;
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			try {
				const s = await stat(join(memoryBankRoot, entry.name));
				totalBytes += s.size;
			} catch {
				// per-entry stat failure (race / permission): skip; the
				// count is still useful even if the byte total is partial.
			}
		}
		log.info(
			"first-bind init at %s: %d top-level entries, %d bytes (top-level files only) pre-init",
			memoryBankRoot,
			entries.length,
			totalBytes,
		);
		/* v8 ignore start -- readdir failure path is defensive */
	} catch (e) {
		log.debug("first-bind audit skipped for %s: %s", memoryBankRoot, (e as Error).message);
	}
	/* v8 ignore stop */
}
