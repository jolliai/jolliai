package ai.jolli.jollimemory.sync

import ai.jolli.jollimemory.core.JmLogger
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import java.io.File

/**
 * Conflict resolution pyramid: Tier 1.5 → Tier 2.7 → Tier 2 → Tier 3.
 *
 * Called by `SyncEngine.runRound` when `SyncGitClient.pullRebase` returns
 * non-empty `conflicted`. For each conflicting path:
 *
 *   - **Tier 1.5**: aggregate JSON auto-merge (deterministic, no AI/user).
 *   - **Tier 2.7**: safe heuristics (empty-vs-content, normalize, append-only).
 *   - **Tier 2**: AI semantic merge via [AiMergeProvider].
 *   - **Tier 3**: policy-driven fallback (mine/theirs/prompt).
 *
 * After all paths: `rebaseContinue` if all resolved, `rebaseAbort` if any skipped.
 *
 * Port of `cli/src/sync/ConflictResolver.ts`.
 */

// ── Interfaces & types ─────────────────────────────────────────────────

data class AiMergeRequest(
	val path: String,
	val base: String?,
	val ours: String,
	val theirs: String,
	val fileKind: String, // "md" | "json"
)

data class AiMergeResponse(
	val merged: String,
	val confidence: Double, // 0..1
	val model: String,
)

fun interface AiMergeProvider {
	fun merge(req: AiMergeRequest): AiMergeResponse
}

enum class Tier3Pick { MINE, THEIRS, SKIP, VIEW_DIFF }

interface ConflictUi {
	fun promptBinaryPick(path: String, oursOid: String?, theirsOid: String?): Tier3Pick
	fun showDiff(path: String, ours: String, theirs: String) {}
}

enum class ConflictPolicy { PROMPT, MINE, THEIRS }

data class ConflictResolutionReport(
	val resolved: List<String>,
	val skipped: List<String>,
	val aiMerged: List<AiMergedEntry>,
	val binaryPicked: List<BinaryPickedEntry>,
	val aggregateMerged: List<String>,
	val rebaseAdvanced: Boolean,
)

data class AiMergedEntry(val path: String, val model: String)
data class BinaryPickedEntry(val path: String, val pick: String) // "mine" | "theirs"

sealed class SafeHeuristicResult {
	data class Merged(val merged: String, val via: String) : SafeHeuristicResult()
	data class Delete(val via: String) : SafeHeuristicResult()
}

// ── ConflictResolver ───────────────────────────────────────────────────

