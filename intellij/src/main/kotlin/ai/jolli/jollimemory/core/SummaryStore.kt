package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.CliIntegrations
import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.core.references.SourceId
import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.reflect.TypeToken

/**
 * Thin JVM DTO adapter for the CLI-owned summary/storage implementation.
 *
 * The constructor keeps its historical [GitOps]/[StorageProvider] parameters so
 * existing IDE composition code does not need a second storage abstraction. No
 * index, alias, path, tree, or write policy is implemented on the JVM.
 */
class SummaryStore(
	private val cwd: String,
	@Suppress("UNUSED_PARAMETER") git: GitOps,
	@Suppress("UNUSED_PARAMETER") storage: StorageProvider,
) {
	constructor(cwd: String, git: GitOps) : this(cwd, git, StorageFactory.create(git, cwd))

	private val gson = Gson()

	companion object {
		const val ORPHAN_BRANCH = JmLogger.ORPHAN_BRANCH
	}

	fun loadIndex(): SummaryIndex? = decode(run("index"), SummaryIndex::class.java)

	fun getSummary(commitHash: String): CommitSummary? =
		decode(run("get") { addProperty("commitHash", commitHash) }, CommitSummary::class.java)

	fun listSummaries(count: Int = 10): List<CommitSummary> {
		val result = run("list") { addProperty("count", count) }
		if (result.isJsonNull) return emptyList()
		return gson.fromJson(result, object : TypeToken<List<CommitSummary>>() {}.type)
	}

	fun getSummaryCount(): Int = run("count").asJsonObject.get("count")?.asInt ?: 0

	fun findRootHash(commitHash: String): String? =
		stringResult(run("find-root") { addProperty("commitHash", commitHash) }, "hash")

	fun filterCommitsWithSummary(hashes: List<String>): Set<String> {
		val result = run("filter-hashes") { add("hashes", gson.toJsonTree(hashes)) }
		return result.asJsonObject.getAsJsonArray("hashes")?.mapTo(linkedSetOf()) { it.asString } ?: emptySet()
	}

	fun scanTreeHashAliases(unmatchedHashes: List<String>): Boolean =
		run("scan-aliases") { add("hashes", gson.toJsonTree(unmatchedHashes)) }
			.asJsonObject.get("changed")?.asBoolean == true

	fun resolveAlias(hash: String): String =
		stringResult(run("resolve-alias") { addProperty("commitHash", hash) }, "hash") ?: hash

	fun storeSummary(
		summary: CommitSummary,
		force: Boolean = false,
		transcript: StoredTranscript? = null,
		planProgress: List<PlanProgressArtifact>? = null,
		referenceFiles: List<FileWrite>? = null,
	) {
		run("store-summary") {
			add("summary", gson.toJsonTree(summary))
			addProperty("force", force)
			transcript?.let { add("transcript", gson.toJsonTree(it)) }
			planProgress?.let { add("planProgress", gson.toJsonTree(it)) }
			referenceFiles?.let { add("referenceFiles", gson.toJsonTree(it)) }
		}
	}

	fun readPlanProgress(slug: String): PlanProgressArtifact? =
		decode(run("read-plan-progress") { addProperty("slug", slug) }, PlanProgressArtifact::class.java)

	fun storePlanFiles(files: List<FileWrite>, commitMessage: String) = storeFiles(files, commitMessage)

	fun storeNoteFiles(files: List<FileWrite>, commitMessage: String) = storeFiles(files, commitMessage)

	fun readPlanFromBranch(slug: String): String? =
		stringResult(run("read-plan") { addProperty("slug", slug) }, "content")

	fun writePlanToBranch(slug: String, content: String, message: String) {
		run("write-plan") {
			addProperty("slug", slug)
			addProperty("content", content)
			addProperty("message", message)
		}
	}

	fun readReferenceFromBranch(source: SourceId, archivedKey: String): String? =
		stringResult(run("read-reference") {
			addProperty("source", source.name)
			addProperty("archivedKey", archivedKey)
		}, "content")

	fun writeReferenceFromBranch(source: SourceId, archivedKey: String, content: String, message: String) {
		run("write-reference") {
			addProperty("source", source.name)
			addProperty("archivedKey", archivedKey)
			addProperty("content", content)
			addProperty("message", message)
		}
	}

	fun storeReferences(files: List<FileWrite>, commitMessage: String) = storeFiles(files, commitMessage)

	fun getTranscriptHashes(): Set<String> =
		run("transcript-hashes").asJsonObject.getAsJsonArray("hashes")
			?.mapTo(linkedSetOf()) { it.asString } ?: emptySet()

	fun readTranscript(commitHash: String): StoredTranscript? =
		decode(run("read-transcript") { addProperty("commitHash", commitHash) }, StoredTranscript::class.java)

	fun writeTranscriptBatch(writes: Map<String, StoredTranscript>, deletes: Set<String>) {
		run("write-transcript-batch") {
			add("writes", gson.toJsonTree(writes))
			add("deletes", gson.toJsonTree(deletes))
		}
	}

	private fun storeFiles(files: List<FileWrite>, message: String) {
		if (files.isEmpty()) return
		run("store-files") {
			add("files", gson.toJsonTree(files))
			addProperty("message", message)
		}
	}

	private fun run(operation: String, configure: JsonObject.() -> Unit = {}): JsonElement {
		val request = JsonObject().apply {
			addProperty("operation", operation)
			configure()
		}
		return CliIntegrations.runIdeBridge(cwd, "summary-store", gson.toJson(request))
	}

	private fun <T> decode(element: JsonElement, type: Class<T>): T? =
		if (element.isJsonNull) null else gson.fromJson(element, type)

	private fun stringResult(element: JsonElement, field: String): String? =
		element.asJsonObject.get(field)?.takeUnless { it.isJsonNull }?.asString
}
