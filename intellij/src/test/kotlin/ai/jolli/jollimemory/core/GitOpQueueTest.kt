package ai.jolli.jollimemory.core

import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class GitOpQueueTest {

    @TempDir
    lateinit var tempDir: File
    private val cwd get() = tempDir.absolutePath
    private fun queueDir() = File(tempDir, ".jolli/jollimemory/git-op-queue")

    /** Write a queue file directly with a chosen timestamp prefix + valid op JSON. */
    private fun writeEntry(ts: Long, hash: String, type: String = "commit") {
        queueDir().mkdirs()
        File(queueDir(), "$ts-${hash.take(8)}.json").writeText(
            """{"type":"$type","commitHash":"$hash","createdAt":"2026-07-02T00:00:00Z"}""",
            Charsets.UTF_8,
        )
    }

    @Test
    fun `enqueue then dequeueAll round-trips the operation`() {
        val op = GitOpQueue.GitOperation(
            type = "amend", commitHash = "abc123def456", branch = "feature/x",
            sourceHashes = listOf("oldhash1"), commitSource = "plugin", createdAt = "2026-07-02T00:00:00Z",
        )
        GitOpQueue.enqueue(op, cwd).shouldBeTrue()

        val entries = GitOpQueue.dequeueAll(cwd)
        entries shouldHaveSize 1
        val (loaded, _) = entries.first()
        loaded.type shouldBe "amend"
        loaded.commitHash shouldBe "abc123def456"
        loaded.branch shouldBe "feature/x"
        loaded.sourceHashes shouldBe listOf("oldhash1")
        loaded.commitSource shouldBe "plugin"
    }

    @Test
    fun `round-trips squash and rebase op types with their source hashes`() {
        val cases = listOf(
            "squash" to listOf("s1", "s2", "s3"),
            "rebase-pick" to listOf("old1"),
            "rebase-squash" to listOf("r1", "r2"),
            "cherry-pick" to null,
            "revert" to null,
        )
        for ((type, sources) in cases) {
            GitOpQueue.enqueue(
                GitOpQueue.GitOperation(
                    type = type, commitHash = "${type}00000000", sourceHashes = sources,
                    createdAt = "2026-07-02T00:00:00Z",
                ),
                cwd,
            )
        }
        val byType = GitOpQueue.dequeueAll(cwd).associate { it.first.type to it.first.sourceHashes }
        byType["squash"] shouldBe listOf("s1", "s2", "s3")
        byType["rebase-pick"] shouldBe listOf("old1")
        byType["rebase-squash"] shouldBe listOf("r1", "r2")
        byType["cherry-pick"] shouldBe null
        byType["revert"] shouldBe null
    }

    @Test
    fun `dequeueAll returns entries in chronological (timestamp) order`() {
        val base = System.currentTimeMillis()
        writeEntry(base + 2000, "bbbbbbbb")
        writeEntry(base + 1000, "aaaaaaaa")
        writeEntry(base + 1500, "cccccccc")

        val order = GitOpQueue.dequeueAll(cwd).map { it.first.commitHash }
        order shouldBe listOf("aaaaaaaa", "cccccccc", "bbbbbbbb")
    }

    @Test
    fun `dequeueAll prunes entries older than 24h`() {
        val old = System.currentTimeMillis() - 25L * 60 * 60 * 1000
        val fresh = System.currentTimeMillis()
        writeEntry(old, "staaaale0")
        writeEntry(fresh, "freshhh00")

        val entries = GitOpQueue.dequeueAll(cwd)
        entries shouldHaveSize 1
        entries.first().first.commitHash shouldBe "freshhh00"
        // stale file was deleted from disk
        (queueDir().listFiles()?.size ?: 0) shouldBe 1
    }

    @Test
    fun `dequeueAll deletes and skips an unparseable entry`() {
        queueDir().mkdirs()
        File(queueDir(), "${System.currentTimeMillis()}-garbage0.json").writeText("{ not json", Charsets.UTF_8)

        GitOpQueue.dequeueAll(cwd) shouldHaveSize 0
        (queueDir().listFiles()?.size ?: 0) shouldBe 0
    }

    @Test
    fun `dequeueAll on a missing queue dir is empty, not an error`() {
        GitOpQueue.dequeueAll(cwd) shouldHaveSize 0
        GitOpQueue.hasEntries(cwd).shouldBeFalse()
    }

    @Test
    fun `deleteEntry removes the file and hasEntries flips`() {
        writeEntry(System.currentTimeMillis(), "aaaaaaaa")
        GitOpQueue.hasEntries(cwd).shouldBeTrue()

        val (_, file) = GitOpQueue.dequeueAll(cwd).first()
        GitOpQueue.deleteEntry(file)

        GitOpQueue.hasEntries(cwd).shouldBeFalse()
    }
}