class ConflictResolver(
	private val client: SyncGitClient,
	private val ai: AiMergeProvider?,
	private val ui: ConflictUi,
	private val writeFile: (String, String) -> Unit = { path, content -> File(path).writeText(content) },
	private val resolveVaultPath: (String) -> String = { it },
	private val minConfidence: Double = DEFAULT_MIN_CONFIDENCE,
	private val policy: ConflictPolicy = ConflictPolicy.PROMPT,
	private val author: CommitAuthor? = null,
) {

	private val log = JmLogger.create("Sync:ConflictResolver")

	fun resolveAll(paths: List<String>): ConflictResolutionReport {
		val resolved = mutableListOf<String>()
		val skipped = mutableListOf<String>()
		val aiMerged = mutableListOf<AiMergedEntry>()
		val binaryPicked = mutableListOf<BinaryPickedEntry>()
		val aggregateMerged = mutableListOf<String>()

		for (path in paths) {
			val ours = client.readIndexStage(path, 2)
			val theirs = client.readIndexStage(path, 3)
			val base = client.readIndexStage(path, 1)

			// Tier 1.5 — aggregate file auto-merge.
			if (isAggregatePath(path)) {
				val oursForMerge = ours ?: emptyAggregateEnvelope(path)
				val theirsForMerge = theirs ?: emptyAggregateEnvelope(path)
				val merged = tryAggregateMerge(path, oursForMerge, theirsForMerge)
				if (merged != null) {
					writeFile(resolveVaultPath(path), merged)
					client.addPath(path)
					resolved.add(path)
					aggregateMerged.add(path)
					continue
				}
				// Parse failure → fall through to Tier 2/3.
			}

			// Tier 2.7 — safe deterministic heuristics.
			val safeMerge = trySafeHeuristics(path, base, ours, theirs)
			if (safeMerge != null) {
				when (safeMerge) {
					is SafeHeuristicResult.Merged -> {
						writeFile(resolveVaultPath(path), safeMerge.merged)
						client.addPath(path)
					}
					is SafeHeuristicResult.Delete -> {
						client.removePath(path)
					}
				}
				resolved.add(path)
				val via = when (safeMerge) {
					is SafeHeuristicResult.Merged -> safeMerge.via
					is SafeHeuristicResult.Delete -> safeMerge.via
				}
				log.info("Tier 2.7 resolved %s via %s", path, via)
				continue
			}

			// Tier 2 — AI merge.
			if (ai != null && ours != null && theirs != null) {
				val aiResult = tryAiMerge(path, base, ours, theirs)
				if (aiResult != null) {
					writeFile(resolveVaultPath(path), aiResult.merged)
					client.addPath(path)
					resolved.add(path)
					aiMerged.add(AiMergedEntry(path, aiResult.model))
					continue
				}
			}

			// Tier 3 — policy-driven fallback.
			val pick = runTier3(path, ours, theirs)
			if (pick == "skip") {
				skipped.add(path)
				continue
			}
			if (pick == "mine") client.checkoutOurs(path)
			else client.checkoutTheirs(path)
			resolved.add(path)
			binaryPicked.add(BinaryPickedEntry(path, pick))
		}

		if (skipped.isNotEmpty()) {
			client.rebaseAbort()
			return ConflictResolutionReport(resolved, skipped, aiMerged, binaryPicked, aggregateMerged, rebaseAdvanced = false)
		}

		client.rebaseContinue(author)
		return ConflictResolutionReport(resolved, skipped, aiMerged, binaryPicked, aggregateMerged, rebaseAdvanced = true)
	}

	private fun tryAiMerge(
		path: String,
		base: String?,
		ours: String,
		theirs: String,
	): AiMergeResult? {
		val fileKind = if (path.lowercase().endsWith(".json")) "json" else "md"
		return try {
			val response = ai!!.merge(AiMergeRequest(path, base, ours, theirs, fileKind))
			if (!passesGuards(response, ours, theirs, fileKind)) null
			else AiMergeResult(response.merged, response.model)
		} catch (e: Exception) {
			log.warn("Tier 2 AI merge failed for %s: %s", path, e.message)
			null
		}
	}

	private fun passesGuards(response: AiMergeResponse, ours: String, theirs: String, fileKind: String): Boolean {
		if (response.confidence < minConfidence) return false
		if (MARKER_REGEX.containsMatchIn(response.merged)) return false
		val maxLen = maxOf(ours.length, theirs.length)
		val len = response.merged.length
		if (len < maxLen * MIN_LENGTH_RATIO) return false
		if (len > maxLen * MAX_LENGTH_RATIO) return false
		if (fileKind == "json") {
			try {
				Gson().fromJson(response.merged, Any::class.java)
			} catch (_: Exception) {
				return false
			}
		}
		return true
	}

	/**
	 * Tier 2.7 — safe deterministic heuristics applied BEFORE Tier 3.
	 */
	internal fun trySafeHeuristics(
		path: String,
		base: String?,
		ours: String?,
		theirs: String?,
	): SafeHeuristicResult? {
		// Rule 1: empty/whitespace-only side.
		if (ours != null && theirs != null) {
			if (isWhitespaceOnly(ours) && !isWhitespaceOnly(theirs)) {
				return SafeHeuristicResult.Merged(theirs, "empty-mine")
			}
			if (isWhitespaceOnly(theirs) && !isWhitespaceOnly(ours)) {
				return SafeHeuristicResult.Merged(ours, "empty-theirs")
			}

			// Rule 2: identical after normalization.
			if (normalizeForCompare(ours) == normalizeForCompare(theirs)) {
				return SafeHeuristicResult.Merged(ours, "identical-after-normalize")
			}
		}

		// Rule 3: base-aware delete-vs-modify.
		if (ours == null && theirs != null) {
			return classifyDeleteVsModify(base, theirs, "mine-deleted")
		}
		if (theirs == null && ours != null) {
			return classifyDeleteVsModify(base, ours, "theirs-deleted")
		}

		// Rule 4: Memory Bank summary/plan markdown union.
		if (ours != null && theirs != null && isMemoryBankAppendOnlyPath(path)) {
			return SafeHeuristicResult.Merged(unionMarkdown(ours, theirs), "memory-bank-summary-union")
		}

		return null
	}

	/**
	 * Tier 3 — policy-driven fallback.
	 */
	private fun runTier3(path: String, ours: String?, theirs: String?): String {
		if (policy == ConflictPolicy.MINE) return "mine"
		if (policy == ConflictPolicy.THEIRS) return "theirs"
		// policy == PROMPT
		while (true) {
			val pick = ui.promptBinaryPick(path, ours, theirs)
			if (pick != Tier3Pick.VIEW_DIFF) {
				return when (pick) {
					Tier3Pick.MINE -> "mine"
					Tier3Pick.THEIRS -> "theirs"
					else -> "skip"
				}
			}
			if (ours != null && theirs != null) {
				ui.showDiff(path, ours, theirs)
			}
		}
	}

	private data class AiMergeResult(val merged: String, val model: String)

	companion object {
		private val MARKER_REGEX = Regex("^(<<<<<<<|=======|>>>>>>>)", RegexOption.MULTILINE)
		private const val DEFAULT_MIN_CONFIDENCE = 0.6
		private const val MIN_LENGTH_RATIO = 0.5
		private const val MAX_LENGTH_RATIO = 4.0
	}
}

