package ai.jolli.jollimemory.core

import java.time.Instant

/**
 * ActiveSessionAggregator — Kotlin port of ActiveSessionAggregator.ts
 *
 * Aggregates active AI coding sessions across all supported sources,
 * filters by recency window, resolves display titles, and returns a
 * sorted list ready for UI consumption.
 *
 * - Sessions older than `windowMs` (default 48h) are excluded.
 * - Sources fan out independently — one failed source never blocks the others.
 *   The set of sources that did fail is returned alongside `items` so callers
 *   can surface a "partial result" indicator.
 * - Sort: updatedAt DESC, tie-break by sessionId ASC (stable order).
 */
object ActiveSessionAggregator {

	private val log = JmLogger.create("ActiveSessionAggregator")

	private const val DEFAULT_WINDOW_MS = 2L * 24 * 60 * 60 * 1000 // 48 hours

	fun listActiveConversations(
		cwd: String,
		windowMs: Long = DEFAULT_WINDOW_MS,
	): List<ActiveConversationItem> =
		listActiveConversationsWithDiagnostics(cwd, windowMs).items

	fun listActiveConversationsWithDiagnostics(
		cwd: String,
		windowMs: Long = DEFAULT_WINDOW_MS,
	): ActiveConversationsResult {
		val cutoff = System.currentTimeMillis() - windowMs

		val collected = collectFromAllSources(cwd)
		val hidden = HiddenConversationsStore.loadHiddenConversations(cwd)

		// Filter by recency
		val fresh = collected.sessions.filter { s ->
			try {
				Instant.parse(s.updatedAt).toEpochMilli() >= cutoff
			} catch (_: Exception) {
				false
			}
		}

		// Deduplicate by (source, sessionId), keeping most recent
		val bySourceAndId = mutableMapOf<String, SessionInfo>()
		for (s in fresh) {
			val key = "${(s.source ?: TranscriptSource.claude).name}:${s.sessionId}"
			val existing = bySourceAndId[key]
			if (existing == null || s.updatedAt > existing.updatedAt) {
				bySourceAndId[key] = s
			}
		}

		// Filter hidden sessions
		val visible = bySourceAndId.values.filter { s ->
			!HiddenConversationsStore.isStillHidden(
				hidden,
				s.source ?: TranscriptSource.claude,
				s.sessionId,
				s.updatedAt,
			)
		}

		// Load branch tags and BP summaries registries
		val branchTagsRegistry = try { BranchTagsStore.loadRegistry(cwd) } catch (_: Exception) { BranchTagsRegistry() }
		val bpSummaryRegistry = try { BPSummaryStore.loadRegistry(cwd) } catch (_: Exception) { BPSummaryRegistry() }

		// Load transcripts, resolve titles, build items
		val items = visible.mapNotNull { s ->
			val unread = safeLoadUnreadMerged(s, cwd)
			if (unread.isEmpty()) return@mapNotNull null

			val titleEntries = safeLoadMerged(s, cwd)
			val source = s.source ?: TranscriptSource.claude
			val key = BranchTagsStore.tagKey(source, s.sessionId)
			val bpKey = BPSummaryStore.bpKey(source.name, s.sessionId)

			ActiveConversationItem(
				sessionId = s.sessionId,
				source = source,
				title = SessionTitleResolver.resolveSessionTitle(s, titleEntries),
				messageCount = unread.size,
				updatedAt = s.updatedAt,
				transcriptPath = s.transcriptPath,
				branchTags = branchTagsRegistry.entries[key]?.branches ?: emptyList(),
				bpSummary = bpSummaryRegistry.entries[bpKey]?.bullets ?: emptyList(),
			)
		}

		val sorted = items.sortedWith(
			compareByDescending<ActiveConversationItem> { it.updatedAt }
				.thenBy { it.sessionId },
		)

		return ActiveConversationsResult(sorted, collected.failedSources)
	}

	// ── Safe wrappers ───────────────────────────────────────────────────────

