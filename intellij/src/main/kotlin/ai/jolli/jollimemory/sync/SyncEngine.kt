package ai.jolli.jollimemory.sync

import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/** Factory: builds a [SyncGitClient] for the given credentials + vault root. */
fun interface GitClientFactory {
	fun create(creds: GitCredentials, memoryBankRoot: String): SyncGitClient
}

/** Engine configuration and dependency bundle. */
data class SyncEngineOpts(
	val backend: SyncBackendClient,
	val resolveContext: (SyncRoundOptions) -> RoundContext,
	val makeGitClient: GitClientFactory,
	val onStateChange: ((SyncState, SyncRoundResult) -> Unit)? = null,
	val onLockedWait: ((VaultLockedWaitInfo) -> Unit)? = null,
	val onPhase: ((SyncPhase) -> Unit)? = null,
	val onRoundComplete: ((String) -> Unit)? = null,
	val lockTimeoutMs: Long = 10_000L,
	val refreshIntervalMs: Long = 60_000L,
	val maxPushAttempts: Int = 3,
	val vaultLockedRetrySchedule: List<Long> = listOf(60_000L, 120_000L, 180_000L),
	val sleepFn: (Long) -> Unit = { Thread.sleep(it) },
	val conflictPolicy: ConflictPolicy = ConflictPolicy.MINE,
	val aiProvider: (() -> AiMergeProvider?)? = null,
	val conflictUi: ConflictUi? = null,
	val makeResolver: ((SyncGitClient, CommitAuthor?) -> ConflictResolver)? = null,
)

/**
 * Core sync-round pipeline.
 *
 * Port of `cli/src/sync/SyncEngine.ts` — steady-state path.
 * First-bind migration and conflict resolution are stubbed for Phase 5.
 */
open class SyncEngine(private val opts: SyncEngineOpts) {

	companion object {
		private const val MAX_REMINTS_PER_PHASE = 1
		private const val SELF_LOCK_TTL_GRACE_MS = 9 * 60_000L
		private const val STALE_LOCK_TTL_MS = 300_000L
		private val log = ai.jolli.jollimemory.core.JmLogger.create("SyncEngine")
	}

	// ── Public entry point ──────────────────────────────────────────

	open fun runRound(round: SyncRoundOptions): SyncRoundResult {
		log.info("runRound start reason=${round.reason} cwd=${round.cwd}")
		if (!SyncLock.acquire(SyncLockOpts(timeoutMs = opts.lockTimeoutMs))) {
			log.info("runRound skipped — another round already in progress (lock contention)")
			return report(SyncState.SYNCING, SyncRoundResult(
				fetched = false, pulled = false, pushed = false,
				newState = SyncState.SYNCING,
			))
		}

		var refresher: ScheduledExecutorService? = null
		val lockHolder = RoundLockHolder()

		try {
			refresher = Executors.newSingleThreadScheduledExecutor { r ->
				Thread(r, "sync-lock-refresh").apply { isDaemon = true }
			}
			refresher.scheduleAtFixedRate(
				{ SyncLock.refreshMtime() },
				opts.refreshIntervalMs, opts.refreshIntervalMs, TimeUnit.MILLISECONDS,
			)

			val ctx = opts.resolveContext(round)
			return doRound(round, ctx, lockHolder)
		} catch (e: Exception) {
			log.warn("runRound threw — going offline: ${e.message} ${e.stackTraceToString()}")
			return reportOffline(
				fetched = false, pulled = false, pushed = false,
				code = SyncErrorCode.SYNC_FAILED_AFTER_RETRIES,
				message = e.message ?: "unexpected error",
			)
		} finally {
			refresher?.shutdownNow()
			releaseLockHolderIfNeeded(lockHolder)
			try { opts.onRoundComplete?.invoke(round.cwd) } catch (_: Exception) {}
			SyncLock.release()
		}
	}

	// ── Pipeline ────────────────────────────────────────────────────