// ── Top-level helpers (visible for testing) ────────────────────────────

private val AGGREGATE_BASENAMES = setOf("manifest.json", "index.json", "branches.json", "catalog.json")

/**
 * True if `path` is one of the aggregate files governed by deterministic merge.
 */
fun isAggregatePath(path: String): Boolean {
	if (path == REPO_MAPPING_PATH) return true
	val segments = path.split("/")
	if (segments.size < 2) return false
	val basename = segments.last()
	val parent = segments[segments.size - 2]
	return parent == ".jolli" && basename in AGGREGATE_BASENAMES
}

/**
 * Returns a serialized empty envelope for the given aggregate path.
 */
fun emptyAggregateEnvelope(path: String): String {
	if (path == REPO_MAPPING_PATH) return """{"version":1,"mappings":[]}"""
	val basename = path.split("/").last()
	return when (basename) {
		"manifest.json" -> """{"version":1,"files":[]}"""
		"index.json" -> """{"version":3,"entries":[]}"""
		"branches.json" -> """{"version":1,"mappings":[]}"""
		"catalog.json" -> """{"version":1,"entries":[]}"""
		else -> "{}"
	}
}

/**
 * Dispatches on basename to the matching deterministic merge function.
 * Returns null when either side fails to parse.
 */
fun tryAggregateMerge(path: String, ours: String, theirs: String): String? {
	if (path == REPO_MAPPING_PATH) {
		return mergeRepoMappingDoc(ours, theirs)
	}

	if (parseJson(ours) == null || parseJson(theirs) == null) return null

	val gson = GsonBuilder().setPrettyPrinting().create()
	val basename = path.split("/").last()

	return when (basename) {
		"manifest.json" -> mergeEnvelopeDoc<ManifestEnvelope>(gson, ours, theirs) { o, t ->
			if (o.files == null || t.files == null) null
			else ManifestEnvelope(version = 1, files = mergeManifest(o.files, t.files))
		}
		"index.json" -> mergeEnvelopeDoc<IndexEnvelope>(gson, ours, theirs) { o, t ->
			if (o.entries == null || t.entries == null) null
			else IndexEnvelope(version = 3, entries = mergeIndex(o.entries, t.entries))
		}
		"branches.json" -> mergeEnvelopeDoc<BranchesEnvelope>(gson, ours, theirs) { o, t ->
			if (o.mappings == null || t.mappings == null) null
			else BranchesEnvelope(version = 1, mappings = mergeBranches(o.mappings, t.mappings))
		}
		"catalog.json" -> mergeEnvelopeDoc<CatalogEnvelope>(gson, ours, theirs) { o, t ->
			if (o.entries == null || t.entries == null) null
			else CatalogEnvelope(version = 1, entries = mergeCatalog(o.entries, t.entries))
		}
		else -> null
	}
}

