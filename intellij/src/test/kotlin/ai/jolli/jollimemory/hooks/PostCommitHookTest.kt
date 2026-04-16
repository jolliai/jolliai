package ai.jolli.jollimemory.hooks

import ai.jolli.jollimemory.core.DiffStats
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import java.lang.reflect.Method

class PostCommitHookTest {

    /** Access the private parseDiffStats method via reflection for testing. */
    private fun parseDiffStats(statOutput: String): DiffStats {
        val method: Method = PostCommitHook::class.java.getDeclaredMethod("parseDiffStats", String::class.java)
        method.isAccessible = true
        return method.invoke(PostCommitHook, statOutput) as DiffStats
    }

    @Nested
    inner class ParseDiffStats {
        @Test
        fun `parses numstat output`() {
            val output = """
10	5	src/Auth.ts
20	3	src/Middleware.ts
            """.trimIndent()

            val stats = parseDiffStats(output)
            stats.filesChanged shouldBe 2
            stats.insertions shouldBe 30
            stats.deletions shouldBe 8
        }

        @Test
        fun `handles binary files with dash markers`() {
            val output = """
10	5	src/code.ts
-	-	assets/image.png
            """.trimIndent()

            val stats = parseDiffStats(output)
            stats.filesChanged shouldBe 2
            stats.insertions shouldBe 10
            stats.deletions shouldBe 5
        }

        @Test
        fun `returns zero stats for empty input`() {
            val stats = parseDiffStats("")
            stats.filesChanged shouldBe 0
            stats.insertions shouldBe 0
            stats.deletions shouldBe 0
        }

        @Test
        fun `ignores malformed lines`() {
            val output = """
10	5	src/code.ts
invalid line
3	2	src/other.ts
            """.trimIndent()

            val stats = parseDiffStats(output)
            stats.filesChanged shouldBe 2
            stats.insertions shouldBe 13
            stats.deletions shouldBe 7
        }
    }
}