	private fun doRound(
		round: SyncRoundOptions,
		ctx: RoundContext,
		lockHolder: RoundLockHolder,
	): SyncRoundResult {
		// Step 1: Mint credentials (with 423 retry loop).
		log.debug("Step 1: minting credentials")
		val mint = mintFresh(lockHolder)
		if (mint !is MintResult.Ok) {
			val failed = mint as MintResult.Failed
			log.warn("Step 1 failed: mint credentials code=${failed.code} message=${failed.message}")
			return reportOffline(
				fetched = false, pulled = false, pushed = false,
				code = failed.code, message = failed.message, selfLocked = failed.selfLocked,
			)
		}

		log.info("Step 1 ok: credentials minted, defaultBranch=${mint.creds.defaultBranch}")

		val state = RoundState(
			creds = mint.creds,
			client = opts.makeGitClient.create(mint.creds, ctx.memoryBankRoot),
			ctx = ctx,
		)

		// Step 2: Check git is installed.
		log.debug("Step 2: checking git installation")
		val gitCheck = state.client.checkGitInstalled()
		if (gitCheck is GitVersionResult.NotFound) {
			log.warn("Step 2 failed: git not found on PATH")
			return reportOffline(
				fetched = false, pulled = false, pushed = false,
				code = SyncErrorCode.GIT_MISSING, message = "git binary not found on PATH",
			)
		}

		// Step 2b: Self-heal stale rebase state.
		try {
			if (state.client.isRebaseInProgress()) {
				log.info("Step 2b: aborting stale rebase")
				state.client.rebaseAbort()
			}
		} catch (_: Exception) {}

		// Step 2c: Sweep stale .git/*.lock files.
		try {
			state.client.sweepStaleLockFiles(STALE_LOCK_TTL_MS)
		} catch (_: Exception) {}

		// Step 3: Fetch or clone with retry.
		log.debug("Step 3: fetch/clone memoryBankRoot=${ctx.memoryBankRoot}")
		emitPhase(SyncPhase.DOWNLOADING)
		val fetchResult = fetchOrCloneWithRetry(state, lockHolder)
		if (fetchResult !is FetchStepResult.Ok) {
			val failed = fetchResult as FetchStepResult.Failed
			log.warn("Step 3 failed: fetch/clone code=${failed.code} message=${failed.message}")
			return reportOffline(
				fetched = false, pulled = false, pushed = false,
				code = failed.code, message = failed.message,
			)
		}

		log.info("Step 3 ok: fetch/clone complete cloned=${(fetchResult as FetchStepResult.Ok).cloned}")

		// Step 3b: Ensure on default branch.
		log.debug("Step 3b: ensuring on default branch=${state.creds.defaultBranch}")
		val branchResult = ensureOnDefaultBranch(state)
		if (branchResult !is BranchStepResult.Ok) {
			val failed = branchResult as BranchStepResult.Failed
			log.warn("Step 3b failed: branch setup code=${failed.code} message=${failed.message}")
			return reportOffline(
				fetched = true, pulled = false, pushed = false,
				code = failed.code, message = failed.message,
			)
		}

		// Check if remote has the default branch.
		val remoteRef = "refs/remotes/origin/${state.creds.defaultBranch}"
		val remoteHasDefault = state.client.refExists(remoteRef)

		// Step 3c: First-bind migration (db → git one-shot).
		if (!state.creds.alreadyVaultBound) {
			log.info("Step 3c: running first-bind migration (vault not yet bound)")
			val migrationResult = runFirstBindMigration(state, round)
			if (!migrationResult.ok) {
				log.warn("Step 3c failed: migration error=${migrationResult.message}")
				return reportOffline(
					fetched = true, pulled = false, pushed = false,
					code = SyncErrorCode.MIGRATION_FAILED,
					message = migrationResult.message ?: "first-bind migration failed",
				)
			}
		}

		// Step 3d: Auto-reconcile owned dirty paths before pull-rebase.
		log.debug("Step 3d: auto-reconcile dirty paths")
		autoReconcile(state, round.transcripts)

		// Step 4: Pull-rebase (skip if remote has no default branch).
		var pulled = false
		var workingTreeChangedByPull = false
		if (remoteHasDefault) {
			log.debug("Step 4: pull-rebase (remote has default branch)")
			emitPhase(SyncPhase.MERGING)
			val pullAndResolve = pullRebaseAndResolve(state)
			if (pullAndResolve == null) {
				return reportOffline(
					fetched = true, pulled = false, pushed = false,
					code = SyncErrorCode.NETWORK,
					message = "vault-write.lock busy (QueueWorker active)",
				)
			}
			pulled = true
			if (pullAndResolve.unresolved.isNotEmpty()) {
				return report(SyncState.CONFLICTS, SyncRoundResult(
					fetched = true, pulled = true, pushed = false,
					conflicts = pullAndResolve.unresolved, newState = SyncState.CONFLICTS,
				))
			}
			workingTreeChangedByPull = pullAndResolve.fastForwarded || pullAndResolve.conflictsResolved
			log.info("Step 4 ok: pulled=true fastForwarded=${pullAndResolve.fastForwarded} conflictsResolved=${pullAndResolve.conflictsResolved}")
		} else {
			log.debug("Step 4: skipped (remote has no default branch)")
		}

		// Step 4b: Repo mapping — resolve vault folder via .jolli/repos.json.
		val effectiveCtx = try {
			val mapping = loadRepoMapping(ctx.memoryBankRoot)
			val conflicts = findRepoMappingConflicts(mapping)
			if (conflicts.isNotEmpty()) {
				for (c in conflicts) {
					log.warn("repos.json folder collision: ${c.folder} claimed by ${c.identities.size} identities (${c.identities.joinToString(", ")})")
				}
			}
			val resolved = resolveOrAssignFolder(mapping, ctx.repoIdentity, ctx.repoFolderName)
			if (resolved.updatedMapping != null) {
				saveRepoMapping(ctx.memoryBankRoot, resolved.updatedMapping)
			}
			if (resolved.folder != ctx.repoFolderName) {
				ctx.copy(repoFolderName = resolved.folder)
			} else ctx
		} catch (_: Exception) { ctx }

		// Step 5: Idle short-circuit.
		if (isIdle(state, remoteHasDefault, workingTreeChangedByPull, round.transcripts)) {
			log.info("Step 5: idle — nothing to push, already synced")
			return report(SyncState.SYNCED, SyncRoundResult(
				fetched = true, pulled = pulled, pushed = false,
				newState = SyncState.SYNCED,
			))
		}

		// Step 6: Stage vault.
		log.debug("Step 6: staging vault files")
		val stageReport = stageVault(
			state.client, ctx.memoryBankRoot,
			StageVaultOpts(syncTranscripts = round.transcripts),
		)
		val canary = if (stageReport.symlinked.isNotEmpty() || stageReport.unowned.isNotEmpty()) {
			CanaryReport(symlinked = stageReport.symlinked, unowned = stageReport.unowned)
		} else null

		// Step 7: Commit.
		log.debug("Step 7: committing staged changes")
		val commitMessage = "[jolli-mb] add: memory bank changes"
		state.client.commit(commitMessage, ctx.author)

		// Step 8: Push with retry.
		log.debug("Step 8: pushing to remote")
		emitPhase(SyncPhase.UPLOADING)
		val pushResult = pushWithRetry(state, lockHolder)
		if (pushResult !is PushStepResult.Ok) {
			val failed = pushResult as PushStepResult.Failed
			log.warn("Step 8 failed: push code=${failed.code} message=${failed.message}")
			return reportOffline(
				fetched = true, pulled = pulled, pushed = false,
				code = failed.code, message = failed.message, canary = canary,
			)
		}

		log.info("Step 8 ok: push complete transmitted=${pushResult.transmitted}")

		// Step 9: Notify push (fire-and-forget).
		if (pushResult.transmitted) {
			try {
				val pushedHead = state.client.currentHead()
				opts.backend.notifyPush(pushedHead, state.creds.defaultBranch, state.creds.lockOwnerToken)
				clearPersistedLock()
				lockHolder.releaseInFinally = false
			} catch (_: Exception) {}
		}

		log.info("runRound end state=SYNCED pushed=true pulled=$pulled")
		return report(SyncState.SYNCED, SyncRoundResult(
			fetched = true, pulled = pulled, pushed = true,
			newState = SyncState.SYNCED, canary = canary,
		))
	}

