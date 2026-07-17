package ai.jolli.jollimemory.hooks

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

class HookRunnerTest {

    @Test
    fun `HookRunner has main method`() {
        val methods = HookRunner::class.java.methods.map { it.name }
        methods.contains("main") shouldBe true
    }

    // The unknown-hook branch calls System.exit and cannot be exercised in-JVM;
    // dispatch behavior is covered by the individual hook tests.
}
