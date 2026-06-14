package ai.jolli.jollimemory.core

/**
 * TopicPageStore — read/write/list canonical topic pages at
 * `topics/<stableSlug>.json` via a [StorageProvider]. The rendered
 * `_wiki/<slug>.md` layer is a separate concern (FolderStorage / WikiMarkdownBuilder).
 *
 * Kotlin port of `cli/src/core/TopicPageStore.ts`. Unlike the TS module, which
 * resolves the process-global active storage, callers here pass the provider
 * explicitly.
 */
object TopicPageStore {

    private val log = JmLogger.create("TopicPageStore")

    /** Reserved file names under `topics/` that are NOT topic pages. */
    private val RESERVED = setOf("index", "processed")

    /**
     * Guards a slug before it is interpolated into a `topics/<slug>.json` path.
     * Slugs are LLM-generated upstream, so the store must reject path-traversal /
     * nesting itself. Safe = non-empty, no `/`, no `..`.
     */
    private fun isSafeSlug(slug: String): Boolean =
        slug.isNotEmpty() && !slug.contains("/") && !slug.contains("..")

    /** Reads a canonical topic page; missing, unparseable, or unsafe slug → null. */
    fun readTopicPage(slug: String, storage: StorageProvider): TopicPage? {
        if (!isSafeSlug(slug)) {
            log.warn("Refusing to read topic page with unsafe slug %s", slug)
            return null
        }
        val raw = storage.readFile("topics/$slug.json") ?: return null
        val page = TopicJson.parse(raw, TopicPage::class.java)
        if (page == null) log.warn("Failed to parse topic page %s", slug)
        return page
    }

    /** Persists a canonical topic page. Throws on an unsafe slug. */
    fun saveTopicPage(page: TopicPage, storage: StorageProvider) {
        if (!isSafeSlug(page.stableSlug)) {
            throw IllegalArgumentException("Refusing to write topic page with unsafe slug: ${page.stableSlug}")
        }
        storage.writeFiles(
            listOf(FileWrite(path = "topics/${page.stableSlug}.json", content = TopicJson.stringify(page))),
            "Update topic page ${page.stableSlug}",
        )
    }

    /** Lists all topic page slugs under `topics/`, excluding index.json / processed.json. */
    fun listTopicPageSlugs(storage: StorageProvider): List<String> =
        storage.listFiles("topics/")
            .filter { it.startsWith("topics/") && it.endsWith(".json") }
            .map { it.removePrefix("topics/").removeSuffix(".json") }
            .filter { it.isNotEmpty() && !it.contains("/") && it !in RESERVED }

    /**
     * Deletes topic page files whose slug is not in [keepSlugs], returning the
     * slugs purged. Converges the canonical layer to the index after a
     * `--rebuild` drops topics; no-op in steady state. Mirrors the
     * "index is the source of truth" model the wiki render follows.
     */
    fun purgeTopicPagesExcept(keepSlugs: Iterable<String>, storage: StorageProvider): List<String> {
        val keep = keepSlugs.toSet()
        val orphans = listTopicPageSlugs(storage).filter { it !in keep }
        if (orphans.isNotEmpty()) {
            storage.writeFiles(
                orphans.map { FileWrite(path = "topics/$it.json", content = "", delete = true) },
                "Purge ${orphans.size} orphaned topic page(s)",
            )
            log.info("Purged %d orphaned topic page(s): %s", orphans.size, orphans.joinToString(", "))
        }
        return orphans
    }
}
