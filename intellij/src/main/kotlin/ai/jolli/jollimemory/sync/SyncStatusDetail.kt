package ai.jolli.jollimemory.sync

import kotlin.math.max
import kotlin.math.min

/** Status bar detail accompanying a [SyncState] update. */
data class SyncStatusDetail(
	val conflictCount: Int? = null,
	val lastError: String? = null,
	val failed: Boolean = false,
	val failedCode: SyncErrorCode? = null,
	val selfLocked: Boolean = false,
)

/** Minimum poll interval: 90 minutes. */
const val MIN_POLL_SEC: Int = 90 * 60

/** Maximum poll interval: 24 hours. */
const val MAX_POLL_SEC: Int = 86_400

/** Default poll interval: 90 minutes. */
const val DEFAULT_POLL_SEC: Int = 90 * 60

/** Default eager-tick threshold: 30 minutes. */
const val DEFAULT_EAGER_TICK_MIN_ELAPSED_MS: Long = 30 * 60_000L

/** Clamp a user-supplied poll interval to [MIN_POLL_SEC]..[MAX_POLL_SEC]. */
fun clampPoll(value: Int?): Int {
	if (value == null || value <= 0) return DEFAULT_POLL_SEC
	return max(MIN_POLL_SEC, min(MAX_POLL_SEC, value))
}

/**
 * Build a [SyncStatusDetail] from a [SyncRoundResult], or null if there is
 * nothing interesting to surface.
 */
fun buildDetail(result: SyncRoundResult): SyncStatusDetail? {
	var conflictCount: Int? = null
	var lastError: String? = null
	var failed = false
	var failedCode: SyncErrorCode? = null
	var selfLocked = false

	if (result.conflicts.isNotEmpty()) {
		conflictCount = result.conflicts.size
	}

	val err = result.lastError
	if (err != null && !err.code.isTransient) {
		lastError = err.message
		failed = true
		failedCode = err.code
	}

	if (err?.selfLocked == true) {
		selfLocked = true
	}

	// Nothing interesting — return null so the status bar can use defaults.
	if (conflictCount == null && lastError == null && !selfLocked) return null

	return SyncStatusDetail(
		conflictCount = conflictCount,
		lastError = lastError,
		failed = failed,
		failedCode = failedCode,
		selfLocked = selfLocked,
	)
}
