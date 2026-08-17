package ai.jolli.jollimemory.core.references

import com.google.gson.annotations.SerializedName
import java.security.MessageDigest

/**
 * Core types for the multi-source reference extraction pipeline.
 *
 * Kotlin port of the Reference / ReferenceField / SourceId types
 * from cli/src/Types.ts.
 */

/**
 * Stable id naming each external-reference provider.
 *
 * The CLI declares `SourceId = string` (open); this Kotlin port pins the currently
 * shipping ids as an enum so `when` on `source` stays exhaustive at the compiler
 * level. Ids with a hyphen carry `@SerializedName` so Gson round-trips them to the
 * exact string the CLI writes into `plans.json` and orphan-branch summaries.
 *
 * A source the runtime encounters that is NOT in this enum decodes to `null` (Gson's
 * default) and is filtered out by [SourceIds.parse]. UI/render sites accept
 * `SourceId?` and route through [SourceDisplay.of], which handles the null
 * (unknown-source) case with a neutral placeholder — this keeps a future CLI-side
 * addition from crashing the panel before this enum is bumped. Adding a raw
 * `when (source)` on a non-nullable `SourceId` is fine because it stays exhaustive
 * at the compiler level; do NOT add an `else` branch, or a missing case for a new
 * enum value slips through silently instead of failing to compile. See
 * `PlansPanel.tagFor` / `CommitsPanel.referenceTag` for the intended pattern.
 */
enum class SourceId {
	linear,
	jira,
	github,
	notion,
	slack,
	jollimemory,
	context7,
	confluence,
	asana,
	monday,
	@SerializedName("zoom-doc") zoom_doc,
	@SerializedName("zoom-meeting") zoom_meeting,
	vercel,
	figma,
	sentry,
}

/** Wire-name helpers for [SourceId] (Gson otherwise encodes enum names verbatim). */
object SourceIds {
	/** The wire string the CLI writes to `plans.json` for a given [SourceId]. */
	fun wireName(id: SourceId): String = when (id) {
		SourceId.zoom_doc -> "zoom-doc"
		SourceId.zoom_meeting -> "zoom-meeting"
		else -> id.name
	}

	/** Lenient parser: returns null for unknown ids, matching Gson's default. */
	fun parse(raw: String?): SourceId? {
		if (raw.isNullOrEmpty()) return null
		return when (raw) {
			"zoom-doc" -> SourceId.zoom_doc
			"zoom-meeting" -> SourceId.zoom_meeting
			else -> try { SourceId.valueOf(raw) } catch (_: IllegalArgumentException) { null }
		}
	}

	/**
	 * Strips the `<wire>:` prefix from an [archivedKey], returning the bare
	 * key used for filesystem / git-object paths. Callers hold the full
	 * archivedKey (`"jollimemory:recall-abc12345"`); the on-disk layout is
	 * `references/<wire>/<pathKey>.md`. Shared by [FolderStorageReader] and
	 * [SummaryReader] so the strip logic has one implementation.
	 */
	fun stripPrefix(wire: String, archivedKey: String): String {
		val prefix = "$wire:"
		return if (archivedKey.startsWith(prefix)) archivedKey.substring(prefix.length) else archivedKey
	}

	/**
	 * The safe file stem the CLI's `SummaryStore.orphanPathFor` produces for
	 * an archived reference — the sanitize that mirrors
	 * `cli/src/core/references/ReferenceStore.ts` `sanitizeNativeIdForPath`.
	 *
	 * For sources whose native id is filesystem-safe and globally unique
	 * within the source (linear / jira / notion / slack / jollimemory /
	 * confluence / asana / monday / zoom-doc / zoom-meeting / vercel /
	 * figma): identity.
	 *
	 * For sources whose native id is collision-prone or unsafe (github's
	 * `<owner>/<repo>#<n>`, context7's `/<org>/<project>`, sentry's
	 * `<host>/<issueId>` — all declared `nativeIdPathSafe: false` in the
	 * CLI): replace `[^\w.-]` with `-` then append an 8-hex sha256 suffix
	 * over the RAW bareKey so two different tuples cannot land at the same
	 * file stem.
	 *
	 * LOCKSTEP with the CLI writer. This function IS the read side of that
	 * lockstep — [FolderStorageReader] and [SummaryReader] both call it, so
	 * a schema change in `SummaryStore.orphanPathFor` or a new source with
	 * `nativeIdPathSafe: false` MUST update this list in the same PR.
	 * AGENTS.md registers this pair.
	 */
	fun pathKey(source: SourceId, bareKey: String): String {
		return if (source in PATH_UNSAFE_SOURCES) {
			val safe = bareKey.replace(PATH_UNSAFE_CHARS, "-")
			val suffix = sha256Hex(bareKey).substring(0, 8)
			"$safe-$suffix"
		} else {
			bareKey
		}
	}

