package ai.jolli.jollimemory.core.references

import ai.jolli.jollimemory.core.TranscriptSource

/**
 * Source adapter registry.
 *
 * [ALL_ADAPTERS] is the canonical list driven by the shared extractor.
 * Adding a new source = implementing a [SourceAdapter] and appending it here.
 */
val ALL_ADAPTERS: List<SourceAdapter> = listOf(LinearAdapter, JiraAdapter, GitHubAdapter, NotionAdapter, SlackAdapter)

/**
 * Adapters applicable to a transcript source. Same instances for every source
 * today — adapters don't vary by agent; only the envelope (in the parser) does.
 */
fun getAdaptersForSource(@Suppress("UNUSED_PARAMETER") source: TranscriptSource): List<SourceAdapter> = ALL_ADAPTERS
