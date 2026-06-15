package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.sync.VaultWriteLock
import ai.jolli.jollimemory.sync.VaultWriteLockMode
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import kotlin.io.path.isRegularFile
import kotlin.io.path.name

/**
 * MultiRepoCompile — runs the single-repo ingest unit over every repo in the
 * Memory Bank folder. Shared entry point for the "Build Knowledge Wiki" button.
 * Swept repos use folder-only storage. Per-repo failures are isolated and
 * reported, never swallowed.
 *
 * Kotlin port of `cli/src/core/MultiRepoCompile.ts`. Differences from the TS:
 *  - storage is passed explicitly per repo (no process-global setActiveStorage swap).
 *  - the `@orama` SearchIndex warm-up is not ported (Node-only, non-fatal there).
 *  - repos are discovered locally (gate on `.jolli/index.json`, name-ascending),
 *    matching the TS `discoverRepos` rather than the `.jolli/`-only KBRepoDiscoverer.
 */
object MultiRepoCompile {

    private val log = JmLogger.create("MultiRepoCompile")

    data class CompileRepoResult(
        val folder: String,
        val ingested: Int,
        val batches: Int,
        val error: String? = null,
    )

    data class CompileAllResult(
        val repos: List<CompileRepoResult>,
        val totalIngested: Int,
        val failed: Int,
        /** Set when the sweep was skipped because another vault writer holds the lock. */
        val skipped: Boolean = false,
    )

    /**
     * Compiles every repo under [parent] (the Memory Bank folder root). Serialises
     * on the shared `vault-write.lock` (fail-fast) keyed off [parent], so a sweep
     * can't interleave on-disk writes with a background worker / sync round / a
     * second sweep over the same folder.
     */
    fun compileAllRepos(
        parent: Path,
        config: IngestPipeline.LlmConfig,
        excludeFolders: List<String> = emptyList(),
        nowIso: String = Instant.now().toString(),
        llm: IngestPipeline.LlmCaller = IngestPipeline.defaultLlmCaller(config),
        onProgress: (String) -> Unit = {},
    ): CompileAllResult {
        // Normalize the lock root to an absolute path so a relative localFolder config
        // resolves to the same vault-write.lock key other writers (sync, CLI) use.
        val lockRoot = parent.toAbsolutePath().normalize().toString()
        val handle = VaultWriteLock.acquire(lockRoot, VaultWriteLockMode.FailFast)
            ?: run {
                log.warn("Another vault writer is busy for %s — skipping this sweep", parent.toString())
                return CompileAllResult(emptyList(), 0, 0, skipped = true)
            }
        try {
            val targets = discoverRepos(parent, excludeFolders)
            val repos = mutableListOf<CompileRepoResult>()
            var totalIngested = 0
            var failed = 0
            for (kbRoot in targets) {
                val folder = kbRoot.name
                onProgress(folder)
                try {
                    val storage = FolderStorage(kbRoot, MetadataManager(kbRoot.resolve(".jolli")))
                    val drain = IngestPipeline.drainIngest(kbRoot, storage, llm, config.model, nowIso)
                    val index = TopicIndexStore.readTopicIndex(storage)
                    TopicPageStore.purgeTopicPagesExcept(index.topics.map { it.stableSlug }, storage)
                    TopicWikiRenderer.renderTopicKBWiki(storage)
                    totalIngested += drain.ingested
                    repos.add(CompileRepoResult(folder, drain.ingested, drain.batches))
                    log.info("Compiled %s: %d source(s) in %d batch(es)", folder, drain.ingested, drain.batches)
                } catch (e: Exception) {
                    failed++
                    // e.message is null for some exceptions (e.g. a bare NPE), so fall
                    // back to toString() (always has the class name) and log the full
                    // stack trace — never swallow the cause as a bare "null".
                    val msg = e.message ?: e.toString()
                    repos.add(CompileRepoResult(folder, 0, 0, msg))
                    log.error("Compile failed for %s: %s\n%s", folder, msg, e.stackTraceToString())
                }
            }
            return CompileAllResult(repos, totalIngested, failed)
        } finally {
            handle.release()
        }
    }

    /**
     * Repos under [parent] that have memories: subfolders containing
     * `.jolli/index.json`, name-ascending, excluding [excludeFolders]. Matches the
     * TS `discoverRepos` gate.
     */
    fun discoverRepos(parent: Path, excludeFolders: List<String> = emptyList()): List<Path> {
        if (!Files.isDirectory(parent)) return emptyList()
        return Files.list(parent).use { stream ->
            stream
                .filter { Files.isDirectory(it) }
                .filter { !it.name.startsWith(".") } // skip hidden dirs (e.g. .trash backups), matching the CLI
                .filter { !matchesAny(it.name, excludeFolders) }
                .filter { it.resolve(".jolli").resolve("index.json").isRegularFile() }
                .sorted(compareBy { it.name })
                .toList()
        }
    }

    /**
     * Minimal glob match: exact name, or `*` wildcards (e.g. `archive-*`). Mirrors
     * the CLI `matchesAny` so `compileExcludeFolders` behaves identically.
     */
    private fun matchesAny(name: String, patterns: List<String>): Boolean = patterns.any { p ->
        if (!p.contains("*")) {
            p == name
        } else {
            val regex = p.split("*").joinToString(".*") { Regex.escape(it) }
            Regex("^$regex$").matches(name)
        }
    }
}
