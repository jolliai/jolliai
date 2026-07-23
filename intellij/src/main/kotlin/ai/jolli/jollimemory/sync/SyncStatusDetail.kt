package ai.jolli.jollimemory.sync

/**
 * Status-bar detail accompanying a [SyncState] update, forwarded from the
 * CLI-owned sync round through `CliSyncOrchestrator.onStateChange`.
 */
data class SyncStatusDetail(
	val conflictCount: Int? = null,
	val lastError: String? = null,
	val failed: Boolean = false,
	val failedCode: SyncErrorCode? = null,
	val selfLocked: Boolean = false,
)

/**
 * How long a finished sync-status badge stays on the status bar / toolbar
 * before it auto-reverts to the neutral resting state. Keeps a stale badge —
 * especially a failure — from lingering until the next round (up to 90 min
 * away, or never once polling stops).
 */
const val STATUS_AUTO_CLEAR_DELAY_MS: Long = 3_000L

/**
 * Whether a [SyncState] should auto-dismiss to neutral after
 * [STATUS_AUTO_CLEAR_DELAY_MS]. SYNCING is an in-progress indicator that its
 * own result replaces, so it is never auto-cleared; every finished state
 * (SYNCED / CONFLICTS / OFFLINE, including failures) is.
 */
fun autoClearableSyncState(state: SyncState): Boolean = state != SyncState.SYNCING
