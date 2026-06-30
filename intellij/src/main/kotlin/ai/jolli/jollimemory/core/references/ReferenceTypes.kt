package ai.jolli.jollimemory.core.references

/**
 * Core types for the multi-source reference extraction pipeline.
 *
 * Kotlin port of the Reference / ReferenceField / SourceId types
 * from cli/src/Types.ts.
 */

/** Stable id naming each external-reference provider. */
enum class SourceId { linear, jira, github, notion }

/**
 * One displayable field produced by a [SourceAdapter].
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
 * Ephemeral, in-memory shape produced by [SourceAdapter.extractRef].
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
	val url: String,
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
 */
data class ReferenceEntry(
	val source: SourceId,
	val nativeId: String,
	val title: String,
	val url: String,
	val sourcePath: String,
	val addedAt: String,
	val updatedAt: String,
	val sourceToolName: String,
	/**
	 * Branch the reference was last captured on. Nullable/blank for legacy rows
	 * written before branch-scoping; those are treated as visible on every branch
	 * (same graceful fallback as [ai.jolli.jollimemory.core.PlanEntry.branch] /
	 * [ai.jolli.jollimemory.core.NoteEntry.branch]). Stamped by
	 * `TranscriptReferenceDiscovery.upsertReferenceEntry` and filtered at the
	 * CONTEXT / Working Memory display sites + the post-commit archive selection.
	 */
	val branch: String? = null,
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
	val url: String,
	val fields: List<ReferenceField>? = null,
	val referencedAt: String,
	val sourceToolName: String,
)
