package ai.jolli.jollimemory.core

/**
 * TranscriptMessageCounter — Kotlin port of TranscriptMessageCounter.ts
 *
 * Two-stage pipeline: load transcript via per-source reader, then apply
 * the per-session overlay so user deletes/edits affect the count exactly
 * like the panel does.
 */
object TranscriptMessageCounter {

	private val log = JmLogger.create("TranscriptMessageCounter")

	/**
	 * Loads the full transcript, applies the session overlay, and returns the
	 * merged entry list. Single source of truth for the (load -> overlay) pipeline.
	 */
	fun loadMergedTranscript(
		session: SessionInfo,
		projectDir: String? = null,
	): List<TranscriptEntry> {
		val source = session.source ?: TranscriptSource.claude
		val entries = loadTranscriptEntries(source, session.transcriptPath)
		val overlay = if (projectDir != null) {
			ConversationOverlayStore.loadOverlay(
				ConversationOverlayStore.OverlayKey(projectDir, source, session.sessionId),
			)
		} else null
		return ConversationOverlayStore.applyOverlay(entries, overlay)
	}

	/**
	 * Loads only the unread portion of a transcript (cursor -> EOF), applies
	 * the overlay. Used by the active-conversations list so sessions already
	 * consumed into a commit summary disappear until new turns arrive.
	 */
	fun loadUnreadMergedTranscript(
		session: SessionInfo,
		projectDir: String? = null,
	): List<TranscriptEntry> {
		if (projectDir == null) return loadMergedTranscript(session)

		val source = session.source ?: TranscriptSource.claude
		val cursor = SessionTracker.loadCursorForTranscript(session.transcriptPath, projectDir)
		val entries = readUnreadTranscript(source, session.transcriptPath, cursor)
		val overlay = ConversationOverlayStore.loadOverlay(
			ConversationOverlayStore.OverlayKey(projectDir, source, session.sessionId),
		)
		return ConversationOverlayStore.applyOverlay(entries, overlay)
	}

	/**
	 * Counts messages in the merged transcript. Returns 0 on any failure.
	 */
	fun countTranscriptMessages(session: SessionInfo, projectDir: String? = null): Int = try {
		loadMergedTranscript(session, projectDir).size
	} catch (e: Exception) {
		log.warn("countTranscriptMessages failed for %s/%s: %s", session.source, session.sessionId, e.message)
		0
	}

	/**
	 * Loads the cursor-trimmed raw entries without overlay. Used by the detail
	 * panel to get both the displayed view and a stable identity-aligned rawByIndex.
	 */
	fun loadUnreadTranscript(
		source: TranscriptSource,
		transcriptPath: String,
		projectDir: String? = null,
	): List<TranscriptEntry> {
		if (projectDir == null) return loadTranscriptEntries(source, transcriptPath)
		return try {
			val cursor = SessionTracker.loadCursorForTranscript(transcriptPath, projectDir)
			readUnreadTranscript(source, transcriptPath, cursor)
		} catch (e: Exception) {
			log.warn("loadUnreadTranscript failed for %s/%s: %s", source, transcriptPath, e.message)
			emptyList()
		}
	}

	// ── Internal dispatch ───────────────────────────────────────────────────

	private fun loadTranscriptEntries(source: TranscriptSource, transcriptPath: String): List<TranscriptEntry> =
		when (source) {
			TranscriptSource.gemini -> GeminiSupport.readGeminiTranscript(transcriptPath)
			TranscriptSource.opencode -> OpenCodeSupport.readTranscript(transcriptPath, null).entries
			TranscriptSource.cursor -> CursorSupport.readTranscript(transcriptPath, null).entries
			TranscriptSource.copilot -> CopilotSupport.readTranscript(transcriptPath, null).entries
			TranscriptSource.`copilot-chat` -> CopilotChatSupport.readTranscript(transcriptPath, null).entries
			TranscriptSource.codex -> TranscriptReader.readTranscript(
				transcriptPath, null, getParserForSource(TranscriptSource.codex),
			).entries
			else -> TranscriptReader.readTranscript(transcriptPath).entries
		}

	private fun readUnreadTranscript(
		source: TranscriptSource,
		transcriptPath: String,
		cursor: TranscriptCursor?,
	): List<TranscriptEntry> = when (source) {
		TranscriptSource.gemini -> GeminiSupport.readGeminiTranscript(transcriptPath)
		TranscriptSource.opencode -> OpenCodeSupport.readTranscript(transcriptPath, cursor).entries
		TranscriptSource.cursor -> CursorSupport.readTranscript(transcriptPath, cursor).entries
		TranscriptSource.copilot -> CopilotSupport.readTranscript(transcriptPath, cursor).entries
		TranscriptSource.`copilot-chat` -> CopilotChatSupport.readTranscript(transcriptPath, cursor).entries
		TranscriptSource.codex -> TranscriptReader.readTranscript(
			transcriptPath, cursor, getParserForSource(TranscriptSource.codex),
		).entries
		else -> TranscriptReader.readTranscript(transcriptPath, cursor).entries
	}
}
