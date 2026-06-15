package ai.jolli.jollimemory.core

import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.exists
import kotlin.io.path.isDirectory
import kotlin.io.path.isRegularFile
import kotlin.io.path.name

/**
 * MemoryBankScanner — surfaces user-written markdown in the Memory Bank as raw
 * compile input ("user drops files in Memory Bank via Obsidian").
 *
 * Identification rule (AND of two checks):
 *  1. file path NOT present in `<kbRoot>/.jolli/manifest.json` files[].path set
 *  2. filename does NOT match a generated pattern (the `-<8hex>.md` suffix or a
 *     `plan--`/`note--`/`topic--` prefix)
 *
 * Scope mapping:
 *   `<localFolder>/<name>.md`               → global
 *   `<kbRoot>/<name>.md`                     → repo
 *   `<kbRoot>/<branchFolder>/<name>.md`      → branch
 *
 * Kotlin port of `cli/src/core/MemoryBankScanner.ts` (root-based variants — the
 * compile path resolves `kbRoot` up front, so the cwd-resolving wrappers are
 * intentionally not ported).
 */
object MemoryBankScanner {

    private val log = JmLogger.create("MemoryBankScanner")

    /** The `-<8hex>.md` suffix FolderStorage uses for generated commit markdown. */
    private val GENERATED_SUFFIX_RE = Regex("-[0-9a-f]{8}\\.md$")

    /** Generated plan/note/topic visible files carry these prefixes (no `-<8hex>` suffix). */
    private val GENERATED_PREFIX_RE = Regex("^(plan|note|topic)--")

    /** kbRoot subfolders that are never branch folders and must not be scanned. */
    private val SYSTEM_SUBDIRS = setOf(".jolli", "_wiki")

    private data class FpCacheEntry(val mtimeMs: Long, val size: Long, val fingerprint: String)

    /** Process-wide fingerprint memo keyed by absolute path, invalidated by mtime+size. */
    private val fpCache = java.util.concurrent.ConcurrentHashMap<String, FpCacheEntry>()

    enum class UserKnowledgeScope { GLOBAL, REPO, BRANCH }

    data class UserKnowledgeFile(
        /** Path relative to the Memory Bank parent (`localFolder`), forward-slash. */
        val path: String,
        val absolutePath: String,
        val scope: UserKnowledgeScope,
        /** Present only when scope == BRANCH. */
        val branch: String? = null,
        /** sha256 of the on-disk content; same algorithm as the manifest fingerprint. */
        val fingerprint: String,
        val content: String,
        /** ISO 8601 mtime — the chronological ordering key in the timeline fold. */
        val mtime: String,
    )

    /**
     * Scans a Memory Bank folder for ALL user-written markdown — global, repo, and
     * **every branch folder physically present on disk** — without needing a branch
     * argument or a summary index. Branch label reverse-mapped via branches.json,
     * falling back to the folder name.
     */
    fun listAllUserKnowledgeFromRoot(kbRoot: Path): List<UserKnowledgeFile> {
        if (!kbRoot.exists()) {
            log.debug("Memory Bank kbRoot not present: %s", kbRoot.toString())
            return emptyList()
        }
        val localFolderRoot = kbRoot.parent
        val metadata = MetadataManager(kbRoot.resolve(".jolli"))
        val manifestPaths = readManifestPaths(metadata)
        val results = mutableListOf<UserKnowledgeFile>()

        collectMarkdown(localFolderRoot, UserKnowledgeScope.GLOBAL, kbRoot, localFolderRoot, manifestPaths, results)
        collectMarkdown(kbRoot, UserKnowledgeScope.REPO, kbRoot, localFolderRoot, manifestPaths, results)

        val subdirs = try {
            Files.list(kbRoot).use { s -> s.filter { it.isDirectory() }.toList() }
        } catch (_: Exception) {
            return results
        }
        for (dir in subdirs) {
            if (dir.name in SYSTEM_SUBDIRS) continue
            collectMarkdown(
                dir, UserKnowledgeScope.BRANCH, kbRoot, localFolderRoot, manifestPaths, results,
                branch = metadata.folderToBranch(dir.name),
            )
        }
        return results
    }

