package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.toolwindow.views.SummaryMarkdownBuilder
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import java.nio.channels.FileChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.security.MessageDigest
import kotlin.io.path.exists
import kotlin.io.path.isRegularFile

/**
 * FolderStorage — StorageProvider backed by a local filesystem folder.
 *
 * Stores data in two layers:
 * - **Hidden** (.jolli/): JSON data files for programmatic access
 *   - .jolli/summaries/{hash}.json, .jolli/index.json, .jolli/transcripts/, etc.
 * - **Visible** (root): human-readable markdown files organized by branch
 *   - {branch}/{slug}-{hash8}.md — auto-generated from CommitSummary
 *
 * When SummaryStore writes `summaries/xxx.json`, FolderStorage:
 * 1. Stores the JSON at `.jolli/summaries/xxx.json`
 * 2. Parses the CommitSummary and generates markdown with YAML frontmatter
 * 3. Writes the markdown to `{branch}/{slug}-{hash8}.md`
 * 4. Updates the manifest to track the AI-generated markdown file
 *
 * Part of JOLLI-1309.
 */
class FolderStorage(
    private val rootPath: Path,
    private val metadataManager: MetadataManager,
) : StorageProvider {

    private val log = JmLogger.create("FolderStorage")
    private val gson: Gson = GsonBuilder().setPrettyPrinting().create()

    override fun readFile(path: String): String? {
        // Read from .jolli/ hidden directory (data files)
        val file = rootPath.resolve(".jolli").resolve(path)
        if (!file.exists()) return null
        return try {
            Files.readString(file, StandardCharsets.UTF_8)
        } catch (e: Exception) {
            log.warn("Failed to read %s: %s", path, e.message)
            null
        }
    }

    override fun writeFiles(files: List<FileWrite>, message: String) {
        ensure()
        withLock {
            var written = 0
            var deleted = 0
            for (file in files) {
                if (file.delete) {
                    if (deleteHiddenFile(file.path)) deleted++
                } else {
                    writeHiddenFile(file.path, file.content)
                    written++

                    // Generate visible markdown for summary files
                    if (file.path.startsWith("summaries/") && file.path.endsWith(".json")) {
                        generateMarkdown(file.content)
                    }

                    // Generate visible markdown for plan files
                    if (file.path.startsWith("plans/") && file.path.endsWith(".md")) {
                        generatePlanMarkdown(file.path, file.content, file.branch)
                    }

                    // Generate visible markdown for note files
                    if (file.path.startsWith("notes/") && file.path.endsWith(".md")) {
                        generateNoteMarkdown(file.path, file.content, file.branch)
                    }
                }
            }
            log.info("Wrote %d files, deleted %d (%s)", written, deleted, message)
        }
    }

    override fun listFiles(prefix: String): List<String> {
        // List from .jolli/ hidden directory
        val dir = rootPath.resolve(".jolli").resolve(prefix)
        if (!Files.isDirectory(dir)) return emptyList()
        val jolliDir = rootPath.resolve(".jolli")
        return Files.walk(dir).use { stream ->
            stream
                .filter { it.isRegularFile() }
                .map { jolliDir.relativize(it).toString() }
                .sorted()
                .toList()
        }
    }

    override fun exists(): Boolean {
        return Files.isDirectory(rootPath)
    }

    override fun ensure() {
        Files.createDirectories(rootPath)
        metadataManager.ensure()
    }

    // ── Markdown generation ────────────────────────────────────────────────

    /**
     * Parses a CommitSummary JSON and generates a visible markdown file.
     *
     * Output: {branch}/{slug}-{hash8}.md with YAML frontmatter.
     */
    private fun generateMarkdown(summaryJson: String) {
        val summary = try {
            gson.fromJson(summaryJson, CommitSummary::class.java)
        } catch (e: Exception) {
            log.warn("Failed to parse summary for markdown generation: %s", e.message)
            return
        }
        if (summary == null) return

        val branchFolder = metadataManager.resolveFolderForBranch(summary.branch)
        val slug = slugify(summary.commitMessage)
        val hash8 = summary.commitHash.take(8)
        val fileName = "$slug-$hash8.md"
        val relativePath = "$branchFolder/$fileName"

        // Build markdown with YAML frontmatter
        val frontmatter = buildYamlFrontmatter(summary)
        val body = SummaryMarkdownBuilder.buildMarkdown(summary)
        val markdown = "$frontmatter\n$body"

        val targetPath = rootPath.resolve(relativePath)
        atomicWrite(targetPath, markdown)

        // Update manifest
        val fingerprint = sha256(markdown)
        metadataManager.updateManifest(ManifestEntry(
            path = relativePath,
            fileId = summary.commitHash,
            type = "commit",
            fingerprint = fingerprint,
            source = ManifestSource(
                commitHash = summary.commitHash,
                branch = summary.branch,
                generatedAt = summary.generatedAt,
            ),
            title = summary.commitMessage,
        ))

        log.info("Markdown generated: %s", relativePath)
    }

    /** Builds YAML frontmatter block for a commit summary markdown file. */
    private fun buildYamlFrontmatter(summary: CommitSummary): String {
        val lines = mutableListOf("---")
        lines.add("commitHash: ${summary.commitHash}")
        lines.add("branch: ${summary.branch}")
        lines.add("author: ${summary.commitAuthor}")
        lines.add("date: ${summary.commitDate}")
        lines.add("type: commit")
        if (summary.commitType != null) {
            lines.add("commitType: ${summary.commitType}")
        }
        if (summary.stats != null) {
            lines.add("filesChanged: ${summary.stats.filesChanged}")
            lines.add("insertions: ${summary.stats.insertions}")
            lines.add("deletions: ${summary.stats.deletions}")
        }
        lines.add("---")
        return lines.joinToString("\n")
    }

    /**
     * Generates a visible markdown copy for a plan file.
     *
     * Output: {branchFolder}/plan--{slug}.md with YAML frontmatter.
     */
    private fun generatePlanMarkdown(path: String, content: String, branch: String?) {
        val slug = path.removePrefix("plans/").removeSuffix(".md")
        val resolvedBranch = branch ?: resolveBranchFromSlug(slug) ?: return
        val branchFolder = metadataManager.resolveFolderForBranch(resolvedBranch)
        val fileName = "plan--$slug.md"
        val relativePath = "$branchFolder/$fileName"

        val frontmatter = buildPlanNoteFrontmatter(type = "plan", slug = slug)
        val markdown = "$frontmatter\n$content"

        val targetPath = rootPath.resolve(relativePath)
        atomicWrite(targetPath, markdown)

        val fingerprint = sha256(markdown)
        metadataManager.updateManifest(ManifestEntry(
            path = relativePath,
            fileId = "plan-$slug",
            type = "plan",
            fingerprint = fingerprint,
            source = ManifestSource(branch = resolvedBranch),
            title = extractTitleFromMarkdown(content),
        ))

        log.info("Plan markdown generated: %s", relativePath)
    }

    /**
     * Generates a visible markdown copy for a note file.
     *
     * Output: {branchFolder}/note--{slug}.md with YAML frontmatter.
     */
    private fun generateNoteMarkdown(path: String, content: String, branch: String?) {
        val slug = path.removePrefix("notes/").removeSuffix(".md")
        val resolvedBranch = branch ?: resolveBranchFromSlug(slug) ?: return
        val branchFolder = metadataManager.resolveFolderForBranch(resolvedBranch)
        val fileName = "note--$slug.md"
        val relativePath = "$branchFolder/$fileName"

        val frontmatter = buildPlanNoteFrontmatter(type = "note", slug = slug)
        val markdown = "$frontmatter\n$content"

        val targetPath = rootPath.resolve(relativePath)
        atomicWrite(targetPath, markdown)

        val fingerprint = sha256(markdown)
        metadataManager.updateManifest(ManifestEntry(
            path = relativePath,
            fileId = "note-$slug",
            type = "note",
            fingerprint = fingerprint,
            source = ManifestSource(branch = resolvedBranch),
            title = extractTitleFromMarkdown(content),
        ))

        log.info("Note markdown generated: %s", relativePath)
    }

    /** Builds YAML frontmatter for plan/note markdown files. */
    private fun buildPlanNoteFrontmatter(type: String, slug: String): String {
        return listOf("---", "type: $type", "slug: $slug", "---").joinToString("\n")
    }

    /** Extracts the first `# ` heading, or falls back to first non-empty line of content. */
    private fun extractTitleFromMarkdown(content: String): String {
        val heading = Regex("^#\\s+(.+)", RegexOption.MULTILINE).find(content)
        if (heading != null) return heading.groupValues[1].trim()
        val firstLine = content.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }
        return firstLine?.take(80) ?: "Untitled"
    }

    /**
     * Resolves a branch name from a slug by extracting the trailing hash8 segment
     * and looking it up in index.json entries.
     *
     * Plan slugs follow the pattern `{name}-{hash8}` where hash8 is the first 8
     * characters of a commit hash. This method extracts that hash8 and scans index
     * entries to find which branch the commit belongs to.
     *
     * @return the branch name, or null if no match is found
     */
    fun resolveBranchFromSlug(slug: String): String? {
        // Extract the last segment after the final dash — it may be a hash8
        val lastDash = slug.lastIndexOf('-')
        if (lastDash < 0) return null
        val hash8 = slug.substring(lastDash + 1)
        if (hash8.length != 8 || !hash8.all { it in '0'..'9' || it in 'a'..'f' }) return null

        val index = metadataManager.readIndex() ?: return null
        val entry = index.entries.find { it.commitHash.startsWith(hash8) }
        return entry?.branch
    }

    // ── Hidden file operations ─────────────────────────────────────────────

    /** Writes a data file to .jolli/{path}. */
    private fun writeHiddenFile(path: String, content: String) {
        val target = rootPath.resolve(".jolli").resolve(path)
        atomicWrite(target, content)
    }

    /** Deletes a data file from .jolli/{path}. Returns true if deleted. */
    private fun deleteHiddenFile(path: String): Boolean {
        val target = rootPath.resolve(".jolli").resolve(path)
        val deleted = Files.deleteIfExists(target)
        if (deleted) {
            cleanEmptyParents(target.parent)
            // Also try to delete the corresponding visible markdown
            if (path.startsWith("summaries/") && path.endsWith(".json")) {
                deleteMarkdownForSummary(path)
            }
        }
        return deleted
    }

    /** Deletes the visible markdown file for a summary, if it exists in the manifest. */
    private fun deleteMarkdownForSummary(summaryPath: String) {
        val hash = summaryPath.removePrefix("summaries/").removeSuffix(".json")
        val entry = metadataManager.findById(hash) ?: return
        val mdPath = rootPath.resolve(entry.path)
        if (Files.deleteIfExists(mdPath)) {
            cleanEmptyParents(mdPath.parent)
            metadataManager.removeFromManifest(hash)
        }
    }

    // ── Internal helpers ───────────────────────────────────────────────────

    /** Acquires a file lock on .jolli/lock for the duration of [block]. */
    private fun <T> withLock(block: () -> T): T {
        val lockFile = rootPath.resolve(".jolli/lock")
        Files.createDirectories(lockFile.parent)
        FileChannel.open(
            lockFile,
            StandardOpenOption.CREATE,
            StandardOpenOption.WRITE,
        ).use { channel ->
            val lock = channel.tryLock()
                ?: throw IllegalStateException("KB folder is locked by another process")
            try {
                return block()
            } finally {
                lock.release()
            }
        }
    }

    /** Writes content to a file atomically via temp file + move. */
    private fun atomicWrite(targetPath: Path, content: String) {
        Files.createDirectories(targetPath.parent)
        val tmp = Files.createTempFile(targetPath.parent, ".jolli-", ".tmp")
        try {
            Files.writeString(tmp, content, StandardCharsets.UTF_8)
            Files.move(tmp, targetPath, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (e: Exception) {
            Files.deleteIfExists(tmp)
            throw e
        }
    }

    /** Removes empty parent directories up to (but not including) rootPath. */
    private fun cleanEmptyParents(dir: Path) {
        var current = dir
        while (current != rootPath && current.startsWith(rootPath)) {
            try {
                Files.list(current).use { stream ->
                    if (stream.findAny().isPresent) return
                }
                Files.delete(current)
                current = current.parent
            } catch (_: Exception) {
                return
            }
        }
    }

    companion object {
        /** Converts a commit message to a URL-safe slug for filenames. */
        fun slugify(text: String): String {
            var result = text.lowercase()
                .replace(Regex("[^a-z0-9\\s-]"), "")
                .replace(Regex("\\s+"), "-")
                .replace(Regex("-{2,}"), "-")
                .trim('-')
            if (result.length > 50) result = result.take(50).trimEnd('-')
            return result.ifEmpty { "untitled" }
        }

        /** SHA-256 hash of content for fingerprinting. */
        fun sha256(content: String): String {
            val digest = MessageDigest.getInstance("SHA-256")
            val bytes = digest.digest(content.toByteArray(StandardCharsets.UTF_8))
            return bytes.joinToString("") { "%02x".format(it) }
        }
    }
}