	/**
	 * Sources declared `nativeIdPathSafe: false` in the CLI's source
	 * definitions under `cli/src/core/references/sources/definitions/`.
	 * Currently: github (`owner/repo#n`), context7 (`/org/project`) and
	 * sentry (`<host>/<issueId>`).
	 *
	 * Membership is not a judgement call made here — it mirrors that one
	 * declaration, and getting it wrong is silent in the worst direction: a
	 * source omitted from this set reads the identity stem while the CLI
	 * wrote the sanitized+sha8 one, so every archived body of that source
	 * comes back null. `SourceLabelsLockstep.test.ts` in the CLI suite pins
	 * the two lists together.
	 */
	private val PATH_UNSAFE_SOURCES: Set<SourceId> = setOf(SourceId.github, SourceId.context7, SourceId.sentry)

	/** True for sources whose native id is filesystem-unsafe (contains `/`, `#`, etc.). */
	fun isPathUnsafe(source: SourceId): Boolean = source in PATH_UNSAFE_SOURCES

	private val PATH_UNSAFE_CHARS = Regex("[^\\w.-]")

	private fun sha256Hex(s: String): String {
		val digest = MessageDigest.getInstance("SHA-256")
		return digest.digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
	}
}

/**
 * One displayable field produced by the CLI's reference-extraction pipeline
 * (see `cli/src/core/references/SourceEngine.ts`).
 *
 * Opaque carrier for everything source-specific (status, priority, labels, …).
 * The common layer stores these as-is; only the adapter that created them
 * knows what they mean.
 */
data class ReferenceField(
	/** Stable key — doubles as the frontmatter key and the prompt XML attribute name. */
	val key: String,
	/** Human-readable label for tooltips (e.g. "Status", "Priority"). */
	val label: String,
	/** Pre-formatted display value. */
	val value: String,
	/** Optional codicon name. */
	val icon: String? = null,
)

/**
 * Ephemeral, in-memory shape produced by the CLI's `SourceEngine.extractRef`
 * (see `cli/src/core/references/SourceEngine.ts`).
 *
 * Carries cross-source core fields plus an opaque [fields] bag for every
 * source-specific attribute.
 */
data class Reference(
	/** `<source>:<nativeId>` — dedup key in plans.json.references. */
	val mapKey: String,
	val source: SourceId,
	/** Stable id native to the source (e.g. "JOLLI-1762", "owner/repo#123", 32-hex Notion page id). */
	val nativeId: String,
	val title: String,
	/** Absent only for sources whose `url` is optional (Slack with no permalink and no configured workspace). */
	val url: String? = null,
	val description: String? = null,
	/** Opaque, source-specific display fields. Built and consumed only by the adapter. */
	val fields: List<ReferenceField>? = null,
	val toolName: String,
	val referencedAt: String,
)

/**
 * Persisted registry row in the `plans.json.references` map.
 *
 * Holds one row per external reference, keyed `<source>:<nativeId>`.
 * A reference is DELETED from the registry when its commit lands — its
 * value-snapshot lives on in [ReferenceCommitRef].
 *
 * Deliberately carries NO `branch`: an uncommitted reference belongs to the
 * worktree, follows the user across a checkout, and binds to a branch only when
 * a commit claims it. The CLI strips any `branch` it finds on load (see
 * `LEGACY_REFERENCE_FIELDS` in `cli/src/core/SessionTracker.ts`), so a field
 * here would deserialize to null on every read anyway. Mirror of the CLI's
 * `ReferenceEntry` in `cli/src/Types.ts` — keep the two in step.
 */
data class ReferenceEntry(
	val source: SourceId,
	val nativeId: String,
	val title: String,
	/** Absent only when the source `Reference.url` was absent (e.g. Slack with no permalink). */
	val url: String? = null,
	val sourcePath: String,
	val addedAt: String,
	val updatedAt: String,
	val sourceToolName: String,
)

/**
 * Multi-source reference snapshot stored in CommitSummary.references.
 *
 * [archivedKey] is the post-archive map key (`<source>:<nativeId>-<shortHash>`).
 */
data class ReferenceCommitRef(
	val archivedKey: String,
	val source: SourceId,
	val nativeId: String,
	val title: String,
	/** Absent only when the source `Reference.url` was absent (e.g. Slack with no permalink). */
	val url: String? = null,
	val fields: List<ReferenceField>? = null,
	val referencedAt: String,
	val sourceToolName: String,
)