    /**
     * Scans a Memory Bank folder for user-written markdown visible to a given
     * branch. When [branch] is null only global + repo scopes are returned.
     */
    fun listUserKnowledgeFromRoot(kbRoot: Path, branch: String? = null): List<UserKnowledgeFile> {
        if (!kbRoot.exists()) {
            log.debug("Memory Bank kbRoot not present: %s", kbRoot.toString())
            return emptyList()
        }
        val localFolderRoot = kbRoot.parent
        val metadata = MetadataManager(kbRoot.resolve(".jolli"))
        val manifestPaths = readManifestPaths(metadata)
        val results = mutableListOf<UserKnowledgeFile>()

        collectMarkdown(localFolderRoot, UserKnowledgeScope.GLOBAL, kbRoot, localFolderRoot, manifestPaths, results)
        collectMarkdown(kbRoot, UserKnowledgeScope.REPO, kbRoot, localFolderRoot, manifestPaths, results)

        if (branch != null) {
            val branchFolder = resolveBranchFolder(metadata, branch)
            val branchDir = kbRoot.resolve(branchFolder)
            if (branchDir.exists()) {
                collectMarkdown(
                    branchDir, UserKnowledgeScope.BRANCH, kbRoot, localFolderRoot, manifestPaths, results,
                    branch = branch,
                )
            }
        }
        return results
    }

    /** Primary identification set: paths recorded in manifest.json (forward-slash). */
    private fun readManifestPaths(metadata: MetadataManager): Set<String> =
        metadata.readManifest().files.map { it.path }.toSet()

    private fun collectMarkdown(
        dir: Path,
        scope: UserKnowledgeScope,
        kbRoot: Path,
        localFolderRoot: Path,
        manifestPaths: Set<String>,
        out: MutableList<UserKnowledgeFile>,
        branch: String? = null,
    ) {
        val entries = try {
            Files.list(dir).use { s -> s.toList() }
        } catch (_: Exception) {
            return
        }
        for (entry in entries) {
            val name = entry.name
            if (!name.endsWith(".md")) continue
            // Secondary rule: drop anything that looks generated.
            if (GENERATED_SUFFIX_RE.containsMatchIn(name) || GENERATED_PREFIX_RE.containsMatchIn(name)) continue
            if (!entry.isRegularFile()) continue

            // Primary rule (skipped for global: those files live outside kbRoot).
            if (scope != UserKnowledgeScope.GLOBAL) {
                val manifestRelPath = kbRoot.relativize(entry).toString().replace('\\', '/')
                if (manifestRelPath in manifestPaths) continue
            }

            // Fingerprint cache: collectAllSourceRefs runs once per ingest batch, and
            // it only needs path/fingerprint/mtime (not content). Skip the read + sha256
            // of files unchanged since the last scan (keyed by mtime+size). On a cache
            // hit `content` is left empty — no caller consumes it here, and
            // SourceContent.loadSourceContent reads the body fresh when reconcile needs it.
            val mtimeMs = try { Files.getLastModifiedTime(entry).toMillis() } catch (_: Exception) { -1L }
            val size = try { Files.size(entry) } catch (_: Exception) { -1L }
            val absStr = entry.toString()
            val cachedFp = fpCache[absStr]

            val fingerprint: String
            val content: String
            if (cachedFp != null && mtimeMs != -1L && cachedFp.mtimeMs == mtimeMs && cachedFp.size == size) {
                fingerprint = cachedFp.fingerprint
                content = ""
            } else {
                content = try {
                    Files.readString(entry, StandardCharsets.UTF_8)
                } catch (e: Exception) {
                    log.warn("Failed to read user file %s: %s", absStr, e.message)
                    continue
                }
                fingerprint = FolderStorage.sha256(content)
                if (mtimeMs != -1L && size != -1L) fpCache[absStr] = FpCacheEntry(mtimeMs, size, fingerprint)
            }

            val localRelPath = localFolderRoot.relativize(entry).toString().replace('\\', '/')
            val mtime = if (mtimeMs != -1L) java.time.Instant.ofEpochMilli(mtimeMs).toString() else ""
            out.add(
                UserKnowledgeFile(
                    path = localRelPath,
                    absolutePath = entry.toString(),
                    scope = scope,
                    branch = branch,
                    fingerprint = fingerprint,
                    content = content,
                    mtime = mtime,
                ),
            )
        }
    }

    private fun resolveBranchFolder(metadata: MetadataManager, branch: String): String {
        val mapping = metadata.listBranchMappings().find { it.branch == branch }
        if (mapping != null) return mapping.folder
        return MetadataManager.transcodeBranchName(branch)
    }
}