	// ── Credential minting ──────────────────────────────────────────

	private sealed class MintResult {
		data class Ok(val creds: GitCredentials) : MintResult()
		data class Failed(val code: SyncErrorCode, val message: String, val selfLocked: Boolean? = null) : MintResult()
	}

	private fun mintFresh(lockHolder: RoundLockHolder): MintResult {
		val schedule = opts.vaultLockedRetrySchedule
		val totalAttempts = schedule.size + 1

		// Capture self-lock state once at loop entry.
		val selfLocked = isSelfLocked()

		var lastMessage = ""
		for (attempt in 1..totalAttempts) {
			try {
				val creds = opts.backend.mintGitCredentials()
				lockHolder.token = creds.lockOwnerToken
				lockHolder.releaseInFinally = true
				persistMintedLock(creds)
				return MintResult.Ok(creds)
			} catch (e: VaultLockedError) {
				lastMessage = e.message ?: "vault locked"
				log.info("Mint attempt $attempt/$totalAttempts: vault locked, selfLocked=$selfLocked")
				if (attempt < totalAttempts) {
					val delayMs = schedule[attempt - 1]
					try {
						opts.onLockedWait?.invoke(VaultLockedWaitInfo(
							attempt = attempt,
							totalAttempts = totalAttempts,
							nextRetryInMs = delayMs,
							message = lastMessage,
							selfLocked = selfLocked,
						))
					} catch (_: Exception) {}
					emitPhase(SyncPhase.WAITING)
					opts.sleepFn(delayMs)
					continue
				}
				return MintResult.Failed(SyncErrorCode.VAULT_LOCKED, lastMessage, selfLocked)
			} catch (e: WebFlushPendingError) {
				lastMessage = e.message ?: "pending flush"
				if (attempt < totalAttempts) {
					val delayMs = maxOf(1000L, e.retryAfterSeconds * 1000L)
					emitPhase(SyncPhase.WAITING)
					opts.sleepFn(delayMs)
					continue
				}
				return MintResult.Failed(SyncErrorCode.NETWORK, lastMessage)
			} catch (e: SyncBackendNetworkError) {
				return MintResult.Failed(SyncErrorCode.NETWORK, e.message ?: "network error")
			} catch (e: SyncBackendUnauthorizedError) {
				return MintResult.Failed(SyncErrorCode.MINT_FAILED, e.message ?: "unauthorized")
			} catch (e: SyncBackendError) {
				return MintResult.Failed(SyncErrorCode.MINT_FAILED, e.message ?: "mint error")
			}
		}
		return MintResult.Failed(SyncErrorCode.MINT_FAILED, "unreachable: mint loop exited ($lastMessage)")
	}

