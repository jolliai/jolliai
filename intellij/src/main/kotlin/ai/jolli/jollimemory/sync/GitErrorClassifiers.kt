package ai.jolli.jollimemory.sync

/**
 * Error classifiers for git stderr/stdout messages.
 *
 * Port of the three classifier functions from `cli/src/sync/GitClient.ts`.
 * Used by both [SyncGitClient] and the sync engine to route failures to
 * the correct recovery path.
 *
 * Priority order at the engine call site:
 *   `unauthorized` > `repoMissing` > `serverRejection` > `network` > `fatal`
 */

/**
 * True when git's output indicates the remote GitHub repo doesn't exist
 * (deleted, never created, or 404). Engine triggers a re-mint so backend
 * `ensureGithubRepoExists` can recreate it.
 */
fun isRepoMissingMessage(message: String): Boolean {
	val m = message.lowercase()
	if (Regex("remote: repository not found").containsMatchIn(m)) return true
	if (Regex("repository '[^']*' not found").containsMatchIn(m)) return true
	if (Regex("the requested url returned error: 404").containsMatchIn(m)) return true
	if (Regex("fatal: not found").containsMatchIn(m)) return true
	return false
}

private val NETWORK_ERROR_PATTERNS = listOf(
	Regex("gnutls"),
	Regex("\\bhandshake failed\\b"),
	Regex("tls connection.*(terminated|reset|closed|aborted)"),
	Regex("ssl[\\s_]?error"),
	Regex("error: ssl"),
	Regex("could ?n['o]?t resolve host"),
	Regex("failed to connect to"),
	Regex("connection (timed out|refused|reset|closed)"),
	Regex("operation timed out"),
	Regex("network is unreachable"),
	Regex("empty reply from server"),
	Regex("\\bearly eof\\b"),
	Regex("unexpected disconnect while reading sideband packet"),
	Regex("the remote end hung up unexpectedly"),
	Regex("rpc failed"),
	Regex("curl.*(\\(56\\)|\\(28\\)|\\(35\\))"),
)

/**
 * True when git's output indicates a network-layer failure (DNS, TLS,
 * timeout, dropped socket). Engine routes these to a transient "offline"
 * state that self-heals on the next poll tick.
 */
fun isNetworkErrorMessage(message: String): Boolean {
	val m = message.lowercase()
	return NETWORK_ERROR_PATTERNS.any { it.containsMatchIn(m) }
}

private val SERVER_REJECTION_PATTERNS = listOf(
	Regex("^remote: error:", RegexOption.MULTILINE),
	Regex("pre[-\\s]?receive hook declined"),
	Regex("post[-\\s]?receive hook declined"),
	Regex("refusing to update checked out branch"),
	Regex("\\bprotected branch\\b"),
	Regex("\\b(push|file).{0,40}(too large|exceeds.{0,20}limit)\\b"),
	Regex("permission to .* denied"),
)

/**
 * True when the server actively rejected the push (pre-receive hook,
 * protected branch policy, size limit). Must be checked BEFORE
 * [isNetworkErrorMessage] since rejection symptoms overlap with network
 * error patterns (server closing the socket looks like "remote end hung up").
 */
fun isServerRejectionMessage(message: String): Boolean {
	val m = message.lowercase()
	return SERVER_REJECTION_PATTERNS.any { it.containsMatchIn(m) }
}

private val AUTH_ERROR_RE = Regex(
	"authentication failed|invalid username or password|401 unauthorized|requested url returned error: 401",
)

/**
 * Classifies a git stderr/stdout error into a recovery category.
 *
 * Priority: `unauthorized` > `repoMissing` > `network` > `fatal`.
 * Used by [SyncEngine] to decide whether to re-mint credentials,
 * report transient offline, or surface a terminal error.
 */
fun classifyGitError(message: String): String {
	val m = message.lowercase()
	if (AUTH_ERROR_RE.containsMatchIn(m)) return "unauthorized"
	if (isRepoMissingMessage(message)) return "repoMissing"
	if (isNetworkErrorMessage(message)) return "network"
	return "fatal"
}
