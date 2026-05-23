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
import { createLogger } from "../Logger.js";
import {
	type BackendClient,
	SyncBackendNetworkError,
	SyncBackendUnauthorizedError,
	VaultLockedError,
} from "./BackendClient.js";
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
import { MemoryBankBootstrap } from "./MemoryBankBootstrap.js";
import { clearPendingLock, readPendingLock, writePendingLock } from "./PendingLockStore.js";
import {
	findRepoMappingConflicts,
	loadRepoMapping,
	type RepoMappingConflict,
	resolveOrAssignFolder,
	saveRepoMapping,
} from "./RepoMapping.js";
import { type SweepReport, sweepSymlinks } from "./SymlinkSweep.js";
import { acquireSyncLock, refreshSyncLockMtime, releaseSyncLock } from "./SyncLock.js";
import type {
	ConflictRecord,
	GitCredentials,
	SyncErrorCode,
	SyncRoundOptions,
	SyncRoundResult,
	SyncState,
	VaultLockedWaitInfo,
} from "./SyncTypes.js";
import { normalizeGitUrl, verifyVaultMarker, writeVaultMarker } from "./VaultMarker.js";

const log = createLogger("Sync:Engine");

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

export interface RoundContext {
	/**
	 * Git working tree root — also the FolderStorage root (plan §0.13).
	 * Defaults to `<localFolder>` (≈ `~/Documents/jolli/`).
	 */
	readonly memoryBankRoot: string;
	/**
	 * Subdirectory of `memoryBankRoot` holding this source repo's Memory Bank
	 * content. Effective `folderRoot` = `join(memoryBankRoot, repoFolderName)`.
	 * Equal to the repo's slug; may be overridden at round time by
	 * `<memoryBankRoot>/.jolli/repos.json` when another `repoIdentity` already
	 * claims this slug — the engine then assigns `<slug>-<hash6>` to the
	 * loser. See `RepoMapping.resolveOrAssignFolder`.
	 */
	readonly repoFolderName: string;
	/**
	 * Canonical identity used to key the `repos.json` mapping. Stable per
	 * source repo (typically the normalized git remote URL); two devices
	 * pointing at the same source repo MUST produce the same value so the
	 * vault mapping resolves consistently.
	 */
	readonly repoIdentity: string;
	/** `git commit --author` flag. */
	readonly author: { readonly name: string; readonly email: string };
}

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

export class SyncEngine {
	private readonly opts: SyncEngineOpts;

	constructor(opts: SyncEngineOpts) {
		this.opts = opts;
	}

	async runRound(round: SyncRoundOptions): Promise<SyncRoundResult> {
		log.info("runRound start reason=%s cwd=%s", round.reason, round.cwd);
		const lockAcquired = await acquireSyncLock({
			timeoutMs: this.opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
		});
		if (!lockAcquired) {
			log.info("Skipping round — sync.lock held by another process");
			return this.report("syncing", { fetched: false, pulled: false, pushed: false, conflicts: [] });
		}

		const refresher = setInterval(() => {
			void refreshSyncLockMtime();
		}, this.opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS);

		try {
			const result = await this.doRound(round);
			log.info("runRound end state=%s pushed=%s pulled=%s", result.newState, result.pushed, result.pulled);
			return result;
		} catch (e) {
			// Catch any uncaught error (e.g. SyncBackendError 4xx/5xx that isn't
			// network/auth, a bogus `localFolder`, or a programming bug). Logging
			// here is the only way the user sees what went wrong — the
			// orchestrator's IIFE swallows the throw and only marks status=offline.
			log.error(
				"runRound threw — going offline: %s\n%s",
				(e as Error).message,
				(e as Error).stack ?? "(no stack)",
			);
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
			await releaseSyncLock();
		}
	}