	// ── Re-mint budget ──────────────────────────────────────────────

	private sealed class RemintResult {
		data object Ok : RemintResult()
		data class Failed(val code: SyncErrorCode, val message: String) : RemintResult()
	}

	private fun tryRemint(state: RoundState, cause: String, lockHolder: RoundLockHolder): RemintResult {
		if (state.remintsUsed >= MAX_REMINTS_PER_PHASE) {
			return RemintResult.Failed(
				SyncErrorCode.SYNC_FAILED_AFTER_RETRIES,
				"remint budget exhausted ($cause)",
			)
		}
		val fresh = mintFresh(lockHolder)
		if (fresh !is MintResult.Ok) {
			val failed = fresh as MintResult.Failed
			return RemintResult.Failed(failed.code, failed.message)
		}
		state.creds = fresh.creds
		state.client = opts.makeGitClient.create(fresh.creds, state.ctx.memoryBankRoot)
		state.remintsUsed++
		return RemintResult.Ok
	}

	// ── Fetch / clone ───────────────────────────────────────────────

	private sealed class FetchStepResult {
		data class Ok(val cloned: Boolean) : FetchStepResult()
		data class Failed(val code: SyncErrorCode, val message: String) : FetchStepResult()
	}

	private fun fetchOrCloneWithRetry(state: RoundState, lockHolder: RoundLockHolder): FetchStepResult {
		val maxAttempts = opts.maxPushAttempts
		for (attempt in 1..maxAttempts) {
			try {
				val gitDir = Path.of(state.ctx.memoryBankRoot, ".git")
				val mbDir = Path.of(state.ctx.memoryBankRoot)

				if (Files.isDirectory(gitDir)) {
					// Steady state: verify marker, then fetch.
					val guard = guardVaultIdentity(state)
					if (guard != null) return guard
					state.client.fetch()
					return FetchStepResult.Ok(cloned = false)
				}

				if (Files.isDirectory(mbDir)) {
					// First-bind: dir exists but no .git.
					state.client.initRemote(state.creds.gitUrl)
					state.client.fetch()
					writeVaultMarker(state.ctx.memoryBankRoot, state.creds)
					return FetchStepResult.Ok(cloned = true)
				}

				// Cold start: clone.
				state.client.clone(state.creds.gitUrl)
				writeVaultMarker(state.ctx.memoryBankRoot, state.creds)
				return FetchStepResult.Ok(cloned = true)
			} catch (e: Exception) {
				val msg = e.message ?: ""
				log.warn("Fetch/clone attempt $attempt/${maxAttempts} failed: $msg")
				val cause = classifyGitError(msg)
				if (cause == "unauthorized" || cause == "repoMissing") {
					val remint = tryRemint(state, cause, lockHolder)
					if (remint is RemintResult.Ok) continue
					val failed = remint as RemintResult.Failed
					return FetchStepResult.Failed(failed.code, failed.message)
				}
				if (cause == "network") {
					return FetchStepResult.Failed(SyncErrorCode.NETWORK, msg)
				}
				val code = if (Files.isDirectory(Path.of(state.ctx.memoryBankRoot, ".git")))
					SyncErrorCode.FETCH_FAILED else SyncErrorCode.CLONE_FAILED
				return FetchStepResult.Failed(code, msg)
			}
		}
		return FetchStepResult.Failed(SyncErrorCode.SYNC_FAILED_AFTER_RETRIES, "fetch exhausted $maxAttempts attempts")
	}

