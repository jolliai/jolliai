package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.CliIntegrations
import com.google.gson.Gson
import java.io.File

/** Thin JVM adapter for CLI-owned transcript parsing and cursor handling. */
object TranscriptMessageCounter {

	private val gson = Gson()

	private data class EntriesResult(val entries: List<TranscriptEntry>)

	fun loadUnreadTranscript(
		source: TranscriptSource,
		transcriptPath: String,
		projectDir: String? = null,
	): List<TranscriptEntry> = load(
		action = "unread-transcript",
		source = source,
		transcriptPath = transcriptPath,
		projectDir = projectDir,
	)

	fun loadTranscript(
		source: TranscriptSource,
		transcriptPath: String,
		projectDir: String? = null,
	): List<TranscriptEntry> = load(
		action = "transcript",
		source = source,
		transcriptPath = transcriptPath,
		projectDir = projectDir,
	)

	private fun load(
		action: String,
		source: TranscriptSource,
		transcriptPath: String,
		projectDir: String?,
	): List<TranscriptEntry> {
		val cwd = projectDir ?: File(transcriptPath).parentFile?.absolutePath ?: "."
		val request = gson.toJson(
			mapOf(
				"source" to source.name,
				"transcriptPath" to transcriptPath,
			),
		)
		val result = CliIntegrations.runIdeBridge(cwd, action, request)
		return gson.fromJson(result, EntriesResult::class.java).entries
	}
}