	private fun safeLoadMerged(s: SessionInfo, projectDir: String): List<TranscriptEntry> = try {
		TranscriptMessageCounter.loadMergedTranscript(s, projectDir)
	} catch (e: Exception) {
		log.warn(
			"loadMergedTranscript failed for %s/%s (transcript=%s): %s",
			s.source ?: "claude", s.sessionId, s.transcriptPath, e.message,
		)
		emptyList()
	}

	private fun safeLoadUnreadMerged(s: SessionInfo, projectDir: String): List<TranscriptEntry> = try {
		TranscriptMessageCounter.loadUnreadMergedTranscript(s, projectDir)
	} catch (e: Exception) {
		log.warn(
			"loadUnreadMergedTranscript failed for %s/%s (transcript=%s): %s",
			s.source ?: "claude", s.sessionId, s.transcriptPath, e.message,
		)
		emptyList()
	}

	// ── Source collection ───────────────────────────────────────────────────

	private data class CollectResult(
		val sessions: List<SessionInfo>,
		val failedSources: List<TranscriptSource>,
	)

	private data class LoaderResult(
		val sessions: List<SessionInfo>,
		val failed: List<TranscriptSource>,
	)

	private fun collectFromAllSources(cwd: String): CollectResult {
		val batches = listOf(
			loadClaudeAndGemini(cwd),
			loadCodex(cwd),
			loadOpenCode(cwd),
			loadCursor(cwd),
			// TODO: plug in when Copilot branches land.
			// loadCopilot(cwd),
			// loadCopilotChat(cwd),
		)
		val sessions = batches.flatMap { it.sessions }
		val failedSources = batches.flatMap { it.failed }
		return CollectResult(sessions, failedSources)
	}

	private fun loadClaudeAndGemini(cwd: String): LoaderResult = try {
		LoaderResult(SessionTracker.loadAllSessions(cwd), emptyList())
	} catch (e: Exception) {
		log.warn("loadAllSessions (claude+gemini) failed: %s", e.message)
		LoaderResult(emptyList(), listOf(TranscriptSource.claude, TranscriptSource.gemini))
	}

	private fun loadCodex(cwd: String): LoaderResult = try {
		LoaderResult(CodexSessionDiscoverer.discoverSessions(), emptyList())
	} catch (e: Exception) {
		log.warn("discoverCodexSessions threw: %s", e.message)
		LoaderResult(emptyList(), listOf(TranscriptSource.codex))
	}

	private fun loadOpenCode(cwd: String): LoaderResult = try {
		val scan = OpenCodeSupport.discoverSessions(cwd)
		LoaderResult(scan.sessions, if (scan.error != null) listOf(TranscriptSource.opencode) else emptyList())
	} catch (e: Exception) {
		log.warn("scanOpenCodeSessions threw: %s", e.message)
		LoaderResult(emptyList(), listOf(TranscriptSource.opencode))
	}

	private fun loadCursor(cwd: String): LoaderResult = try {
		val scan = CursorSupport.discoverSessions(cwd)
		LoaderResult(scan.sessions, if (scan.error != null) listOf(TranscriptSource.cursor) else emptyList())
	} catch (e: Exception) {
		log.warn("scanCursorSessions threw: %s", e.message)
		LoaderResult(emptyList(), listOf(TranscriptSource.cursor))
	}
	//
	// private fun loadCopilot(cwd: String): LoaderResult = try {
	//     val r = CopilotSupport.discoverSessions(cwd)
	//     LoaderResult(r, emptyList())
	// } catch (e: Exception) {
	//     log.warn("scanCopilotSessions threw: %s", e.message)
	//     LoaderResult(emptyList(), listOf(TranscriptSource.copilot))
	// }
	//
	// private fun loadCopilotChat(cwd: String): LoaderResult = try {
	//     val r = CopilotChatSupport.discoverSessions(cwd)
	//     LoaderResult(r, emptyList())
	// } catch (e: Exception) {
	//     log.warn("scanCopilotChatSessions threw: %s", e.message)
	//     LoaderResult(emptyList(), listOf(TranscriptSource.`copilot-chat`))
	// }
}