	/** Returns a [FetchStepResult.Failed] if the vault identity check fails, null if ok. */
	private fun guardVaultIdentity(state: RoundState): FetchStepResult.Failed? {
		val originUrl = state.client.getOriginUrl()
		val verdict = verifyVaultMarker(state.ctx.memoryBankRoot, originUrl, state.creds)
		return when (verdict) {
			is VaultVerdict.Ok -> {
				if (verdict.needsRewrite) {
					try { writeVaultMarker(state.ctx.memoryBankRoot, state.creds) } catch (_: Exception) {}
				}
				null
			}
			is VaultVerdict.Failed -> {
				// Try backfill if marker is missing but origin matches.
				if (verdict.reason == "missing_marker" && originUrl != null) {
					val normalizedOrigin = normalizeGitUrl(originUrl)
					val normalizedCreds = normalizeGitUrl(state.creds.gitUrl)
					if (normalizedOrigin == normalizedCreds) {
						try { writeVaultMarker(state.ctx.memoryBankRoot, state.creds) } catch (_: Exception) {}
						return null
					}
				}
				FetchStepResult.Failed(SyncErrorCode.VAULT_MISMATCH, verdict.message)
			}
		}
	}

	// ── Branch management ───────────────────────────────────────────

	private sealed class BranchStepResult {
		data object Ok : BranchStepResult()
		data class Failed(val code: SyncErrorCode, val message: String) : BranchStepResult()
	}

	private fun ensureOnDefaultBranch(state: RoundState): BranchStepResult {
		val defaultBranch = state.creds.defaultBranch
		try {
			val currentBranch = state.client.currentBranch()
			if (currentBranch == defaultBranch) {
				log.debug("Already on default branch $defaultBranch")
				return BranchStepResult.Ok
			}
			log.info("On branch $currentBranch, need $defaultBranch — switching")

			val remoteRef = "refs/remotes/origin/$defaultBranch"
			val localRef = "refs/heads/$defaultBranch"
			val hasRemote = state.client.refExists(remoteRef)
			val hasLocal = state.client.refExists(localRef)

			if (!hasLocal && hasRemote) {
				// Check if bootstrap merge is needed (fresh local + populated remote).
				val shouldMerge = shouldRunBootstrapMerge(state.client, defaultBranch)
				if (shouldMerge is ShouldRunResult.Ok) {
					val mergeResult = runBootstrapMerge(
						state.client, state.ctx.memoryBankRoot, defaultBranch, state.ctx.author,
					)
					if (mergeResult.ok) {
						return BranchStepResult.Ok
					}
					// Bootstrap merge failed — fall through to normal checkout.
				}
				// Missing local ref: create from remote.
				state.client.checkoutTrackingBranch(defaultBranch)
				return BranchStepResult.Ok
			}

			if (!hasLocal && !hasRemote) {
				// Empty repo, no refs at all.
				state.client.checkoutBranch(defaultBranch)
				return BranchStepResult.Ok
			}

			if (hasLocal) {
				val headSha = state.client.revParse("HEAD")
				val defaultSha = state.client.revParse(localRef)
				if (headSha != null && defaultSha != null) {
					if (state.client.isAncestor(headSha, defaultSha)) {
						// HEAD ⊆ default: simple checkout.
						state.client.checkoutBranch(defaultBranch)
						return BranchStepResult.Ok
					}
					if (state.client.isAncestor(defaultSha, headSha)) {
						// default ⊆ HEAD: fast-forward default to stranded commits.
						state.client.recreateBranchAt(defaultBranch, "HEAD")
						return BranchStepResult.Ok
					}
				}
				// Divergent: refuse.
				return BranchStepResult.Failed(
					SyncErrorCode.VAULT_MISMATCH,
					"HEAD diverged from $defaultBranch; manual resolution required",
				)
			}

			return BranchStepResult.Ok
		} catch (_: Exception) {
			// Non-fatal: proceed and let pull-rebase surface real errors.
			return BranchStepResult.Ok
		}
	}

