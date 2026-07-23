package ai.jolli.jollimemory.sync

/** UI-facing sync state persisted between rounds. */
enum class SyncState { SYNCED, SYNCING, CONFLICTS, OFFLINE }

/**
 * Stable terminal-error codes surfaced by the CLI's `jolli ide-bridge sync`
 * response. The IntelliJ status bar / KB toolbar map these to a user-visible
 * failure banner. `NETWORK` is treated as transient by the CLI; the rest are
 * terminal and stick until the next successful round.
 */
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
}
