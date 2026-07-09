package ai.jolli.jollimemory.core.references

import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.TranscriptSource

/**
 * TranscriptReferenceDiscovery — Kotlin port of TranscriptReferenceDiscovery.ts
 *
 * `scanReferencesFrom` is a pure scan + upsert: runs
 * `ReferenceExtractor.extractFromTranscript`, then routes each discovered ref
 * through `upsertReferenceEntry`. Does NOT own the discovery cursor.
 */
object TranscriptReferenceDiscovery {

	private val log = JmLogger.create("ReferenceDiscovery")

	private val allAdapters = listOf(LinearAdapter, JiraAdapter, GitHubAdapter, NotionAdapter, SlackAdapter)

	/**
	 * Scans the transcript for all adapters applicable to `source` from `fromLine`
	 * and persists discovered references. Returns the furthest line scanned.
	 */
	fun scanReferencesFrom(
		transcriptPath: String,
		fromLine: Int,
		cwd: String,
		source: TranscriptSource,
	): Int {
		val extractSource = when (source) {
			TranscriptSource.codex -> ai.jolli.jollimemory.core.TranscriptSource.codex
			else -> ai.jolli.jollimemory.core.TranscriptSource.claude
		}
		// Slack thread references need the configured workspace URL to reconstruct a
		// permalink when none was pasted into the transcript. Read once per scan.
		val slackWorkspaceUrl = try {
			SessionTracker.loadConfig(cwd).slack?.workspaceUrl
		} catch (_: Exception) {
			null
		}
		val opts = ExtractOptions(
			fromLineNumber = fromLine,
			source = extractSource,
			slackWorkspaceUrl = slackWorkspaceUrl,
		)
		log.debug("scanReferencesFrom: extracting from %s (fromLine=%d, source=%s)", transcriptPath, fromLine, source)
		val result = ReferenceExtractor.extractFromTranscript(transcriptPath, allAdapters, opts)
		log.debug("scanReferencesFrom: extractor returned %d ref(s), lastLine=%d", result.references.size, result.lastLineNumberScanned)

		if (result.references.isEmpty()) {
			return result.lastLineNumberScanned
		}

		// Stamp the branch on newly-created rows so the panel can branch-scope.
		// Omit on an "unknown" git lookup (a transient rev-parse failure) so the row
		// stays branch-less — writing the literal "unknown" would silently exclude
		// the reference from every branch's summary prompt. Mirrors the plan path.
		val discoveredBranch = getCurrentBranchSafe(cwd)
		val branchField: String? = if (discoveredBranch.isNotEmpty() && discoveredBranch != "unknown") discoveredBranch else null
		log.debug("scanReferencesFrom: branch=%s, upserting %d ref(s)", branchField ?: "(none)", result.references.size)
		val upserted = mutableListOf<String>()
		val failed = mutableListOf<String>()
		for (ref in result.references) {
			try {
				upsertReferenceEntry(ref, cwd, branchField)
				upserted.add(ref.mapKey)
			} catch (err: Exception) {
				log.warn(
					"Reference discovery: failed to persist %s: %s — continuing with rest of batch",
					ref.mapKey, err.message,
				)
				failed.add(ref.mapKey)
			}
		}
		log.info(
			"Reference discovery: upserted %d of %d ref(s)%s",
			upserted.size, result.references.size,
			if (failed.isNotEmpty()) " (failed: [${failed.joinToString(", ")}])" else "",
		)

		return result.lastLineNumberScanned
	}

	/**
	 * Current git branch (synchronous, never throws). Returns "unknown" on failure.
	 */
	fun getCurrentBranchSafe(cwd: String): String {
		return try {
			val process = ProcessBuilder("git", "rev-parse", "--abbrev-ref", "HEAD")
				.directory(java.io.File(cwd))
				.redirectError(ProcessBuilder.Redirect.DISCARD)
				.start()
			val output = process.inputStream.bufferedReader().readText().trim()
			process.waitFor()
			if (process.exitValue() == 0 && output.isNotEmpty()) output else "unknown"
		} catch (_: Exception) {
			"unknown"
		}
	}

	/**
	 * Upsert a reference entry: write markdown + update plans.json.references.
	 */
	private fun upsertReferenceEntry(ref: Reference, cwd: String, branch: String?) {
		log.debug("upsertReferenceEntry: writing markdown for %s (title=%s)", ref.mapKey, ref.title)
		val result = ReferenceStore.writeReferenceMarkdown(ref, cwd)
		log.debug("upsertReferenceEntry: markdown written to %s", result.sourcePath)
		val mapKey = ref.mapKey
		val now = java.time.Instant.now().toString()

		// Load → merge → save under lock. Only release the lock if we actually hold
		// it — releaseLock is an unconditional file delete, so releasing a lock we
		// never acquired would wipe the holder's lock (the PostCommitHook worker or a
		// parallel StopHook) and let a second writer interleave plans.json writes.
		val locked = SessionTracker.acquireLock(cwd)
		if (!locked) {
			log.warn("upsertReferenceEntry: could not acquire lock for %s — writing without lock", mapKey)
		}
		try {
			val registry = SessionTracker.loadPlansRegistry(cwd)
			val existing = registry.references?.get(mapKey)

			val next = if (existing != null) {
				existing.copy(
					title = ref.title,
					url = ref.url,
					sourcePath = result.sourcePath,
					sourceToolName = ref.toolName,
					updatedAt = now,
					// Re-stamp the branch only on a known git lookup: a reference
					// re-surfaced on a new branch follows it (matches plan/note
					// upsert). On an "unknown" lookup keep the existing branch rather
					// than clobber a real value with a summary-excluding sentinel.
					branch = branch ?: existing.branch,
				)
			} else {
				ReferenceEntry(
					source = ref.source,
					nativeId = ref.nativeId,
					title = ref.title,
					url = ref.url,
					sourcePath = result.sourcePath,
					addedAt = now,
					updatedAt = now,
					sourceToolName = ref.toolName,
					branch = branch,
				)
			}

			val freshRegistry = SessionTracker.loadPlansRegistry(cwd)
			val freshRefs = (freshRegistry.references ?: emptyMap()).toMutableMap()
			freshRefs[mapKey] = next
			val updated = freshRegistry.copy(references = freshRefs)
			SessionTracker.savePlansRegistry(updated, cwd)
			log.debug("upsertReferenceEntry: saved plans.json with %d reference(s)", freshRefs.size)
			log.info("upsertReferenceEntry: %s (%s)", mapKey, if (existing == null) "new" else "updated")
		} finally {
			if (locked) SessionTracker.releaseLock(cwd)
		}
	}
}