	// ── Auto-reconcile ──────────────────────────────────────────────

	private fun autoReconcile(state: RoundState, syncTranscripts: Boolean) {
		try {
			if (hasOwnedDirtyPaths(state, syncTranscripts)) {
				// Quarantine corrupt JSON before staging so truncated files
				// never reach the orphan history.
				val dirty = state.client.listDirtyPaths()
				val corrupt = quarantineCorruptJson(state.ctx.memoryBankRoot, dirty)
				if (corrupt.quarantined > 0) {
					log.warn("Auto-reconcile quarantined ${corrupt.quarantined} corrupt JSON file(s): ${corrupt.paths.joinToString(", ")}")
				}
				stageVault(
					state.client, state.ctx.memoryBankRoot,
					StageVaultOpts(syncTranscripts = syncTranscripts),
				)
				state.client.commit("[jolli-mb] reconcile: user-modified", state.ctx.author)
				log.info("Auto-reconcile: committed dirty owned paths")
			}
		} catch (e: Exception) {
			log.warn("Auto-reconcile failed (non-fatal): ${e.message}")
		}
	}

	// ── Pull-rebase + conflict resolution ────────────────────────────

	private data class PullAndResolveResult(
		val fastForwarded: Boolean,
		val unresolved: List<String>,
		val conflictsResolved: Boolean,
	)

	/**
	 * Runs pull-rebase inside a vault-write.lock. If conflicts occur,
	 * runs conflict resolution while still holding the lock.
	 * Returns null if the lock could not be acquired.
	 */
	private fun pullRebaseAndResolve(state: RoundState): PullAndResolveResult? {
		val handle = VaultWriteLock.acquire(
			state.ctx.memoryBankRoot,
			VaultWriteLockMode.Wait(VaultWriteLock.DEFAULT_PULL_LOCK_WAIT_MS),
		) ?: return null

		return try {
			val pullResult = state.client.pullRebase(state.ctx.author)
			if (pullResult.conflicted.isEmpty()) {
				return PullAndResolveResult(
					fastForwarded = pullResult.fastForwarded,
					unresolved = emptyList(),
					conflictsResolved = false,
				)
			}

			// Conflicts detected — resolve while holding the lock.
			emitPhase(SyncPhase.RESOLVING)
			val resolver = buildResolver(state)
			val resolution = resolver.resolveAll(pullResult.conflicted)
			if (!resolution.rebaseAdvanced) {
				PullAndResolveResult(
					fastForwarded = false,
					unresolved = resolution.skipped,
					conflictsResolved = false,
				)
			} else {
				PullAndResolveResult(
					fastForwarded = pullResult.fastForwarded,
					unresolved = emptyList(),
					conflictsResolved = true,
				)
			}
		} finally {
			handle.release()
		}
	}

	/**
	 * Runs pull-rebase inside a vault-write.lock (no conflict resolution).
	 * Used by push-retry non-FF path where conflicts abort immediately.
	 */
	private fun pullRebaseLocked(state: RoundState): PullResult? {
		val handle = VaultWriteLock.acquire(
			state.ctx.memoryBankRoot,
			VaultWriteLockMode.Wait(VaultWriteLock.DEFAULT_PULL_LOCK_WAIT_MS),
		) ?: return null

		return try {
			state.client.pullRebase(state.ctx.author)
		} finally {
			handle.release()
		}
	}

