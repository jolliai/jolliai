package ai.jolli.jollimemory.core

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class PushPendingReaderTest {

    @TempDir
    lateinit var tempDir: File

    @Test
    fun `returns queued commit hashes`() {
        val queue = File(tempDir, ".jolli/jollimemory/push-pending.json")
        queue.parentFile.mkdirs()
        queue.writeText("""{"version":1,"entries":{"hash-a":{},"hash-b":{}}}""")

        PushPendingReader.loadHashes(tempDir.absolutePath) shouldBe setOf("hash-a", "hash-b")
    }

    @Test
    fun `returns empty when the queue is missing and null when it is corrupt`() {
        PushPendingReader.loadHashes(tempDir.absolutePath) shouldBe emptySet()

        val queue = File(tempDir, ".jolli/jollimemory/push-pending.json")
        queue.parentFile.mkdirs()
        queue.writeText("not json")
        PushPendingReader.loadHashes(tempDir.absolutePath) shouldBe null
    }
}
