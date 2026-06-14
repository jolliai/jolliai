package ai.jolli.jollimemory.core

import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.ints.shouldBeGreaterThan
import io.kotest.matchers.ints.shouldBeLessThan
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.FileTime
import java.time.Instant

class SourceTimelineTest {

    private fun ref(type: String, id: String, ts: String, branch: String? = null) =
        SourceRef(type = type, id = id, timestamp = ts, branch = branch)

    // ── compareSourceRefs (exactness-critical) ─────────────────────────────

    @Test
    fun `orders by epoch ascending`() {
        val a = ref("summary", "a", "2026-01-01T00:00:00Z")
        val b = ref("summary", "b", "2026-01-02T00:00:00Z")
        SourceTimeline.compareSourceRefs(a, b).shouldBeLessThan(0)
        SourceTimeline.compareSourceRefs(b, a).shouldBeGreaterThan(0)
    }

    @Test
    fun `parses timezone offsets to epoch, not string compare`() {
        // +02:00 local midnight == 22:00 UTC the previous day → earlier instant than Z.
        val offset = ref("summary", "a", "2026-01-01T00:00:00+02:00")
        val zulu = ref("summary", "b", "2026-01-01T00:00:00Z")
        SourceTimeline.compareSourceRefs(offset, zulu).shouldBeLessThan(0)
    }

    @Test
    fun `unparseable timestamps sort after valid ones`() {
        val valid = ref("summary", "a", "2026-01-01T00:00:00Z")
        val bad = ref("summary", "b", "not-a-date")
        SourceTimeline.compareSourceRefs(bad, valid).shouldBeGreaterThan(0)
        SourceTimeline.compareSourceRefs(valid, bad).shouldBeLessThan(0)
    }

    @Test
    fun `equal instant breaks ties by type rank then id`() {
        val ts = "2026-01-01T00:00:00Z"
        // type rank: summary < plan < note < userfile
        SourceTimeline.compareSourceRefs(ref("summary", "z", ts), ref("plan", "a", ts)).shouldBeLessThan(0)
        SourceTimeline.compareSourceRefs(ref("note", "a", ts), ref("userfile", "a", ts)).shouldBeLessThan(0)
        // same type + instant → id lexicographic
        SourceTimeline.compareSourceRefs(ref("plan", "a", ts), ref("plan", "b", ts)).shouldBeLessThan(0)
        SourceTimeline.compareSourceRefs(ref("plan", "a", ts), ref("plan", "a", ts)) shouldBe 0
    }

    // ── collectAllSourceRefs / listPendingSources (integration) ────────────

    @TempDir
    lateinit var tempDir: Path
    private lateinit var kbRoot: Path
    private lateinit var metadataManager: MetadataManager
    private lateinit var storage: FolderStorage

    @BeforeEach
    fun setUp() {
        kbRoot = tempDir.resolve("kb")
        metadataManager = MetadataManager(kbRoot.resolve(".jolli"))
        storage = FolderStorage(kbRoot, metadataManager)
        storage.ensure()
    }

    private fun seedSources() {
        // Summary (root) at 01-03.
        metadataManager.writeIndex(
            SummaryIndex(
                entries = listOf(
                    SummaryIndexEntry(
                        commitHash = "hash1", parentCommitHash = null, commitMessage = "m",
                        commitDate = "2026-01-03T00:00:00Z", branch = "main", generatedAt = "g",
                    ),
                    // A child summary — must be excluded (parentCommitHash != null).
                    SummaryIndexEntry(
                        commitHash = "child", parentCommitHash = "hash1", commitMessage = "m2",
                        commitDate = "2026-01-04T00:00:00Z", branch = "main", generatedAt = "g",
                    ),
                ),
            ),
        )
        // Plan source at 01-02.
        metadataManager.updateManifest(
            ManifestEntry(
                path = "main/plan--myplan.md", fileId = "plan:myplan", type = "plan",
                fingerprint = "fp", source = ManifestSource(branch = "main"),
                title = "My Plan", updatedAt = "2026-01-02T00:00:00Z",
            ),
        )
        Files.createDirectories(kbRoot.resolve(".jolli/plans"))
        Files.writeString(kbRoot.resolve(".jolli/plans/myplan.md"), "# Plan body", StandardCharsets.UTF_8)
        // User file at 01-01.
        val userFile = kbRoot.resolve("notes.md")
        Files.writeString(userFile, "# My notes", StandardCharsets.UTF_8)
        Files.setLastModifiedTime(userFile, FileTime.from(Instant.parse("2026-01-01T00:00:00Z")))
    }

    @Test
    fun `collects summary + plan + userfile refs and excludes child summaries`() {
        seedSources()
        val refs = SourceTimeline.collectAllSourceRefs(kbRoot, storage)
        refs.filter { it.type == SourceType.SUMMARY }.map { it.id } shouldContainExactly listOf("hash1")
        refs.filter { it.type == SourceType.PLAN }.map { it.id } shouldContainExactly listOf("myplan")
        refs.count { it.type == SourceType.USERFILE } shouldBe 1
    }

    @Test
    fun `listPendingSources orders old to new and respects processed set`() {
        seedSources()
        val pending = SourceTimeline.listPendingSources(kbRoot, storage, ProcessedSourceStore.emptyProcessedSet())
        // user file (01-01) < plan (01-02) < summary (01-03)
        pending.map { it.type } shouldContainExactly listOf(SourceType.USERFILE, SourceType.PLAN, SourceType.SUMMARY)

        // Mark the plan processed → it drops out.
        val processed = ProcessedSourceStore.addProcessed(
            ProcessedSourceStore.emptyProcessedSet(),
            listOf(SourceRef(SourceType.PLAN, "myplan", "2026-01-02T00:00:00Z")),
        )
        val afterProcessed = SourceTimeline.listPendingSources(kbRoot, storage, processed)
        afterProcessed.none { it.type == SourceType.PLAN } shouldBe true
    }
}