	private fun buildResolver(state: RoundState): ConflictResolver {
		if (opts.makeResolver != null) {
			return opts.makeResolver.invoke(state.client, state.ctx.author)
		}
		val ui = opts.conflictUi ?: object : ConflictUi {
			override fun promptBinaryPick(path: String, oursOid: String?, theirsOid: String?) = Tier3Pick.MINE
		}
		return ConflictResolver(
			client = state.client,
			ai = opts.aiProvider?.invoke(),
			ui = ui,
			resolveVaultPath = { path -> Path.of(state.ctx.memoryBankRoot, path).toString() },
			policy = opts.conflictPolicy,
			author = state.ctx.author,
		)
	}

	// ── Idle short-circuit ──────────────────────────────────────────

	private fun isIdle(
		state: RoundState,
		remoteHasDefault: Boolean,
		workingTreeChangedByPull: Boolean,
		syncTranscripts: Boolean,
	): Boolean {
		if (!remoteHasDefault) return false
		if (workingTreeChangedByPull) return false

		val remoteRef = "refs/remotes/origin/${state.creds.defaultBranch}"
		val localHead = state.client.revParse("HEAD")
		val remoteHead = state.client.revParse(remoteRef)
		if (localHead == null || remoteHead == null || localHead != remoteHead) return false

		return !hasOwnedDirtyPaths(state, syncTranscripts)
	}

	private fun hasOwnedDirtyPaths(state: RoundState, syncTranscripts: Boolean): Boolean {
		val entries = state.client.statusPorcelainZ()
		if (entries.isEmpty()) return false
		return entries.any { entry ->
			val path = entry.path
			classifyVaultPath(path) != null &&
				isAllowedPath(path, AllowListOpts(syncTranscripts = syncTranscripts))
		}
	}

	// ── Push with retry ─────────────────────────────────────────────

	private sealed class PushStepResult {
		data class Ok(val transmitted: Boolean) : PushStepResult()
		data class Failed(val code: SyncErrorCode, val message: String) : PushStepResult()
	}

	private fun pushWithRetry(state: RoundState, lockHolder: RoundLockHolder): PushStepResult {
		var lastMessage = ""
		for (attempt in 1..opts.maxPushAttempts) {
			log.debug("Push attempt $attempt/${opts.maxPushAttempts}")
			val result = state.client.push()
			when (result) {
				is PushResult.Ok -> {
					return PushStepResult.Ok(transmitted = result.transmitted)
				}
				is PushResult.Failed -> {
					lastMessage = result.message
					log.warn("Push attempt $attempt failed: ${result.message} nonFF=${result.nonFastForward} unauth=${result.unauthorized}")
					if (result.unauthorized || result.repoMissing) {
						val cause = if (result.unauthorized) "unauthorized" else "repoMissing"
						val remint = tryRemint(state, cause, lockHolder)
						if (remint is RemintResult.Ok) continue
						val failed = remint as RemintResult.Failed
						return PushStepResult.Failed(failed.code, failed.message)
					}
					if (result.nonFastForward) {
						try {
							val pull = pullRebaseLocked(state)
							if (pull == null) {
								return PushStepResult.Failed(
									SyncErrorCode.NETWORK,
									"vault-write.lock busy during non-FF retry",
								)
							}
							if (pull.conflicted.isNotEmpty()) {
								safeRebaseAbort(state)
								return PushStepResult.Failed(
									SyncErrorCode.SYNC_FAILED_AFTER_RETRIES,
									"non-FF retry hit conflicts",
								)
							}
							continue
						} catch (e: Exception) {
							safeRebaseAbort(state)
							val msg = e.message ?: ""
							val code = when {
								isServerRejectionMessage(msg) -> SyncErrorCode.PUSH_REJECTED
								isNetworkErrorMessage(msg) -> SyncErrorCode.NETWORK
								else -> SyncErrorCode.SYNC_FAILED_AFTER_RETRIES
							}
							return PushStepResult.Failed(code, msg)
						}
					}
					// Terminal failure.
					val code = when {
						isServerRejectionMessage(result.message) -> SyncErrorCode.PUSH_REJECTED
						isNetworkErrorMessage(result.message) -> SyncErrorCode.NETWORK
						else -> SyncErrorCode.SYNC_FAILED_AFTER_RETRIES
					}
					return PushStepResult.Failed(code, result.message)
				}
			}
		}
		return PushStepResult.Failed(
			SyncErrorCode.SYNC_FAILED_AFTER_RETRIES,
			"push exhausted ${opts.maxPushAttempts} attempts: $lastMessage",
		)
	}

