package ai.jolli.jollimemory.sync

import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.KBPathResolver
import ai.jolli.jollimemory.core.SessionTracker

/**
 * DI helper that assembles a fully-wired [SyncEngine] from the user's
 * config + cwd, or returns `null` when sync is dormant (no auth token).
 *
 * Port of `cli/src/sync/SyncBootstrap.ts`.
 */

private val log = JmLogger.create("SyncBootstrap")

/**
 * Returns a configured [SyncEngine] or `null` when prerequisites are missing.
 */
fun buildSyncEngine(cwd: String): SyncEngine? {
	val config = SessionTracker.loadConfig(cwd)
	if (config.jolliApiKey.isNullOrBlank()) {
		log.debug("jolliApiKey missing — engine dormant (user must sign in)")
		return null
	}

	log.info("buildSyncEngine: API key present, building engine for cwd=$cwd")

	val backend = SyncBackendClient(
		baseUrlOverride = System.getProperty("jolli.sync.baseUrl"),
		jolliApiKeyProvider = { SessionTracker.loadConfig(cwd).jolliApiKey },
	)

	// Re-read config per round so localFolder/syncTranscripts changes
	// take effect without restart.
	val resolveContext: (SyncRoundOptions) -> RoundContext = { round ->
		val fresh = SessionTracker.loadConfig(cwd)
		defaultResolveContext(round, fresh.localFolder)
	}

	val makeGitClient = GitClientFactory { creds, memoryBankRoot ->
		SyncGitClient(
			vaultRoot = memoryBankRoot,
			credentials = creds,
		)
	}

	log.info("buildSyncEngine: engine assembled successfully")
	return SyncEngine(SyncEngineOpts(
		backend = backend,
		resolveContext = resolveContext,
		makeGitClient = makeGitClient,
	))
}

/**
 * Default context resolver. `memoryBankRoot` is the parent folder
 * (e.g. `~/Documents/jolli/`); `repoFolderName` is the specific repo
 * subdirectory basename.
 */
internal fun defaultResolveContext(
	round: SyncRoundOptions,
	localFolder: String?,
): RoundContext {
	val repoName = KBPathResolver.extractRepoName(round.cwd)
	val remoteUrl = KBPathResolver.getRemoteUrl(round.cwd)
	val repoPath = KBPathResolver.resolve(repoName, remoteUrl, localFolder)
	val memoryBankRoot = repoPath.parent.toString()
	val repoFolderName = repoPath.fileName.toString()
	val identity = computeRepoIdentity(round.cwd)
	log.debug("resolveContext: repo=$repoName folder=$repoFolderName root=$memoryBankRoot identity=$identity")
	return RoundContext(
		memoryBankRoot = memoryBankRoot,
		repoFolderName = repoFolderName,
		repoIdentity = identity,
		author = CommitAuthor(name = "Jolli Memory", email = "memory@jolli.ai"),
	)
}

/**
 * Computes a stable repo identity from the working tree path.
 * Uses normalized git remote URL, or directory basename as fallback.
 *
 * Port of `cli/src/sync/RepoIdentity.ts:computeRepoIdentity`.
 */
fun computeRepoIdentity(projectPath: String): String {
	val remote = KBPathResolver.getRemoteUrl(projectPath)
	return if (remote != null) normalizeGitUrl(remote) else java.io.File(projectPath).name
}


/**
 * Default vault subdirectory name — slug derived from repo name.
 *
 * Port of `cli/src/sync/RepoIdentity.ts:computeRepoFolderName`.
 */
fun defaultRepoFolderName(cwd: String): String {
	val name = KBPathResolver.extractRepoName(cwd)
	return slugify(name)
}

internal fun slugify(name: String): String {
	val cleaned = java.text.Normalizer.normalize(name, java.text.Normalizer.Form.NFKD)
		.lowercase()
		.replace(Regex("[\\u0300-\\u036f]"), "")
		.replace(Regex("[^a-z0-9-]+"), "-")
		.replace(Regex("-+"), "-")
		.replace(Regex("^-|-$"), "")
	return cleaned.ifEmpty { "repo" }
}