/**
 * True if path is a Memory Bank append-only markdown file:
 * `<repo>/<branch>/<file>.md` (3+ segments, not under `.jolli/`).
 */
fun isMemoryBankAppendOnlyPath(path: String): Boolean {
	if (!path.lowercase().endsWith(".md")) return false
	val segments = path.split("/").filter { it.isNotEmpty() }
	if (segments.size < 3) return false
	if (segments.contains(".jolli")) return false
	return true
}

/**
 * Append `theirs` onto `ours` with a visible separator. Idempotent:
 * if one side already contains the other, returns the containing side.
 */
fun unionMarkdown(ours: String, theirs: String): String {
	val oursTrimmed = ours.replace(Regex("\\s+$"), "")
	val theirsTrimmed = theirs.replace(Regex("\\s+$"), "")
	if (oursTrimmed.contains(theirsTrimmed)) return ours
	if (theirsTrimmed.contains(oursTrimmed)) return theirs
	return "$oursTrimmed\n\n---\n\n*Synced from another device:*\n\n$theirsTrimmed\n"
}

/**
 * Base-aware classifier for delete-vs-modify (Rule 3).
 */
fun classifyDeleteVsModify(
	base: String?,
	present: String,
	tag: String,
): SafeHeuristicResult? {
	if (base != null && normalizeForCompare(base) == normalizeForCompare(present)) {
		return SafeHeuristicResult.Delete("respect-$tag")
	}
	if (base == null) {
		return SafeHeuristicResult.Merged(present, "accept-add-when-$tag")
	}
	return null
}

/** Strips trailing whitespace per line + trailing newlines. CRLF → LF. */
fun normalizeForCompare(s: String): String {
	return s
		.replace("\r\n", "\n")
		.replace(Regex("[ \\t]+$", RegexOption.MULTILINE), "")
		.replace(Regex("\\n+$"), "")
}

// ── Private helpers ────────────────────────────────────────────────────

private fun isWhitespaceOnly(s: String): Boolean = s.trim().isEmpty()

private fun parseJson(text: String): Any? {
	return try {
		Gson().fromJson(text, Any::class.java)
	} catch (_: Exception) {
		null
	}
}

private inline fun <reified T> mergeEnvelopeDoc(
	gson: Gson,
	ours: String,
	theirs: String,
	merge: (T, T) -> T?,
): String? {
	return try {
		val o = gson.fromJson(ours, T::class.java)
		val t = gson.fromJson(theirs, T::class.java)
		val merged = merge(o, t) ?: return null
		"${gson.toJson(merged)}\n"
	} catch (_: Exception) {
		null
	}
}

private fun mergeRepoMappingDoc(ours: String, theirs: String): String? {
	val oursDoc = parseRepoMapping(ours) ?: return null
	val theirsDoc = parseRepoMapping(theirs) ?: return null
	val (merged, _) = mergeRepoMapping(oursDoc, theirsDoc)
	return serializeRepoMapping(merged)
}