	// ── Self-lock detection ─────────────────────────────────────────

	private fun isSelfLocked(): Boolean {
		val apiKey = opts.backend.getJolliApiKey() ?: return false
		val entry = PendingLockStore.read(apiKey) ?: return false
		val ageMs = System.currentTimeMillis() - entry.mintedAt
		return ageMs < SELF_LOCK_TTL_GRACE_MS
	}

	private fun persistMintedLock(creds: GitCredentials) {
		val apiKey = opts.backend.getJolliApiKey() ?: return
		try { PendingLockStore.write(apiKey, creds.lockOwnerToken) } catch (_: Exception) {}
	}

	private fun clearPersistedLock() {
		try { PendingLockStore.clear() } catch (_: Exception) {}
	}

	// ── Lock release ────────────────────────────────────────────────

	private fun releaseLockHolderIfNeeded(lockHolder: RoundLockHolder) {
		if (lockHolder.token != null && lockHolder.releaseInFinally && !lockHolder.deferredCompletion) {
			try {
				opts.backend.releaseLock(lockHolder.token!!)
				clearPersistedLock()
			} catch (_: Exception) {}
		}
	}

	// ── First-bind migration ────────────────────────────────────────

	private data class MigrationStepResult(val ok: Boolean, val message: String? = null)

	private fun runFirstBindMigration(state: RoundState, round: SyncRoundOptions): MigrationStepResult {
		return try {
			val legacyResponse = opts.backend.getLegacyContent()
			log.debug("First-bind migration: alreadyMigrated=${legacyResponse.alreadyMigrated} docs=${legacyResponse.docs.size}")
			if (!legacyResponse.alreadyMigrated && legacyResponse.docs.isNotEmpty()) {
				log.info("First-bind migration: writing ${legacyResponse.docs.size} legacy docs")
				val migration = LegacyMigration(state.ctx.memoryBankRoot, round.transcripts)
				migration.apply(legacyResponse)
				stageVault(
					state.client, state.ctx.memoryBankRoot,
					StageVaultOpts(syncTranscripts = round.transcripts),
				)
				state.client.commit("[jolli-mb] migrate: legacy db content", state.ctx.author)
				state.client.push()
			}
			// Complete migration (flips backend from db → git backing).
			val headSha = state.client.currentHead()
			opts.backend.completeMigration(headSha, state.creds.lockOwnerToken)
			log.info("First-bind migration: completed successfully")
			MigrationStepResult(ok = true)
		} catch (e: Exception) {
			log.warn("First-bind migration failed: ${e.message} ${e.stackTraceToString()}")
			MigrationStepResult(ok = false, message = "first-bind migration: ${e.message}")
		}
	}

	// ── Rebase safety ───────────────────────────────────────────────

	private fun safeRebaseAbort(state: RoundState) {
		try { state.client.rebaseAbort() } catch (_: Exception) {}
	}

	// ── Reporting ───────────────────────────────────────────────────

	private fun report(newState: SyncState, result: SyncRoundResult): SyncRoundResult {
		try { opts.onStateChange?.invoke(newState, result) } catch (_: Exception) {}
		return result
	}

	private fun reportOffline(
		fetched: Boolean,
		pulled: Boolean,
		pushed: Boolean,
		code: SyncErrorCode,
		message: String,
		selfLocked: Boolean? = null,
		canary: CanaryReport? = null,
	): SyncRoundResult {
		return report(SyncState.OFFLINE, SyncRoundResult(
			fetched = fetched,
			pulled = pulled,
			pushed = pushed,
			newState = SyncState.OFFLINE,
			lastError = SyncRoundError(code = code, message = message, selfLocked = selfLocked),
			canary = canary,
		))
	}

	private fun emitPhase(phase: SyncPhase) {
		try { opts.onPhase?.invoke(phase) } catch (_: Exception) {}
	}
}

// ── Internal mutable state ──────────────────────────────────────────

private class RoundState(
	var creds: GitCredentials,
	var client: SyncGitClient,
	val ctx: RoundContext,
	var remintsUsed: Int = 0,
)

private class RoundLockHolder(
	var token: String? = null,
	var releaseInFinally: Boolean = false,
	var deferredCompletion: Boolean = false,
)