	private async doRound(round: SyncRoundOptions): Promise<SyncRoundResult> {
		const ctx = await this.opts.resolveContext(round);

		// 1. Mint fresh credentials at round start. No cross-round cache (§0.6).
		const initialMint = await this.mintFresh();
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

		// 3. Clone-or-fetch with step-level retry + at-most-one re-mint
		// recovery on 401 / 404. "Needs clone" is detected by probing
		// `<memoryBankRoot>/.git` rather than parsing git's stderr — git can
		// return non-zero with empty stderr, and parsing error strings
		// broke once in the field already.
		const fetched = await this.fetchOrCloneWithRetry(state);
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

		// 3a. Sweep symlinks BEFORE any git stage/commit, file write, or
		// branch-switch commit happens (plan §P2 revised). Any symlink
		// that survives this point would be staged by the next `git add
		// --all` — including the pre-pull auto-reconcile commit, the
		// `ensureOnDefaultBranch` preserve-side-work commit, the migration
		// push, and `MemoryBankBootstrap.writeFile(.gitignore)` (which
		// would FOLLOW a hostile `.gitignore` symlink and overwrite the
		// target file).
		//
		// A second sweep runs right before the steady-state stageAll as
		// defence-in-depth against any symlink created mid-round by a
		// racing process or by a tool we invoked (none today, but cheap
		// insurance).
		{
			const sweep = await runSweep(state.ctx.memoryBankRoot, "pre-round");
			if (sweep.failed !== 0) {
				return this.reportOffline(
					{ fetched: true, pulled: false, pushed: false, conflicts: [] },
					{
						code: "symlink_quarantine_failed",
						message: formatSweepError("pre-round", sweep),
					},
				);
			}
			if (sweep.quarantined > 0) {
				log.info("Pre-round symlink sweep quarantined=%d (plan §P2)", sweep.quarantined);
			}
		}

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
		const branchSwitch = await this.ensureOnDefaultBranch(state, ctx);
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
			const migrationResult = await this.runFirstBindMigration(state, round);
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
		try {
			if (await state.client.hasUncommittedChanges()) {
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
				await state.client.stageAll();
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
		if (!remoteHasDefault) {
			log.info(
				"pullRebase skipped — origin/%s not present (empty-remote first-bind); the round's commit + push will create it",
				defaultBranch,
			);
		}
		try {
			if (remoteHasDefault) {
				const pull = await state.client.pullRebase(ctx.author);
				pulled = true;
				if (pull.conflicted.length > 0) {
					const resolver = await this.buildResolver(state.client, ctx);
					const report = await resolver.resolveAll(pull.conflicted);
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
		const mapping = await loadRepoMapping(ctx.memoryBankRoot);
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
		const resolved = resolveOrAssignFolder(mapping, {
			repoIdentity: ctx.repoIdentity,
			authoritativeFolder: ctx.repoFolderName,
		});
		const effectiveCtx: RoundContext = { ...ctx, repoFolderName: resolved.folder };
		if (resolved.updatedMapping !== null) {
			await saveRepoMapping(effectiveCtx.memoryBankRoot, resolved.updatedMapping);
			// One log line covers both "new mapping" and "rewrote diverged
			// mapping" — the engine doesn't care which one happened, only
			// that `repos.json` is now consistent with disk.
			log.info(
				"repos.json: persisted folder=%s for repoIdentity=%s (authoritative=%s)",
				resolved.folder,
				ctx.repoIdentity,
				ctx.repoFolderName,
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
			memoryBankRoot: effectiveCtx.memoryBankRoot,
			transcripts: round.transcripts,
		});
		await bootstrap.ensureBootstrap();

		// 6. Second symlink sweep — defence-in-depth (plan §P2 revised).
		//    The PRIMARY sweep ran at step 3a, before any commit or file
		//    write. This second pass catches anything created during the
		//    round: a racing user/process drop, a Tier-2 merge that
		//    materialised a symlink (none today, but cheap insurance),
		//    or — critically — a fresh symlink dropped between pullRebase
		//    pulling in a peer's commit and our final stageAll. Without
		//    this pass, a remote symlink that just landed via pull would
		//    immediately re-stage in our push.
		{
			const sweep = await runSweep(effectiveCtx.memoryBankRoot, "pre-stage");
			if (sweep.failed !== 0) {
				return this.reportOffline(
					{ fetched: true, pulled: true, pushed: false, conflicts: [] },
					{
						code: "symlink_quarantine_failed",
						message: formatSweepError("pre-stage", sweep),
					},
				);
			}
			if (sweep.quarantined > 0) {
				log.info("Pre-stage symlink sweep quarantined=%d (defence-in-depth, plan §P2)", sweep.quarantined);
			}
		}

		// 7. Commit + push. `stageAll` followed by `commit` is a no-op when
		//    the working tree matches HEAD; the unconditional push below is
		//    idempotent in that case too.
		const summary = makeCommitSummary(isFirstBind);
		await state.client.stageAll();
		await state.client.commit(summary, ctx.author);
		const pushed = await this.pushWithRetry(state);
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
		if (completionDeferred) {
			const retry = await this.tryCompleteMigration(state);
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
		//    lock here. Ownership is verified via `lockOwnerToken` — the
		//    same token returned by the matching `/credentials` call that
		//    opened this round.
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
			const completion = await this.tryCompleteMigration(state);
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
			await state.client.stageAll();
			await state.client.commit(commitMessage, state.ctx.author);
			const pushed = await this.pushWithRetry(state);
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
				} catch (e) {
					log.debug("migration notify-push failed (swallowed): %s", (e as Error).message);
				}
			}
		}

		const completion = await this.tryCompleteMigration(state);
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
			// Truly-empty remote case (post-`git init`, fetched nothing, no
			// docs to migrate): HEAD is unborn, `currentHead` would throw
			// "ambiguous argument 'HEAD'", the catch below would swallow it
			// and the backend would never flip. Skip the call and let the
			// steady-state push later in the round produce a real HEAD —
			// the next round's `runFirstBindMigration` retries this.
			/* v8 ignore start -- truly-empty-remote-and-no-docs case is the §0.13 first-bind degenerate state; reaching it requires synchronously failing every test mint mode, and the next round's runFirstBindMigration retries it cleanly */
			if (!(await state.client.hasHead())) {
				log.info(
					"completeMigration: deferred — HEAD is unborn (empty vault, no docs to migrate yet); doRound will retry after steady-state push",
				);
				return { ok: true, deferred: true };
			}
			/* v8 ignore stop */
			const commitSha = await state.client.currentHead();
			const res = await this.opts.backend.completeMigration({
				commitSha,
				lockOwnerToken: state.creds.lockOwnerToken,
			});
			// `complete-migration` is the second canonical lock-release
			// path (the first is `notify-push`). Clear evidence on success
			// so the next round's mint retries attribute any 423 correctly.
			await this.clearPersistedLock();
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
	private async mintFresh(): Promise<
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
	): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: SyncErrorCode; readonly message: string }> {
		if (state.remintsUsed >= MAX_REMINTS_PER_PHASE) {
			const msg = `recovery exhausted (${cause}): already re-minted ${state.remintsUsed} time(s) this round`;
			log.warn(msg);
			return { ok: false, code: "sync_failed_after_retries", message: msg };
		}
		log.warn("Triggering recovery re-mint (cause=%s, remintsUsed=%d)", cause, state.remintsUsed);
		const fresh = await this.mintFresh();
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
						if (await state.client.hasUncommittedChanges()) {
							log.warn(
								"Unborn HEAD on '%s' with local working-tree content — deferring branch adoption to auto-reconcile + pullRebase (Tier 1.5)",
								defaultBranch,
							);
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
			if (await state.client.hasUncommittedChanges()) {
				await state.client.stageAll();
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
					const remintResult = await this.tryRemint(state, cause);
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
				const remintResult = await this.tryRemint(state, cause);
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
				const pull = await state.client.pullRebase(state.ctx.author);
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

	private report(state: SyncState, partial: Omit<SyncRoundResult, "newState">): SyncRoundResult {
		const result: SyncRoundResult = { ...partial, newState: state };
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
 * Wraps `sweepSymlinks` so an unforeseen throw (the function itself catches
 * per-entry I/O failures and returns counts; this is belt-and-suspenders for
 * unexpected runtime errors like OOM or a corrupted Dirent type) becomes a
 * `failed=-1` report the caller can treat the same as any other failure.
 * Synthesising rather than re-throwing keeps the round termination on a
 * single code path: `reportOffline(symlink_quarantine_failed, …)`.
 */
async function runSweep(root: string, label: "pre-round" | "pre-stage"): Promise<SweepReport> {
	try {
		return await sweepSymlinks(root);
	} catch (e) {
		/* v8 ignore start -- sweepSymlinks itself catches and counts per-entry failures, so this branch only fires on truly unexpected runtime errors (OOM, corrupt Dirent type bits on niche kernels) that the test fixture can't reproduce deterministically */
		log.warn("Symlink sweep (%s) threw: %s — treating as failed=-1", label, (e as Error).message);
		return { quarantined: 0, failed: -1, paths: [] };
		/* v8 ignore stop */
	}
}

/**
 * Formats a `SweepReport` failure for the `lastError.message` shown in the
 * status bar tooltip. Caps the path list at 3 entries to keep the tooltip
 * readable on small screens; paths are already relative to `memoryBankRoot`
 * so no absolute-path information leaks.
 */
function formatSweepError(label: "pre-round" | "pre-stage", sweep: SweepReport): string {
	const head = sweep.paths.slice(0, 3).join(", ");
	const more = sweep.paths.length > 3 ? `, +${sweep.paths.length - 3} more` : "";
	const paths = sweep.paths.length > 0 ? ` (paths: ${head}${more})` : "";
	return `${label} symlink sweep: failed=${sweep.failed}${paths}`;
}

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
