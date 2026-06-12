package ai.jolli.jollimemory.sync

/** UI-facing sync state persisted between rounds. */
enum class SyncState { SYNCED, SYNCING, CONFLICTS, OFFLINE }

/** Stable error codes. NETWORK is transient; all others are terminal. */
enum class SyncErrorCode {
	NETWORK,
	MINT_FAILED,
	VAULT_LOCKED,
	VAULT_MISMATCH,
	LOCALFOLDER_INVALID,
	PUSH_REJECTED,
	GIT_MISSING,
	CLONE_FAILED,
	FETCH_FAILED,
	PULL_FAILED,
	MIGRATION_FAILED,
	SYNC_FAILED_AFTER_RETRIES;

	val isTransient: Boolean get() = this == NETWORK
}

/** Granular progress phase within a running round. */
enum class SyncPhase { DOWNLOADING, MERGING, RESOLVING, UPLOADING, WAITING }

/** Caller-supplied options for [SyncEngine.runRound]. */
data class SyncRoundOptions(
	val cwd: String,
	val reason: String,
	val transcripts: Boolean,
)

/** Immutable per-round context resolved from [SyncRoundOptions]. */
data class RoundContext(
	val memoryBankRoot: String,
	val repoFolderName: String,
	val repoIdentity: String,
	val author: CommitAuthor,
)

data class SyncRoundError(
	val code: SyncErrorCode,
	val message: String,
	val selfLocked: Boolean? = null,
)

data class CanaryReport(
	val symlinked: List<String>,
	val unowned: List<String>,
)

data class SyncRoundResult(
	val fetched: Boolean,
	val pulled: Boolean,
	val pushed: Boolean,
	val conflicts: List<String> = emptyList(),
	val newState: SyncState,
	val lastError: SyncRoundError? = null,
	val canary: CanaryReport? = null,
)

/** Emitted by [SyncEngine] when a 423 vault_locked retry backoff begins. */
data class VaultLockedWaitInfo(
	val attempt: Int,
	val totalAttempts: Int,
	val nextRetryInMs: Long,
	val message: String,
	val selfLocked: Boolean,
)
